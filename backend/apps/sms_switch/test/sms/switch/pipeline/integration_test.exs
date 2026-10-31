defmodule Sms.Switch.Pipeline.IntegrationTest do
  # The pipeline against the real stores (INTEGRATION=1): the configuration queries on the PostgreSQL schema
  # (db/postgres/migrations) and the EDR rows on the ClickHouse schema (db/clickhouse/migrations).
  use ExUnit.Case, async: false
  alias Sms.Core.Bus.Local
  alias Sms.Core.{ClickHouse, Repo}

  alias Sms.Switch.Pipeline.{
    Billing,
    Config,
    Edr,
    EdrWriter,
    LateReceipts,
    Ledger,
    MessageId,
    Queries
  }

  alias Sms.Switch.Pipeline.Config.Loader
  alias Sms.Switch.Pipeline.Ledger.Source.Postgres
  alias Sms.Switch.Test.{CustomerCase, PipelineConfig}

  @moduletag :integration

  describe "Loader on the real schema" do
    setup do
      start_supervised!(Repo)
      :ok
    end

    test "every query runs and the snapshot builds from whatever the database holds" do
      assert {:ok, fp} = Loader.fingerprint()
      assert is_binary(fp)
      assert {:ok, fps} = Loader.rate_fingerprints()
      assert is_map(fps)
      assert {:ok, rates} = Loader.load_rates(Enum.take(Map.keys(fps), 5))
      assert is_map(rates)

      assert {:ok, snapshot} = Loader.load_snapshot("EUR")
      assert snapshot.platform_currency == "EUR"

      for key <- [
            :destinations,
            :customer_trunks,
            :vendor_trunks,
            :route_index,
            :translation,
            :lists,
            :fx
          ],
          do: assert(Map.has_key?(snapshot, key))
    end
  end

  describe "Ledger on the real schema (migration 072)" do
    setup do
      start_supervised!(Repo)
      :ok
    end

    test "accounts come from balance_ledger; buckets are written to traffic_charges and read back" do
      # Its own enterprise, rolled back at the end, so it runs on an empty database too.
      Repo.transaction(fn ->
        q = fn sql, params -> Repo.query!(sql, params).rows end

        q.(
          "INSERT INTO currencies (iso, name, symbol) VALUES ('EUR', 'Euro', '€') ON CONFLICT (iso) DO NOTHING",
          []
        )

        [[company]] =
          q.(
            "INSERT INTO business_companies (name, base_currency) VALUES ('Test Co', 'EUR') RETURNING id",
            []
          )

        [[cycle]] =
          q.(
            "INSERT INTO billing_cycles (name, billing_type, usage_days, due_days) VALUES ('Test cycle', 'monthly', 30, 7) RETURNING id",
            []
          )

        [[ent]] =
          q.(
            """
            INSERT INTO enterprises (name, alias, type, tier, address_line1, business_company_id)
            VALUES ('Ledger Test', 'LT', 'customer', 'tier1', 'Street 1', $1) RETURNING id
            """,
            [company]
          )

        q.(
          """
          INSERT INTO enterprise_billing (enterprise_id, side, currency, billing_cycle_id, billing_type, credit_limit,
                                          opening_balance, timezone)
          VALUES ($1, 'customer', 'EUR', $2, 'postpaid', 50, 10, 'Asia/Kolkata')
          """,
          [ent, cycle]
        )

        # A prepaid vendor side with its own balance alert levels (migration 073).
        q.(
          """
          INSERT INTO enterprise_billing (enterprise_id, side, currency, billing_cycle_id, billing_type, opening_balance,
                                          balance_alert_notice)
          VALUES ($1, 'vendor', 'EUR', $2, 'prepaid', 100, 40)
          """,
          [ent, cycle]
        )

        # A payment of 11 USD counts at the USD rate of its date (product owner 2026-10-25).
        q.(
          "INSERT INTO currencies (iso, name, symbol) VALUES ('USD', 'US dollar', '$') ON CONFLICT (iso) DO NOTHING",
          []
        )

        q.(
          "INSERT INTO currency_rates (iso, rate_per_eur, valid_from) VALUES ('USD', 1.1, '2020-01-01') ON CONFLICT DO NOTHING",
          []
        )

        q.(
          """
          INSERT INTO transactions (enterprise_id, side, payment_mode, payment_type, transaction_type, amount, currency,
                                    amount_base, payment_date)
          VALUES ($1, 'customer', 'bank_transfer', 'credit', 'receipt', 11, 'USD', 10, '2026-01-15')
          """,
          [ent]
        )

        [[usd]] = q.("SELECT rate_per_eur_at('USD', '2026-01-15'::timestamptz)", [])
        paid = Decimal.div(Decimal.new(11), usd)
        base = paid |> Decimal.add(10) |> Ledger.to_micro()

        assert {:ok, accounts} = Postgres.accounts()
        account = Enum.find(accounts, &(&1.enterprise_id == ent and &1.side == :customer))
        vendor = Enum.find(accounts, &(&1.enterprise_id == ent and &1.side == :vendor))
        assert %{prepaid: true, alerts: [40, 70, 90], limit: 0, base: 100_000_000} = vendor

        assert %{
                 key: key,
                 side: :customer,
                 base: ^base,
                 limit: 50_000_000,
                 prepaid: false,
                 cutoff: 0
               } =
                 account

        assert key == Ledger.key(:customer, ent)
        # Midnight in the partner's time zone (+05:30): a half-hour boundary.
        assert rem(account.periods["today"], 1_800) == 0

        bucket = Ledger.bucket(System.os_time(:second))
        assert :ok = Postgres.persist([{account, bucket, 1_234_567, 3}])
        assert :ok = Postgres.persist([{account, bucket, 2_000_000, 4}])
        assert {:ok, [{^bucket, 2_000_000, 4}]} = Postgres.charges(account, bucket)
        assert :ok = Postgres.persist([])

        # The uninvoiced traffic is in the balance.
        assert {:ok, again} = Postgres.accounts()
        assert Enum.find(again, &(&1.enterprise_id == ent and &1.side == :customer)).base == base

        assert [[balance]] =
                 q.(
                   "SELECT balance FROM balance_ledger WHERE enterprise_id = $1 AND side = 'customer'",
                   [ent]
                 )

        # Opening 10 + the payment − 2 of traffic not invoiced yet.
        assert Ledger.to_micro(balance) == base - 2_000_000

        Repo.rollback(:done)
      end)
    end
  end

  describe "EdrWriter on the real schema" do
    setup do
      start_supervised!(ClickHouse)
      :ok
    end

    defp msg do
      %{
        id: "01a1000000000000ffff",
        received_at: System.os_time(:millisecond),
        trunk: %{
          id: 1,
          enterprise_id: 11,
          business_company_id: 1,
          product_category_id: 1,
          account_manager_id: 5,
          billing_type: "submit",
          base_currency: "EUR"
        },
        client: %{ip: {127, 0, 0, 1}, port: 40_000},
        origin: %{session_id: "s1", bind: :trx},
        fields: %{
          source_addr: "FakeBank",
          destination_addr: "4915112345678",
          registered_delivery: 1
        },
        ingress: %{},
        data_coding: 0,
        text: "integration",
        body: "integration",
        udh: <<>>,
        parts: 1,
        destination: nil,
        sell: nil
      }
    end

    defp count(table, edr_id) do
      {:ok, %{rows: [[n]]}} =
        ClickHouse.query("SELECT count() FROM #{table} WHERE edr_id = {id:UUID}", %{
          "id" => edr_id
        })

      n
    end

    test "attempt and receipt rows are stored with every key a real column" do
      edr_id = Edr.new_id()

      attempt =
        Edr.attempt_row(msg(), %{
          edr_id: edr_id,
          no: 0,
          final: true,
          success: false,
          command_status: 0x0B
        })

      receipt =
        Edr.receipt_row(%{
          edr_id: edr_id,
          kind: "customer",
          at: System.os_time(:millisecond),
          msg: msg(),
          part: 1
        })

      batch = fn data, type ->
        %Sms.Core.Bus.Event{
          # A real event's id: the insert's de-duplication token comes from it on the local bus (ClickHouse 010).
          id: Edr.new_id(),
          type: type,
          subject: "sms.#{type}",
          data: data,
          occurred_at: nil,
          version: 1
        }
      end

      json = fn row -> row |> Jason.encode!() |> Jason.decode!() end

      assert :ok =
               EdrWriter.handle_batch([
                 batch.(json.(attempt), "edr.attempt"),
                 batch.(json.(receipt), "edr.receipt")
               ])

      assert count("edr", edr_id) == 1
      assert count("edr_receipt", edr_id) == 1
    end

    test "every key of a full attempt row (vendor leg, rates) and of a receipt row is a column" do
      PipelineConfig.put()
      start_supervised!({Config.Server, loader: PipelineConfig})
      CustomerCase.assert_eventually(&Config.ready?/0)

      now = System.os_time(:millisecond)
      sell = Config.sell_rate(1, "26201", now)
      cost = Config.vendor_rate(1, "26201", now)
      dest = Config.destination("4915112345678")
      full = %{msg() | sell: sell, destination: dest}

      vendor = %{
        vendor_trunk_id: 1,
        rule_id: 1,
        route_type: :static,
        level: 1,
        decided_by: :level,
        cost: cost,
        data_coding: 0,
        egress: %{sender: "FakeBank", receiver: "4915112345678", fired: [3]}
      }

      attempt =
        Edr.attempt_row(full, %{
          edr_id: Edr.new_id(),
          no: 1,
          final: true,
          success: true,
          command_status: 0,
          vendor: vendor,
          submit_time: now,
          resp_time: now,
          vendor_message_id: "abc"
        })

      receipt =
        Edr.receipt_row(%{
          edr_id: Edr.new_id(),
          kind: "vendor",
          at: now,
          msg: full,
          part: 1,
          vendor_trunk_id: 1,
          vendor_message_id: "abc",
          status: "DELIVRD",
          error: "000",
          network_error: 0,
          customer_status: "DELIVRD",
          customer_error: "000",
          session_id: "s1",
          held_ms: 0,
          late: false,
          duplicate: false,
          source: "vendor"
        })

      assert Map.has_key?(attempt, "v_rate") and Map.has_key?(attempt, "c_rate")

      assert MapSet.subset?(keys(attempt), columns("edr")),
             inspect(MapSet.difference(keys(attempt), columns("edr")))

      assert MapSet.subset?(keys(receipt), columns("edr_receipt"))
      assert :ok = EdrWriter.write("edr", [Map.delete(attempt, "row_key")])
      assert count("edr", attempt["edr_id"]) == 1

      # The outcome row (ClickHouse 005) lands in edr_receipt and, through its view, in edr_hourly.
      # Step 11b: the outcome row repeats the attempt's report columns (ClickHouse 006, edr_all).
      dims =
        Edr.outcome_dims(full, %{
          edr_id: attempt["edr_id"],
          no: 1,
          final: true,
          success: true,
          command_status: 0,
          vendor: vendor,
          submit_time: now,
          resp_time: now,
          vendor_message_id: "abc"
        })

      bill =
        full
        |> Map.put(:route, nil)
        |> Billing.of_attempt(vendor, 1)
        |> Map.merge(%{c_type: "delivery", v_type: "delivery", attempt_no: 1})
        |> Map.update!(:dims, &Map.merge(&1, dims))

      data =
        Map.merge(full, %{edr_id: attempt["edr_id"], vendor_trunk_id: 1, bill: bill})

      outcome =
        Edr.outcome_row(data, %{
          at: now,
          status: "DELIVRD",
          customer_status: "DELIVRD",
          customer_billable: true,
          vendor_billable: true
        })

      assert %{"c_currency" => _, "c_rate_table_id" => _, "msg_count" => _} = outcome

      assert MapSet.subset?(keys(outcome), columns("edr_receipt")),
             inspect(MapSet.difference(keys(outcome), columns("edr_receipt")))

      assert :ok = EdrWriter.write("edr_receipt", [Map.delete(outcome, "row_key")])

      {:ok, %{rows: [[delivered, billable, revenue]]}} =
        ClickHouse.query(
          """
          SELECT sum(delivered), sum(billable_c), toString(sum(revenue_sys)) FROM edr_hourly
           WHERE c_enterprise_id = {ent:UInt32} AND hour = toStartOfHour(fromUnixTimestamp64Milli({at:Int64}))
          """,
          %{"ent" => full.trunk.enterprise_id, "at" => full.received_at}
        )

      assert delivered >= 1 and billable >= 1
      assert Decimal.compare(Decimal.new(revenue), Decimal.new("0.05")) != :lt
    end

    defp keys(row), do: row |> Map.delete("row_key") |> Map.keys() |> MapSet.new()

    defp columns(table) do
      {:ok, %{rows: rows}} =
        ClickHouse.query(
          "SELECT name FROM system.columns WHERE database = currentDatabase() AND table = {t:String}",
          %{"t" => table}
        )

      MapSet.new(rows, &hd/1)
    end

    test "a row ClickHouse refuses is dropped and the rest of its batch is written" do
      good = Edr.new_id()
      bad = Edr.new_id()

      row = fn id ->
        Edr.attempt_row(msg(), %{
          edr_id: id,
          no: 0,
          final: true,
          success: false,
          command_status: 1
        })
      end

      refused = Map.put(row.(bad), "c_ip", "not an address")

      assert :ok =
               EdrWriter.write("edr", [
                 Map.drop(row.(good), ["row_key"]),
                 Map.drop(refused, ["row_key"])
               ])

      assert count("edr", good) == 1
      assert count("edr", bad) == 0
    end

    test "a receipt after the message left Redis is matched from the EDRs: late after a DLR timeout, else a duplicate (D5)" do
      start_supervised!(Sms.Core.Bus)
      start_supervised!(Sms.Switch.Pipeline.Store)
      PipelineConfig.put()
      start_supervised!({Config.Server, loader: PipelineConfig})
      CustomerCase.assert_eventually(&Config.ready?/0)
      # Unique across runs too: ClickHouse keeps the rows of earlier runs.
      vt = 800_000 + :rand.uniform(4_000_000_000)
      edr_id = Edr.new_id()

      attempt =
        msg()
        |> Edr.attempt_row(%{
          edr_id: edr_id,
          no: 1,
          final: true,
          success: true,
          command_status: 0,
          vendor: %{vendor_trunk_id: vt, egress: %{}},
          vendor_message_id: "a1,a2",
          vendor_message_keys: ["a1", "a2"]
        })
        |> Map.put("v_trunk_id", vt)
        # A vendor billing on delivery: the late DELIVRD adds its cost (§7, D5).
        |> Map.merge(%{
          "v_billing_type" => "delivery",
          "v_rate" => "0.02",
          "v_sys_rate" => "0.02",
          "msg_count" => 2
        })

      assert :ok = EdrWriter.write("edr", [Map.delete(attempt, "row_key")])

      # Part 2 was answered by the switch's DLR timeout; part 1 by the vendor.
      timeout = receipt_row(edr_id, 2, "switch")
      vendor = receipt_row(edr_id, 1, "vendor")

      assert :ok =
               EdrWriter.write("edr_receipt", [
                 Map.delete(timeout, "row_key"),
                 Map.delete(vendor, "row_key")
               ])

      late = fn id ->
        %{
          vendor_message_id: id,
          status: "DELIVRD",
          error: "000",
          network_error: 0,
          received_at: System.os_time(:millisecond),
          vendor_trunk_id: vt
        }
      end

      assert :ok = LateReceipts.settle(vt, ["a2"], late.("a2"))
      assert :ok = LateReceipts.settle(vt, ["a1"], late.("a1"))
      assert :ok = LateReceipts.settle(vt, ["zz"], late.("zz"))

      all = for e <- Local.published(), e.type == "edr.receipt", do: e.data
      {outcomes, rows} = Enum.split_with(all, &(&1["kind"] == "outcome"))

      assert [
               %{
                 "part_no" => 2,
                 "is_late" => 1,
                 "is_duplicate" => 0,
                 "msg_status" => "DELIVRD",
                 "c_message_id" => c_id
               },
               %{"part_no" => 1, "is_late" => 0, "is_duplicate" => 1}
             ] = rows

      # The vendor's cost of the late delivery, once (not for the duplicate), with no status of its own.
      assert [
               %{
                 "is_vendor_billable" => 1,
                 "cost" => "0.04",
                 "msg_status" => "",
                 "edr_id" => ^edr_id
               }
             ] = outcomes

      assert c_id == msg().id
    end

    test "query_sm reads a finished message from the EDRs: the customer's receipt, a refusal, else ENROUTE (S-2.15)" do
      start_supervised!(Sms.Switch.Pipeline.Store)
      ent = 700_000 + System.unique_integer([:positive])

      PipelineConfig.put(
        customer_trunks: [
          PipelineConfig.customer_trunk(enterprise_id: ent),
          PipelineConfig.customer_trunk(id: 2, enterprise_id: ent + 1)
        ]
      )

      start_supervised!({Config.Server, loader: PipelineConfig})
      CustomerCase.assert_eventually(&Config.ready?/0)
      context = %{origin: %{trunk_id: 1}}

      write = fn id, attempt ->
        base = msg()
        m = %{base | id: id, trunk: %{base.trunk | enterprise_id: ent}}
        edr_id = Edr.new_id()

        row =
          Edr.attempt_row(
            m,
            Map.merge(%{edr_id: edr_id, no: 1, final: true, vendor: nil}, attempt)
          )

        :ok = EdrWriter.write("edr", [Map.delete(row, "row_key")])
        {m, edr_id}
      end

      delivered = MessageId.new()
      {m, edr_id} = write.(delivered, %{success: true, command_status: 0})

      receipt =
        Edr.receipt_row(%{
          edr_id: edr_id,
          kind: "customer",
          at: System.os_time(:millisecond),
          msg: m,
          part: 1,
          status: "DELIVRD",
          customer_status: "DELIVRD",
          customer_error: "000"
        })

      :ok = EdrWriter.write("edr_receipt", [Map.delete(receipt, "row_key")])

      assert {:ok, %{message_state: 2, final_date: date, error_code: 0}, []} =
               Queries.query(context, %{message_id: delivered})

      assert date =~ ~r/\A\d{12}\d00\+\z/

      refused = MessageId.new()
      _ = write.(refused, %{success: false, command_status: 0x45})

      assert {:ok, %{message_state: 8, error_code: 0x45}, []} =
               Queries.query(context, %{message_id: refused})

      waiting = MessageId.new()
      _ = write.(waiting, %{success: true, command_status: 0})
      assert {:ok, %{message_state: 1}, []} = Queries.query(context, %{message_id: waiting})

      # Another customer's message, or none at all.
      assert {:error, :esme_rqueryfail} =
               Queries.query(%{origin: %{trunk_id: 2}}, %{message_id: delivered})

      assert {:error, :esme_rsyserr} =
               Queries.query(%{origin: %{trunk_id: 99}}, %{message_id: delivered})

      assert {:error, :esme_rqueryfail} =
               Queries.query(context, %{message_id: MessageId.new()})
    end

    defp receipt_row(edr_id, part, source) do
      Edr.receipt_row(%{
        edr_id: edr_id,
        kind: "vendor",
        at: System.os_time(:millisecond),
        msg: msg(),
        part: part,
        status: "UNDELIV",
        source: source
      })
    end

    # S-7.3, ClickHouse 010: rows of a trunk no other test uses (unique across runs: ClickHouse keeps earlier runs'
    # rows), removed with what the views took from them when the test ends.
    defp own_trunk do
      trunk = 3_000_000_000 + :rand.uniform(1_000_000_000)
      base = msg()
      {trunk, %{base | trunk: %{base.trunk | id: trunk, enterprise_id: trunk}}}
    end

    defp remove_trunk(trunk) do
      for t <- ~w(edr edr_receipt edr_hourly edr_totals edr_sender_daily) do
        {:ok, _} =
          ClickHouse.query(
            "ALTER TABLE #{t} DELETE WHERE c_trunk_id = {t:UInt32}",
            %{"t" => trunk},
            settings: [mutations_sync: 1]
          )
      end
    end

    # Bus events as the NATS batcher hands them over: JSON data and the stream sequence number.
    defp events(rows) do
      for {type, row, seq} <- rows do
        %Sms.Core.Bus.Event{
          id: Edr.new_id(),
          type: type,
          subject: "sms.#{type}",
          data: row |> Jason.encode!() |> Jason.decode!(),
          occurred_at: nil,
          version: 1,
          seq: seq
        }
      end
    end

    defp stored(trunk) do
      {:ok, %{rows: [row]}} =
        ClickHouse.query(
          """
          SELECT (SELECT count() FROM edr WHERE c_trunk_id = {t:UInt32}),
                 (SELECT count() FROM edr_receipt WHERE c_trunk_id = {t:UInt32}),
                 (SELECT toInt64(sum(attempts)) FROM edr_hourly WHERE c_trunk_id = {t:UInt32}),
                 (SELECT toInt64(sum(rows)) FROM edr_totals WHERE c_trunk_id = {t:UInt32}),
                 (SELECT toInt64(sum(rows)) FROM edr_sender_daily WHERE c_trunk_id = {t:UInt32})
          """,
          %{"t" => trunk}
        )

      Enum.zip([:attempts, :receipts, :hourly, :totals, :sender_daily], row) |> Map.new()
    end

    test "a batch delivered again writes nothing new, in the EDRs or the totals their views feed (S-7.3)" do
      {trunk, m} = own_trunk()
      seq = :rand.uniform(1_000_000_000_000)

      attempt = fn id ->
        Edr.attempt_row(m, %{edr_id: id, no: 1, final: true, success: true, command_status: 0})
      end

      first = Edr.new_id()

      receipt =
        Edr.receipt_row(%{
          edr_id: first,
          kind: "vendor",
          at: m.received_at + 900,
          msg: m,
          part: 1,
          status: "DELIVRD"
        })

      batch = events([{"edr.attempt", attempt.(first), seq}, {"edr.receipt", receipt, seq + 1}])

      try do
        assert :ok = EdrWriter.handle_batch(batch)
        once = %{attempts: 1, receipts: 1, hourly: 1, totals: 1, sender_daily: 1}
        assert stored(trunk) == once

        # The bus hands the batch out again (its ack wait passed while the insert was slow).
        assert :ok = EdrWriter.handle_batch(batch)
        assert stored(trunk) == once

        # Part of it again with a new row: the stored rows are left out by their keys, the new one is written.
        second = Edr.new_id()

        again =
          events([
            {"edr.attempt", attempt.(first), seq},
            {"edr.attempt", attempt.(second), seq + 2}
          ])

        assert :ok = EdrWriter.handle_batch(again)
        assert stored(trunk) == %{once | attempts: 2, hourly: 2, totals: 2, sender_daily: 2}
        assert count("edr", first) == 1 and count("edr", second) == 1

        # Every row keeps its key.
        {:ok, %{rows: keys}} =
          ClickHouse.query(
            "SELECT row_key FROM edr WHERE c_trunk_id = {t:UInt32} ORDER BY row_key",
            %{"t" => trunk}
          )

        assert Enum.sort(keys) == Enum.sort([[first <> ":1"], [second <> ":1"]])
      after
        remove_trunk(trunk)
      end
    end

    test "ClickHouse drops a batch delivered again while its first insert is still running: same token (S-7.3)" do
      {trunk, m} = own_trunk()
      seq = :rand.uniform(1_000_000_000_000)

      attempt = fn id ->
        Edr.attempt_row(m, %{edr_id: id, no: 1, final: true, success: true, command_status: 0})
      end

      first = Edr.new_id()

      try do
        assert :ok = EdrWriter.handle_batch(events([{"edr.attempt", attempt.(first), seq}]))
        assert stored(trunk).attempts == 1

        # The same bus message as the first insert (same sequence number) that the key lookup cannot see yet, as when
        # both inserts run at once: ClickHouse drops it by the token, and the views take nothing from it.
        unseen = Edr.new_id()
        assert :ok = EdrWriter.handle_batch(events([{"edr.attempt", attempt.(unseen), seq}]))
        assert count("edr", unseen) == 0
        assert %{attempts: 1, hourly: 1, totals: 1, sender_daily: 1} = stored(trunk)

        # Rows written directly carry no token: a new row is written.
        assert :ok = EdrWriter.write("edr", [Map.delete(attempt.(unseen), "row_key")])
        assert count("edr", unseen) == 1
        assert %{attempts: 2, hourly: 2, totals: 2} = stored(trunk)
      after
        remove_trunk(trunk)
      end
    end

    test "a schema problem is retried, never dropped" do
      row =
        Edr.attempt_row(msg(), %{
          edr_id: Edr.new_id(),
          no: 0,
          final: true,
          success: false,
          command_status: 1
        })

      assert {:error, %Ch.Error{code: 60}} =
               EdrWriter.write("edr_missing_table", [Map.drop(row, ["row_key"])])
    end
  end
end
