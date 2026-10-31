defmodule Sms.Switch.Pipeline.ScheduledRedisTest do
  # S-2.12, S-2.4, S-5.10: on real Redis, a single step Redis refuses (a key of the wrong type stands in for it) is
  # logged and the release or the timeout sweep carries on; nothing is lost or sent. INTEGRATION=1: real Redis.
  use ExUnit.Case, async: false
  @moduletag :integration
  @moduletag capture_log: true

  alias Sms.Core.Bus.Local
  alias Sms.Switch.Customer.TrunkStore
  alias Sms.Switch.Pipeline.{MessageId, Scheduled, Store, Timeouts}
  alias Sms.Switch.Test.CustomerCase
  alias Sms.Switch.Throttle

  setup do
    previous = Application.get_env(:sms_switch, Store)
    Application.put_env(:sms_switch, Store, backend: :redis)
    on_exit(fn -> Application.put_env(:sms_switch, Store, previous) end)

    start_supervised!(Sms.Core.Redis)
    start_supervised!(Store)
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Throttle)
    CustomerCase.assert_eventually(fn -> Store.command(["PING"]) == {:ok, "PONG"} end)

    # Ids of this test only, so the shared Redis keeps nothing of it.
    trunk = unique()

    trunks = [
      CustomerCase.trunk(id: trunk, username: "fake#{trunk}", tps: 1, max_connections: 1)
    ]

    start_supervised!({TrunkStore, loader: fn -> {:ok, trunks} end, refresh_ms: 3_600_000})
    CustomerCase.assert_eventually(&TrunkStore.ready?/0)
    %{trunk: trunk, ent: unique()}
  end

  defp unique, do: 900_000 + System.unique_integer([:positive])

  defp hold(trunk, ent) do
    id = MessageId.new()

    :ok =
      Scheduled.hold(%{
        id: id,
        trunk: %{id: trunk, enterprise_id: ent},
        scheduled_at: System.os_time(:millisecond) - 60_000,
        scheduled: true,
        buffered: false
      })

    id
  end

  defp released, do: for(e <- Local.published(), e.type == "msg.accepted", do: e.data["id"])

  # A key of the wrong type: Redis refuses the step that reads or writes it.
  defp break(key) do
    {:ok, _} = Store.command(["DEL", key])
    {:ok, _} = Store.command(["SET", key, "not what it should be"])
  end

  defp cleanup(keys, members) do
    config = Application.fetch_env!(:sms_core, Sms.Core.Redis)

    on_exit(fn ->
      {:ok, conn} =
        Redix.start_link(host: config[:host], port: config[:port], password: config[:password])

      Redix.pipeline!(conn, [["DEL" | keys] | members])
      Redix.stop(conn)
    end)
  end

  test "a trunk's waiting set or a message Redis cannot read: logged, kept for a later sweep, the rest goes on",
       %{
         trunk: trunk,
         ent: ent
       } do
    broken_trunk = unique()
    [unreadable, readable] = [hold(trunk, ent), hold(trunk, ent)]

    cleanup(
      ["schq:#{broken_trunk}"] ++
        Enum.flat_map([unreadable, readable], &["sch:#{&1}", "sp:#{ent}:#{&1}", "q:#{ent}:#{&1}"]),
      [
        ["SREM", "schq", broken_trunk],
        ["ZREM", "sch", unreadable, readable],
        ["ZREM", "schl", unreadable, readable]
      ]
    )

    {:ok, _} = Store.command(["SADD", "schq", broken_trunk])
    break("schq:#{broken_trunk}")
    break("sch:#{unreadable}")

    :ok = Scheduled.release_due()

    sent = released()
    assert readable in sent
    refute unreadable in sent
    # Leased, so tried again once its lease runs out; the broken trunk stays listed.
    assert {:ok, leased} =
             Store.due_scheduled(:leased, System.os_time(:millisecond) + 61_000, 10_000)

    assert unreadable in leased
    assert {:ok, trunks} = Store.waiting_trunks()
    assert broken_trunk in trunks
  end

  test "cancel_sm of a waiting message whose set Redis cannot change answers the error", %{
    trunk: trunk,
    ent: ent
  } do
    id = hold(trunk, ent)
    now = System.os_time(:millisecond)

    cleanup(["schq:#{trunk}", "sch:#{id}", "sp:#{ent}:#{id}"], [
      ["SREM", "schq", trunk],
      ["ZREM", "sch", id],
      ["ZREM", "schl", id]
    ])

    assert Store.claim_scheduled(:waiting, id, now, now + 60_000)
    assert Store.defer_scheduled(id, trunk, now - 60_000, now + 60_000, ent, [id], 600)
    break("schq:#{trunk}")

    assert {:error, _} = Scheduled.cancel(ent, id)
    assert {:ok, true} = Scheduled.held?(ent, id)
  end

  test "a DLR timeout whose message Redis cannot read is tried again later (S-5.10)" do
    id = "t#{unique()}"
    now = System.os_time(:millisecond)
    cleanup(["m:#{id}"], [["ZREM", "t", id]])

    :ok = Store.schedule_timeout(id, now - 1_000)
    break("m:#{id}")

    assert :ok = Timeouts.sweep()
    assert {:ok, score} = Store.command(["ZSCORE", "t", id])
    assert String.to_integer(score) >= now + 25_000
  end
end
