defmodule Sms.Core.RedisTest do
  # Where the connections go: one host, or the primary the sentinels name (backend step 8).
  use ExUnit.Case, async: true
  alias Sms.Core.Redis

  test "without sentinels: the host and port" do
    assert Redis.target(host: "h", port: 6380, sentinels: []) == [host: "h", port: 6380]
    assert Redis.target(host: "h", port: 6380) == [host: "h", port: 6380]
  end

  test "with sentinels: the group's primary, with the sentinels' password when set" do
    sentinels = [[host: "a", port: 26_379], [host: "b", port: 26_379]]

    assert Redis.target(host: "h", port: 1, sentinels: sentinels) ==
             [sentinel: [sentinels: sentinels, group: "sms"]]

    assert Redis.target(sentinels: sentinels, sentinel_group: "g", sentinel_password: "pw") ==
             [sentinel: [sentinels: sentinels, group: "g", password: "pw"]]
  end
end

defmodule Sms.Core.RedisStaleTest do
  # A connection that only times out (its server's packets dropped) is restarted to ask the sentinels again.
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  alias Sms.Core.Redis

  setup do
    # A "Redis" that accepts and answers the handshake-free PING... never: every command times out.
    {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(listen)
    acceptor = spawn_link(fn -> accept(listen) end)
    before = Application.get_env(:sms_core, Redis)

    Application.put_env(:sms_core, Redis,
      host: "127.0.0.1",
      port: port,
      pool_size: 1,
      sentinels: []
    )

    on_exit(fn ->
      Application.put_env(:sms_core, Redis, before)
      Process.exit(acceptor, :kill)
    end)

    start_supervised!(Redis)
    :ok
  end

  defp accept(listen) do
    {:ok, socket} = :gen_tcp.accept(listen)
    spawn(fn -> hold(socket) end)
    accept(listen)
  end

  defp hold(socket) do
    receive do
    after
      60_000 -> :gen_tcp.close(socket)
    end
  end

  test "ten timeouts in a row restart the connection" do
    pid = Process.whereis(:"Elixir.Sms.Core.Redis.1")
    Process.sleep(50)

    log =
      capture_log(fn ->
        for _ <- 1..10, do: assert({:error, _} = Redis.command(["PING"], 20))
        Process.sleep(50)
      end)

    assert log =~ "timed out 10 times in a row: reconnecting"
    new = Process.whereis(:"Elixir.Sms.Core.Redis.1")
    assert is_pid(new) and new != pid
  end
end
