defmodule SmppSim.Probe do
  @moduledoc """
  Watches the machine and the switch while a test runs, from `/proc` (Linux): the whole machine's CPU use, and each
  switch node's CPU use (of one core, so 200 % = two cores busy) and memory (RSS), given their OS process ids.
  """

  @doc "A reading to compare with the next one."
  @spec read([pos_integer()]) :: map()
  def read(pids) do
    %{at: System.monotonic_time(:millisecond), machine: machine(), procs: Map.new(pids, &{&1, proc(&1)})}
  end

  @doc "CPU use between two readings, and the RSS at the later one."
  @spec usage(map(), map()) :: %{machine_cpu_pct: float(), procs: %{pos_integer() => map()}}
  def usage(later, earlier) do
    seconds = max(later.at - earlier.at, 1) / 1_000
    hz = 100

    procs =
      Map.new(later.procs, fn {pid, now} ->
        before = earlier.procs[pid]

        cpu =
          if now && before, do: (now.ticks - before.ticks) / hz / seconds * 100, else: 0.0

        {pid, %{cpu_pct: Float.round(cpu, 1), rss_mb: if(now, do: now.rss_mb, else: 0)}}
      end)

    {busy, total} = later.machine
    {busy0, total0} = earlier.machine
    machine = if total > total0, do: (busy - busy0) / (total - total0) * 100, else: 0.0
    %{machine_cpu_pct: Float.round(machine, 1), procs: procs}
  end

  defp machine do
    case File.read("/proc/stat") do
      {:ok, <<"cpu ", rest::binary>>} ->
        [line | _] = String.split(rest, "\n")
        nums = line |> String.split() |> Enum.map(&String.to_integer/1)
        idle = Enum.at(nums, 3, 0) + Enum.at(nums, 4, 0)
        total = Enum.sum(nums)
        {total - idle, total}

      _ ->
        {0, 0}
    end
  end

  defp proc(pid) do
    with {:ok, stat} <- File.read("/proc/#{pid}/stat"),
         {:ok, status} <- File.read("/proc/#{pid}/status") do
      # Fields after the command name (which may hold spaces): utime and stime are the 12th and 13th.
      [_, after_comm] = String.split(stat, ") ", parts: 2)
      fields = String.split(after_comm)
      ticks = String.to_integer(Enum.at(fields, 11)) + String.to_integer(Enum.at(fields, 12))

      rss_kb =
        case Regex.run(~r/VmRSS:\s+(\d+)/, status) do
          [_, kb] -> String.to_integer(kb)
          _ -> 0
        end

      %{ticks: ticks, rss_mb: div(rss_kb, 1024)}
    else
      _ -> nil
    end
  end
end
