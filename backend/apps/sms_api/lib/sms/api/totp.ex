defmodule Sms.Api.Totp do
  @moduledoc """
  Authenticator codes (§13.28): RFC 6238 TOTP with SHA-1, 6 digits and 30-second steps, the secret in base32 as the
  mock stores it (mock/src/admin/passwords.ts). The current step and one either side are accepted. A code works once:
  `step/3` names the step a code belongs to, and the caller keeps the user's last accepted step (users.totp_last_step,
  migration 102) so a code whose step is not later is refused (Sms.Api.SignIn).
  """
  import Bitwise

  @period 30

  @doc "Whether `code` is the code of `secret` at `now` (unix seconds), or one step before or after."
  @spec valid?(String.t() | nil, String.t() | nil, integer()) :: boolean()
  def valid?(secret, code, now \\ System.os_time(:second)), do: step(secret, code, now) != :error

  @doc """
  The 30-second step (RFC 6238 counter) whose code `code` is: the step of `now` (unix seconds) or one either side, the
  latest when several match; `:error` when none does.
  """
  @spec step(String.t() | nil, String.t() | nil, integer()) :: {:ok, integer()} | :error
  def step(secret, code, now \\ System.os_time(:second))

  def step(secret, code, now) when is_binary(secret) and is_binary(code) do
    with {:ok, key} <- decode32(secret) do
      current = div(now, @period)
      want = pad(code)
      Enum.find_value([current + 1, current, current - 1], :error, &matching(key, &1, want))
    end
  end

  def step(_secret, _code, _now), do: :error

  defp matching(key, step, want),
    do: if(:crypto.hash_equals(code(key, step), want), do: {:ok, step})

  @doc "The code of `secret` at `now` (unix seconds)."
  @spec code_at(String.t(), integer()) :: String.t()
  def code_at(secret, now \\ System.os_time(:second)) do
    {:ok, key} = decode32(secret)
    code(key, div(now, @period))
  end

  defp code(key, counter) do
    h = :crypto.mac(:hmac, :sha, key, <<counter::64>>)
    offset = :binary.last(h) &&& 0x0F
    <<_::binary-size(offset), n::32, _::binary>> = h
    (n &&& 0x7FFFFFFF) |> rem(1_000_000) |> Integer.to_string() |> String.pad_leading(6, "0")
  end

  # A code that is not 6 characters never compares equal (hash_equals needs equal sizes).
  defp pad(code), do: code |> String.slice(0, 6) |> String.pad_trailing(6, "-")

  @alphabet ~c"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

  defp decode32(secret) do
    chars = secret |> String.upcase() |> String.replace(~r/[\s=]/, "") |> String.to_charlist()

    if chars != [] and Enum.all?(chars, &(&1 in @alphabet)) do
      bits = for c <- chars, into: <<>>, do: <<Enum.find_index(@alphabet, &(&1 == c))::5>>
      whole = div(bit_size(bits), 8) * 8
      <<key::bitstring-size(whole), _::bitstring>> = bits
      {:ok, key}
    else
      :error
    end
  end
end
