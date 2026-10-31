defmodule Sms.Switch.Pipeline.ScheduledClusterTest do
  # S-2.12 (decided 2026-10-31): a scheduled message held by one server is released by the other, through the Redis
  # both share (INTEGRATION=1: real Redis, a second BEAM node as the second server).
  use ExUnit.Case, async: false
  alias Sms.Core.Bus.Local
  alias Sms.Switch.Pipeline.{Intake, MessageId, Scheduled, Store}
  alias Sms.Switch.Test.Cluster

  @moduletag :integration

  setup do
    previous = Application.get_env(:sms_switch, Store)
    Application.put_env(:sms_switch, Store, backend: :redis)
    on_exit(fn -> Application.put_env(:sms_switch, Store, previous) end)
    start_supervised!(Sms.Core.Redis)
    start_supervised!(Store)
    start_supervised!(Sms.Core.Bus)

    {peer, node} = Cluster.start_peer(:"scheduled-#{System.unique_integer([:positive])}")
    on_exit(fn -> :peer.stop(peer) end)
    redis = Application.fetch_env!(:sms_core, Sms.Core.Redis)
    bus = Application.fetch_env!(:sms_core, Sms.Core.Bus)
    :ok = :erpc.call(node, Cluster, :start_store, [redis, bus])
    %{node: node}
  end

  test "held on this server, released on the other once its time comes", %{node: node} do
    ent = 900_000 + System.unique_integer([:positive])
    id = MessageId.new()
    now = System.os_time(:millisecond)

    # A shared Redis keeps nothing of this test, also when it fails.
    on_exit(fn -> cleanup(redis_config(), id, ent) end)

    msg = %{
      id: id,
      trunk: %{id: 1, enterprise_id: ent},
      scheduled_at: now + 200,
      scheduled: true,
      buffered: false,
      text: "fake scheduled text"
    }

    assert :ok = Scheduled.hold(msg)
    assert {:ok, true} = Scheduled.held?(ent, id)

    # The other server's sweep, after its time.
    assert :ok = :erpc.call(node, Scheduled, :release_due, [now + 1_000])

    published = :erpc.call(node, Local, :published, [])
    assert [event] = for(e <- published, e.type == "msg.accepted", do: e)
    assert event.data["id"] == id
    released = Intake.decode(event.data)
    assert %{release: true, credit_held: false, text: "fake scheduled text"} = released

    # Gone from the shared store, queued for cancel_sm and query_sm as any accepted message; this server has nothing
    # left to release.
    assert :none = Store.scheduled(id)
    assert {:ok, false} = Scheduled.held?(ent, id)
    assert {:ok, :queued} = Store.queued(ent, id)
    assert :ok = Scheduled.release_due(now + 1_000)
    assert [] = for(e <- Local.published(), e.type == "msg.accepted", do: e)
  end

  defp redis_config, do: Application.fetch_env!(:sms_core, Sms.Core.Redis)

  defp cleanup(config, id, ent) do
    {:ok, conn} =
      Redix.start_link(host: config[:host], port: config[:port], password: config[:password])

    Redix.pipeline!(conn, [
      ["ZREM", "sch", id],
      ["ZREM", "schl", id],
      ["DEL", "sch:#{id}", "sp:#{ent}:#{id}", "q:#{ent}:#{id}"]
    ])

    Redix.stop(conn)
  end
end
