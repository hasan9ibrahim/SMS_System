defmodule Sms.Switch.Pipeline.WarmupTest do
  # Warm-up counts for route rule vendors (§13.27, team trial round 6).
  use ExUnit.Case, async: false
  alias Sms.Switch.Pipeline.{Store, Warmup}

  setup do
    start_supervised!(Store)
    :ok
  end

  @v %{vendor_trunk_id: 11, warmup_count: 3, warmup_reset: "day", warmup_per: "customer_trunk"}
  # 2026-10-27 (a Tuesday) 10:30 UTC
  @now 1_793_097_000_000

  test "counted per customer trunk or for the whole rule, apart for each vendor" do
    :ok = Warmup.count(7, @v, 1, @now, 2)
    assert Warmup.sent(7, @v, 1, @now) == 2
    assert Warmup.sent(7, @v, 2, @now) == 0
    assert Warmup.sent(7, %{@v | vendor_trunk_id: 12}, 1, @now) == 0

    rule_wide = %{@v | warmup_per: "rule"}
    :ok = Warmup.count(7, rule_wide, 1, @now, 1)
    :ok = Warmup.count(7, rule_wide, 2, @now, 1)
    assert Warmup.sent(7, rule_wide, 3, @now) == 2
  end

  test "a new period or Reset starts again; editing the threshold does not" do
    :ok = Warmup.count(8, @v, 1, @now, 3)
    assert Warmup.sent(8, %{@v | warmup_count: 900}, 1, @now) == 3
    assert Warmup.sent(8, @v, 1, @now + 86_400_000) == 0
    assert Warmup.sent(8, Map.put(@v, :warmup_reset_at, div(@now, 1000)), 1, @now) == 0
  end

  test "period starts in UTC" do
    now = div(@now, 1000)
    day = div(now, 86_400) * 86_400
    assert Warmup.period_start(@v, now) == day
    assert Warmup.period_start(%{@v | warmup_reset: "hour"}, now) == day + 10 * 3_600
    assert Warmup.period_start(%{@v | warmup_reset: "week"}, now) == day - 86_400
    custom = %{@v | warmup_reset: "custom"} |> Map.put(:warmup_reset_hours, 6)
    assert Warmup.period_start(custom, now) == day + 6 * 3_600
  end
end
