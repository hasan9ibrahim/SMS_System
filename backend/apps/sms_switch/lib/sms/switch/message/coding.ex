defmodule Sms.Switch.Message.Coding do
  @moduledoc """
  The coding a message goes to a vendor in (spec §5.5 AllowedDataCodingList, docs/SMPP_SCENARIOS.md S-2.11, S-4.4,
  S-4.6), shared by routing (a vendor that cannot take it is skipped) and the sender:

    * a text no translation changed goes as the customer sent it; a changed one is encoded again in its alphabet, or
      in UCS-2 when a character no longer fits (S-4.4);
    * Latin-1 bytes under data_coding 0 (a customer trunk whose Default Coding is Latin-1) would be read as GSM by the
      vendor: they go in GSM when every character has one and it needs no more parts, else as data_coding 3 (S-2.11);
    * a coding the vendor does not allow is converted to one it allows when the text fits and needs no more parts
      (e.g. 3 → 0 when every character is in GSM, S-2.11); otherwise the vendor cannot take the message.
  """
  alias Sms.Switch.Message.Text

  @typedoc "The message as the customer sent it: its bytes, their alphabet and data_coding, and its text (nil: binary)."
  @type message :: %{
          required(:body) => binary(),
          required(:alphabet) => Text.alphabet() | nil,
          required(:data_coding) => non_neg_integer(),
          required(:text) => String.t() | nil,
          optional(atom()) => term()
        }

  # The codings a text may be converted to, in the order tried.
  @conversions [{:gsm, 0}, {:ascii, 1}, {:latin1, 3}, {:ucs2, 8}]

  @doc """
  The bytes, alphabet and data_coding the message goes in with its text after translation (`text`, nil when there is
  none), the vendor allowing `allowed` (nil: any). Errors: `:unencodable` (a changed text that cannot be encoded),
  `:coding_not_allowed` (no coding the vendor allows fits).
  """
  @spec for_vendor(message(), String.t() | nil, [non_neg_integer()] | nil) ::
          {:ok, binary(), Text.alphabet(), non_neg_integer()}
          | {:error, :unencodable | :coding_not_allowed}
  def for_vendor(msg, text, allowed) do
    case natural(msg, text) do
      {:error, _alphabet, _coding} ->
        {:error, :unencodable}

      {bytes, alphabet, coding} ->
        if allowed == nil or coding in allowed,
          do: {:ok, bytes, alphabet, coding},
          else: convert({bytes, alphabet}, text || msg.text, allowed)
    end
  end

  @doc """
  The bytes, alphabet and data_coding the message goes in whatever the vendor allows; `{:error, alphabet, coding}`
  for a changed text that cannot be encoded.
  """
  @spec natural(message(), String.t() | nil) ::
          {binary(), Text.alphabet(), non_neg_integer()}
          | {:error, Text.alphabet(), non_neg_integer()}
  def natural(msg, text), do: msg |> encoded(text) |> latin1_as_gsm(text || msg.text)

  defp encoded(%{text: nil} = msg, _text), do: {msg.body, msg.alphabet, msg.data_coding}

  defp encoded(msg, text) when text == msg.text or is_nil(text),
    do: {msg.body, msg.alphabet, msg.data_coding}

  defp encoded(msg, text) do
    alphabet = Text.fit(text, msg.alphabet)

    case Text.encode(text, alphabet) do
      {:ok, bytes} -> {bytes, alphabet, Text.data_coding(alphabet, msg.data_coding)}
      :error -> {:error, alphabet, msg.data_coding}
    end
  end

  defp latin1_as_gsm({bytes, :latin1, 0}, text) when is_binary(bytes) do
    with {:ok, gsm} <- Text.encode(text, :gsm),
         true <- Text.part_count(gsm, :gsm) <= Text.part_count(bytes, :latin1) do
      {gsm, :gsm, 0}
    else
      _ -> {bytes, :latin1, 3}
    end
  end

  defp latin1_as_gsm(encoded, _text), do: encoded

  # Binary data is never converted; a text goes in the first coding the vendor allows that it fits in no more parts.
  defp convert({_bytes, :binary}, _text, _allowed), do: {:error, :coding_not_allowed}
  defp convert(_natural, nil, _allowed), do: {:error, :coding_not_allowed}

  defp convert({bytes, alphabet}, text, allowed) do
    parts = Text.part_count(bytes, alphabet)

    Enum.find_value(@conversions, {:error, :coding_not_allowed}, fn {to, coding} ->
      with true <- coding in allowed,
           {:ok, converted} <- Text.encode(text, to),
           true <- Text.part_count(converted, to) <= parts do
        {:ok, converted, to, coding}
      else
        _ -> nil
      end
    end)
  end
end
