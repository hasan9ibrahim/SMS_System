defmodule Sms.Switch.FenceTest do
  # Which server steps back when the servers lose each other (backend step 8).
  use ExUnit.Case, async: false
  alias Sms.Switch.Fence

  @b :"sms@server-b"
  @w :sms@witness
  @cluster [peers: ["sms@server-b", "sms@witness"], witness: "sms@witness"]

  defp check(connected, witness_sees, primary),
    do:
      Fence.check(
        cluster: @cluster,
        connected: connected,
        witness_view: fn @w -> witness_sees end,
        primary: fn -> primary end
      )

  test "all three reached: nobody steps back" do
    refute check([@b, @w], [node(), @b], false)
    refute check([@b, @w], [node(), @b], true)
  end

  test "link to the other server cut, the witness still sees it: the PostgreSQL primary keeps the traffic" do
    assert check([@w], [node(), @b], false)
    refute check([@w], [node(), @b], true)
  end

  test "the other server really down (the witness lost it too): this one takes over, primary or not" do
    refute check([@w], [node()], false)
  end

  test "neither the other server nor the witness: minority, steps back" do
    assert check([], [], true)
  end

  test "the witness gone, the other server there: a majority, nobody steps back" do
    refute check([@b], [], false)
  end

  test "decide/1 on its own" do
    assert Fence.decide(%{
             majority: false,
             lost_peer: false,
             witness_sees_peer: false,
             primary: true
           })

    refute Fence.decide(%{
             majority: true,
             lost_peer: true,
             witness_sees_peer: false,
             primary: false
           })
  end

  @tag capture_log: true
  test "a change applies after two checks in a row, runs the hook, and is lifted the same way" do
    dir = Path.join(System.tmp_dir!(), "fence_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    hook = Path.join(dir, "hook.sh")
    log = Path.join(dir, "log")
    File.write!(hook, "#!/bin/sh\necho \"$1\" >> #{log}\n")
    File.chmod!(hook, 0o755)

    fenced = :atomics.new(1, [])

    start_supervised!(
      {Fence,
       interval_ms: 30,
       hook: hook,
       cluster: @cluster,
       connected: [@w],
       witness_view: fn @w -> [node(), @b] end,
       primary: fn -> :atomics.get(fenced, 1) == 0 end}
    )

    refute Fence.fenced?()
    :atomics.put(fenced, 1, 1)
    assert eventually(fn -> Fence.fenced?() end)
    assert eventually(fn -> File.read(log) == {:ok, "fenced\n"} end)

    :atomics.put(fenced, 1, 0)
    assert eventually(fn -> not Fence.fenced?() end)
    assert eventually(fn -> File.read(log) == {:ok, "fenced\nresumed\n"} end)
  end

  test "the witness's own view, asked over the cluster: unreachable counts as seeing nobody" do
    # A witness listed as connected but not really there: the remote call fails, so it sees no server.
    refute Fence.check(
             cluster: [peers: [:"sms@server-b", :sms@witness], witness: :sms@witness],
             connected: [@w],
             primary: fn -> false end
           )
  end

  test "the PostgreSQL primary from Patroni's URL: 200 only on the primary, no URL counts as primary" do
    {:ok, ok} = patroni(200)
    {:ok, standby} = patroni(503)
    {:ok, closed} = :gen_tcp.listen(0, [])
    {:ok, closed_port} = :inet.port(closed)
    :ok = :gen_tcp.close(closed)

    lost = [cluster: @cluster, connected: [@w], witness_view: fn @w -> [node(), @b] end]

    refute Fence.check([{:primary_url, "http://127.0.0.1:#{ok}/primary"} | lost])
    assert Fence.check([{:primary_url, "http://127.0.0.1:#{standby}/primary"} | lost])
    assert Fence.check([{:primary_url, "http://127.0.0.1:#{closed_port}/primary"} | lost])
    refute Fence.check([{:primary_url, ""} | lost])
    refute Fence.check(lost)
  end

  @tag capture_log: true
  test "a hook that fails is logged, the step back still applies" do
    dir = Path.join(System.tmp_dir!(), "fence_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    hook = Path.join(dir, "hook.sh")
    File.write!(hook, "#!/bin/sh\necho broken\nexit 3\n")
    # Stays stepped back when the fence stops: later tests need the normal state.
    on_exit(fn -> :persistent_term.put({Fence, :fenced}, false) end)
    File.chmod!(hook, 0o755)

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        start_supervised!(
          {Fence,
           interval_ms: 30,
           hook: hook,
           cluster: @cluster,
           connected: [],
           witness_view: fn @w -> [] end,
           primary: fn -> true end}
        )

        assert eventually(fn -> Fence.fenced?() end)
        Process.sleep(200)
      end)

    assert log =~ "fence hook fenced exited 3: broken"
  end

  # A one-request-at-a-time HTTP server answering every request with `status` (Patroni's /primary).
  defp patroni(status) do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(listen)
    test = self()

    pid =
      spawn(fn ->
        send(test, :listening)
        serve(listen, status)
      end)

    :ok = :gen_tcp.controlling_process(listen, pid)
    assert_receive :listening
    on_exit(fn -> Process.exit(pid, :kill) end)
    {:ok, port}
  end

  defp serve(listen, status) do
    {:ok, socket} = :gen_tcp.accept(listen)
    {:ok, _request} = :gen_tcp.recv(socket, 0, 1_000)

    :ok =
      :gen_tcp.send(
        socket,
        "HTTP/1.1 #{status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
      )

    :gen_tcp.close(socket)
    serve(listen, status)
  end

  defp eventually(fun, tries \\ 100) do
    cond do
      fun.() -> true
      tries == 0 -> false
      true -> Process.sleep(20) && eventually(fun, tries - 1)
    end
  end
end
