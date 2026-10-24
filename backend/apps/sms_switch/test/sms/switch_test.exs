defmodule Sms.SwitchTest do
  use ExUnit.Case, async: true

  test "the switch application starts its supervision tree (the customer side is off in tests)" do
    assert {:ok, _} = Application.ensure_all_started(:sms_switch)
    assert is_pid(Process.whereis(Sms.Switch.Supervisor))
  end
end
