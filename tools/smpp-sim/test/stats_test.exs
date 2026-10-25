defmodule SmppSim.StatsTest do
  use ExUnit.Case, async: false
  alias SmppSim.Stats

  setup do
    Stats.reset()
    :ok
  end

  test "counters, statuses and latencies, measured as the difference of two snapshots" do
    s0 = Stats.snapshot()
    Stats.incr(:submitted, 3)
    Stats.status(0)
    Stats.status(0x58)
    Stats.record(:resp, 2_000)
    d = Stats.diff(Stats.snapshot(), s0)
    assert d.counters.submitted == 3
    assert d.statuses == %{0 => 1, 0x58 => 1}
    assert d.latency.resp.count == 1
    assert Stats.diff(Stats.snapshot(), nil).counters.submitted == 3
  end

  test "each receipt is matched once to an accepted message; unknown and duplicate receipts are told apart" do
    Stats.accepted("m1", 100)
    Stats.accepted("m2", 200)
    assert Stats.awaiting_receipts() == 2
    assert {:ok, 100} = Stats.receipt("m1")
    assert :dup = Stats.receipt("m1")
    assert :unknown = Stats.receipt("nope")
    assert Stats.awaiting_receipts() == 1
    # Done messages sent before the cut-off are forgotten; waiting ones are kept.
    assert Stats.forget_done(1_000) == 1
    assert Stats.awaiting_receipts() == 1
  end
end
