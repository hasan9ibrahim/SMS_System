defmodule Sms.Switch.Message.Concat do
  @moduledoc """
  Concatenated (multipart) messages (docs/SMPP_SCENARIOS.md §3): the user data header (UDH) at the start of
  `short_message` when esm_class has the UDHI bit, or the SAR TLVs.

  Recognised concatenation: UDH IE 0x00 (8-bit reference) and IE 0x08 (16-bit reference), and SAR
  (`sar_msg_ref_num`, `sar_total_segments`, `sar_segment_seqnum`). Other UDH elements (ports, national language shift
  tables, S-3.12, D9) are kept and passed on with the message: on a single message as they came, in every part the
  switch makes after its own concatenation element (`other_elements/2`).
  """
  import Bitwise

  @udhi 0x40

  @type info :: %{
          ref: non_neg_integer(),
          total: pos_integer(),
          seq: pos_integer(),
          kind: :udh8 | :udh16 | :sar
        }

  @doc "Whether esm_class says `short_message` starts with a UDH."
  @spec udhi?(non_neg_integer()) :: boolean()
  def udhi?(esm_class), do: (esm_class &&& @udhi) != 0

  @doc """
  Splits a message body into its UDH and its user data, and reads the concatenation, if any.

  `{:ok, udh, data, info}`: `udh` is the whole header with its length byte (`<<>>` when none), `info` the part's
  place in its message or nil for a single message. `{:error, reason}` for a header that does not hold together or
  concatenation fields out of range (S-3.6): answered 0x01 or 0xC1 by the caller.
  """
  @spec parse(binary(), non_neg_integer(), list()) ::
          {:ok, binary(), binary(), info() | nil} | {:error, atom()}
  def parse(body, esm_class, tlvs) do
    with {:ok, udh, data} <- header(body, udhi?(esm_class)),
         {:ok, from_udh} <- udh_concat(udh),
         {:ok, from_sar} <- sar(tlvs) do
      case {from_udh, from_sar} do
        {nil, info} -> {:ok, udh, data, info}
        {info, nil} -> {:ok, udh, data, info}
        {_, _} -> {:error, :concatenation_twice}
      end
    end
  end

  defp header(body, false), do: {:ok, <<>>, body}

  defp header(<<len, rest::binary>>, true) when byte_size(rest) >= len do
    <<ies::binary-size(len), data::binary>> = rest
    {:ok, <<len, ies::binary>>, data}
  end

  defp header(_body, true), do: {:error, :invalid_udh}

  defp udh_concat(<<>>), do: {:ok, nil}
  defp udh_concat(<<_len, ies::binary>>), do: elements(ies, nil)

  defp elements(<<>>, found), do: {:ok, found}

  defp elements(<<iei, len, rest::binary>>, found) when byte_size(rest) >= len do
    <<value::binary-size(len), more::binary>> = rest

    case {iei, value} do
      {0x00, <<ref, total, seq>>} -> concat_ie(more, found, ref, total, seq, :udh8)
      {0x08, <<ref::16, total, seq>>} -> concat_ie(more, found, ref, total, seq, :udh16)
      {iei, _} when iei in [0x00, 0x08] -> {:error, :invalid_udh}
      _other -> elements(more, found)
    end
  end

  defp elements(_ies, _found), do: {:error, :invalid_udh}

  defp concat_ie(_more, %{}, _ref, _total, _seq, _kind), do: {:error, :concatenation_twice}

  defp concat_ie(more, nil, ref, total, seq, kind) do
    with {:ok, info} <- info(ref, total, seq, kind), do: elements(more, info)
  end

  defp sar(tlvs) do
    fields = [:sar_msg_ref_num, :sar_total_segments, :sar_segment_seqnum]

    case Enum.map(fields, &List.keyfind(tlvs, &1, 0)) do
      [nil, nil, nil] -> {:ok, nil}
      [{_, ref}, {_, total}, {_, seq}] -> info(ref, total, seq, :sar)
      _some -> {:error, :incomplete_sar}
    end
  end

  # S-3.6: a total of 0 or 1, or a sequence outside 1..total, is not a multipart part.
  defp info(ref, total, seq, kind) when total >= 2 and seq >= 1 and seq <= total,
    do: {:ok, %{ref: ref, total: total, seq: seq, kind: kind}}

  defp info(_ref, _total, _seq, _kind), do: {:error, :invalid_concatenation}

  @doc """
  The elements of `udh` (a whole header with its length byte, or `<<>>`) but those whose IEI is in `drop` (by default
  the concatenation ones), without the length byte: what a message's parts carry on beside the switch's own
  concatenation (ports, national language shift tables, D9, S-3.12).
  """
  @spec other_elements(binary(), [byte()]) :: binary()
  def other_elements(udh, drop \\ [0x00, 0x08])
  def other_elements(<<>>, _drop), do: <<>>
  def other_elements(<<_len, ies::binary>>, drop), do: keep(ies, drop, [])

  defp keep(<<iei, len, rest::binary>>, drop, acc) when byte_size(rest) >= len do
    <<value::binary-size(len), more::binary>> = rest
    keep(more, drop, if(iei in drop, do: acc, else: [acc, iei, len, value]))
  end

  defp keep(_ies, _drop, acc), do: IO.iodata_to_binary(acc)

  @doc "A UDH of these elements with its length byte; none (`<<>>`) for no elements."
  @spec udh(binary()) :: binary()
  def udh(<<>>), do: <<>>
  def udh(ies), do: <<byte_size(ies), ies::binary>>

  @doc """
  A UDH with an 8-bit concatenation element, for a part the switch made (S-3.1, S-3.10), then the message's other
  elements `ies`.
  """
  @spec udh8(0..255, 2..255, 1..255, binary()) :: binary()
  def udh8(ref, total, seq, ies \\ <<>>),
    do: <<5 + byte_size(ies), 0x00, 3, ref, total, seq, ies::binary>>

  @doc "A UDH with a 16-bit concatenation element (S-3.10), then the message's other elements `ies`."
  @spec udh16(0..65_535, 1..255, 1..255, binary()) :: binary()
  def udh16(ref, total, seq, ies \\ <<>>),
    do: <<6 + byte_size(ies), 0x08, 4, ref::16, total, seq, ies::binary>>

  @doc "esm_class with the UDHI bit set."
  @spec with_udhi(non_neg_integer()) :: non_neg_integer()
  def with_udhi(esm_class), do: esm_class ||| @udhi
end
