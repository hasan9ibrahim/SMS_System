defmodule Sms.Api.ForwardTest do
  # Calls not ported yet go to the mock (backend step 9): the health check without a session, streamed answers,
  # empty answers, the client address from nginx, and a mock that does not answer.
  use ExUnit.Case, async: false
  import Phoenix.ConnTest
  import Plug.Conn
  alias Sms.Api.{Auth, Forward}
  alias Sms.Api.Test.FakeMock

  @endpoint Sms.Api.Endpoint

  setup do
    {mock, url} = FakeMock.start(self())
    previous = Application.get_env(:sms_api, Forward)
    Application.put_env(:sms_api, Forward, url: url, secret: "test-secret", timeout_ms: 5_000)

    on_exit(fn ->
      Application.put_env(:sms_api, Forward, previous)
      Process.exit(mock, :normal)
    end)

    :ok
  end

  # A request that already carries a session (the Auth plug would find it in the database).
  defp signed(path, method \\ :get, body \\ "") do
    session = %{user_id: 7, session_id: 70}

    Phoenix.ConnTest.build_conn(method, path, body)
    |> put_req_header("content-type", "application/json")
    |> assign(:session, session)
    |> Forward.call([])
  end

  test "the health check is forwarded without a session; nothing else is" do
    assert build_conn() |> get("/api/v1/health") |> json_response(200) == %{"echo" => true}
    assert_received {:mock_request, "GET", "/api/v1/health", _, headers, _}
    refute Enum.any?(headers, fn {k, _} -> k == "x-sms-user" end)

    assert %{"code" => "sign_in_required"} =
             build_conn() |> post("/api/v1/enterprises/query") |> json_response(401)
  end

  test "bodies go through; large answers are streamed; empty answers stay empty" do
    conn = signed("/api/v1/enterprises/query", :post, ~s({"limit": 5}))
    assert conn.status == 200

    assert_received {:mock_request, "POST", "/api/v1/enterprises/query", "", headers,
                     ~s({"limit": 5})}

    assert {"x-sms-user", "7"} in headers
    assert {"x-sms-session", "70"} in headers

    big = signed("/api/v1/big")
    assert big.state == :chunked
    assert big.status == 200

    empty = signed("/api/v1/empty")
    assert empty.status == 204
    assert empty.resp_body == ""
  end

  test "a mock that does not answer: 503 problem" do
    Application.put_env(:sms_api, Forward,
      url: "http://127.0.0.1:1",
      secret: "x",
      timeout_ms: 1_000
    )

    conn = signed("/api/v1/enterprises")
    assert conn.status == 503
    assert ["application/problem+json" <> _] = get_resp_header(conn, "content-type")
  end

  test "get_json reports a failed answer" do
    assert {:error, {:status, 500}} =
             Forward.get_json("/api/v1/broken-me", %{user_id: 1, session_id: 1})

    assert {:ok, %{"id" => 1}} = Forward.get_json("/api/v1/me", %{user_id: 1, session_id: 1})
  end

  test "the client address: the connection's, or behind nginx the last X-Forwarded-For entry" do
    conn = build_conn() |> put_req_header("x-forwarded-for", "198.51.100.1, 192.0.2.44")
    assert Auth.client_ip(conn) == "127.0.0.1"

    previous = Application.get_env(:sms_api, Auth)
    Application.put_env(:sms_api, Auth, trust_proxy: true)
    on_exit(fn -> Application.put_env(:sms_api, Auth, previous) end)
    assert Auth.client_ip(conn) == "192.0.2.44"
    assert Auth.client_ip(build_conn()) == "127.0.0.1"
  end

  test "an unreadable JSON body is answered as a problem" do
    conn =
      build_conn()
      |> put_req_header("content-type", "application/json")

    assert_error_sent 400, fn -> post(conn, "/api/v1/session", "{not json") end
  end
end
