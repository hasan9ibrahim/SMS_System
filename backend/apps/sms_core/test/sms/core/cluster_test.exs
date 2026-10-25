defmodule Sms.Core.ClusterTest do
  # Joining the other servers (SWITCH_PEERS, BACKEND_PLAN §3).
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  require Logger
  alias Sms.Core.Cluster

  test "tries every peer not connected, again on each interval, and logs joins and losses" do
    start_supervised!(
      {Cluster,
       peers: ["peer-a@127.0.0.1", :"peer-b@127.0.0.1", Atom.to_string(node())], interval_ms: 20}
    )

    assert %{peers: [:"peer-a@127.0.0.1", :"peer-b@127.0.0.1"], connected: []} = Cluster.status()
    Process.sleep(50)

    level = Logger.level()
    Logger.configure(level: :info)
    on_exit(fn -> Logger.configure(level: level) end)

    log =
      capture_log(fn ->
        send(Cluster, {:nodeup, :"peer-a@127.0.0.1"})
        send(Cluster, {:nodedown, :"peer-a@127.0.0.1"})
        Cluster.status()
      end)

    assert log =~ "peer-a@127.0.0.1 joined"
    assert log =~ "peer-a@127.0.0.1 lost"
  end
end
