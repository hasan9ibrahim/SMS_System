defmodule Sms.SwitchTest do
  use ExUnit.Case, async: true

  test "the switch application starts its (still empty) supervision tree" do
    assert {:ok, _} = Application.ensure_all_started(:sms_switch)
    assert is_pid(Process.whereis(Sms.Switch.Supervisor))
  end
end
