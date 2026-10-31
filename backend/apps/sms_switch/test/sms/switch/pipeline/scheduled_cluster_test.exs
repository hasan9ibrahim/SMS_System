defmodule Sms.Switch.Pipeline.ScheduledClusterTest do
  # S-2.12 (decided 2026-10-31): a scheduled message held by one server is released by the other, through the Redis
  # both share; both releasing at once keep to the customer trunk's TPS and send each message once (S-2.4).
  # INTEGRATION=1: real Redis, a second BEAM node as the second server.
  use ExUnit.Case, async: false
  alias Sms.Core.Bus.Local
  alias Sms.Switch.Customer.TrunkStore
  alias Sms.Switch.Pipeline.{Intake, MessageId, Scheduled, Store}
  alias Sms.Switch.Test.{Cluster, CustomerCase}
  alias Sms.Switch.Throttle

  @moduletag :integration

  setup context do
    previous = Application.get_env(:sms_switch, Store)
    previous_throttle = Application.get_env(:sms_switch, Throttle)
    Application.put_env(:sms_switch, Store, backend: :redis)
    Application.put_env(:sms_switch, Throttle, backend: :redis)

    on_exit(fn ->
      Application.put_env(:sms_switch, Store, previous)
      Application.put_env(:sms_switch, Throttle, previous_throttle)
    end)

    start_supervised!(Sms.Core.Redis)
    start_supervised!(Store)
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Throttle)

    # A customer trunk of this test only (TPS counters and waiting set in the shared Redis), on both servers.
    trunk_id = 900_000 + System.unique_integer([:positive])

    trunks = [
      CustomerCase.trunk(
        id: trunk_id,
        username: "fake#{trunk_id}",
        tps: Map.get(context, :tps, 1_000),
        max_connections: 1
      )
    ]

    start_supervised!({TrunkStore, loader: fn -> {:ok, trunks} end, refresh_ms: 3_600_000})
    CustomerCase.assert_eventually(&TrunkStore.ready?/0)

    {peer, node} = Cluster.start_peer(:"scheduled-#{System.unique_integer([:positive])}")
    on_exit(fn -> :peer.stop(peer) end)
    redis = Application.fetch_env!(:sms_core, Sms.Core.Redis)
    bus = Application.fetch_env!(:sms_core, Sms.Core.Bus)
    :ok = :erpc.call(node, Cluster, :start_store, [redis, bus, trunks])
    :ok = await_peer_trunks(node, 100)
    %{node: node, trunk_id: trunk_id}
  end

  defp await_peer_trunks(node, tries) do
    cond do
      :erpc.call(node, TrunkStore, :ready?, []) ->
        :ok

      tries > 0 ->
        Process.sleep(20)
        await_peer_trunks(node, tries - 1)

      true ->
        :not_ready
    end
  end

  defp scheduled(id, trunk_id, ent, at) do
    %{
      id: id,
      trunk: %{id: trunk_id, enterprise_id: ent},
      scheduled_at: at,
      scheduled: true,
      buffered: false,
      text: "fake scheduled text"
    }
  end

  defp released_on(node) do
    for e <- :erpc.call(node, Local, :published, []), e.type == "msg.accepted", do: e.data["id"]
  end

  defp released_here, do: for(e <- Local.published(), e.type == "msg.accepted", do: e.data["id"])

  test "held on this server, released on the other once its time comes", %{
    node: node,
    trunk_id: trunk_id
  } do
    ent = 900_000 + System.unique_integer([:positive])
    id = MessageId.new()
    now = System.os_time(:millisecond)

    # A shared Redis keeps nothing of this test, also when it fails.
    on_exit(fn -> cleanup(redis_config(), [id], ent, trunk_id) end)

    assert :ok = Scheduled.hold(scheduled(id, trunk_id, ent, now + 200))
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

  @tag tps: 4
  test "both servers releasing a burst at once: the trunk's TPS between them, each message once",
       %{
         node: node,
         trunk_id: trunk_id
       } do
    ent = 900_000 + System.unique_integer([:positive])
    now = System.os_time(:millisecond)
    ids = for _ <- 1..12, do: MessageId.new()
    on_exit(fn -> cleanup(redis_config(), ids, ent, trunk_id) end)

    for {id, i} <- Enum.with_index(ids),
        do: :ok = Scheduled.hold(scheduled(id, trunk_id, ent, now - 60_000 + i))

    for k <- 1..3 do
      Process.sleep(1_000 - rem(System.os_time(:millisecond), 1_000) + 5)
      there = Task.async(fn -> :erpc.call(node, Scheduled, :release_due, []) end)
      :ok = Scheduled.release_due()
      :ok = Task.await(there, 5_000)

      here = released_here()
      other = released_on(node)
      # Never on both servers; together no more than the TPS each second.
      assert MapSet.disjoint?(MapSet.new(here), MapSet.new(other))
      assert length(here) + length(other) == 4 * k
    end

    assert Enum.sort(released_here() ++ released_on(node)) == Enum.sort(ids)
    assert {:ok, waiting} = Store.waiting_trunks()
    refute trunk_id in waiting
  end

  defp redis_config, do: Application.fetch_env!(:sms_core, Sms.Core.Redis)

  defp cleanup(config, ids, ent, trunk_id) do
    {:ok, conn} =
      Redix.start_link(host: config[:host], port: config[:port], password: config[:password])

    Redix.pipeline!(
      conn,
      Enum.flat_map(ids, fn id ->
        [
          ["ZREM", "sch", id],
          ["ZREM", "schl", id],
          ["DEL", "sch:#{id}", "sp:#{ent}:#{id}", "q:#{ent}:#{id}"]
        ]
      end) ++ [["DEL", "schq:#{trunk_id}"], ["SREM", "schq", trunk_id]]
    )

    Redix.stop(conn)
  end
end
