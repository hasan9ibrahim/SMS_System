defmodule Sms.Switch.Pipeline.ReceiptsTest do
  # The customer's receipt from its parts' receipts (S-5.9) and what the customer asked for (registered_delivery).
  use ExUnit.Case, async: true
  alias Sms.Switch.Pipeline.{Forwarder, Receipt, Receipts}
  alias Sms.Switch.Smpp.Pdu

  describe "Receipt timeout per destination (S-5.10, team trial round 12)" do
    alias Sms.Switch.Pipeline.Sender

    @trunk %{dlr_timeout_s: 600, dlr_timeout_stat: "EXPIRED", dlr_timeout_mccmncs: MapSet.new()}

    test "no destinations listed: the trunk's timeout and status for every message" do
      assert {600, "EXPIRED"} = Sender.receipt_timeout(@trunk, %{destination: %{mccmnc: "26201"}})
      assert {600, "EXPIRED"} = Sender.receipt_timeout(@trunk, %{destination: nil})
    end

    test "destinations listed: theirs for those, the default 48 hours and UNKNOWN for the rest" do
      trunk = %{@trunk | dlr_timeout_mccmncs: MapSet.new(["26201", "262"])}
      assert {600, "EXPIRED"} = Sender.receipt_timeout(trunk, %{destination: %{mccmnc: "26201"}})
      assert {600, "EXPIRED"} = Sender.receipt_timeout(trunk, %{destination: %{mccmnc: "262"}})

      assert {172_800, "UNKNOWN"} =
               Sender.receipt_timeout(trunk, %{destination: %{mccmnc: "26202"}})

      assert {172_800, "UNKNOWN"} = Sender.receipt_timeout(trunk, %{destination: nil})
    end
  end

  describe "outcome rows (§7, S-6.7)" do
    alias Sms.Switch.Pipeline.Edr

    test "money in the base currency at the exchange rates taken at send time, not at the receipt's" do
      now = System.os_time(:millisecond)

      data = %{
        id: "m1",
        edr_id: "e1",
        received_at: now - 60_000,
        trunk: %{id: 1, enterprise_id: 11},
        vendor_trunk_id: 1,
        bill: %{
          sell: %{rate: Decimal.new("0.05"), currency: "USD"},
          cost: %{rate: Decimal.new("0.02"), currency: "USD"},
          c_parts: 2,
          v_parts: 2,
          base_currency: "EUR",
          # 1 EUR = 1.25 USD when the message was sent.
          c_sys_rate: Decimal.new("0.04"),
          v_sys_rate: Decimal.new("0.016"),
          attempt_no: 1,
          dims: %{}
        }
      }

      row =
        Edr.outcome_row(data, %{
          at: now,
          status: "DELIVRD",
          customer_billable: true,
          vendor_billable: true
        })

      assert %{
               "revenue" => "0.1",
               "revenue_sys" => "0.08",
               "cost" => "0.04",
               "cost_sys" => "0.032"
             } =
               row
    end
  end

  describe "aggregate/1 (S-5.9)" do
    test "DELIVRD only when every part was delivered" do
      assert %{status: "DELIVRD"} =
               Receipts.aggregate(%{1 => %{status: "DELIVRD"}, 2 => %{status: "DELIVRD"}})
    end

    test "else the first part, in part order, that was not, with its error" do
      finals = %{
        3 => %{status: "EXPIRED", error: "003"},
        1 => %{status: "DELIVRD", error: "000"},
        2 => %{status: "UNDELIV", error: "002"}
      }

      assert %{status: "UNDELIV", error: "002"} = Receipts.aggregate(finals)
    end
  end

  describe "wants?/3 (registered_delivery)" do
    test "0 none, 1 every final status, 2 failures only" do
      refute Forwarder.wants?(%{registered_delivery: 0}, "DELIVRD")
      refute Forwarder.wants?(%{registered_delivery: 0}, "UNDELIV")
      assert Forwarder.wants?(%{registered_delivery: 1}, "DELIVRD")
      assert Forwarder.wants?(%{registered_delivery: 1}, "REJECTD")
      refute Forwarder.wants?(%{registered_delivery: 2}, "DELIVRD")
      assert Forwarder.wants?(%{registered_delivery: 2}, "EXPIRED")
      # 3 is reserved: nothing.
      refute Forwarder.wants?(%{registered_delivery: 3}, "UNDELIV")
    end

    test "intermediate statuses only with bit 4" do
      refute Forwarder.wants?(%{registered_delivery: 1}, "ENROUTE", true)
      assert Forwarder.wants?(%{registered_delivery: 0x11}, "ENROUTE", true)
      assert Forwarder.wants_intermediate?(%{registered_delivery: 0x10})
    end
  end

  describe "Receipt.parse/1 (S-5.7)" do
    defp dlr(text, tlvs \\ []),
      do: Pdu.new(:deliver_sm, %{esm_class: 0x04, short_message: text}, tlvs: tlvs)

    test "the receipt text alone: id, status, error and done date" do
      text =
        "id:ab12 sub:001 dlvrd:001 submit date:2610241200 done date:261024120130 stat:DELIVRD err:0 text:hi"

      assert {:ok, r} = Receipt.parse(dlr(text))
      assert r.vendor_message_id == "ab12"
      assert r.status == "DELIVRD"
      assert r.error == "000"
      assert r.network_error == 0
      assert r.done_at == ~U[2026-10-24 12:01:30Z]
      assert r.mismatch == []
    end

    test "TLVs win over the text, and where they disagree it is reported" do
      text = "id:text-id stat:DELIVRD err:000 text:"

      tlvs = [
        receipted_message_id: "tlv-id",
        message_state: 5,
        network_error_code: <<3, 0, 11>>
      ]

      assert {:ok, r} = Receipt.parse(dlr(text, tlvs))
      assert r.vendor_message_id == "tlv-id"
      assert r.status == "UNDELIV"
      assert r.network_error == 11
      assert Enum.sort(r.mismatch) == [:id, :status]

      # An unknown message_state is UNKNOWN; a blank receipted_message_id falls back to the text.
      assert {:ok, %{status: "UNKNOWN", vendor_message_id: "text-id"}} =
               Receipt.parse(dlr(text, receipted_message_id: "  ", message_state: 99))
    end

    test "a receipt that names no message cannot be matched" do
      assert Receipt.parse(dlr("stat:DELIVRD err:000")) == {:error, :no_message_id}
      assert Receipt.parse(Pdu.new(:deliver_sm, %{esm_class: 0x04})) == {:error, :no_message_id}
    end

    test "long status forms are normalised; anything else, or none, is UNKNOWN" do
      for {stat, status} <- [
            {"delivered", "DELIVRD"},
            {"UNDELIVERABLE", "UNDELIV"},
            {"Rejected", "REJECTD"},
            {"EXPIRED_X", "EXPIRED"},
            {"ACCEPTED", "ACCEPTD"},
            {"enroute", "ENROUTE"},
            {"WHATEVER", "UNKNOWN"}
          ] do
        assert {:ok, %{status: ^status}} = Receipt.parse(dlr("id:1 stat:#{stat}"))
      end

      assert {:ok, %{status: "UNKNOWN", error: "000"}} = Receipt.parse(dlr("id:1"))
    end

    test "a done date that is not a date is left out" do
      for date <- ["2613991200", "26102412xx", "2610"] do
        assert {:ok, %{done_at: nil}} = Receipt.parse(dlr("id:1 done date:#{date} stat:DELIVRD"))
      end

      assert {:ok, %{done_at: ~U[2026-10-24 12:00:00Z]}} =
               Receipt.parse(dlr("id:1 done date:2610241200 stat:DELIVRD"))
    end
  end

  describe "Receipt.build/1" do
    test "the customer's receipt carries the network error when there is one; no done date means now" do
      {fields, tlvs} =
        Receipt.build(%{
          message_id: "m1",
          source: "4915112345678",
          source_ton: 1,
          source_npi: 1,
          destination: "FakeBank",
          destination_ton: 5,
          destination_npi: 0,
          status: "UNDELIV",
          error: "011",
          submitted_at: 1_793_000_000_000,
          done_at: nil,
          text: "Ünïcode text that is longer than twenty",
          network_error: 11
        })

      assert fields.esm_class == 0x04
      assert {:network_error_code, <<3, 0, 11>>} in tlvs
      assert {:message_state, 5} in tlvs
      text = fields.short_message
      assert text =~ "dlvrd:000"
      assert text =~ "stat:UNDELIV err:011 text:?n?code text that i"
      assert Receipt.final?("UNDELIV")
      refute Receipt.final?("ENROUTE")
      assert Receipt.state("NOPE") == 7
    end

    test "the receipt text is ASCII, never GSM-coded: '@' and '_' stay themselves" do
      {fields, _tlvs} =
        Receipt.build(%{
          message_id: "abc",
          source: "1",
          source_ton: 1,
          source_npi: 1,
          destination: "2",
          destination_ton: 1,
          destination_npi: 1,
          status: "DELIVRD",
          error: "000",
          submitted_at: 0,
          done_at: 0,
          text: "mail me@x_y {€}",
          network_error: 0
        })

      assert fields.short_message =~ ~r/^id:abc sub:001 dlvrd:001 submit date:7001010000 /
      assert String.ends_with?(fields.short_message, "stat:DELIVRD err:000 text:mail me@x_y {?}")
      assert for(<<b <- fields.short_message>>, reduce: true, do: (ok -> ok and b in 0x20..0x7E))
    end
  end
end
