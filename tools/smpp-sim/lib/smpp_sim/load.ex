defmodule SmppSim.Load do
  @moduledoc """
  The fake customers as one load: `sessions` connections per customer trunk, the total rate split evenly between
  them. A trunk's limits (Max Connections ≤ 10, its TPS) decide how many trunks a load needs: the load-test setup
  creates enough (`tools/smpp-sim/scripts/setup.sh`).
  """
  alias SmppSim.Esme

  @doc """
  Starts the sessions and waits until they are bound. Options: `:trunks` (`[%{system_id, password}]`),
  `:sessions` per trunk, `:hosts`, `:prefixes`, `:window`, `:multipart_pct`, `:receipts` (ask for receipts, default
  true).
  """
  @spec start(keyword()) :: {:ok, [pid()]} | {:error, :not_bound}
  def start(opts) do
    trunks = Keyword.fetch!(opts, :trunks)
    sessions = Keyword.get(opts, :sessions, 4)

    pids =
      for {trunk, t} <- Enum.with_index(trunks), i <- 1..sessions do
        spec =
          {Esme,
           hosts: Keyword.fetch!(opts, :hosts),
           host_index: t + i,
           system_id: trunk.system_id,
           password: trunk.password,
           prefixes: Keyword.fetch!(opts, :prefixes),
           window: Keyword.get(opts, :window, 100),
           multipart_pct: Keyword.get(opts, :multipart_pct, 0),
           receipts: Keyword.get(opts, :receipts, true)}

        {:ok, pid} = DynamicSupervisor.start_child(SmppSim.EsmeSup, spec)
        pid
      end

    :persistent_term.put({__MODULE__, :pids}, pids)
    if await_bound(pids, Keyword.get(opts, :bind_timeout_ms, 30_000)), do: {:ok, pids}, else: {:error, :not_bound}
  end

  @doc "The sessions running."
  @spec pids() :: [pid()]
  def pids, do: :persistent_term.get({__MODULE__, :pids}, [])

  @doc "Sets the total rate (messages per second), split evenly between the sessions."
  @spec set_rate(number()) :: :ok
  def set_rate(total) do
    pids = pids()
    for pid <- pids, do: Esme.set_rate(pid, total / max(length(pids), 1))
    :ok
  end

  @doc "How many sessions are bound, and the answers waiting in all of them."
  @spec info() :: %{bound: non_neg_integer(), sessions: non_neg_integer(), inflight: non_neg_integer()}
  def info do
    infos = for pid <- pids(), Process.alive?(pid), do: Esme.info(pid)

    %{
      bound: Enum.count(infos, &(&1.state == :bound)),
      sessions: length(pids()),
      inflight: infos |> Enum.map(& &1.inflight) |> Enum.sum()
    }
  end

  @doc "Stops sending, waits for the answers still due (at most `timeout_ms`), unbinds every session."
  @spec stop(non_neg_integer()) :: :ok
  def stop(timeout_ms \\ 30_000) do
    set_rate(0)
    wait_until(fn -> info().inflight == 0 end, timeout_ms)
    for pid <- pids(), Process.alive?(pid), do: Esme.stop(pid)
    :persistent_term.put({__MODULE__, :pids}, [])
    :ok
  end

  defp await_bound(pids, timeout_ms),
    do: wait_until(fn -> Enum.all?(pids, &(Esme.info(&1).state == :bound)) end, timeout_ms)

  @doc false
  @spec wait_until((-> boolean()), non_neg_integer()) :: boolean()
  def wait_until(fun, timeout_ms) do
    cond do
      fun.() -> true
      timeout_ms <= 0 -> false
      true -> Process.sleep(100) && wait_until(fun, timeout_ms - 100)
    end
  end
end
