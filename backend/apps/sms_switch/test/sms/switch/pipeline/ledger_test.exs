defmodule Sms.Switch.Pipeline.LedgerTest do
  # Live balances and the credit check (§7, Q24, product owner 2026-10-24).
  use ExUnit.Case, async: false
  alias Sms.Switch.Pipeline.{Ledger, Store}
  alias Sms.Switch.Pipeline.Ledger.Sync
  alias Sms.Switch.Test.LedgerSource

  @eur %{rate: Decimal.new("0.05"), currency: "EUR"}

  setup do
    start_supervised!(Sms.Core.Bus)
    start_supervised!(Store)
    :ok
  end

  defp start(accounts, charges \\ %{}, opts \\ []) do
    LedgerSource.put(accounts, charges, opts)
    start_supervised!({Sync, source: LedgerSource, interval_ms: 3_600_000})
    start_supervised!(Ledger.Charges)
    assert Sync.sync() == if(opts[:fail], do: {:error, :down}, else: :ok)
  end

  defp msg(ent, parts \\ 1, sell \\ @eur),
    do: %{trunk: %{enterprise_id: ent}, sell: sell, parts: parts}

  describe "credit check" do
    test "a prepaid customer sends while its balance covers the message, then is refused (0x45)" do
      start([[enterprise_id: 11, prepaid: true, base: "0.1", limit: "1000"]])
      assert :ok = Ledger.check(msg(11, 2))
      assert {:error, :esme_rsubmitfail} = Ledger.check(msg(11, 3))

      assert :ok = Ledger.charge(:customer, 11, "m1", @eur, 2)
      assert Ledger.balance("c11") == 0
      assert {:error, :esme_rsubmitfail} = Ledger.check(msg(11, 1))
    end

    test "a postpaid customer uses its credit limit on top of its balance, and stops at the limit" do
      start([[enterprise_id: 12, base: "0.05", limit: "0.1"]])
      assert :ok = Ledger.check(msg(12, 3))
      Ledger.charge(:customer, 12, "m1", @eur, 2)
      # Balance -0.05: 0.05 of the 0.10 limit left.
      assert Ledger.balance("c12") == -50_000
      assert :ok = Ledger.check(msg(12, 1))
      assert {:error, :esme_rsubmitfail} = Ledger.check(msg(12, 2))
    end

    test "no billing set up, or no rate: not checked; another currency is converted" do
      start([[enterprise_id: 13, currency: "USD", base: "0"]])
      assert :ok = Ledger.check(msg(99, 1000))
      assert :ok = Ledger.check(%{trunk: %{enterprise_id: 13}, sell: nil, parts: 1})
      assert {:error, :esme_rsubmitfail} = Ledger.check(msg(13))
      # Without exchange rates loaded the amount is taken as it is.
      assert Ledger.micro(@eur, 2, "USD") == 100_000
      assert Ledger.balance("v1") == nil
    end
  end

  describe "charges" do
    test "each charge counts once, in its 15-minute bucket, and is written to PostgreSQL" do
      start([[enterprise_id: 14]])
      assert :ok = Ledger.charge(:customer, 14, "m1", @eur, 1)
      # The same message again (a redelivery): not counted twice.
      assert :ok = Ledger.charge(:customer, 14, "m1", @eur, 1)

      assert :ok =
               Ledger.apply_charge(%{
                 "k" => "c14",
                 "id" => "m1:customer",
                 "b" => 1,
                 "m" => 50_000,
                 "n" => 1
               })

      assert Ledger.balance("c14") == -50_000

      # Accounts without billing, or no rate: nothing.
      assert :ok = Ledger.charge(:vendor, 14, "e1", @eur, 1)
      assert :ok = Ledger.charge(:vendor, nil, "e1", @eur, 1)
      assert :ok = Ledger.charge(:customer, 14, "m2", nil, 1)

      assert :ok = Sync.sync()
      bucket = Ledger.bucket(System.os_time(:second))
      assert [{%{key: "c14"}, ^bucket, 50_000, 1}] = LedgerSource.persisted()
      # Nothing changed since: nothing written again.
      assert :ok = Sync.sync()
      assert length(LedgerSource.persisted()) == 1
    end

    test "an invoice moving the cut-off leaves only the traffic after it" do
      start([[enterprise_id: 15, cutoff: 0]])
      now = Ledger.bucket(System.os_time(:second))

      Ledger.apply_charge(%{
        "k" => "c15",
        "id" => "old",
        "b" => now - 10,
        "m" => 70_000,
        "n" => 1
      })

      Ledger.apply_charge(%{"k" => "c15", "id" => "new", "b" => now, "m" => 30_000, "n" => 1})
      assert {:ok, 100_000} = Ledger.used("c15")

      LedgerSource.put([[enterprise_id: 15, cutoff: now - 5, base: "-0.07"]])
      assert :ok = Sync.sync()
      assert {:ok, 30_000} = Ledger.used("c15")
      assert Ledger.balance("c15") == -100_000
    end

    test "Redis without the account's buckets gets them from PostgreSQL" do
      now = Ledger.bucket(System.os_time(:second))

      start([[enterprise_id: 16, cutoff: now - 4]], %{
        "c16" => [{now - 8, 5_000, 1}, {now - 1, 20_000, 2}]
      })

      assert {:ok, 20_000} = Ledger.used("c16")
    end

    test "a failed write is tried again on the next run; a failed account read keeps the accounts loaded" do
      start([[enterprise_id: 17, base: "1"]])
      Ledger.charge(:customer, 17, "m1", @eur, 1)
      LedgerSource.put([[enterprise_id: 17, base: "1"]], %{}, fail: true)
      assert {:error, :down} = Sync.sync()
      assert :ok = Ledger.check(msg(17))

      LedgerSource.put([[enterprise_id: 17, base: "1"]])
      assert :ok = Sync.sync()
      assert [_] = LedgerSource.persisted()
    end
  end

  test "Redis unavailable: the last total read within a minute is used (Q24), then messages are refused" do
    start([[enterprise_id: 18, base: "1"]])
    assert :ok = Ledger.check(msg(18))

    previous = Application.get_env(:sms_switch, Store)
    Application.put_env(:sms_switch, Store, backend: :redis)
    on_exit(fn -> Application.put_env(:sms_switch, Store, previous) end)

    assert :ok = Ledger.check(msg(18))
    :ets.insert(Ledger.seen_table(), {"c18", 0, System.monotonic_time(:millisecond) - 61_000})
    assert {:error, :esme_rsubmitfail} = Ledger.check(msg(18))
  end

  test "amounts" do
    assert Ledger.to_micro(nil) == 0
    assert Ledger.to_micro(2) == 2_000_000
    assert Ledger.to_micro(0.5) == 500_000
    assert Ledger.units(1_250_000) == Decimal.new("1.25")
    assert Ledger.key(:vendor, 3) == "v3"
  end

  describe "credit alerts" do
    defp alerts,
      do: for(e <- Sms.Core.Bus.Local.published(), e.type == "billing.credit_alert", do: e.data)

    test "Notice, Warning and Critical as the credit limit is used, once each; the limit reached; re-armed by a payment" do
      start([[enterprise_id: 21, base: "0", limit: "1", alerts: [50, 70, 90]]])
      assert alerts() == []

      Ledger.apply_charge(%{"k" => "c21", "id" => "a", "b" => 1, "m" => 600_000, "n" => 1})
      Sync.sync()

      assert [
               %{
                 "level" => "notice",
                 "balance" => "-0.6",
                 "credit_limit" => "1",
                 "enterprise_id" => 21
               }
             ] = alerts()

      # Nothing new: no new alert.
      Sync.sync()
      assert length(alerts()) == 1

      Ledger.apply_charge(%{"k" => "c21", "id" => "b", "b" => 1, "m" => 350_000, "n" => 1})
      Sync.sync()
      assert List.last(alerts())["level"] == "critical"

      Ledger.apply_charge(%{"k" => "c21", "id" => "c", "b" => 1, "m" => 100_000, "n" => 1})
      Sync.sync()
      assert List.last(alerts())["level"] == "limit_reached"

      # A payment of 1: back under Notice, so Notice alerts again later.
      LedgerSource.put([[enterprise_id: 21, base: "1", limit: "1", alerts: [50, 70, 90]]])
      Sync.sync()
      count = length(alerts())
      Ledger.apply_charge(%{"k" => "c21", "id" => "d", "b" => 1, "m" => 600_000, "n" => 1})
      Sync.sync()
      assert length(alerts()) == count + 1
      assert List.last(alerts())["level"] == "notice"
    end

    test "a prepaid customer or vendor: an alert when the balance is used up; Credit Alert off: none" do
      start([
        [enterprise_id: 22, prepaid: true, base: "0.01"],
        [enterprise_id: 23, side: :vendor, prepaid: true, base: "0"],
        [enterprise_id: 24, base: "-5", limit: "1", alerts: []]
      ])

      assert [%{"enterprise_id" => 23, "side" => "vendor", "level" => "used_up"}] = alerts()
      Ledger.apply_charge(%{"k" => "c22", "id" => "a", "b" => 1, "m" => 10_000, "n" => 1})
      Sync.sync()
      assert List.last(alerts())["enterprise_id"] == 22
      assert length(alerts()) == 2
    end
  end
end
