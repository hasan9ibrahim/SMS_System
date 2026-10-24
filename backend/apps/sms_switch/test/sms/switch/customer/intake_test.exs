defmodule Sms.Switch.Customer.IntakeTest do
  use ExUnit.Case, async: false
  alias Sms.Switch.Customer.{Events, Intake}
  alias Sms.Switch.Smpp.Pdu

  test "until the pipeline exists (step 4), every message request is refused at once with the right status" do
    assert Intake.impl() == Intake.NotReady
    assert Intake.NotReady.handle(%{}, Pdu.new(:submit_sm)) == {:error, :esme_rsubmitfail}
    assert Intake.NotReady.handle(%{}, Pdu.new(:data_sm)) == {:error, :esme_rsubmitfail}
    assert Intake.NotReady.handle(%{}, Pdu.new(:query_sm)) == {:error, :esme_rqueryfail}
    assert Intake.NotReady.handle(%{}, Pdu.new(:cancel_sm)) == {:error, :esme_rcancelfail}
  end

  test "the configured intake is used" do
    previous = Application.get_env(:sms_switch, Sms.Switch.Customer)

    Application.put_env(
      :sms_switch,
      Sms.Switch.Customer,
      Keyword.put(previous || [], :intake, Sms.Switch.Test.Intake)
    )

    on_exit(fn -> Application.put_env(:sms_switch, Sms.Switch.Customer, previous) end)
    assert Intake.impl() == Sms.Switch.Test.Intake
  end

  test "publishing an event never fails the caller, even with no task supervisor (node stopping)" do
    assert Events.publish(:closed, %{session_id: "x"}) == :ok
  end
end
