defmodule Sms.Api.Password do
  @moduledoc """
  Staff and portal passwords (§13.28): stored only as scrypt hashes, `scrypt$N$salt$hash` (salt and hash base64), the
  format the mock writes (mock/src/admin/passwords.ts), so both read the same users table while the API is ported
  (backend step 9). The password is NFKC-normalised first. Erlang's `:crypto` has PBKDF2 but no scrypt, so the
  memory-hard part (ROMix with Salsa20/8, RFC 7914) is here.
  """
  import Bitwise

  @doc "Whether `password` matches a stored hash (in constant time); false for any other format."
  @spec verify?(String.t(), String.t() | nil) :: boolean()
  def verify?(password, stored) when is_binary(password) and is_binary(stored) do
    with ["scrypt", n, salt, hash] <- String.split(stored, "$"),
         {n, ""} when n > 1 and n <= 1_048_576 and (n &&& n - 1) == 0 <- Integer.parse(n),
         {:ok, salt} <- Base.decode64(salt),
         {:ok, want} <- Base.decode64(hash) do
      got = scrypt(normalize(password), salt, n, 8, 1, byte_size(want))
      :crypto.hash_equals(got, want)
    else
      _ -> false
    end
  end

  def verify?(_password, _stored), do: false

  @doc """
  A new hash of `password` (r = 8, p = 1, a random 16-byte salt). N = 4096 by default, as the mock writes: this
  scrypt takes about 0.4 s at that cost; a higher one waits for a native scrypt (BACKEND_TODO).
  """
  @spec hash(String.t(), pos_integer()) :: String.t()
  def hash(password, n \\ 4096) do
    salt = :crypto.strong_rand_bytes(16)
    key = scrypt(normalize(password), salt, n, 8, 1, 32)
    "scrypt$#{n}$#{Base.encode64(salt)}$#{Base.encode64(key)}"
  end

  defp normalize(password), do: :unicode.characters_to_nfkc_binary(password)

  @doc false
  # RFC 7914: scrypt(P, S, N, r, p, dkLen).
  @spec scrypt(binary(), binary(), pos_integer(), pos_integer(), pos_integer(), pos_integer()) ::
          binary()
  def scrypt(password, salt, n, r, p, length) do
    block = 128 * r
    b = :crypto.pbkdf2_hmac(:sha256, password, salt, 1, p * block)
    mixed = for <<chunk::binary-size(block) <- b>>, into: <<>>, do: ro_mix(chunk, n, r)
    :crypto.pbkdf2_hmac(:sha256, password, mixed, 1, length)
  end

  defp ro_mix(x, n, r) do
    {v, x} = fill(x, n, r, [])
    v = List.to_tuple(v)
    mix_back(x, n, r, v, n)
  end

  defp fill(x, 0, _r, acc), do: {Enum.reverse(acc), x}
  defp fill(x, i, r, acc), do: fill(block_mix(x, r), i - 1, r, [x | acc])

  defp mix_back(x, _n, _r, _v, 0), do: x

  defp mix_back(x, n, r, v, i) do
    j = integerify(x, r) &&& n - 1
    mix_back(block_mix(:crypto.exor(x, elem(v, j)), r), n, r, v, i - 1)
  end

  # The first 4 bytes (little-endian) of the last 64-byte block; N is at most 2^20 here.
  defp integerify(x, r) do
    <<_::binary-size((2 * r - 1) * 64), j::little-32, _::binary>> = x
    j
  end

  # Salsa20/8 over the 2r 64-byte blocks in turn; the even outputs first, then the odd ones.
  defp block_mix(b, r) do
    <<_::binary-size((2 * r - 1) * 64), last::binary-64>> = b
    {even, odd, _} = mix_blocks(b, last, 0, [], [])
    IO.iodata_to_binary([Enum.reverse(even), Enum.reverse(odd)])
  end

  defp mix_blocks(<<>>, x, _i, even, odd), do: {even, odd, x}

  defp mix_blocks(<<c::binary-64, rest::binary>>, x, i, even, odd) do
    y = salsa20_8(:crypto.exor(x, c))

    if rem(i, 2) == 0,
      do: mix_blocks(rest, y, i + 1, [y | even], odd),
      else: mix_blocks(rest, y, i + 1, even, [y | odd])
  end

  defp salsa20_8(
         <<x0::little-32, x1::little-32, x2::little-32, x3::little-32, x4::little-32,
           x5::little-32, x6::little-32, x7::little-32, x8::little-32, x9::little-32,
           x10::little-32, x11::little-32, x12::little-32, x13::little-32, x14::little-32,
           x15::little-32>>
       ) do
    input = {x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15}
    out = Enum.reduce(1..4, input, fn _, s -> double_round(s) end)

    for i <- 0..15, into: <<>> do
      <<elem(out, i) + elem(input, i) &&& 0xFFFFFFFF::little-32>>
    end
  end

  defp double_round({x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15}) do
    # Columns.
    x4 = bxor(x4, rotl(x0 + x12, 7))
    x8 = bxor(x8, rotl(x4 + x0, 9))
    x12 = bxor(x12, rotl(x8 + x4, 13))
    x0 = bxor(x0, rotl(x12 + x8, 18))
    x9 = bxor(x9, rotl(x5 + x1, 7))
    x13 = bxor(x13, rotl(x9 + x5, 9))
    x1 = bxor(x1, rotl(x13 + x9, 13))
    x5 = bxor(x5, rotl(x1 + x13, 18))
    x14 = bxor(x14, rotl(x10 + x6, 7))
    x2 = bxor(x2, rotl(x14 + x10, 9))
    x6 = bxor(x6, rotl(x2 + x14, 13))
    x10 = bxor(x10, rotl(x6 + x2, 18))
    x3 = bxor(x3, rotl(x15 + x11, 7))
    x7 = bxor(x7, rotl(x3 + x15, 9))
    x11 = bxor(x11, rotl(x7 + x3, 13))
    x15 = bxor(x15, rotl(x11 + x7, 18))
    # Rows.
    x1 = bxor(x1, rotl(x0 + x3, 7))
    x2 = bxor(x2, rotl(x1 + x0, 9))
    x3 = bxor(x3, rotl(x2 + x1, 13))
    x0 = bxor(x0, rotl(x3 + x2, 18))
    x6 = bxor(x6, rotl(x5 + x4, 7))
    x7 = bxor(x7, rotl(x6 + x5, 9))
    x4 = bxor(x4, rotl(x7 + x6, 13))
    x5 = bxor(x5, rotl(x4 + x7, 18))
    x11 = bxor(x11, rotl(x10 + x9, 7))
    x8 = bxor(x8, rotl(x11 + x10, 9))
    x9 = bxor(x9, rotl(x8 + x11, 13))
    x10 = bxor(x10, rotl(x9 + x8, 18))
    x12 = bxor(x12, rotl(x15 + x14, 7))
    x13 = bxor(x13, rotl(x12 + x15, 9))
    x14 = bxor(x14, rotl(x13 + x12, 13))
    x15 = bxor(x15, rotl(x14 + x13, 18))
    {x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15}
  end

  defp rotl(v, n) do
    v = v &&& 0xFFFFFFFF
    (v <<< n ||| v >>> (32 - n)) &&& 0xFFFFFFFF
  end
end
