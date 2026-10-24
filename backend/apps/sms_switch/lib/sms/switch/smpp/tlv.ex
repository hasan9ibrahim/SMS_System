defmodule Sms.Switch.Smpp.Tlv do
  @moduledoc """
  SMPP 3.4 optional parameters (TLVs, spec §5.3). Known tags decode to named, typed values; unknown tags
  (vendor-specific 0x1400–0x3FFF and any other) are kept as `{tag, raw_binary}` so they can be logged or passed on.

  C-octet-string TLVs are accepted with or without their terminating NUL (many SMSCs omit it on
  `receipted_message_id`) and are always encoded with it.
  """

  # name => {tag, type}; types: :int8 | :int16 | :int32 | {:cstring, max_with_nul} | {:octets, min, max} | :empty
  @tags [
    dest_addr_subunit: {0x0005, :int8},
    dest_network_type: {0x0006, :int8},
    dest_bearer_type: {0x0007, :int8},
    dest_telematics_id: {0x0008, :int16},
    source_addr_subunit: {0x000D, :int8},
    source_network_type: {0x000E, :int8},
    source_bearer_type: {0x000F, :int8},
    source_telematics_id: {0x0010, :int8},
    qos_time_to_live: {0x0017, :int32},
    payload_type: {0x0019, :int8},
    additional_status_info_text: {0x001D, {:cstring, 256}},
    receipted_message_id: {0x001E, {:cstring, 65}},
    ms_msg_wait_facilities: {0x0030, :int8},
    privacy_indicator: {0x0201, :int8},
    source_subaddress: {0x0202, {:octets, 2, 23}},
    dest_subaddress: {0x0203, {:octets, 2, 23}},
    user_message_reference: {0x0204, :int16},
    user_response_code: {0x0205, :int8},
    source_port: {0x020A, :int16},
    destination_port: {0x020B, :int16},
    sar_msg_ref_num: {0x020C, :int16},
    language_indicator: {0x020D, :int8},
    sar_total_segments: {0x020E, :int8},
    sar_segment_seqnum: {0x020F, :int8},
    sc_interface_version: {0x0210, :int8},
    callback_num_pres_ind: {0x0302, :int8},
    callback_num_atag: {0x0303, {:octets, 0, 65}},
    number_of_messages: {0x0304, :int8},
    callback_num: {0x0381, {:octets, 4, 19}},
    dpf_result: {0x0420, :int8},
    set_dpf: {0x0421, :int8},
    ms_availability_status: {0x0422, :int8},
    network_error_code: {0x0423, {:octets, 3, 3}},
    message_payload: {0x0424, {:octets, 0, 65_535}},
    delivery_failure_reason: {0x0425, :int8},
    more_messages_to_send: {0x0426, :int8},
    message_state: {0x0427, :int8},
    ussd_service_op: {0x0501, :int8},
    display_time: {0x1201, :int8},
    sms_signal: {0x1203, :int16},
    ms_validity: {0x1204, :int8},
    alert_on_message_delivery: {0x130C, :empty},
    its_reply_type: {0x1380, :int8},
    its_session_info: {0x1383, :int16}
  ]

  @by_name Map.new(@tags)
  @by_tag Map.new(@tags, fn {name, {tag, type}} -> {tag, {name, type}} end)

  @type name :: atom()
  @type value :: non_neg_integer() | binary() | nil
  @type t :: {name() | non_neg_integer(), value()}

  @doc "The names of every known TLV."
  @spec names() :: [name()]
  def names, do: Keyword.keys(@tags)

  @doc "The type of a known TLV."
  @spec type(name()) :: term()
  def type(name), do: @by_name |> Map.fetch!(name) |> elem(1)

  @doc """
  Decodes a TLV stream (the rest of a PDU body). Errors carry the SMPP status to answer with:
  `:esme_rinvoptparstream` for a broken stream, `:esme_rinvparlen` for a known tag with a wrong length.
  """
  @spec decode(binary()) :: {:ok, [t()]} | {:error, atom(), term()}
  def decode(binary), do: decode(binary, [])

  defp decode(<<>>, acc), do: {:ok, Enum.reverse(acc)}

  defp decode(<<tag::16, len::16, value::binary-size(len), rest::binary>>, acc) do
    case Map.fetch(@by_tag, tag) do
      {:ok, {name, type}} ->
        case decode_value(type, value) do
          {:ok, v} -> decode(rest, [{name, v} | acc])
          :error -> {:error, :esme_rinvparlen, {:tlv_length, name, len}}
        end

      :error ->
        decode(rest, [{tag, value} | acc])
    end
  end

  defp decode(rest, _acc), do: {:error, :esme_rinvoptparstream, {:truncated_tlv, byte_size(rest)}}

  defp decode_value(:int8, <<v::8>>), do: {:ok, v}
  defp decode_value(:int16, <<v::16>>), do: {:ok, v}
  defp decode_value(:int32, <<v::32>>), do: {:ok, v}
  defp decode_value(:empty, <<>>), do: {:ok, nil}

  defp decode_value({:cstring, max}, value) when byte_size(value) <= max do
    text = String.trim_trailing(value, <<0>>)
    if String.contains?(text, <<0>>), do: :error, else: {:ok, text}
  end

  defp decode_value({:octets, min, max}, value)
       when byte_size(value) >= min and byte_size(value) <= max,
       do: {:ok, value}

  defp decode_value(_type, _value), do: :error

  @doc "Encodes TLVs; a value that does not fit its tag is an error naming it."
  @spec encode([t()]) :: {:ok, iodata()} | {:error, term()}
  def encode(tlvs) do
    Enum.reduce_while(tlvs, {:ok, []}, fn tlv, {:ok, acc} ->
      case encode_one(tlv) do
        {:ok, bin} -> {:cont, {:ok, [acc, bin]}}
        {:error, _} = error -> {:halt, error}
      end
    end)
  end

  defp encode_one({tag, value}) when is_integer(tag) and tag in 0..0xFFFF and is_binary(value) do
    if Map.has_key?(@by_tag, tag),
      do: {:error, {:use_tlv_name, tag}},
      else: frame(tag, value)
  end

  defp encode_one({name, value}) when is_atom(name) do
    case Map.fetch(@by_name, name) do
      {:ok, {tag, type}} ->
        case encode_value(type, value) do
          {:ok, bin} -> frame(tag, bin)
          :error -> {:error, {:invalid_tlv, name, value}}
        end

      :error ->
        {:error, {:unknown_tlv, name}}
    end
  end

  defp encode_one(other), do: {:error, {:invalid_tlv, other}}

  defp frame(tag, bin) when byte_size(bin) <= 0xFFFF,
    do: {:ok, <<tag::16, byte_size(bin)::16, bin::binary>>}

  defp frame(tag, _bin), do: {:error, {:tlv_too_long, tag}}

  defp encode_value(:int8, v) when is_integer(v) and v in 0..0xFF, do: {:ok, <<v::8>>}
  defp encode_value(:int16, v) when is_integer(v) and v in 0..0xFFFF, do: {:ok, <<v::16>>}
  defp encode_value(:int32, v) when is_integer(v) and v in 0..0xFFFFFFFF, do: {:ok, <<v::32>>}
  defp encode_value(:empty, nil), do: {:ok, <<>>}

  defp encode_value({:cstring, max}, v) when is_binary(v) and byte_size(v) < max do
    if String.contains?(v, <<0>>), do: :error, else: {:ok, v <> <<0>>}
  end

  defp encode_value({:octets, min, max}, v)
       when is_binary(v) and byte_size(v) >= min and byte_size(v) <= max,
       do: {:ok, v}

  defp encode_value(_type, _value), do: :error
end
