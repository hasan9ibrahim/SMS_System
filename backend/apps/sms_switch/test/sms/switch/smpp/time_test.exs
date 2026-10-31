defmodule Sms.Switch.Smpp.TimeTest do
  # SMPP time fields (SMPP 3.4 §7.1.1, S-2.12, S-2.13).
  use ExUnit.Case, async: true
  alias Sms.Switch.Smpp.Time

  @received DateTime.to_unix(~U[2026-10-31 10:00:00Z], :millisecond)

  defp ms(dt), do: DateTime.to_unix(dt, :millisecond)

  test "empty: none" do
    assert Time.parse("", @received) == {:ok, nil}
    assert Time.parse(nil, @received) == {:ok, nil}
  end

  test "absolute: the local time with its offset in quarter hours, read in UTC" do
    assert Time.parse("261031120000000+", @received) == {:ok, ms(~U[2026-10-31 12:00:00Z])}
    # 12:00 at UTC+2 (8 quarter hours) is 10:00 UTC; tenths count.
    assert Time.parse("261031120000508+", @received) == {:ok, ms(~U[2026-10-31 10:00:00.500Z])}
    assert Time.parse("261031120000004-", @received) == {:ok, ms(~U[2026-10-31 13:00:00Z])}
  end

  test "relative: from when the message was received" do
    assert Time.parse("000000000500000R", @received) == {:ok, ms(~U[2026-10-31 10:05:00Z])}
    assert Time.parse("000001020000000R", @received) == {:ok, ms(~U[2026-11-01 12:00:00Z])}
  end

  test "fields that do not read" do
    for bad <- [
          "2610311200",
          "261331120000000+",
          "26103112000000x+",
          "261031120000049+",
          "abcdefghijkl000R"
        ],
        do: assert(Time.parse(bad, @received) == :error, bad)
  end

  test "a vendor gets the absolute form in UTC" do
    assert Time.absolute(ms(~U[2026-10-31 10:05:07Z])) == "261031100507000+"
    assert Time.absolute(nil) == ""
  end
end
