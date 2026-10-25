defmodule Sms.Api.Auth do
  @moduledoc """
  Finds the signed-in staff user of a request from the `sms_session` cookie (`Sms.Api.Sessions`) and assigns it as
  `:session` (`%{user_id, session_id}`), or nil. Calls that need a user answer 401 `sign_in_required` without one.

  The client address (sessions, rate limits, the mock's audit trail) is the connection's, or behind the servers'
  nginx (`trust_proxy: true`, TRUST_PROXY=1) the last address nginx added to X-Forwarded-For.
  """
  @behaviour Plug
  import Plug.Conn
  alias Sms.Api.Sessions

  @type session :: Sessions.session()

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    conn = fetch_cookies(conn)
    assign(conn, :session, Sessions.lookup(conn.req_cookies[Sessions.cookie()]))
  end

  @doc "The client's address as text."
  @spec client_ip(Plug.Conn.t()) :: String.t()
  def client_ip(conn) do
    trust? = Keyword.get(Application.get_env(:sms_api, __MODULE__, []), :trust_proxy, false)

    forwarded =
      conn
      |> get_req_header("x-forwarded-for")
      |> Enum.flat_map(&String.split(&1, ","))
      |> Enum.map(&String.trim/1)
      |> List.last()

    if trust? and forwarded not in [nil, ""],
      do: forwarded,
      else: conn.remote_ip |> :inet.ntoa() |> to_string()
  end

  @doc "The client of a request for a new session: address and user agent."
  @spec client(Plug.Conn.t()) :: Sessions.client()
  def client(conn),
    do: %{ip: client_ip(conn), user_agent: conn |> get_req_header("user-agent") |> List.first("")}
end
