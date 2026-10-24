defmodule Sms.Switch.Pipeline.ReceiptsTest do
  # The customer's receipt from its parts' receipts (S-5.9) and what the customer asked for (registered_delivery).
  use ExUnit.Case, async: true
  alias Sms.Switch.Pipeline.{Forwarder, Receipts}

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
end
