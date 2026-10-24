defmodule Sms.Switch.Customer.IpRange do
  @moduledoc """
  The client addresses a customer trunk allows (spec §5.4 Host Name, stored as PostgreSQL `inet[]`): single hosts
  (`10.1.2.3`) or networks (`10.1.2.0/24`), IPv4 or IPv6. An IPv4 client reaching an IPv6 listener arrives as
  `::ffff:a.b.c.d` and is matched as the IPv4 address.
  """
  import Bitwise

  @type t :: {:inet.ip_address(), non_neg_integer()}

  @doc "Parses `addr` or `addr/prefix` (the text form of PostgreSQL `inet`)."
  @spec parse(String.t()) :: {:ok, t()} | {:error, term()}
  def parse(text) when is_binary(text) do
    with [addr | rest] when length(rest) <= 1 <- String.split(text, "/"),
         {:ok, ip} <- :inet.parse_strict_address(String.to_charlist(addr)),
         {:ok, bits} <- prefix(rest, bits(ip)) do
      {:ok, {ip, bits}}
    else
      _ -> {:error, {:invalid_ip_range, text}}
    end
  end

  defp prefix([], max), do: {:ok, max}

  defp prefix([text], max) do
    case Integer.parse(text) do
      {n, ""} when n >= 0 and n <= max -> {:ok, n}
      _ -> :error
    end
  end

  @doc "Whether `ip` is inside any of `ranges`."
  @spec member?([t()], :inet.ip_address()) :: boolean()
  def member?(ranges, ip) do
    ip = unmap(ip)
    Enum.any?(ranges, fn range -> contains?(range, ip) end)
  end

  defp contains?({net, bits}, ip) do
    tuple_size(net) == tuple_size(ip) and
      to_integer(net) >>> (bits(net) - bits) == to_integer(ip) >>> (bits(ip) - bits)
  end

  @doc "An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as the IPv4 address; any other address unchanged."
  @spec unmap(:inet.ip_address()) :: :inet.ip_address()
  def unmap({0, 0, 0, 0, 0, 0xFFFF, hi, lo}), do: {hi >>> 8, hi &&& 0xFF, lo >>> 8, lo &&& 0xFF}
  def unmap(ip), do: ip

  defp bits(ip) when tuple_size(ip) == 4, do: 32
  defp bits(ip) when tuple_size(ip) == 8, do: 128

  defp to_integer({a, b, c, d}), do: a <<< 24 ||| b <<< 16 ||| c <<< 8 ||| d

  defp to_integer(ip) when tuple_size(ip) == 8 do
    ip |> Tuple.to_list() |> Enum.reduce(0, fn part, acc -> acc <<< 16 ||| part end)
  end
end
