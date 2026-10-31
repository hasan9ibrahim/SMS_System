defmodule Sms.Switch.Smpp.Time do
  @moduledoc """
  SMPP time fields (SMPP 3.4 §7.1.1): `schedule_delivery_time` and `validity_period` (docs/SMPP_SCENARIOS.md S-2.12,
  S-2.13). Empty means none.

    * absolute: `YYMMDDhhmmsstnnp`, the local time `nn` quarter hours ahead of (`+`) or behind (`-`) UTC, `t` tenths of
      a second;
    * relative: `YYMMDDhhmmss000R`, a time from when the message was received.

  The switch reads both as a moment (ms since the epoch, UTC) and gives a vendor the absolute form in UTC, so a relative
  validity never starts again at the vendor.
  """

  @doc """
  The moment a time field means, `received_ms` being when the message was received (for a relative one): `{:ok, ms}`,
  `{:ok, nil}` for an empty field, or `:error` for one that does not read.
  """
  @spec parse(String.t() | nil, integer()) :: {:ok, integer() | nil} | :error
  def parse(value, _received_ms) when value in [nil, ""], do: {:ok, nil}

  def parse(<<fields::binary-12, _tnn::binary-3, "R">>, received_ms) do
    with {:ok, [yy, mo, dd, hh, mi, ss]} <- numbers(fields) do
      shifted =
        received_ms
        |> DateTime.from_unix!(:millisecond)
        |> DateTime.shift(year: yy, month: mo, day: dd, hour: hh, minute: mi, second: ss)

      {:ok, DateTime.to_unix(shifted, :millisecond)}
    end
  end

  def parse(<<fields::binary-12, t, nn::binary-2, sign>>, _received_ms) when sign in [?+, ?-] do
    with {:ok, [yy, mo, dd, hh, mi, ss]} <- numbers(fields),
         {:ok, [quarters]} <- numbers(nn),
         true <- t in ?0..?9 and quarters <= 48,
         {:ok, local} <- NaiveDateTime.new(2000 + yy, mo, dd, hh, mi, ss) do
      offset_s = quarters * 900 * if(sign == ?+, do: 1, else: -1)
      utc = local |> NaiveDateTime.add(-offset_s) |> DateTime.from_naive!("Etc/UTC")
      {:ok, DateTime.to_unix(utc, :millisecond) + (t - ?0) * 100}
    else
      _ -> :error
    end
  end

  def parse(_value, _received_ms), do: :error

  @doc "The absolute form of a moment in UTC (`YYMMDDhhmmss000+`); empty for none."
  @spec absolute(integer() | nil) :: String.t()
  def absolute(nil), do: ""

  def absolute(ms) do
    ms
    |> DateTime.from_unix!(:millisecond)
    |> Calendar.strftime("%y%m%d%H%M%S")
    |> Kernel.<>("000+")
  end

  # Two-digit numbers, or :error.
  defp numbers(digits) do
    if digits =~ ~r/\A[0-9]+\z/ and rem(byte_size(digits), 2) == 0 do
      {:ok, for(<<pair::binary-2 <- digits>>, do: String.to_integer(pair))}
    else
      :error
    end
  end
end
