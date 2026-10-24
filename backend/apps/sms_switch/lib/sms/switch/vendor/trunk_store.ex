defmodule Sms.Switch.Vendor.TrunkStore do
  @moduledoc """
  The vendor trunks in memory, read on every submit without touching the database (S-7.2: the switch keeps running
  from memory while PostgreSQL is down).

  It loads at start and again every `:refresh_ms`; a failed load keeps the trunks it had. After each successful load
  `Sms.Switch.Vendor.Manager` reconciles the connections with the new trunks.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Vendor.{Loader, Manager, Trunk}

  @table __MODULE__
  @retry_ms 1_000

  @doc """
  Options: `:loader` (a 0-arity function returning `{:ok, [Trunk.t()]}` or `{:error, reason}`, default
  `Sms.Switch.Vendor.Loader.load/0`) and `:refresh_ms` (default 5 s).
  """
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "The trunk with this id."
  @spec get(pos_integer()) :: {:ok, Trunk.t()} | :error
  def get(id) do
    case :ets.lookup(@table, id) do
      [{_, trunk}] -> {:ok, trunk}
      [] -> :error
    end
  rescue
    ArgumentError -> :error
  end

  @doc "Every trunk loaded, by id."
  @spec all() :: [Trunk.t()]
  def all do
    for {id, trunk} <- :ets.tab2list(@table), is_integer(id), do: trunk
  rescue
    ArgumentError -> []
  end

  @doc "Whether the trunks have been loaded at least once."
  @spec ready?() :: boolean()
  def ready? do
    :ets.member(@table, :ready)
  rescue
    ArgumentError -> false
  end

  @doc "Loads now and waits; returns what the loader returned (`{:ok, count}` or the error)."
  @spec refresh(timeout()) :: {:ok, non_neg_integer()} | {:error, term()}
  def refresh(timeout \\ 30_000), do: GenServer.call(__MODULE__, :refresh, timeout)

  @impl true
  def init(opts) do
    _ = :ets.new(@table, [:named_table, :protected, :set, read_concurrency: true])

    state = %{
      loader: Keyword.get(opts, :loader, &Loader.load/0),
      refresh_ms: Keyword.get(opts, :refresh_ms, 5_000),
      timer: nil
    }

    {:ok, state, {:continue, :load}}
  end

  @impl true
  def handle_continue(:load, state), do: {:noreply, load(state)}

  @impl true
  def handle_call(:refresh, _from, state) do
    result = do_load(state)
    {:reply, result, schedule(state, interval(result, state))}
  end

  @impl true
  def handle_info(:refresh, state), do: {:noreply, load(state)}

  defp load(state) do
    result = do_load(state)
    schedule(state, interval(result, state))
  end

  # Not loaded yet: try again soon. Loaded before: keep the old trunks and try at the normal pace.
  defp interval({:error, _}, state), do: if(ready?(), do: state.refresh_ms, else: @retry_ms)
  defp interval({:ok, _}, state), do: state.refresh_ms

  defp do_load(state) do
    case state.loader.() do
      {:ok, trunks} ->
        replace(trunks)
        Manager.reconcile()
        {:ok, length(trunks)}

      {:error, reason} = error ->
        Logger.error("vendor trunks not loaded, keeping the previous ones: #{inspect(reason)}")
        error
    end
  end

  # New rows are written before the removed ones are deleted, so a lookup never misses a trunk in both versions.
  defp replace(trunks) do
    new = Map.new(trunks, &{&1.id, &1})
    :ets.insert(@table, Enum.map(trunks, &{&1.id, &1}))

    for id <- :ets.select(@table, [{{:"$1", :_}, [{:is_integer, :"$1"}], [:"$1"]}]),
        not Map.has_key?(new, id),
        do: :ets.delete(@table, id)

    :ets.insert(@table, {:ready, true})
  end

  defp schedule(state, ms) do
    _ = if state.timer, do: Process.cancel_timer(state.timer)
    %{state | timer: Process.send_after(self(), :refresh, ms)}
  end
end
