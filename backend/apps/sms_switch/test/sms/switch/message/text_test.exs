defmodule Sms.Switch.Message.TextTest do
  # data_coding, text conversions, part counts and splitting (spec §2, SMPP_SCENARIOS S-3.12, S-4.4, S-4.6).
  use ExUnit.Case, async: true
  use ExUnitProperties
  alias Sms.Switch.Message.{Concat, Text}

  describe "alphabet" do
    test "data_coding values, with the trunk's Default Coding for 0" do
      assert Text.alphabet(0) == :gsm
      assert Text.alphabet(0, 3) == :latin1
      assert Text.alphabet(1) == :ascii
      assert Text.alphabet(3) == :latin1
      assert Text.alphabet(8) == :ucs2
      for dc <- [2, 4, 5, 6, 7, 13, 14], do: assert(Text.alphabet(dc) == :binary)
    end

    test "GSM 03.38 coding groups" do
      assert Text.alphabet(0x10) == :gsm
      assert Text.alphabet(0x14) == :binary
      assert Text.alphabet(0x18) == :ucs2
      # Compressed text is opaque.
      assert Text.alphabet(0x30) == :binary
      assert Text.alphabet(0xC0) == :gsm
      assert Text.alphabet(0xE0) == :ucs2
      assert Text.alphabet(0xF0) == :gsm
      assert Text.alphabet(0xF4) == :binary
    end
  end

  describe "GSM 03.38" do
    test "the default alphabet and the extension table, both ways" do
      text = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./09:;<=>?¡AZÄÖÑÜ§¿azäöñüà"
      assert {:ok, bytes} = Text.encode(text, :gsm)
      assert byte_size(bytes) == String.length(text)
      assert Text.decode(bytes, :gsm) == {:ok, text}

      ext = "^{}\\[~]|€\f"
      assert {:ok, bytes} = Text.encode(ext, :gsm)
      assert byte_size(bytes) == 20
      assert :binary.first(bytes) == 0x1B
      assert Text.decode(bytes, :gsm) == {:ok, ext}
    end

    test "characters outside it cannot be encoded; bytes outside it decode as ?" do
      assert Text.encode("ş", :gsm) == :error
      assert Text.encode("emoji 😀", :gsm) == :error
      refute Text.gsm?("€ and ç")
      assert Text.gsm?("€ and Ç")
      assert Text.decode(<<0x41, 0x80, 0x42>>, :gsm) == {:ok, "A?B"}
      # An escape at the very end, and an unknown extension code.
      assert Text.decode(<<0x41, 0x1B>>, :gsm) == {:ok, "A?"}
      assert Text.decode(<<0x1B, 0x41>>, :gsm) == {:ok, "A"}
    end
  end

  test "Latin-1, IA5 and UCS-2" do
    assert Text.decode(<<0xE9, 0x41>>, :latin1) == {:ok, "éA"}
    assert Text.encode("éA", :latin1) == {:ok, <<0xE9, 0x41>>}
    assert Text.encode("€", :latin1) == :error
    assert Text.decode(<<0x41, 0xE9>>, :ascii) == {:ok, "A?"}
    assert Text.encode("é", :ascii) == :error
    assert {:ok, bytes} = Text.encode("A😀", :ucs2)
    assert bytes == <<0, 0x41, 0xD8, 0x3D, 0xDE, 0x00>>
    assert Text.decode(bytes, :ucs2) == {:ok, "A😀"}
    # A lone surrogate and an odd byte.
    assert Text.decode(<<0xD8, 0x3D, 0, 0x41, 0x42>>, :ucs2) == {:ok, "?A?"}
    assert Text.decode(<<1, 2, 3>>, :binary) == :binary
  end

  test "a changed text keeps its coding when it fits, else goes to UCS-2 (S-4.4)" do
    assert Text.fit("plain", :gsm) == :gsm
    assert Text.fit("ça", :gsm) == :ucs2
    assert Text.fit("ça", :latin1) == :latin1
    assert Text.fit("anything", :binary) == :binary
    assert Text.data_coding(:ucs2, 0) == 8
    assert Text.data_coding(:ucs2, 0x18) == 0x18
    assert Text.data_coding(:gsm, 0) == 0
  end

  describe "part counts (the screens' figures)" do
    test "7-bit: 160 in one part, then 153 per part; extension characters count twice" do
      assert Text.part_count(String.duplicate("a", 160), :gsm) == 1
      assert Text.part_count(String.duplicate("a", 161), :gsm) == 2
      assert Text.part_count(String.duplicate("a", 306), :gsm) == 2
      assert Text.part_count(String.duplicate("a", 307), :gsm) == 3
      {:ok, euros} = Text.encode(String.duplicate("€", 80), :gsm)
      assert Text.part_count(euros, :gsm) == 1
      {:ok, euros} = Text.encode(String.duplicate("€", 81), :gsm)
      assert Text.part_count(euros, :gsm) == 2
      assert Text.part_count(<<>>, :gsm) == 0
    end

    test "UCS-2: 70 then 67 units; 8-bit: 140 then 134 bytes" do
      assert Text.part_count(:binary.copy(<<0, 0x41>>, 70), :ucs2) == 1
      assert Text.part_count(:binary.copy(<<0, 0x41>>, 71), :ucs2) == 2
      assert Text.part_count(:binary.copy(<<0, 0x41>>, 134), :ucs2) == 2
      assert Text.part_count(:binary.copy(<<0, 0x41>>, 135), :ucs2) == 3
      assert Text.part_count(:binary.copy(<<1>>, 140), :binary) == 1
      assert Text.part_count(:binary.copy(<<1>>, 141), :latin1) == 2
      assert Text.part_count(:binary.copy(<<1>>, 269), :binary) == 3
    end
  end

  describe "split (S-3.12)" do
    test "a € at position 153 moves whole to the next part" do
      {:ok, bytes} =
        Text.encode(String.duplicate("a", 152) <> "€" <> String.duplicate("b", 10), :gsm)

      [first, second] = Text.split(bytes, :gsm)
      assert byte_size(first) == 152
      assert second == <<0x1B, 0x65>> <> String.duplicate("b", 10)
    end

    test "an emoji on the boundary is not cut" do
      {:ok, bytes} =
        Text.encode(String.duplicate("a", 66) <> "😀" <> String.duplicate("b", 10), :ucs2)

      [first, second] = Text.split(bytes, :ucs2)
      assert byte_size(first) == 132
      assert Text.decode(second, :ucs2) == {:ok, "😀" <> String.duplicate("b", 10)}
    end

    property "parts join back to the message, fit their size and each decode on its own" do
      check all(
              text <- string([?a..?z, ?€, ?^, ?Ä, ?\s], min_length: 1, max_length: 700),
              alphabet <- member_of([:gsm, :ucs2])
            ) do
        {:ok, bytes} = Text.encode(text, alphabet)
        parts = Text.split(bytes, alphabet)
        assert IO.iodata_to_binary(parts) == bytes
        max = if alphabet == :gsm, do: 153, else: 67
        if length(parts) > 1, do: assert(Enum.all?(parts, &(Text.units(&1, alphabet) <= max)))
        assert Enum.map_join(parts, &elem(Text.decode(&1, alphabet), 1)) == text
      end
    end

    property "emoji and runs of escapes are never cut" do
      check all(chars <- list_of(member_of(["a", "😀", "é"]), min_length: 60, max_length: 400)) do
        text = Enum.join(chars)
        {:ok, bytes} = Text.encode(text, :ucs2)
        assert Enum.map_join(Text.split(bytes, :ucs2), &elem(Text.decode(&1, :ucs2), 1)) == text
      end

      check all(n <- integer(1..400), lead <- integer(0..160)) do
        bytes = String.duplicate("a", lead) <> :binary.copy(<<0x1B, 0x65>>, n)
        parts = Text.split(bytes, :gsm)

        assert Enum.all?(
                 parts,
                 &(rem(byte_size(:binary.replace(&1, "a", "", [:global])), 2) == 0)
               )
      end
    end
  end

  describe "Concat" do
    test "UDH with an 8-bit or a 16-bit reference, other elements kept" do
      assert Concat.parse(<<5, 0, 3, 7, 3, 2, "hi">>, 0x40, []) ==
               {:ok, <<5, 0, 3, 7, 3, 2>>, "hi", %{ref: 7, total: 3, seq: 2, kind: :udh8}}

      assert Concat.parse(<<6, 8, 4, 1, 2, 2, 1, "x">>, 0x43, []) ==
               {:ok, <<6, 8, 4, 1, 2, 2, 1>>, "x", %{ref: 258, total: 2, seq: 1, kind: :udh16}}

      # A port element alone is not concatenation.
      assert Concat.parse(<<6, 5, 4, 0x0B, 0x84, 0x23, 0xF0, "y">>, 0x40, []) ==
               {:ok, <<6, 5, 4, 0x0B, 0x84, 0x23, 0xF0>>, "y", nil}
    end

    test "SAR TLVs, and messages without either" do
      tlvs = [sar_msg_ref_num: 513, sar_total_segments: 2, sar_segment_seqnum: 2]

      assert Concat.parse("body", 0, tlvs) ==
               {:ok, <<>>, "body", %{ref: 513, total: 2, seq: 2, kind: :sar}}

      assert Concat.parse("body", 0, []) == {:ok, <<>>, "body", nil}
    end

    test "inconsistent parts are refused (S-3.6)" do
      assert Concat.parse(<<5, 0, 3, 7, 3, 4, "x">>, 0x40, []) == {:error, :invalid_concatenation}
      assert Concat.parse(<<5, 0, 3, 7, 1, 1, "x">>, 0x40, []) == {:error, :invalid_concatenation}
      assert Concat.parse(<<5, 0, 3, 7, 0, 0, "x">>, 0x40, []) == {:error, :invalid_concatenation}
      assert Concat.parse(<<9, 0, 3>>, 0x40, []) == {:error, :invalid_udh}
      assert Concat.parse(<<4, 0, 2, 7, 3>>, 0x40, []) == {:error, :invalid_udh}
      assert Concat.parse(<<>>, 0x40, []) == {:error, :invalid_udh}
      assert Concat.parse("x", 0, sar_msg_ref_num: 1) == {:error, :incomplete_sar}

      assert Concat.parse(<<5, 0, 3, 7, 2, 1, "x">>, 0x40,
               sar_msg_ref_num: 1,
               sar_total_segments: 2,
               sar_segment_seqnum: 1
             ) ==
               {:error, :concatenation_twice}

      assert Concat.parse(<<10, 0, 3, 7, 2, 1, 0, 3, 7, 2, 1>>, 0x40, []) ==
               {:error, :concatenation_twice}
    end

    test "other UDH elements are kept, after the switch's concatenation element (D9)" do
      udh = <<11, 0x00, 3, 7, 2, 1, 0x24, 1, 1, 0x25, 1, 2>>
      assert Concat.other_elements(udh) == <<0x24, 1, 1, 0x25, 1, 2>>
      assert Concat.other_elements(udh, [0x00, 0x08, 0x24, 0x25]) == <<>>
      assert Concat.other_elements(<<>>) == <<>>
      assert Concat.udh(<<0x24, 1, 1>>) == <<3, 0x24, 1, 1>>
      assert Concat.udh(<<>>) == <<>>
      assert Concat.udh8(9, 3, 1, <<0x24, 1, 1>>) == <<8, 0, 3, 9, 3, 1, 0x24, 1, 1>>
      assert Concat.udh16(9, 3, 1, <<0x24, 1, 1>>) == <<9, 8, 4, 0, 9, 3, 1, 0x24, 1, 1>>
    end

    test "other UDH elements take their room in every part and in a single SMS" do
      # A single SMS with a 4-octet header (shift table): 155 septets.
      assert Text.part_count(String.duplicate("a", 155), :gsm, 3) == 1
      assert Text.part_count(String.duplicate("a", 156), :gsm, 3) == 2
      # Parts with a 9-octet header: 149 septets; 8-bit 131 bytes.
      assert Enum.map(Text.split(String.duplicate("a", 300), :gsm, 6, 3), &byte_size/1) == [
               149,
               149,
               2
             ]

      assert Enum.map(Text.split(:binary.copy(<<1>>, 200), :binary, 6, 7), &byte_size/1) == [
               127,
               73
             ]
    end

    test "headers the switch builds" do
      assert Concat.udh8(9, 3, 1) == <<5, 0, 3, 9, 3, 1>>
      assert Concat.with_udhi(0x03) == 0x43
      assert Concat.udhi?(0x43)
      refute Concat.udhi?(0x03)
    end
  end
end
