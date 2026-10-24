defmodule Sms.Switch.Pipeline.LiveTpsTest do
  # Live TPS for routing (§13.8, §13.23): counts per scope, window averages, hysteresis, vendor capacity, and the
  # cluster total shared through Redis (INTEGRATION=1).
  use ExUnit.Case, async: false
  alias Sms.Core.Redis
  alias Sms.Switch.Pipeline.LiveTps

  setup do
    start_supervised!(LiveTps)
    %{key: "ct:#{System.unique_integer([:positive])}", now: System.os_time(:second)}
  end

  test "the TPS of a scope is its average over the last whole seconds", %{key: key, now: now} do
    assert LiveTps.rate(key, 5) == 0.0
    for s <- (now - 5)..(now - 1), do: LiveTps.count([key], 10, s)
    # This second does not count yet.
    LiveTps.count([key], 1_000)
    assert LiveTps.rate(key, 5) == 10.0
    assert LiveTps.rate(key, 10) == 5.0
    assert LiveTps.rate(key, 1) == 10.0
  end

  test "scope keys of a message and of a condition" do
    input = %{
      customer_trunk: %{id: 3, enterprise_id: 9},
      destination: %{mccmnc: "26201"},
      sender: "Bank"
    }

    assert LiveTps.scope_key("customer_trunk", 1, input) == "ct:3"
    assert LiveTps.scope_key(nil, 1, input) == "ct:3"
    assert LiveTps.scope_key("customer_enterprise", 1, input) == "ce:9"
    assert LiveTps.scope_key("destination", 1, input) == "d:26201"
    assert LiveTps.scope_key("sender_id", 1, input) == "s:Bank"
    assert LiveTps.scope_key("rule", 7, input) == "r:7"

    msg = %{
      trunk: %{id: 3, enterprise_id: 9},
      destination: %{mccmnc: "26201"},
      ingress: %{sender: "Bank"}
    }

    assert LiveTps.message_keys(msg) == ["ct:3", "ce:9", "d:26201", "s:Bank"]
  end

  test "a vendor's TPS as a % of its limit", %{now: now} do
    id = System.unique_integer([:positive])
    LiveTps.count(["vt:#{id}"], 45, now - 1)
    assert LiveTps.vendor_pct(id, 50) == 90.0
    assert LiveTps.vendor_pct(id, nil) == 0.0
    assert LiveTps.vendor_pct(id, 0) == 0.0
  end

  describe "hysteresis" do
    test "without hold or release the condition follows the TPS", %{key: key, now: now} do
      t = %{op: ">", value: 50, window_s: 1}
      assert {false, +0.0} = LiveTps.check(1, key, t)
      LiveTps.count([key], 60, now - 1)
      assert {true, 60.0} = LiveTps.check(1, key, t)
    end

    test "a change must last hold_s before the rule switches", %{key: key, now: now} do
      t = %{op: ">", value: 50, window_s: 1, hold_s: 10}
      ms = now * 1_000
      assert {false, _} = LiveTps.check(2, key, t, ms)
      LiveTps.count([key], 60, now - 1)
      assert {false, _} = LiveTps.check(2, key, t, ms + 1_000)
      assert {false, _} = LiveTps.check(2, key, t, ms + 9_000)
      assert {true, _} = LiveTps.check(2, key, t, ms + 11_500)
    end

    test "a condition that is on stays on until the TPS is back past the value by release_pct", %{
      key: key,
      now: now
    } do
      over = %{op: ">", value: 50, window_s: 1, release_pct: 10}
      LiveTps.count([key], 60, now - 1)
      assert {true, _} = LiveTps.check(3, key, over)

      # 48 is under 50 but not 10 % under: still on.
      key2 = key <> "b"
      LiveTps.count([key2], 60, now - 1)
      assert {true, _} = LiveTps.check(4, key2, over)
      :ets.insert(:sms_live_tps_local, {{key2, now - 1}, 48})
      assert {true, _} = LiveTps.check(4, key2, over)
      :ets.insert(:sms_live_tps_local, {{key2, now - 1}, 40})
      assert {false, _} = LiveTps.check(4, key2, over)

      under = %{op: "<", value: 10, window_s: 1, release_pct: 50}
      key3 = key <> "c"
      LiveTps.count([key3], 5, now - 1)
      assert {true, _} = LiveTps.check(5, key3, under)
      :ets.insert(:sms_live_tps_local, {{key3, now - 1}, 12})
      assert {true, _} = LiveTps.check(5, key3, under)
      :ets.insert(:sms_live_tps_local, {{key3, now - 1}, 16})
      assert {false, _} = LiveTps.check(5, key3, under)

      # "=" has no release: it follows the TPS.
      eq = %{op: "=", value: 5, window_s: 1, release_pct: 50, tolerance_pct: 5}
      assert {true, _} = LiveTps.check(6, key3 <> "x", %{eq | value: 0})
    end
  end

  test "old seconds are swept", %{key: key, now: now} do
    LiveTps.count([key], 5, now - 200)
    send(LiveTps, :tick)
    _ = :sys.get_state(LiveTps)
    assert :ets.lookup(:sms_live_tps_local, {key, now - 200}) == []
  end

  describe "redis backend" do
    @describetag :integration

    setup do
      previous = Application.get_env(:sms_switch, Sms.Switch.Pipeline.Store)
      Application.put_env(:sms_switch, Sms.Switch.Pipeline.Store, backend: :redis)
      on_exit(fn -> Application.put_env(:sms_switch, Sms.Switch.Pipeline.Store, previous) end)
      start_supervised!(Redis)
      :ok
    end

    test "each server adds its counts and reads the cluster's total of the second before", %{
      key: key,
      now: now
    } do
      # Another server's count of two seconds ago, already in Redis.
      {:ok, _} = Redis.command(["HINCRBY", "lt:#{now - 2}", key, 30])
      LiveTps.count([key], 20, now - 1)
      send(LiveTps, :tick)
      _ = :sys.get_state(LiveTps)

      # Ticks may straddle a second; the total of `now - 2` is read on the tick made in second `now`.
      if System.os_time(:second) == now do
        assert LiveTps.rate(key, 1) == 30.0
        assert {:ok, "20"} = Redis.command(["HGET", "lt:#{now - 1}", key])
      end
    end
  end
end
