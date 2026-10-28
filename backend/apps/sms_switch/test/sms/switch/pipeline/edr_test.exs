defmodule Sms.Switch.Pipeline.EdrTest do
  use ExUnit.Case, async: true

  alias Sms.Switch.Pipeline.Edr

  @msg %{id: "01a1", received_at: 1_000, trunk: %{id: 1, enterprise_id: 2}}

  defp row(status),
    do:
      Edr.receipt_row(%{
        edr_id: "e1",
        kind: "vendor",
        at: 5_000,
        msg: @msg,
        part: 1,
        status: status
      })

  test "two receipts for one part in the same millisecond keep apart (the bus drops a repeated key)" do
    assert row("ENROUTE")["row_key"] != row("DELIVRD")["row_key"]
    assert row("DELIVRD")["row_key"] == row("DELIVRD")["row_key"]
  end
end
