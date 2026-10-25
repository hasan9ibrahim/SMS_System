defmodule Sms.Api.SessionController do
  @moduledoc """
  The sign-in operations of the contract (v0.96.0, §13.28): `signIn` (POST /session), `signInCode` (POST
  /session/code), `resendSignInCode` (POST /session/code/resend) and `signOut` (DELETE /session). Bodies are checked
  against the contract's schemas; the rules are in `Sms.Api.SignIn`. A signed-in answer carries the user as
  `getCurrentUser` returns it, read from the mock as that user until /me is ported.
  """
  use Phoenix.Controller, formats: [:json]
  import Plug.Conn
  alias Sms.Api.{Audit, Auth, Forward, Operations, Problem, RateLimit, Sessions, SignIn}

  # The Audit Trail (§11) records each sign-in call with its user, when known (failed attempts too, §13.28).
  plug :audit

  def create(conn, params) do
    with :ok <- check(params, username: :text, password: :text),
         :ok <- limit(conn) do
      conn = assign(conn, :audit_user, SignIn.user_id(params["username"]))
      reply(conn, SignIn.password(params["username"], params["password"], Auth.client(conn)))
    else
      {:error, problem} -> Problem.send(conn, problem)
    end
  end

  def code(conn, params) do
    case check(params, challenge: :text, code: :code) do
      :ok -> reply(conn, SignIn.code(params["challenge"], params["code"]))
      {:error, problem} -> Problem.send(conn, problem)
    end
  end

  def resend(conn, params) do
    case check(params, challenge: :text) do
      :ok -> reply(conn, SignIn.resend(params["challenge"]))
      {:error, problem} -> Problem.send(conn, problem)
    end
  end

  def delete(conn, _params) do
    :ok = Sessions.close(conn.req_cookies[Sessions.cookie()])

    conn
    |> put_session_cookie("", 0)
    |> send_resp(204, "")
  end

  defp reply(conn, {:signed_in, user_id}) do
    conn = assign(conn, :audit_user, user_id)
    {token, session_id} = Sessions.open(user_id, Auth.client(conn))

    case Forward.get_json("/api/v1/me", %{user_id: user_id, session_id: session_id}) do
      {:ok, user} ->
        conn
        |> put_session_cookie(token, Sessions.max_age())
        |> json(%{status: "signed_in", user: user})

      {:error, _reason} ->
        # The session would work, but the answer cannot carry the user: sign in again shortly.
        :ok = Sessions.close(token)

        Problem.send(
          conn,
          Problem.new(503, "Signing in is not available right now", detail: "Try again shortly.")
        )
    end
  end

  defp reply(conn, {:code_required, body}), do: json(conn, body)
  defp reply(conn, {:error, problem}), do: Problem.send(conn, problem)

  defp audit(conn, _opts) do
    started = System.monotonic_time()
    op = Operations.find(conn.method, String.replace_prefix(conn.request_path, "/api/v1", ""))

    register_before_send(conn, fn conn ->
      user = conn.assigns[:audit_user] || (conn.assigns[:session] && conn.assigns.session.user_id)
      :ok = Audit.record(conn, op, user, started)
      conn
    end)
  end

  defp put_session_cookie(conn, value, max_age) do
    secure? = Keyword.get(Application.get_env(:sms_api, Sessions, []), :secure_cookie, false)

    put_resp_cookie(conn, Sessions.cookie(), value,
      http_only: true,
      same_site: "Lax",
      secure: secure?,
      max_age: max_age,
      path: "/"
    )
  end

  defp limit(conn) do
    case RateLimit.hit(Auth.client_ip(conn)) do
      :ok ->
        :ok

      {:error, seconds} ->
        {:error,
         Problem.new(429, "Too many sign-ins from this address",
           detail: "Try again in #{seconds} seconds."
         )}
    end
  end

  # The contract's schemas: no other keys; text 1-200 characters; a code of 6 digits.
  defp check(params, fields) do
    allowed = Enum.map(fields, fn {k, _} -> Atom.to_string(k) end)

    errors =
      Enum.flat_map(fields, fn {key, kind} ->
        field_errors(params[Atom.to_string(key)], kind, "/#{key}")
      end) ++
        for(
          k <- Map.keys(params),
          k not in allowed,
          do: %{path: "/#{k}", message: "must NOT have additional properties"}
        )

    if errors == [],
      do: :ok,
      else: {:error, Problem.new(400, "Request body does not match the contract", errors: errors)}
  end

  defp field_errors(nil, _kind, path), do: [%{path: path, message: "required"}]

  defp field_errors(v, :text, path) when is_binary(v) do
    if String.length(v) in 1..200,
      do: [],
      else: [%{path: path, message: "must be 1 to 200 characters"}]
  end

  defp field_errors(v, :code, path) when is_binary(v) do
    if v =~ ~r/\A[0-9]{6}\z/,
      do: [],
      else: [%{path: path, message: ~s(must match pattern "^[0-9]{6}$")}]
  end

  defp field_errors(_v, _kind, path), do: [%{path: path, message: "must be string"}]
end
