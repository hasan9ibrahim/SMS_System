defmodule Sms.Switch.Commands.Diagnose do
  @moduledoc """
  Network Diagnosis (spec §9.2, backend step 11c): ping, traceroute or mtr to a host, or a TCP connect to a host and
  port (the screen's telnet), run on the switch server that owns the source address asked for (any server when none is
  given), so NOC sees the path the switch's own traffic takes.

  The tools run with an argument list (never a shell) under `timeout`, so a hung probe never holds the command; the
  executables can be set per tool (`config :sms_switch, Sms.Switch.Commands, tools: %{"ping" => "/usr/bin/ping"}`).
  """
  @hostname ~r/^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
  @limit_s 90
  @connect_timeout_ms 10_000

  @doc "Runs a probe; `:skip` when a source address is given that this server does not have."
  @spec run(map()) :: {:ok, map() | :skip} | {:error, term()}
  def run(data) do
    with {:ok, tool} <- tool(data["tool"]),
         {:ok, dest} <- destination(data["destination"]),
         {:ok, source} <- source(data["source"]),
         {:ok, count} <- count(data["count"]),
         {:ok, port} <- port(tool, data["port"]) do
      if source && not local?(source),
        do: {:ok, :skip},
        else: {:ok, probe(tool, dest, source, count, port)}
    end
  end

  defp tool(t) when t in ["ping", "traceroute", "mtr", "telnet"], do: {:ok, t}
  defp tool(_), do: {:error, {:bad_input, "tool must be ping, traceroute, mtr or telnet"}}

  defp destination(d) when is_binary(d) do
    d = String.trim(d)

    if ip?(d) or Regex.match?(@hostname, d),
      do: {:ok, d},
      else: {:error, {:bad_input, "destination must be a host name or IP address"}}
  end

  defp destination(_), do: {:error, {:bad_input, "destination must be a host name or IP address"}}

  defp source(nil), do: {:ok, nil}
  defp source(""), do: {:ok, nil}

  defp source(s) when is_binary(s) do
    s = String.trim(s)

    if ip?(s),
      do: {:ok, s},
      else: {:error, {:bad_input, "source must be an IP address of a switch server"}}
  end

  defp source(_), do: {:error, {:bad_input, "source must be an IP address of a switch server"}}

  defp count(nil), do: {:ok, 4}
  defp count(n) when is_integer(n) and n in 1..20, do: {:ok, n}
  defp count(_), do: {:error, {:bad_input, "count must be 1 to 20"}}

  defp port("telnet", p) when is_integer(p) and p in 1..65_535, do: {:ok, p}
  defp port("telnet", _), do: {:error, {:bad_input, "telnet needs a port 1 to 65535"}}
  defp port(_, _), do: {:ok, nil}

  defp ip?(text), do: match?({:ok, _}, :inet.parse_strict_address(String.to_charlist(text)))

  @doc false
  # Whether this server has the address on one of its interfaces.
  @spec local?(String.t()) :: boolean()
  def local?(source) do
    {:ok, ip} = :inet.parse_strict_address(String.to_charlist(source))

    case :inet.getifaddrs() do
      {:ok, ifs} -> Enum.any?(ifs, fn {_name, opts} -> {:addr, ip} in opts end)
      _ -> false
    end
  end

  defp probe("telnet", dest, source, _count, port), do: connect(dest, source, port)

  defp probe(tool, dest, source, count, _port) do
    args = args(tool, dest, source, count)
    started = System.monotonic_time(:millisecond)

    {output, status} =
      System.cmd(executable("timeout"), ["#{@limit_s}", executable(tool) | args],
        stderr_to_stdout: true
      )

    %{
      command: Enum.join([tool | args], " "),
      lines:
        output |> String.split("\n") |> Enum.map(&String.trim_trailing/1) |> drop_trailing_blank(),
      exit_code: status,
      duration_ms: System.monotonic_time(:millisecond) - started
    }
  rescue
    e in ErlangError ->
      failed(tool, dest, "#{tool} is not installed on this server (#{inspect(e.original)})")
  end

  defp args("ping", dest, source, count),
    do: ["-n", "-c", "#{count}", "-W", "2"] ++ opt("-I", source) ++ [dest]

  defp args("traceroute", dest, source, _count),
    do: ["-n", "-q", "1", "-w", "2", "-m", "30"] ++ opt("-s", source) ++ [dest]

  defp args("mtr", dest, source, count),
    do: ["--report", "--no-dns", "-c", "#{count}"] ++ opt("-a", source) ++ [dest]

  defp opt(_flag, nil), do: []
  defp opt(flag, value), do: [flag, value]

  defp executable(name) do
    :sms_switch
    |> Application.get_env(Sms.Switch.Commands, [])
    |> Keyword.get(:tools, %{})
    |> Map.get(name, name)
  end

  defp drop_trailing_blank(lines),
    do: lines |> Enum.reverse() |> Enum.drop_while(&(&1 == "")) |> Enum.reverse()

  defp failed(tool, dest, text),
    do: %{command: "#{tool} #{dest}", lines: [text], exit_code: 127, duration_ms: 0}

  # The screen's telnet: a TCP connect from the source address, closed at once.
  defp connect(dest, source, port) do
    started = System.monotonic_time(:millisecond)
    opts = if source, do: [ip: parse(source)], else: []
    command = "telnet #{if source, do: "-b #{source} ", else: ""}#{dest} #{port}"

    {lines, code} =
      case :gen_tcp.connect(
             String.to_charlist(dest),
             port,
             [:binary, active: false] ++ opts,
             @connect_timeout_ms
           ) do
        {:ok, socket} ->
          :gen_tcp.close(socket)
          {["Trying #{dest}...", "Connected to #{dest}.", "Connection closed."], 0}

        {:error, reason} ->
          {["Trying #{dest}...", "Unable to connect to remote host: #{reason_text(reason)}"], 1}
      end

    %{
      command: command,
      lines: lines,
      exit_code: code,
      duration_ms: System.monotonic_time(:millisecond) - started
    }
  end

  defp parse(ip) do
    {:ok, addr} = :inet.parse_strict_address(String.to_charlist(ip))
    addr
  end

  defp reason_text(:econnrefused), do: "Connection refused"
  defp reason_text(:timeout), do: "Connection timed out"
  defp reason_text(:nxdomain), do: "Unknown host"
  defp reason_text(:ehostunreach), do: "No route to host"
  defp reason_text(:enetunreach), do: "Network is unreachable"
  defp reason_text(other), do: inspect(other)
end
