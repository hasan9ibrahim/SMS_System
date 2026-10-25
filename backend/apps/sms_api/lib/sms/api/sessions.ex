defmodule Sms.Api.Sessions do
  @moduledoc """
  Staff sessions (backend step 9, §13.28) in `user_sessions` (`user_kind` 'staff'), found by a SHA-256 hash of the
  `sms_session` cookie; the token itself is never stored. Decided 2026-10-25: a session ends after 8 hours without
  activity and 24 hours after sign-in at most (`:idle_hours`, `:max_hours`). Logged In Users (§11) lists them; an
  administrator can end one there.
  """
  alias Sms.Core.Repo

  @cookie "sms_session"

  @type session :: %{user_id: pos_integer(), session_id: pos_integer()}
  @type client :: %{ip: String.t(), user_agent: String.t()}

  @doc "The cookie's name."
  @spec cookie() :: String.t()
  def cookie, do: @cookie

  @doc "How long the cookie lives, in seconds (the 24-hour limit)."
  @spec max_age() :: number()
  def max_age, do: hours(:max_hours, 24) * 3600

  @doc "The open session of a cookie token, or nil (ended, idle too long, too old, the user inactive or deleted)."
  @spec lookup(String.t() | nil) :: session() | nil
  def lookup(token) when is_binary(token) and token != "" do
    %{rows: rows} =
      Repo.query!(
        """
        SELECT s.id, s.user_id, s.last_seen_at < now() - interval '1 minute'
          FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.user_kind = 'staff' AND s.ended_at IS NULL
           AND s.last_seen_at > now() - make_interval(hours => $2)
           AND s.logged_in_at > now() - make_interval(hours => $3)
           AND u.status = 'active' AND u.deleted_at IS NULL
        """,
        [hash(token), hours(:idle_hours, 8), hours(:max_hours, 24)]
      )

    case rows do
      [[id, user_id, stale?]] ->
        _ =
          if stale?,
            do: Repo.query!("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [id])

        %{user_id: user_id, session_id: id}

      [] ->
        nil
    end
  end

  def lookup(_token), do: nil

  @doc """
  Opens a session and returns its cookie token. A user without Allow Multiple Login has their other sessions ended
  first (end reason `replaced`).
  """
  @spec open(pos_integer(), client()) :: {String.t(), pos_integer()}
  def open(user_id, client) do
    token = Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
    %{device: device, os: os, browser: browser} = device(client.user_agent)

    _ =
      Repo.query!(
        """
        UPDATE user_sessions SET ended_at = now(), end_reason = 'replaced'
         WHERE user_kind = 'staff' AND user_id = $1 AND ended_at IS NULL
           AND NOT (SELECT allow_multiple_login FROM users WHERE id = $1)
        """,
        [user_id]
      )

    %{rows: [[id]]} =
      Repo.query!(
        """
        INSERT INTO user_sessions (user_kind, user_id, ip, device, os, browser, logged_in_at, last_seen_at, token_hash)
        VALUES ('staff', $1, $2::text::inet, $3, $4, $5, now(), now(), $6) RETURNING id
        """,
        [user_id, client.ip, device, os, browser, hash(token)]
      )

    _ =
      Repo.query!(
        "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
        [user_id]
      )

    {token, id}
  end

  @doc "Ends the session of a cookie token (sign out)."
  @spec close(String.t() | nil) :: :ok
  def close(token) when is_binary(token) and token != "" do
    _ =
      Repo.query!(
        """
        UPDATE user_sessions SET ended_at = now(), end_reason = 'logout'
         WHERE token_hash = $1 AND user_kind = 'staff' AND ended_at IS NULL
        """,
        [hash(token)]
      )

    :ok
  end

  def close(_token), do: :ok

  @doc false
  @spec hash(String.t()) :: String.t()
  def hash(token), do: :sha256 |> :crypto.hash(token) |> Base.encode16(case: :lower)

  defp hours(key, default),
    do: Keyword.get(Application.get_env(:sms_api, __MODULE__, []), key, default)

  @doc "Desktop / mobile, operating system and browser in words, for Logged In Users (§11), as the mock reads them."
  @spec device(String.t()) :: %{device: String.t(), os: String.t(), browser: String.t()}
  def device(ua) do
    %{
      device: if(ua =~ ~r/Mobile|Android|iPhone/i, do: "mobile", else: "desktop"),
      os:
        first_match(ua, [
          {~r/Windows/, "Windows"},
          {~r/iPhone|iPad/, "iOS"},
          {~r/Mac OS X/, "macOS"},
          {~r/Android/, "Android"},
          {~r/Linux/, "Linux"}
        ]),
      browser:
        first_match(ua, [
          {~r/Edg\//, "Edge"},
          {~r/Chrome\//, "Chrome"},
          {~r/Firefox\//, "Firefox"},
          {~r/Safari\//, "Safari"}
        ])
    }
  end

  defp first_match(ua, rules) do
    Enum.find_value(rules, "Other", fn {re, name} -> if ua =~ re, do: name end)
  end
end
