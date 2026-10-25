defmodule Sms.Switch.Pipeline.ReadinessTest do
  # A server starting (backend step 7): before the configuration is loaded, receipts are asked again later and
  # accepted messages wait on the bus; nothing is handled half-configured.
  use ExUnit.Case, async: false
  alias Sms.Core.Bus.Event
  alias Sms.Switch.Pipeline.{Receipts, Sender}
  alias Sms.Switch.Smpp.Pdu

  @snapshot {Sms.Switch.Pipeline.Config, :snapshot}

  setup do
    previous = :persistent_term.get(@snapshot, nil)
    :persistent_term.put(@snapshot, nil)
    on_exit(fn -> :persistent_term.put(@snapshot, previous) end)
  end

  test "receipts are answered 0x08 so the vendor sends them again; messages are left for redelivery" do
    refute Receipts.ready?()

    assert {:error, :esme_rsyserr} =
             Receipts.handle(%{trunk: %{id: 1}}, Pdu.new(:deliver_sm, %{esm_class: 4}))

    event =
      Event.new("sms.msg.accepted", "msg.accepted", %{"m" => "not decoded before the check"})

    assert {:error, :config_not_loaded} = Sender.handle_event(event)
  end
end
