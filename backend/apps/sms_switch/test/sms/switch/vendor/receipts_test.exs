defmodule Sms.Switch.Vendor.ReceiptsTest do
  # The vendor side's receipt handler before the pipeline takes it (Q7, S-5.12), and its bus events (§13.1).
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  require Logger
  alias Sms.Switch.Smpp.Pdu
  alias Sms.Switch.Vendor.{Events, Receipts}

  test "without a configured handler, every receipt and MO is answered OK and logged (Q7, S-5.12)" do
    previous = Application.get_env(:sms_switch, Sms.Switch.Vendor, [])
    Application.put_env(:sms_switch, Sms.Switch.Vendor, Keyword.delete(previous, :receipts))
    on_exit(fn -> Application.put_env(:sms_switch, Sms.Switch.Vendor, previous) end)
    assert Receipts.impl() == Receipts.LogOnly

    Logger.put_module_level(Receipts.LogOnly, :info)
    on_exit(fn -> Logger.delete_module_level(Receipts.LogOnly) end)
    pdu = Pdu.new(:deliver_sm, %{esm_class: 0x04}, tlvs: [message_state: 2], sequence: 3)

    log =
      capture_log([level: :info], fn ->
        assert Receipts.LogOnly.handle(%{trunk: %{id: 7}}, pdu) == :ok
      end)

    assert log =~ "vendor deliver_sm from trunk 7 answered OK and not processed"
    assert log =~ "esm_class 4"
    assert log =~ "[:message_state]"
  end

  test "a session event is never lost silently into a crash: without the vendor side it is dropped, :ok" do
    refute Process.whereis(Sms.Switch.Vendor.Tasks)
    assert Events.publish(:bound, %{"trunk_id" => 1}) == :ok
  end
end
