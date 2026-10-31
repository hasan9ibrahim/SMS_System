defmodule Sms.Api.Forward do
  @moduledoc """
  Forwards every contract call the Elixir API has not ported yet to the mock server (product owner 2026-10-25: the
  API in front, the screens keep one address). The signed-in user goes along as `X-Sms-User` / `X-Sms-Session` with
  the shared secret `X-Sms-Proxy-Secret` (MOCK_PROXY_SECRET), which the mock checks (mock/src/auth/user.ts); such
  headers from the browser are dropped. Without a session only the health check, the set-password link's calls and
  Content-Security-Policy reports (at most 64 KB, 60 a minute per client address) are forwarded; anything else is
  answered 401 `sign_in_required`. The customer portal (/portal) has its own sign-in: its calls go through with the
  portal's cookie.

  Before a call goes on, the password gate (`Sms.Api.PasswordGate`) and the user's access group
  (`Sms.Api.Access`) are checked; a change to users, access groups or passwords drops their cached state.

  The answer is streamed back as it arrives, so exports and downloads are not held in memory. Settings
  (`config :sms_api, Sms.Api.Forward`): `:url` (MOCK_URL), `:secret`, `:timeout_ms`.
  """
  @behaviour Plug
  import Plug.Conn
  require Logger
  alias Sms.Api.{Access, Auth, ConfigPush, Operations, PasswordGate, Problem, RateLimit}

  # Hop-by-hop headers and the ones this API sets itself.
  @dropped ~w(connection keep-alive proxy-connection transfer-encoding te trailer upgrade host content-length cookie)
  # Also the set-password link's two calls (team trial round 11): the link's token is the proof, never a session.
  @public [
    {"GET", "/api/v1/health"},
    {"POST", "/api/v1/password-setup/check"},
    {"POST", "/api/v1/password-setup"}
  ]

  @impl true
  def init(opts), do: opts

  # Content-Security-Policy reports (§14): browsers post them on their own, so no session; nginx and the service
  # limit them too.
  @csp_reports "/api/v1/csp-reports"
  @csp_max_bytes 65_536
  @csp_per_minute 60

  # Only the methods the contract uses go on (HEAD and the rest matched no operation and were forwarded unchecked).
  @methods ~w(GET POST PUT PATCH DELETE)

  @impl true
  def call(conn, _opts) do
    session = conn.assigns[:session]

    cond do
      # Security audit (team trial round 12): the operation is found on the path as sent, while the service behind
      # decodes it; "/api/v1/%75sers/1" matched no operation here but reached /users/1 there with the access checks
      # skipped. No contract path needs an encoded character, a dot segment or a backslash.
      unsafe_path?(conn.request_path) -> Problem.send(conn, not_found(conn))
      conn.method not in @methods -> Problem.send(conn, Problem.new(405, "Method not allowed"))
      portal?(conn) -> forward(conn, nil)
      conn.method == "POST" and conn.request_path == @csp_reports -> csp_report(conn)
      {conn.method, conn.request_path} in @public -> forward(conn, session)
      session == nil -> Problem.send(conn, Problem.sign_in_required())
      true -> checked(conn, session)
    end
  end

  defp portal?(conn), do: String.starts_with?(conn.request_path, "/api/v1/portal/")

  # A report goes on as nobody when it says how long it is (at most 64 KB) and its address is under the limit.
  defp csp_report(conn) do
    length = conn |> get_req_header("content-length") |> List.first("") |> Integer.parse()

    cond do
      not match?({n, ""} when n <= @csp_max_bytes, length) ->
        Problem.send(conn, Problem.new(413, "The report is over 64 KB"))

      RateLimit.hit({:csp, Auth.client_ip(conn)}, @csp_per_minute, 60) != :ok ->
        Problem.send(conn, Problem.new(429, "Too many reports", detail: "Try again in a minute."))

      true ->
        forward(conn, nil)
    end
  end

  defp checked(conn, session) do
    op = Operations.find(conn.method, String.replace_prefix(conn.request_path, "/api/v1", ""))

    with true <- op != nil,
         :ok <- PasswordGate.check(session.user_id, op.operation_id),
         :ok <- Access.check(session.user_id, op),
         :ok <- lookup_check(conn, session, op) do
      conn = forward(conn, session, op.operation_id)
      forget_cached(conn, op)
      :ok = ConfigPush.after_call(conn.method, conn.request_path, conn.status || 0)
      conn
    else
      # No such operation: answered here, never forwarded unchecked (security audit, team trial round 12).
      false -> Problem.send(conn, not_found(conn))
      {:error, problem} -> Problem.send(conn, problem)
    end
  end

  @doc "Whether a request path holds what no contract path has: an encoded character, a dot segment, a backslash."
  @spec unsafe_path?(String.t()) :: boolean()
  def unsafe_path?(path) do
    String.contains?(path, ["%", "\\", "//"]) or
      Enum.any?(String.split(path, "/"), &(&1 in [".", ".."]))
  end

  defp not_found(conn),
    do: Problem.new(404, "No contract operation for #{conn.method} #{conn.request_path}")

  # Names-only picks of another page's records (backend step 10): the user needs a page that picks from the list.
  defp lookup_check(conn, session, %{operation_id: "queryLookup"}) do
    case String.split(conn.request_path, "/", trim: true) do
      ["api", "v1", "lookups", list, "query"] -> Access.check_lookup(session.user_id, list)
      _ -> :ok
    end
  end

  defp lookup_check(_conn, _session, _op), do: :ok

  # A change to users, access groups, security settings or a password takes effect at once.
  defp forget_cached(conn, op) do
    first = op.path |> String.split("/", trim: true) |> List.first()

    if conn.method != "GET" and conn.status in 200..299 and
         first in ~w(users access-groups me security) do
      :ok = Access.forget()
      :ok = PasswordGate.forget()
    end
  end

  defp forward(conn, session, operation_id \\ nil) do
    {:ok, body, conn} = read_all(conn, [])
    url = config(:url, "http://127.0.0.1:4010") <> conn.request_path <> query(conn.query_string)

    # The operation checked here goes along: the service refuses a forwarded call whose route is another one.
    headers =
      request_headers(conn, session) ++
        if(operation_id, do: [{"x-sms-op", operation_id}], else: [])

    request = Finch.build(conn.method, url, headers, body)

    case Finch.stream(request, Sms.Api.Finch, conn, &relay/2,
           receive_timeout: config(:timeout_ms, 120_000)
         ) do
      {:ok, %Plug.Conn{state: :chunked} = conn} ->
        conn

      {:ok, conn} ->
        # An answer with no body (e.g. 204): the headers arrived, nothing was sent yet.
        send_resp(conn, conn.status || 502, "")

      {:error, reason, %Plug.Conn{state: :unset} = conn} ->
        Logger.error("forward #{conn.method} #{conn.request_path} failed: #{inspect(reason)}")

        Problem.send(
          conn,
          Problem.new(503, "The server behind the API is not reachable",
            detail: "Try again shortly."
          )
        )

      {:error, reason, conn} ->
        # Cut off after the answer started: nothing more can be sent.
        Logger.error("forward #{conn.method} #{conn.request_path} cut off: #{inspect(reason)}")
        halt(conn)
    end
  end

  @doc "GET of a JSON answer from the mock as `session`'s user (e.g. GET /me after signing in)."
  @spec get_json(String.t(), Auth.session()) :: {:ok, term()} | {:error, term()}
  def get_json(path, session) do
    op = Operations.find("GET", String.replace_prefix(path, "/api/v1", ""))

    request =
      Finch.build(
        :get,
        config(:url, "http://127.0.0.1:4010") <> path,
        identity(session) ++
          [{"accept", "application/json"}] ++
          if(op, do: [{"x-sms-op", op.operation_id}], else: [])
      )

    case Finch.request(request, Sms.Api.Finch, receive_timeout: config(:timeout_ms, 120_000)) do
      {:ok, %Finch.Response{status: 200, body: body}} -> Jason.decode(body)
      {:ok, %Finch.Response{status: status}} -> {:error, {:status, status}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp relay({:status, status}, conn), do: %{conn | status: status}

  defp relay({:headers, headers}, conn) do
    Enum.reduce(headers, conn, fn {k, v}, conn ->
      if String.downcase(k) in @dropped,
        do: conn,
        else: put_resp_header(conn, String.downcase(k), v)
    end)
  end

  defp relay({:data, data}, %Plug.Conn{state: :chunked} = conn) do
    case chunk(conn, data) do
      {:ok, conn} -> conn
      {:error, _closed} -> conn
    end
  end

  defp relay({:data, data}, conn), do: relay({:data, data}, send_chunked(conn, conn.status))
  defp relay({:trailers, _}, conn), do: conn

  defp request_headers(conn, session) do
    # The portal's own session cookie goes along to the portal calls only.
    dropped = if portal?(conn), do: @dropped -- ["cookie"], else: @dropped

    kept =
      Enum.reject(conn.req_headers, fn {k, _} ->
        k in dropped or String.starts_with?(k, "x-sms-") or k == "x-forwarded-for"
      end)

    kept ++
      [{"x-forwarded-for", Auth.client_ip(conn)}] ++ if(session, do: identity(session), else: [])
  end

  defp identity(session) do
    [
      {"x-sms-user", Integer.to_string(session.user_id)},
      {"x-sms-session", Integer.to_string(session.session_id)},
      {"x-sms-proxy-secret", config(:secret, "") || ""}
    ]
  end

  defp read_all(conn, acc) do
    case read_body(conn, length: 1_000_000, read_length: 1_000_000) do
      {:ok, data, conn} -> {:ok, IO.iodata_to_binary(Enum.reverse([data | acc])), conn}
      {:more, data, conn} -> read_all(conn, [data | acc])
    end
  end

  defp query(""), do: ""
  defp query(qs), do: "?" <> qs

  defp config(key, default),
    do: Keyword.get(Application.get_env(:sms_api, __MODULE__, []), key, default)
end
