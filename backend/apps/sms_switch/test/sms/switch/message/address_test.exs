defmodule Sms.Switch.Message.AddressTest do
  # Sender checks and automatic TON / NPI after translation (docs/SMPP_SCENARIOS.md S-2.10, S-4.7); the Route
  # Simulator's copy is mock/src/routing/tonNpi.ts (mock/test/tonNpi.test.ts holds the same cases).
  use ExUnit.Case, async: true
  alias Sms.Switch.Message.Address

  defp msg(fields \\ []) do
    Map.merge(
      %{
        sender: "FakeBank",
        receiver: "4915112345678",
        sender_ton: 1,
        sender_npi: 1,
        dest_ton: 0,
        dest_npi: 0
      },
      Map.new(fields)
    )
  end

  defp source(a), do: {a.sender, a.sender_ton, a.sender_npi}
  defp destination(a), do: {a.receiver, a.dest_ton, a.dest_npi}

  describe "auto/2" do
    test "source: alphanumeric 5 / 0; + then digits 1 / 1 without the +; 9+ digits 1 / 1; 3–8 digits 3 / 0" do
      assert Address.auto(msg()) == %{
               msg()
               | sender_ton: 5,
                 sender_npi: 0,
                 dest_ton: 1,
                 dest_npi: 1
             }

      assert source(Address.auto(msg(sender: "+447700900123", sender_ton: 5, sender_npi: 0))) ==
               {"447700900123", 1, 1}

      assert source(Address.auto(msg(sender: "447700900123", sender_ton: 0))) ==
               {"447700900123", 1, 1}

      assert source(Address.auto(msg(sender: "12345"))) == {"12345", 3, 0}
      # Nothing to go on: left as they are.
      for sender <- ["", "12"] do
        assert source(Address.auto(msg(sender: sender, sender_ton: 2, sender_npi: 8))) ==
                 {sender, 2, 8}
      end
    end

    test "destination: a full international number 1 / 1 without the +; anything else as it is" do
      assert destination(Address.auto(msg(receiver: "+4915112345678"))) == {"4915112345678", 1, 1}

      for receiver <- ["1234567", "1234567890123456", "49 151 1234"] do
        assert destination(Address.auto(msg(receiver: receiver, dest_ton: 2, dest_npi: 8))) ==
                 {receiver, 2, 8}
      end
    end

    test "a field a translation rule set wins; the + stays when the rule set the TON" do
      a = Address.auto(msg(sender: "+447700900123", sender_ton: 2), [:sender_ton, :dest_npi])
      assert source(a) == {"+447700900123", 2, 1}
      assert {a.dest_ton, a.dest_npi} == {1, 0}
    end

    test "a length or characters cannot be fixed: the sender is still unfit to send" do
      a = Address.auto(msg(sender: "ABCDEFGHIJKLMN"))
      assert a.sender_ton == 5
      assert Address.source_problem(a.sender, a.sender_ton, a.sender_npi) == :esme_rinvsrcadr

      fixed = Address.auto(msg(sender: "+447700900123", sender_ton: 5))
      assert Address.source_problem(fixed.sender, fixed.sender_ton, fixed.sender_npi) == nil
    end
  end
end
