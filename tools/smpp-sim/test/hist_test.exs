defmodule SmppSim.HistTest do
  use ExUnit.Case, async: true
  alias SmppSim.Hist

  test "buckets are exact below 64 µs and within about 3 % above" do
    for us <- [0, 1, 63, 64, 100, 1_000, 33_333, 1_000_000, 50_000_000] do
      b = Hist.bucket(us)
      assert Hist.lower(b) <= us
      if us >= 64, do: assert(us - Hist.lower(b) <= us * 0.04)
    end
  end

  test "percentiles, mean and max of a snapshot, and the difference of two" do
    h = Hist.new()
    for us <- 1..1_000, do: Hist.record(h, us * 10)
    first = Hist.snapshot(h)
    s = Hist.summary(first)
    assert s.count == 1_000
    assert_in_delta s.percentiles[50], 5_000, 250
    assert_in_delta s.percentiles[99], 9_900, 400
    assert s.max == 10_000
    assert_in_delta s.mean, 5_005, 250

    Hist.record(h, -5)
    for _ <- 1..10, do: Hist.record(h, 2_000_000)
    d = Hist.summary(Hist.diff(Hist.snapshot(h), first))
    assert d.count == 11
    assert d.percentiles[50] > 1_000_000
    assert Hist.summary(Hist.diff(first, nil)).count == 1_000

    assert Hist.summary(Hist.snapshot(Hist.new())) == %{
             count: 0,
             mean: 0.0,
             max: 0,
             percentiles: %{50 => 0, 90 => 0, 95 => 0, 99 => 0, 99.9 => 0}
           }
  end
end
