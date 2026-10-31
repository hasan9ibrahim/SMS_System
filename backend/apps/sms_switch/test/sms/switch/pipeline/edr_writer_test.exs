defmodule Sms.Switch.Pipeline.EdrWriterTest do
  # The writer's keys and de-duplication tokens (S-7.3, ClickHouse 010); the writes themselves run against ClickHouse
  # in the integration tests.
  use ExUnit.Case, async: true

  alias Sms.Switch.Pipeline.{Edr, EdrWriter}

  @msg %{id: "01a1", received_at: 1_000, trunk: %{id: 1, enterprise_id: 2}}

  test "the row_key column is the EDR id and the row's key on the bus" do
    receipt =
      Edr.receipt_row(%{
        edr_id: "e1",
        kind: "vendor",
        at: 5_000,
        msg: @msg,
        part: 1,
        status: "DELIVRD"
      })

    assert EdrWriter.row_key(receipt) == "e1:vendor:1:5000:DELIVRD"
    assert EdrWriter.row_key(%{"edr_id" => "e1", "row_key" => "2"}) == "e1:2"

    # No key, no de-duplication by key (rows written before ClickHouse 010 keep an empty key too).
    assert EdrWriter.row_key(%{"edr_id" => "e1"}) == ""
    assert EdrWriter.row_key(%{"edr_id" => "e1", "row_key" => ""}) == ""
    assert EdrWriter.row_key(%{"row_key" => "2"}) == ""
  end

  test "a batch delivered again gets the same token, in any order; another batch or table another one" do
    token = EdrWriter.token("edr", ["s10", "s11", "s12"])

    assert token =~ ~r/\Aedr:[0-9a-f]{64}\z/
    assert EdrWriter.token("edr", ["s12", "s10", "s11"]) == token
    assert EdrWriter.token("edr", ["s10", "s11"]) != token
    assert EdrWriter.token("edr_receipt", ["s10", "s11", "s12"]) != token
  end

  test "rows written directly (no bus sequence numbers) go without a token" do
    assert EdrWriter.token("edr", [nil]) == nil
    assert EdrWriter.token("edr", ["s1", nil]) == nil
    assert EdrWriter.token("edr", []) == nil
  end
end
