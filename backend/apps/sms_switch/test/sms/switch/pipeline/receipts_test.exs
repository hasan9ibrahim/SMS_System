defmodule Sms.Switch.Pipeline.ReceiptsTest do
  # The customer's receipt from its parts' receipts (S-5.9) and what the customer asked for (registered_delivery).
  use ExUnit.Case, async: true
  alias Sms.Switch.Message.Text
  alias Sms.Switch.Pipeline.{Forwarder, Receipt, Receipts}
  alias Sms.Switch.Smpp.Pdu

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
      assert {:ok, text} = Text.decode(fields.short_message, :gsm)
      assert text =~ "dlvrd:000"
      assert text =~ "stat:UNDELIV err:011 text:"
      assert Receipt.final?("UNDELIV")
      refute Receipt.final?("ENROUTE")
      assert Receipt.state("NOPE") == 7
    end
  end
end
