defmodule Sms.Switch.Pipeline.RevenueTest do
  # Accumulated revenue for route rules (§13.9).
  use ExUnit.Case, async: false
  alias Sms.Switch.Pipeline.{Ledger, Revenue, Store}
  alias Sms.Switch.Pipeline.Ledger.Sync
  alias Sms.Switch.Test.LedgerSource

  setup do
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Store)
    :ok
  end

  defp earn(id, keys, micro, bucket \\ Ledger.bucket(System.os_time(:second))),
    do: Ledger.apply_charge(%{"id" => id, "b" => bucket, "rv" => keys, "rm" => micro})

  test "the scope keys of a message; the platform amount of its rate" do
    msg = %{
      trunk: %{id: 3, enterprise_id: 9},
      destination: %{mccmnc: "26201"},
      ingress: %{sender: "Bank"},
      fields: %{}
    }

    assert Revenue.keys(msg, 7) == ["ct:3", "ce:9", "d:26201", "s:Bank", "r:7"]

    assert Revenue.keys(%{msg | ingress: %{}, fields: %{source_addr: "X"}}, nil) |> List.last() ==
             "s:X"

    assert Revenue.platform_micro(%{platform: 0.05}, 3) == 150_000
    assert Revenue.platform_micro(nil, 3) == 0
  end

  test "revenue is counted once per charge and summed over the period's buckets" do
    now = Ledger.bucket(System.os_time(:second))
    earn("a", ["ce:9", "ct:3"], 50_000)
    # The same charge again: once.
    earn("a", ["ce:9", "ct:3"], 50_000)
    earn("b", ["ce:9"], 20_000)

    # Two hours ago: in today (UTC, no billing set up) unless just after midnight, never in the last 60 minutes.
    earn("c", ["ce:9"], 100_000, now - 8)

    assert Revenue.value("ce:9", "15m", 9) == 0.07
    assert Revenue.value("ce:9", "60m", 9) == 0.07
    assert Revenue.value("ct:3", "60m", 9) == 0.05
    assert Revenue.value("ce:9", "month", 9) in [0.07, 0.17]
    assert Revenue.value("d:none", "week", 9) == 0.0
  end

  test "today, week, month and billing cycle start in the customer's time zone and at its last invoice" do
    now = System.os_time(:second)

    LedgerSource.put([[enterprise_id: 9, cutoff: Ledger.bucket(now - 3_600)]])

    start_supervised!({Sync, source: LedgerSource, interval_ms: 3_600_000})
    :ok = Sync.sync()

    account = Ledger.account("c9")

    :ets.insert(
      Ledger.accounts_table(),
      {"c9",
       Map.put(account, :periods, %{
         "today" => now - 7_200,
         "week" => now - 86_400,
         "month" => now - 10 * 86_400,
         "billing_cycle" => now - 1_800
       })}
    )

    assert Revenue.from_bucket("today", 9) == Ledger.bucket(now - 7_200)
    assert Revenue.from_bucket("week", 9) == Ledger.bucket(now - 86_400)
    assert Revenue.from_bucket("billing_cycle", 9) == Ledger.bucket(now - 1_800)
    assert Revenue.from_bucket(nil, 9) == Ledger.bucket(now - 7_200)
    # No billing: UTC calendar periods.
    assert Revenue.from_bucket("today", 77) == Ledger.bucket(div(now, 86_400) * 86_400)
    assert Revenue.from_bucket("week", 77) <= Revenue.from_bucket("today", 77)
    assert Revenue.from_bucket("billing_cycle", 77) == Revenue.from_bucket("month", 77)

    # Read once, then from the cache for 5 s.
    earn("x", ["ct:5"], 10_000)
    assert Revenue.value("ct:5", "60m", 9) == 0.01
    earn("y", ["ct:5"], 10_000)
    assert Revenue.value("ct:5", "60m", 9) == 0.01
  end
end
