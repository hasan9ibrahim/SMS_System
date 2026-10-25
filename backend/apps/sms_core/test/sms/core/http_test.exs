defmodule Sms.Core.HttpTest do
  # The health and metrics endpoint for monitoring (backend step 8).
  use ExUnit.Case, async: false
  alias Sms.Core.{Http, Metrics}

  defmodule Provider do
    @moduledoc false
    @behaviour Sms.Core.Metrics
    @impl true
    def metrics,
      do: [
        {"test_things", :gauge, "Things", [{%{kind: "a\"b"}, 2}, {%{}, 1.5}]},
        {"test_flag", :gauge, "A flag", [{%{}, true}, {%{other: 1}, false}]}
      ]
  end

  defmodule Broken do
    @moduledoc false
    def metrics, do: raise("boom")
  end

  defmodule Exits do
    @moduledoc false
    def metrics, do: exit(:gone)
  end

  setup do
    start_supervised!({Http, port: 0, providers: [Provider, Broken, Exits]})
    %{port: Http.port()}
  end

  defp get(port, request) do
    {:ok, s} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false])
    :ok = :gen_tcp.send(s, request)
    {:ok, response} = recv_all(s, "")
    response
  end

  defp recv_all(s, acc) do
    case :gen_tcp.recv(s, 0, 5_000) do
      {:ok, data} -> recv_all(s, acc <> data)
      {:error, :closed} -> {:ok, acc}
    end
  end

  test "health is ok when the configured services answer (none in unit tests)", %{port: port} do
    response = get(port, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n")
    assert response =~ "HTTP/1.1 200 OK"
    assert response =~ "\r\n\r\nok\n"
  end

  @tag capture_log: true
  test "metrics: the node's own, then each provider's; a failing provider is skipped", %{
    port: port
  } do
    response = get(port, "GET /metrics?x=1 HTTP/1.1\r\n\r\n")
    assert response =~ "HTTP/1.1 200 OK"
    assert response =~ "content-type: text/plain; version=0.0.4"
    assert response =~ "# TYPE sms_up gauge\nsms_up 1\n"
    assert response =~ ~s(sms_vm_memory_bytes{kind="total"} )
    assert response =~ "sms_cluster_peers_connected 0\n"
    assert response =~ ~s(test_things{kind="a\\"b"} 2\n)
    assert response =~ "test_things 1.5\n"
    assert response =~ "test_flag 1\n"
    assert response =~ ~s(test_flag{other="1"} 0\n)
  end

  test "anything else is 404, and a request that is not HTTP is 400", %{port: port} do
    assert get(port, "GET /nope HTTP/1.1\r\n\r\n") =~ "HTTP/1.1 404 Not Found"
    assert get(port, "POST /health HTTP/1.1\r\n\r\n") =~ "HTTP/1.1 404 Not Found"
    assert get(port, "hello\r\n\r\n") =~ "HTTP/1.1 400 Bad Request"
  end

  test "a store that does not answer makes /health 503, naming it", %{port: port} do
    Application.put_env(:sms_core, :services, [:redis])
    on_exit(fn -> Application.put_env(:sms_core, :services, []) end)
    response = get(port, "GET /health HTTP/1.1\r\n\r\n")
    assert response =~ "HTTP/1.1 503 Service Unavailable"
    assert response =~ "degraded\nredis: {:error"
    assert {"sms_up", :gauge, _, [{%{}, 0}]} = hd(Metrics.core())
  end
end
