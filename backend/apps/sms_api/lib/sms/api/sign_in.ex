defmodule Sms.Api.SignIn do
  @moduledoc """
  Staff sign-in (backend step 9, contract v0.96.0, §13.28), the same rules the mock follows (mock/src/api/signIn.ts):

    * Username (any case) and password. One answer for an unknown user and a wrong password, so usernames cannot be
      guessed. Five wrong passwords in a row lock the user for 15 minutes.
    * Then a 2FA code at every login (product owner 2026-10-25): the authenticator app when the user has one,
      otherwise a 6-digit code e-mailed to the user. Only an administrator can turn the code off for a user (OTP
      verification Off); such a user is signed in at once.
    * The code is checked against a challenge: an opaque token (only its hash is stored) that works for 10 minutes
      and 5 tries; a wrong code uses one try. An e-mailed code can be sent again once a minute.

  E-mailed codes are written to the e-mail log, as the mock does. In production (`SMS_MODE=production`, backend step 11)
  they are written as queued and the TypeScript service's e-mail job sends them over SMTP (mock/src/jobs/mailer.ts).
  """
  alias Sms.Api.{Password, Problem, Sessions, Totp}
  alias Sms.Core.Repo

  @max_failed 5
  @lock_minutes 15
  @code_minutes 10
  @code_tries 5
  @resend_gap_s 60

  @type result ::
          {:signed_in, pos_integer()}
          | {:code_required, map()}
          | {:error, Problem.t()}

  @doc "The id of the user with this username (any case), for the audit trail; nil when there is none."
  @spec user_id(String.t()) :: pos_integer() | nil
  def user_id(username) do
    case Repo.query!(
           "SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL",
           [
             String.trim(username)
           ]
         ) do
      %{rows: [[id]]} -> id
      _ -> nil
    end
  end

  @doc "Checks the password; signs in, asks for the code, or refuses."
  @spec password(String.t(), String.t(), Sessions.client()) :: result()
  def password(username, password, client) do
    %{rows: rows} =
      Repo.query!(
        """
        SELECT id, password_hash, status, failed_logins, locked_until > now(), locked_until,
               temp_password_expires_at < now(), otp_method, totp_enabled AND totp_secret IS NOT NULL, email
          FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL
        """,
        [String.trim(username)]
      )

    case rows do
      [] -> {:error, wrong()}
      [row] -> check_user(row, password, client)
    end
  end

  defp check_user([_id, _hash, _status, _failed, true, until | _], _password, _client),
    do:
      {:error,
       Problem.new(429, "Too many wrong passwords", detail: "Try again after #{hhmm(until)} UTC.")}

  defp check_user(
         [id, hash, status, failed, _locked, _until, temp_expired, otp, totp?, email],
         password,
         client
       ) do
    cond do
      not Password.verify?(password, hash) ->
        {:error, failed_password(id, failed)}

      status != "active" ->
        {:error, Problem.new(401, "This user is not active. Ask your administrator.")}

      temp_expired == true ->
        {:error,
         Problem.new(
           401,
           "Your temporary password expired. Ask your administrator for a new one."
         )}

      totp? ->
        challenge(id, "authenticator", client)

      otp == "off" ->
        {:signed_in, id}

      email in [nil, ""] ->
        {:error,
         Problem.new(
           401,
           "Your user has no e-mail address for the sign-in code. Ask your administrator."
         )}

      true ->
        challenge(id, "email", client)
    end
  end

  defp failed_password(id, failed) do
    failed = failed + 1
    locked? = failed >= @max_failed

    _ =
      Repo.query!(
        """
        UPDATE users SET failed_logins = $2::smallint,
               locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) END
         WHERE id = $1
        """,
        [id, if(locked?, do: 0, else: failed), locked?, @lock_minutes]
      )

    if locked?,
      do:
        Problem.new(429, "Too many wrong passwords",
          detail: "The account is locked for #{@lock_minutes} minutes."
        ),
      else: wrong()
  end

  defp wrong, do: Problem.new(401, "Wrong username or password")

  defp challenge(user_id, method, client) do
    token = Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

    %{rows: [[id, expires_at]]} =
      Repo.query!(
        """
        INSERT INTO sign_in_challenges (token_hash, user_id, method, ip, user_agent, expires_at)
        VALUES ($1, $2, $3, $4::text::inet, $5, now() + make_interval(mins => $6)) RETURNING id, expires_at
        """,
        [Sessions.hash(token), user_id, method, client.ip, client.user_agent, @code_minutes]
      )

    sent = if method == "email", do: %{sentTo: send_code(id, user_id)}, else: %{}

    {:code_required,
     Map.merge(
       %{status: "code_required", challenge: token, method: method, expiresAt: iso(expires_at)},
       sent
     )}
  end

  @doc "Checks the code of a challenge; signs in or refuses (a wrong code uses one try)."
  @spec code(String.t(), String.t()) :: {:signed_in, pos_integer()} | {:error, Problem.t()}
  def code(challenge, code) do
    case open_challenge(challenge) do
      nil ->
        {:error, expired()}

      c ->
        if code_ok?(c, code) do
          _ = Repo.query!("UPDATE sign_in_challenges SET used_at = now() WHERE id = $1", [c.id])
          {:signed_in, c.user_id}
        else
          _ = Repo.query!("UPDATE sign_in_challenges SET tries = tries + 1 WHERE id = $1", [c.id])
          left = @code_tries - c.tries - 1

          {:error,
           if(left > 0,
             do:
               Problem.new(401, "The code does not match",
                 detail: "#{left} tries left.",
                 code: "wrong_code"
               ),
             else:
               Problem.new(401, "Too many wrong codes. Sign in again.", code: "challenge_expired")
           )}
        end
    end
  end

  defp code_ok?(%{method: "authenticator", totp_secret: secret}, code),
    do: Totp.valid?(secret, code)

  defp code_ok?(%{method: "email", id: id, code_hash: want}, code) when is_binary(want),
    do: :crypto.hash_equals(code_hash(id, code), want)

  defp code_ok?(_challenge, _code), do: false

  @doc "E-mails a new code for a challenge (e-mailed codes only, once a minute)."
  @spec resend(String.t()) :: {:code_required, map()} | {:error, Problem.t()}
  def resend(challenge) do
    case open_challenge(challenge) do
      nil ->
        {:error, expired()}

      %{method: "authenticator"} ->
        {:error, Problem.new(409, "Use the code from your authenticator app")}

      %{too_soon: true} ->
        {:error, Problem.new(409, "A code was sent less than a minute ago")}

      c ->
        {:code_required,
         %{
           status: "code_required",
           challenge: challenge,
           method: "email",
           sentTo: send_code(c.id, c.user_id),
           expiresAt: iso(c.expires_at)
         }}
    end
  end

  defp expired,
    do: Problem.new(401, "The sign-in expired. Sign in again.", code: "challenge_expired")

  defp open_challenge(token) do
    %{rows: rows} =
      Repo.query!(
        """
        SELECT c.id, c.user_id, c.method, c.code_hash, c.tries, c.expires_at,
               coalesce(c.sent_at > now() - make_interval(secs => $3), false), u.totp_secret
          FROM sign_in_challenges c JOIN users u ON u.id = c.user_id
         WHERE c.token_hash = $1 AND c.used_at IS NULL AND c.expires_at > now() AND c.tries < $2
           AND u.status = 'active' AND u.deleted_at IS NULL
        """,
        [Sessions.hash(token), @code_tries, @resend_gap_s]
      )

    case rows do
      [[id, user_id, method, code_hash, tries, expires_at, too_soon, secret]] ->
        %{
          id: id,
          user_id: user_id,
          method: method,
          code_hash: code_hash,
          tries: tries,
          expires_at: expires_at,
          too_soon: too_soon,
          totp_secret: secret
        }

      [] ->
        nil
    end
  end

  # The code only; never a password or a sign-in link (§13.28).
  defp send_code(challenge_id, user_id) do
    code = 0..999_999 |> Enum.random() |> Integer.to_string() |> String.pad_leading(6, "0")

    %{rows: [[first_name, email]]} =
      Repo.query!("SELECT first_name, email FROM users WHERE id = $1", [user_id])

    _ =
      Repo.query!(
        "UPDATE sign_in_challenges SET code_hash = $2, sent_at = now(), tries = 0 WHERE id = $1",
        [challenge_id, code_hash(challenge_id, code)]
      )

    body =
      "Hello #{first_name},\n\nYour sign-in code is #{code}. It works for #{@code_minutes} minutes.\n\n" <>
        "If you did not try to sign in, change your password and tell your administrator."

    _ =
      Repo.query!(
        """
        INSERT INTO email_logs (email_type, status, to_addresses, subject, body, user_id)
        VALUES ('otp', $4, $1, 'Your sign-in code', $2, $3)
        """,
        [[email], body, user_id, email_status()]
      )

    mask(email)
  end

  # Queued for the e-mail job in production; written as sent where nothing is delivered (development, tests).
  defp email_status, do: Application.get_env(:sms_api, __MODULE__, [])[:email_status] || "sent"

  defp code_hash(challenge_id, code),
    do: :sha256 |> :crypto.hash("signin:#{challenge_id}:#{code}") |> Base.encode16(case: :lower)

  defp mask(email) do
    [local | domain] = String.split(email, "@", parts: 2)
    "#{String.slice(local, 0, 1)}***@#{List.first(domain, "")}"
  end

  defp iso(%DateTime{} = at), do: at |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()

  defp hhmm(%DateTime{} = at),
    do: at |> DateTime.to_time() |> Time.to_string() |> String.slice(0, 5)
end
