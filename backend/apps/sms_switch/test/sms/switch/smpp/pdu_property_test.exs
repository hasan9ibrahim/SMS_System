defmodule Sms.Switch.Smpp.PduPropertyTest do
  # Generated PDUs of every command (S-1.8: random splits and merges; fuzzing: never a crash).
  use ExUnit.Case, async: true
  use ExUnitProperties
  alias Sms.Switch.Smpp.{Command, Pdu, Tlv}

  defp cstring(max),
    do: StreamData.string(Enum.concat([?0..?9, ?A..?Z, ?a..?z, [?+, ?\s]]), max_length: max - 1)

  defp time do
    StreamData.one_of([
      StreamData.constant(""),
      StreamData.map({StreamData.integer(0..99), StreamData.member_of(["+", "-", "R"])}, fn {yy,
                                                                                             p} ->
        String.pad_leading(Integer.to_string(yy), 2, "0") <> "1024120000" <> "0" <> "04" <> p
      end)
    ])
  end

  defp value({:cstring, max, _}), do: cstring(max)
  defp value(:int8), do: StreamData.integer(0..255)
  defp value({:time, _}), do: time()
  defp value(:short_message), do: StreamData.binary(max_length: 254)

  defp value(:dest_addresses) do
    sme =
      StreamData.fixed_map(%{
        dest_flag: StreamData.constant(1),
        ton: value(:int8),
        npi: value(:int8),
        address: cstring(21)
      })

    dl = StreamData.fixed_map(%{dest_flag: StreamData.constant(2), dl_name: cstring(21)})
    StreamData.list_of(StreamData.one_of([sme, dl]), min_length: 1, max_length: 5)
  end

  defp value(:unsuccess_smes) do
    StreamData.list_of(
      StreamData.fixed_map(%{
        ton: value(:int8),
        npi: value(:int8),
        address: cstring(21),
        error_status_code: StreamData.integer(0..0xFFFFFFFF)
      }),
      max_length: 4
    )
  end

  defp tlv_value(:int8), do: StreamData.integer(0..0xFF)
  defp tlv_value(:int16), do: StreamData.integer(0..0xFFFF)
  defp tlv_value(:int32), do: StreamData.integer(0..0xFFFFFFFF)
  defp tlv_value(:empty), do: StreamData.constant(nil)
  defp tlv_value({:cstring, max}), do: cstring(max)

  defp tlv_value({:octets, min, max}),
    do: StreamData.binary(min_length: min, max_length: min(max, 40))

  defp tlvs do
    known =
      StreamData.bind(StreamData.member_of(Tlv.names() -- [:message_payload]), fn name ->
        StreamData.map(tlv_value(Tlv.type(name)), &{name, &1})
      end)

    vendor =
      StreamData.tuple({StreamData.integer(0x1400..0x3FFF), StreamData.binary(max_length: 20)})

    StreamData.list_of(StreamData.one_of([known, vendor]), max_length: 4)
  end

  defp pdu do
    StreamData.bind(StreamData.member_of(Command.all()), fn command ->
      fields =
        command
        |> Pdu.layout()
        |> Map.new(fn {name, type} -> {name, value(type)} end)
        |> StreamData.fixed_map()

      StreamData.map({fields, tlvs(), StreamData.integer(1..0x7FFFFFFF)}, fn {fields, tlvs, seq} ->
        %Pdu{command: command, sequence: seq, status: 0, fields: fields, tlvs: tlvs}
      end)
    end)
  end

  property "every command: encode then decode gives the same PDU" do
    check all(pdu <- pdu(), max_runs: 500) do
      bin = Pdu.encode!(pdu)
      assert {:ok, decoded, ""} = Pdu.decode(bin)
      expected = if pdu.fields == %{} or not Command.response?(pdu.command), do: pdu, else: pdu
      assert decoded == expected
    end
  end

  property "a stream of PDUs split into any chunks decodes to the same PDUs in order (S-1.8)" do
    check all(
            pdus <- StreamData.list_of(pdu(), min_length: 1, max_length: 6),
            cuts <- StreamData.list_of(StreamData.integer(1..64), max_length: 30)
          ) do
      stream = pdus |> Enum.map(&Pdu.encode!/1) |> IO.iodata_to_binary()
      assert feed(chunks(stream, cuts), "", []) == pdus
    end
  end

  defp chunks(bin, []), do: [bin]

  defp chunks(bin, [n | ns]) when byte_size(bin) > n,
    do: [binary_part(bin, 0, n) | chunks(binary_part(bin, n, byte_size(bin) - n), ns)]

  defp chunks(bin, _), do: [bin]

  # What a session does: append each read to the buffer and decode while whole PDUs are there.
  defp feed([], "", acc), do: Enum.reverse(acc)
  defp feed([chunk | chunks], buffer, acc), do: drain(buffer <> chunk, chunks, acc)

  defp drain(buffer, chunks, acc) do
    case Pdu.decode(buffer) do
      {:ok, pdu, rest} -> drain(rest, chunks, [pdu | acc])
      {:incomplete, _} -> feed(chunks, buffer, acc)
    end
  end

  property "random bytes never crash the decoder" do
    check all(bin <- StreamData.binary(max_length: 300), max_runs: 1_000) do
      assert_decodes_or_errors(bin)
    end
  end

  property "valid frames with random bytes corrupted never crash the decoder; errors always have a reply rule" do
    check all(
            pdu <- pdu(),
            flips <-
              StreamData.list_of(
                StreamData.tuple({StreamData.integer(0..1000), StreamData.integer(0..255)}),
                min_length: 1,
                max_length: 4
              ),
            max_runs: 500
          ) do
      bin = Pdu.encode!(pdu)

      corrupted =
        Enum.reduce(flips, bin, fn {pos, byte}, acc ->
          i = rem(pos, byte_size(acc))
          <<pre::binary-size(i), _::8, post::binary>> = acc
          <<pre::binary, byte, post::binary>>
        end)

      assert_decodes_or_errors(corrupted)
    end
  end

  defp assert_decodes_or_errors(bin) do
    case Pdu.decode(bin) do
      {:ok, %Pdu{}, rest} ->
        assert byte_size(rest) < byte_size(bin)

      {:incomplete, n} ->
        assert n > 0

      {:error, %Pdu.Error{} = e, rest} ->
        assert is_atom(e.status)
        assert byte_size(rest) < byte_size(bin) or bin == ""
        reply = Pdu.error_reply(e)
        assert reply == nil or match?({:ok, _}, Pdu.encode(reply))
    end
  end
end
