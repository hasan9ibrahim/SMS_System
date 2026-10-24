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
      assert {:ok, accounts} = Postgres.accounts()

      case accounts do
        [] ->
          :ok

        [account | _] ->
          assert account.key == Ledger.key(account.side, account.enterprise_id)
          bucket = Ledger.bucket(System.os_time(:second)) + 100_000

          try do
            assert :ok = Postgres.persist([{account, bucket, 1_234_567, 3}])
            assert :ok = Postgres.persist([{account, bucket, 2_000_000, 4}])
            assert {:ok, buckets} = Postgres.charges(account, bucket)
            assert {bucket, 2_000_000, 4} in buckets
            assert :ok = Postgres.persist([])
          after
            Repo.query!("DELETE FROM traffic_charges WHERE bucket = to_timestamp($1)", [
              bucket * Ledger.bucket_s()
            ])
          end
      end
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
          id: "x",
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
      bill =
        full
        |> Map.put(:route, nil)
        |> Billing.of_attempt(vendor, 1)
        |> Map.merge(%{c_type: "delivery", v_type: "delivery", attempt_no: 1})

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
      vt = 800_000 + System.unique_integer([:positive])
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

      rows = for e <- Local.published(), e.type == "edr.receipt", do: e.data

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
