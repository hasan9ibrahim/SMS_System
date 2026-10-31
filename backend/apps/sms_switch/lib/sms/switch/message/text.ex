defmodule Sms.Switch.Message.Text do
  @moduledoc """
  Message text in SMPP (spec §2 data_coding, docs/SMPP_SCENARIOS.md §3–§4): which alphabet a `data_coding` means, the
  bytes ⇄ text conversions, how many SMS parts a message needs, and splitting it into parts.

  Alphabets:

    * `:gsm`: GSM 03.38 default alphabet, one byte per septet, unpacked (SMPP's usual form); the extension table
      characters (`^ { } \\ [ ~ ] | €` and form feed) take two septets (escape + code);
    * `:ascii`: IA5 (data_coding 1), counted like GSM (7-bit), as the screens do;
    * `:latin1`: ISO-8859-1 (data_coding 3, or 0 on a trunk whose Default Coding is Latin-1), one byte per character;
    * `:ucs2`: UTF-16 big-endian (data_coding 8); a character outside the BMP takes two units (a surrogate pair);
    * `:binary`: anything else (8-bit data, JIS, Cyrillic, Hebrew, Kanji…): passed on as bytes, never read as text.

  Part sizes (S-3.12): 160 / 153 septets for 7-bit, 70 / 67 units for UCS-2, 140 / 134 bytes for 8-bit; the second
  figure leaves room for the 6-octet concatenation header. A split never cuts an escape sequence or a surrogate pair.
  """

  import Bitwise

  @type alphabet :: :gsm | :ascii | :latin1 | :ucs2 | :binary

  # GSM 03.38 default alphabet, code 0x00..0x7F; 0x1B is the escape to the extension table.
  @basic [
    "@",
    "£",
    "$",
    "¥",
    "è",
    "é",
    "ù",
    "ì",
    "ò",
    "Ç",
    "\n",
    "Ø",
    "ø",
    "\r",
    "Å",
    "å",
    "Δ",
    "_",
    "Φ",
    "Γ",
    "Λ",
    "Ω",
    "Π",
    "Ψ",
    "Σ",
    "Θ",
    "Ξ",
    nil,
    "Æ",
    "æ",
    "ß",
    "É",
    " ",
    "!",
    "\"",
    "#",
    "¤",
    "%",
    "&",
    "'",
    "(",
    ")",
    "*",
    "+",
    ",",
    "-",
    ".",
    "/",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    ":",
    ";",
    "<",
    "=",
    ">",
    "?",
    "¡",
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z",
    "Ä",
    "Ö",
    "Ñ",
    "Ü",
    "§",
    "¿",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "ä",
    "ö",
    "ñ",
    "ü",
    "à"
  ]
  @extension %{
    0x0A => "\f",
    0x14 => "^",
    0x28 => "{",
    0x29 => "}",
    0x2F => "\\",
    0x3C => "[",
    0x3D => "~",
    0x3E => "]",
    0x40 => "|",
    0x65 => "€"
  }

  @decode_basic @basic
                |> Enum.with_index()
                |> Enum.reject(&is_nil(elem(&1, 0)))
                |> Map.new(fn {c, i} -> {i, c} end)
  @encode_basic Map.new(@decode_basic, fn {i, c} -> {c, i} end)
  @encode_extension Map.new(@extension, fn {i, c} -> {c, i} end)
  @escape 0x1B
  # Shown for a byte or unit that does not belong to the alphabet (never silently dropped, S-4.6).
  @replacement "?"

  @single %{seven: 160, ucs2: 70, eight: 140}

  @doc """
  The alphabet of a `data_coding`, per SMPP 3.4 §5.2.19 and GSM 03.38 §4 coding groups. `default_coding` is the
  customer trunk's Default Coding (0 GSM or 3 Latin-1), used when `data_coding` is 0.
  """
  @spec alphabet(non_neg_integer(), 0 | 3) :: alphabet()
  def alphabet(data_coding, default_coding \\ 0)
  def alphabet(0, 3), do: :latin1
  def alphabet(0, _), do: :gsm
  def alphabet(1, _), do: :ascii
  def alphabet(3, _), do: :latin1
  def alphabet(8, _), do: :ucs2

  # General data coding (00xx xxxx): bits 3–2 give the alphabet; compressed text (bit 5) is opaque.
  def alphabet(dc, _) when dc in 0x10..0x3F and (dc &&& 0x20) == 0, do: general(dc &&& 0x0C)
  # Message waiting groups: 1100 / 1101 GSM, 1110 UCS-2.
  def alphabet(dc, _) when dc in 0xC0..0xDF, do: :gsm
  def alphabet(dc, _) when dc in 0xE0..0xEF, do: :ucs2
  # Data coding / message class (1111 xxxx): bit 2 = 8-bit, else GSM.
  def alphabet(dc, _) when dc in 0xF0..0xFF, do: if((dc &&& 0x04) == 0, do: :gsm, else: :binary)
  def alphabet(_dc, _), do: :binary

  defp general(0x00), do: :gsm
  defp general(0x08), do: :ucs2
  defp general(_), do: :binary

  @doc "The text of `bytes` in `alphabet`, or `:binary` for an alphabet that is not text."
  @spec decode(binary(), alphabet()) :: {:ok, String.t()} | :binary
  def decode(_bytes, :binary), do: :binary
  def decode(bytes, :gsm), do: {:ok, decode_gsm(bytes, [])}

  def decode(bytes, :ascii),
    do: {:ok, for(<<b <- bytes>>, into: "", do: if(b < 0x80, do: <<b>>, else: @replacement))}

  def decode(bytes, :latin1), do: {:ok, :unicode.characters_to_binary(bytes, :latin1)}
  def decode(bytes, :ucs2), do: {:ok, decode_ucs2(bytes, [])}

  defp decode_gsm(<<@escape, code, rest::binary>>, acc),
    # An unknown extension code shows as its default-alphabet character (GSM 03.38 §6.2.1.1).
    do:
      decode_gsm(rest, [
        Map.get(@extension, code) || Map.get(@decode_basic, code, @replacement) | acc
      ])

  defp decode_gsm(<<@escape>>, acc), do: decode_gsm(<<>>, [@replacement | acc])

  defp decode_gsm(<<b, rest::binary>>, acc),
    do: decode_gsm(rest, [Map.get(@decode_basic, b, @replacement) | acc])

  defp decode_gsm(<<>>, acc), do: acc |> Enum.reverse() |> IO.iodata_to_binary()

  # A lone surrogate or an odd last byte shows as the replacement character.
  defp decode_ucs2(<<hi::16, lo::16, rest::binary>>, acc)
       when hi in 0xD800..0xDBFF and lo in 0xDC00..0xDFFF,
       do: decode_ucs2(rest, [<<0x10000 + ((hi - 0xD800) <<< 10) + (lo - 0xDC00)::utf8>> | acc])

  defp decode_ucs2(<<u::16, rest::binary>>, acc) when u in 0xD800..0xDFFF,
    do: decode_ucs2(rest, [@replacement | acc])

  defp decode_ucs2(<<u::16, rest::binary>>, acc), do: decode_ucs2(rest, [<<u::utf8>> | acc])
  defp decode_ucs2(<<_odd>>, acc), do: decode_ucs2(<<>>, [@replacement | acc])
  defp decode_ucs2(<<>>, acc), do: acc |> Enum.reverse() |> IO.iodata_to_binary()

  @doc "The bytes of `text` in `alphabet`, or `:error` when a character does not exist in it."
  @spec encode(String.t(), alphabet()) :: {:ok, binary()} | :error
  def encode(text, :gsm), do: encode_gsm(String.codepoints(text), [])
  def encode(text, :ascii), do: if(ascii?(text), do: {:ok, text}, else: :error)

  def encode(text, :latin1) do
    case :unicode.characters_to_binary(text, :utf8, :latin1) do
      bytes when is_binary(bytes) -> {:ok, bytes}
      _ -> :error
    end
  end

  def encode(text, :ucs2) do
    case :unicode.characters_to_binary(text, :utf8, {:utf16, :big}) do
      bytes when is_binary(bytes) -> {:ok, bytes}
      _ -> :error
    end
  end

  def encode(_text, :binary), do: :error

  defp encode_gsm([], acc), do: {:ok, acc |> Enum.reverse() |> IO.iodata_to_binary()}

  defp encode_gsm([c | rest], acc) do
    case @encode_basic do
      %{^c => code} ->
        encode_gsm(rest, [code | acc])

      _ ->
        case @encode_extension do
          %{^c => code} -> encode_gsm(rest, [code, @escape | acc])
          _ -> :error
        end
    end
  end

  defp ascii?(text), do: for(<<b <- text>>, reduce: true, do: (ok -> ok and b < 0x80))

  @doc "Whether every character of `text` exists in the GSM alphabet."
  @spec gsm?(String.t()) :: boolean()
  def gsm?(text), do: encode(text, :gsm) != :error

  @doc """
  The alphabet a changed text needs (S-4.4): the original one when every character fits, else UCS-2 for text, so a
  translation that adds "é€" or an emoji changes the coding instead of losing characters.
  """
  @spec fit(String.t(), alphabet()) :: alphabet()
  def fit(_text, :binary), do: :binary
  def fit(text, alphabet), do: if(encode(text, alphabet) == :error, do: :ucs2, else: alphabet)

  @doc "The `data_coding` to send for an alphabet chosen by `fit/2`, keeping the original when it did not change."
  @spec data_coding(alphabet(), non_neg_integer()) :: non_neg_integer()
  def data_coding(:ucs2, original) when original != 8,
    do: if(alphabet(original) == :ucs2, do: original, else: 8)

  def data_coding(_alphabet, original), do: original

  @doc """
  How long `bytes` are in the alphabet's own units: septets for 7-bit (escapes count), UTF-16 units for UCS-2, bytes
  otherwise.
  """
  @spec units(binary(), alphabet()) :: non_neg_integer()
  def units(bytes, :ucs2), do: div(byte_size(bytes) + 1, 2)
  def units(bytes, _alphabet), do: byte_size(bytes)

  @doc "How many SMS parts `bytes` need (0 for no bytes, which still go as one empty part)."
  @spec part_count(binary(), alphabet()) :: non_neg_integer()
  def part_count(<<>>, _alphabet), do: 0
  def part_count(bytes, alphabet), do: length(split(bytes, alphabet))

  @doc """
  The bytes of each part, without the concatenation header: one part when the message fits in a single SMS, else
  parts that leave room for a header of `header_octets` in the 140-octet user data (6: UDH with an 8-bit reference,
  153 septets / 67 units / 134 bytes, also SAR, whose header the vendor's SMSC adds on air; 7: a 16-bit reference,
  152 / 66 / 133; 0: no header, 160 / 70 / 140), never cutting an escape sequence or a surrogate pair (S-3.1,
  S-3.10).
  """
  @spec split(binary(), alphabet(), 0..7) :: [binary()]
  def split(bytes, alphabet, header_octets \\ 6) do
    kind = kind(alphabet)

    if units(bytes, alphabet) <= @single[kind] do
      [bytes]
    else
      chunk(bytes, alphabet, size(alphabet, per_part(kind, header_octets)), [])
    end
  end

  # Units left in one part after a header of `h` octets; a 7-bit header is padded to whole septets.
  defp per_part(:seven, h), do: 160 - div(h * 8 + 6, 7)
  defp per_part(:ucs2, h), do: div(140 - h, 2)
  defp per_part(:eight, h), do: 140 - h

  defp kind(a) when a in [:gsm, :ascii], do: :seven
  defp kind(:ucs2), do: :ucs2
  defp kind(_), do: :eight

  # Bytes per part for the unit count.
  defp size(:ucs2, units), do: units * 2
  defp size(_alphabet, units), do: units

  defp chunk(<<>>, _alphabet, _size, acc), do: Enum.reverse(acc)

  defp chunk(bytes, _alphabet, size, acc) when byte_size(bytes) <= size,
    do: Enum.reverse([bytes | acc])

  defp chunk(bytes, alphabet, size, acc) do
    cut = safe_cut(bytes, alphabet, size)
    <<part::binary-size(cut), rest::binary>> = bytes
    chunk(rest, alphabet, size, [part | acc])
  end

  # Moves the cut back by one unit when it would separate an escape from its code, or a high surrogate from its low.
  defp safe_cut(bytes, :gsm, size) do
    if escape_before?(bytes, size), do: size - 1, else: size
  end

  defp safe_cut(bytes, :ucs2, size) do
    <<_::binary-size(size - 2), last::16, _::binary>> = bytes
    if last in 0xD800..0xDBFF, do: size - 2, else: size
  end

  defp safe_cut(_bytes, _alphabet, size), do: size

  # Whether byte `size - 1` is an escape that opens a sequence. Escapes pair up from the start of their run (the part
  # starts on a sequence boundary), so an odd run at the end of the part leaves its last escape without its code.
  defp escape_before?(bytes, size) do
    <<head::binary-size(size), _::binary>> = bytes

    trailing =
      head
      |> :binary.bin_to_list()
      |> Enum.reverse()
      |> Enum.take_while(&(&1 == @escape))
      |> length()

    rem(trailing, 2) == 1
  end
end
