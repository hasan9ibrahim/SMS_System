defmodule Sms.Switch.Pipeline.IntegrationTest do
  # The pipeline against the real stores (INTEGRATION=1): the configuration queries on the PostgreSQL schema
  # (db/postgres/migrations) and the EDR rows on the ClickHouse schema (db/clickhouse/migrations).
  use ExUnit.Case, async: false
  alias Sms.Core.{ClickHouse, Repo}
  alias Sms.Switch.Pipeline.{Config, Edr, EdrWriter}
  alias Sms.Switch.Pipeline.Config.Loader
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

      assert :ok = Sms.Switch.Pipeline.LateReceipts.settle(vt, ["a2"], late.("a2"))
      assert :ok = Sms.Switch.Pipeline.LateReceipts.settle(vt, ["a1"], late.("a1"))
      assert :ok = Sms.Switch.Pipeline.LateReceipts.settle(vt, ["zz"], late.("zz"))

      rows = for e <- Sms.Core.Bus.Local.published(), e.type == "edr.receipt", do: e.data

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
