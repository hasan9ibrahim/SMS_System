defmodule Sms.Api.Test.FakeMock do
  @moduledoc """
  A stand-in for the mock server behind the API in tests: answers GET /api/v1/me as the forwarded user, echoes what
  it received, streams a large body, and reports every request to the test process that started it.
  """
  @behaviour Plug
  import Plug.Conn

  @doc "Starts it on a free loopback port; returns the base URL."
  def start(test_pid) do
    {:ok, pid} =
      Bandit.start_link(plug: {__MODULE__, test_pid}, ip: :loopback, port: 0, startup_log: false)

    {:ok, {_ip, port}} = ThousandIsland.listener_info(pid)
    {pid, "http://127.0.0.1:#{port}"}
  end

  @impl true
  def init(test_pid), do: test_pid

  @impl true
  def call(conn, test_pid) do
    {:ok, body, conn} = read_body(conn)

    send(
      test_pid,
      {:mock_request, conn.method, conn.request_path, conn.query_string, conn.req_headers, body}
    )

    answer(conn, conn.request_path)
  end

  defp answer(conn, "/api/v1/me") do
    case get_req_header(conn, "x-sms-user") do
      [id] ->
        json(conn, 200, %{id: String.to_integer(id), username: "fake.user", permissions: ["*"]})

      [] ->
        json(conn, 401, %{title: "Sign in to continue", status: 401})
    end
  end

  defp answer(conn, "/api/v1/broken-me"), do: json(conn, 500, %{title: "boom", status: 500})

  defp answer(conn, "/api/v1/empty"), do: send_resp(conn, 204, "")

  defp answer(conn, "/api/v1/big") do
    conn = conn |> put_resp_content_type("text/csv") |> send_chunked(200)

    Enum.reduce(1..50, conn, fn i, conn ->
      {:ok, conn} = chunk(conn, String.duplicate("row #{i},", 1000) <> "\n")
      conn
    end)
  end

  defp answer(conn, _path), do: json(conn, 200, %{echo: true})

  defp json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> put_resp_header("x-from-mock", "1")
    |> send_resp(status, Jason.encode!(body))
  end
end
