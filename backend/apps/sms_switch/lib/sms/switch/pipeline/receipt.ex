defmodule Sms.Switch.Pipeline.Receipt do
  @moduledoc """
  Delivery receipts (spec §2: receipt text `id:<msgid> sub:001 dlvrd:001 submit date:YYMMDDhhmm done date:YYMMDDhhmm
  stat:DELIVRD err:000 text:`, TLVs receipted_message_id, message_state, network_error_code).

    * `parse/1` reads a vendor's deliver_sm: the TLVs win over the text when both are there (S-5.7), and a mismatch is
      reported so it can be logged;
    * `build/1` makes the receipt the switch sends its customer.
  """
  import Bitwise
  alias Sms.Switch.Message.Text
  alias Sms.Switch.Smpp.Pdu

  @states %{
    "ENROUTE" => 1,
    "DELIVRD" => 2,
    "EXPIRED" => 3,
    "DELETED" => 4,
    "UNDELIV" => 5,
    "ACCEPTD" => 6,
    "UNKNOWN" => 7,
    "REJECTD" => 8
  }
  @by_state Map.new(@states, fn {k, v} -> {v, k} end)
  @finals ["DELIVRD", "EXPIRED", "DELETED", "UNDELIV", "UNKNOWN", "REJECTD"]

  @type t :: %{
          vendor_message_id: String.t(),
          status: String.t(),
          error: String.t(),
          network_error: non_neg_integer(),
          done_at: DateTime.t() | nil,
          mismatch: [atom()]
        }

  @doc "Whether a deliver_sm / data_sm is a receipt (esm_class SMSC delivery receipt or intermediate notification)."
  @spec receipt?(Pdu.t()) :: boolean()
  def receipt?(%Pdu{fields: fields}) do
    type = Map.get(fields, :esm_class, 0) &&& 0x3C
    type in [0x04, 0x08, 0x10, 0x20]
  end

  @doc "Whether a status is final (the first final status wins, S-5.8)."
  @spec final?(String.t()) :: boolean()
  def final?(status), do: status in @finals

  @doc "The SMPP message_state of a receipt status (UNKNOWN for anything else)."
  @spec state(String.t()) :: 1..8
  def state(status), do: Map.get(@states, status, 7)

  @doc "A vendor receipt's id, status, error and done date; `{:error, reason}` when it names no message."
  @spec parse(Pdu.t()) :: {:ok, t()} | {:error, atom()}
  def parse(%Pdu{} = pdu) do
    text = text_fields(Map.get(pdu.fields, :short_message, "") || "")
    tlv_id = tlv(pdu, :receipted_message_id)
    tlv_state = tlv(pdu, :message_state)
    tlv_network = tlv(pdu, :network_error_code)

    id = blank_to_nil(tlv_id) || text["id"]

    status =
      if tlv_state,
        do: Map.get(@by_state, tlv_state, "UNKNOWN"),
        else: normal_status(text["stat"])

    if is_nil(id) do
      {:error, :no_message_id}
    else
      {:ok,
       %{
         vendor_message_id: id,
         status: status,
         error: error_text(text["err"]),
         network_error: network_error(tlv_network),
         done_at: parse_date(text["done date"]),
         mismatch: mismatch(tlv_id, tlv_state, text)
       }}
    end
  end

  # Where the TLVs and the receipt text disagree.
  defp mismatch(tlv_id, tlv_state, text) do
    [
      (tlv_id != nil and text["id"] != nil and tlv_id != text["id"]) && :id,
      (tlv_state != nil and text["stat"] != nil and
         Map.get(@by_state, tlv_state) != normal_status(text["stat"])) &&
        :status
    ]
    |> Enum.filter(& &1)
  end

  defp tlv(pdu, name) do
    case List.keyfind(pdu.tlvs, name, 0) do
      {_, value} -> value
      nil -> nil
    end
  end

  defp blank_to_nil(nil), do: nil
  defp blank_to_nil(value), do: if(String.trim(value) == "", do: nil, else: String.trim(value))

  # "id:abc sub:001 ... stat:DELIVRD err:000 text:..." → a map; values never contain spaces except text (last).
  defp text_fields(text) when is_binary(text) do
    head = text |> String.split(~r/\btext:/i, parts: 2) |> hd()

    ~r/(id|sub|dlvrd|submit date|done date|stat|err):\s*(\S*)/i
    |> Regex.scan(head)
    |> Map.new(fn [_, key, value] -> {String.downcase(key), value} end)
  end

  defp normal_status(nil), do: "UNKNOWN"

  defp normal_status(stat) do
    up = String.upcase(stat)

    cond do
      Map.has_key?(@states, up) -> up
      # Some vendors write the long forms.
      String.starts_with?(up, "DELIVER") -> "DELIVRD"
      String.starts_with?(up, "UNDELIV") -> "UNDELIV"
      String.starts_with?(up, "REJECT") -> "REJECTD"
      String.starts_with?(up, "EXPIRE") -> "EXPIRED"
      String.starts_with?(up, "ACCEPT") -> "ACCEPTD"
      true -> "UNKNOWN"
    end
  end

  defp error_text(nil), do: "000"
  defp error_text(err), do: err |> String.slice(0, 3) |> String.pad_leading(3, "0")

  # network_error_code: 1 byte network type, 2 bytes error code.
  defp network_error(<<_type, code::16>>), do: code
  defp network_error(_), do: 0

  defp parse_date(nil), do: nil

  defp parse_date(
         <<y::binary-size(2), mo::binary-size(2), d::binary-size(2), h::binary-size(2),
           mi::binary-size(2), rest::binary>>
       ) do
    s = if byte_size(rest) >= 2, do: binary_part(rest, 0, 2), else: "00"

    with {:ok, [y, mo, d, h, mi, s]} <- integers([y, mo, d, h, mi, s]),
         {:ok, at} <- NaiveDateTime.new(2000 + y, mo, d, h, mi, s) do
      DateTime.from_naive!(at, "Etc/UTC")
    else
      _ -> nil
    end
  end

  defp parse_date(_), do: nil

  defp integers(texts) do
    Enum.reduce_while(texts, {:ok, []}, fn t, {:ok, acc} ->
      case Integer.parse(t) do
        {n, ""} -> {:cont, {:ok, acc ++ [n]}}
        _ -> {:halt, :error}
      end
    end)
  end

  @doc """
  The customer's receipt for one of its messages: deliver_sm fields and TLVs. `receipt` has `message_id` (ours),
  `source` / `destination` (the customer's original sender and receiver, swapped back), their TON / NPI, `status`,
  `error`, `submitted_at`, `done_at`, `text` (the original message, first 20 characters shown) and `network_error`.
  """
  @spec build(map()) :: {map(), list()}
  def build(r) do
    delivered = if r.status == "DELIVRD", do: 1, else: 0

    text =
      "id:#{r.message_id} sub:001 dlvrd:#{pad3(delivered)} submit date:#{date(r.submitted_at)} " <>
        "done date:#{date(r.done_at)} stat:#{r.status} err:#{r.error} text:#{String.slice(r.text || "", 0, 20)}"

    fields = %{
      source_addr_ton: r.source_ton,
      source_addr_npi: r.source_npi,
      source_addr: r.source,
      dest_addr_ton: r.destination_ton,
      dest_addr_npi: r.destination_npi,
      destination_addr: r.destination,
      esm_class: 0x04,
      data_coding: 0,
      short_message: receipt_bytes(text)
    }

    network =
      if r[:network_error] in [nil, 0],
        do: [],
        else: [network_error_code: <<3, r.network_error::16>>]

    tlvs = [receipted_message_id: r.message_id, message_state: state(r.status)] ++ network
    {fields, tlvs}
  end

  # The receipt text is ASCII apart from the message excerpt: characters outside GSM become ? so it always encodes.
  defp receipt_bytes(text) do
    {:ok, bytes} =
      text
      |> String.codepoints()
      |> Enum.map_join(&if(Text.gsm?(&1), do: &1, else: "?"))
      |> Text.encode(:gsm)

    bytes
  end

  defp pad3(n), do: n |> Integer.to_string() |> String.pad_leading(3, "0")

  defp date(nil), do: date(DateTime.utc_now())
  defp date(%DateTime{} = at), do: Calendar.strftime(at, "%y%m%d%H%M")
  defp date(ms) when is_integer(ms), do: ms |> DateTime.from_unix!(:millisecond) |> date()
end
