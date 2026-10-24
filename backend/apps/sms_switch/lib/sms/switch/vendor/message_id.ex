defmodule Sms.Switch.Vendor.MessageId do
  @moduledoc """
  Vendor message ids, normalised per vendor so receipts match their messages (spec §5.5 MsgID Type, S-5.6).

  The trunk's MsgID Type says how the vendor writes the id in `submit_sm_resp`:

    * `:default`: an opaque text, matched as sent (surrounding spaces removed);
    * `:decimal`: a number in decimal (`"00123"` and `"123"` are the same id);
    * `:hexadecimal`: a number in hexadecimal, any case (`"0A1f"` and `"a1F"` are the same id).

  A numeric id is kept as its value in decimal, so the resp and the receipt meet whatever base each one uses. Many
  vendors answer in one base and write the receipt in the other (S-5.6), so `receipt_keys/2` gives the receipt's id
  read both ways, the trunk's own base first: the caller (step 4) matches the first key that finds a message.
  An id that is not a number in the trunk's base is kept as text, so nothing is lost.
  """

  @type type :: :default | :decimal | :hexadecimal

  @doc "The key a `submit_sm_resp` message id is stored under."
  @spec normalize(String.t(), type()) :: String.t()
  def normalize(id, type) when is_binary(id) do
    id = String.trim(id)

    value =
      case type do
        :default -> nil
        :decimal -> number(id, 10)
        :hexadecimal -> number(id, 16)
      end

    case value do
      nil -> id
      number -> number
    end
  end

  @doc """
  The keys to look a receipt's message id up under, most likely first: the trunk's base, then the other base, then the
  text as sent. Duplicates are removed.
  """
  @spec receipt_keys(String.t(), type()) :: [String.t()]
  def receipt_keys(id, type) when is_binary(id) do
    id = String.trim(id)

    case type do
      :default -> [id]
      :decimal -> [number(id, 10), number(id, 16), id]
      :hexadecimal -> [number(id, 16), number(id, 10), id]
    end
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  # The value in decimal, or nil when the text is not a number in that base. A "0x" prefix is allowed in hex.
  @spec number(String.t(), 10 | 16) :: String.t() | nil
  defp number(text, 16) do
    digits = text |> String.replace_prefix("0x", "") |> String.replace_prefix("0X", "")
    parse(digits, 16, ~r/\A[0-9a-fA-F]{1,64}\z/)
  end

  defp number(text, 10), do: parse(text, 10, ~r/\A[0-9]{1,77}\z/)

  defp parse(digits, base, format) do
    if Regex.match?(format, digits), do: digits |> String.to_integer(base) |> Integer.to_string()
  end
end
