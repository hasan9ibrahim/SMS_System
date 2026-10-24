defmodule Sms.Switch.Customer.TrunkStore do
  @moduledoc """
  The customer trunks in memory, looked up by SMPP `system_id` on every bind without touching the database
  (S-7.2: the switch keeps running from memory while PostgreSQL is down).

  It loads at start and again every `:refresh_ms`. A failed load keeps the trunks it had. After each load, the
  sessions of every trunk that changed or disappeared re-check themselves (`Sms.Switch.Customer.Sessions`), so a
  trunk that is deactivated, deleted or loses a client IP drops its binds.

  Until the first load succeeds the store is not `ready?/0`, and binds are answered with a system error (the client
  retries) rather than "unknown system_id".
  """
  use GenServer
  require Logger
  alias Sms.Switch.Customer.{Loader, Sessions, Trunk}

  @table __MODULE__
  @retry_ms 1_000

  @doc """
  Options: `:loader` (a 0-arity function returning `{:ok, [Trunk.t()]}` or `{:error, reason}`, default
  `Sms.Switch.Customer.Loader.load/0`) and `:refresh_ms` (default 5 s).
  """
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "The trunk whose SMPP username is `system_id`."
  @spec lookup(String.t()) :: {:ok, Trunk.t()} | :error
  def lookup(system_id) do
    case :ets.lookup(@table, {:user, system_id}) do
      [{_, trunk}] -> {:ok, trunk}
      [] -> :error
    end
  end

  @doc "The trunk with this id."
  @spec get(pos_integer()) :: {:ok, Trunk.t()} | :error
  def get(id) do
    case :ets.lookup(@table, {:id, id}) do
      [{_, trunk}] -> {:ok, trunk}
      [] -> :error
    end
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
    {result, state} = do_load(state)
    {:reply, result, schedule(state, interval(result, state))}
  end

  @impl true
  def handle_info(:refresh, state), do: {:noreply, load(state)}

  defp load(state) do
    {result, state} = do_load(state)
    schedule(state, interval(result, state))
  end

  # Not loaded yet: try again soon. Loaded before: keep the old trunks and try at the normal pace.
  defp interval({:error, _}, state), do: if(ready?(), do: state.refresh_ms, else: @retry_ms)
  defp interval({:ok, _}, state), do: state.refresh_ms

  defp do_load(state) do
    case state.loader.() do
      {:ok, trunks} ->
        changed = replace(trunks)
        Enum.each(changed, &Sessions.revalidate/1)
        {{:ok, length(trunks)}, state}

      {:error, reason} = error ->
        Logger.error("customer trunks not loaded, keeping the previous ones: #{inspect(reason)}")
        {error, state}
    end
  end

  # Swaps the table's content and returns the ids of trunks that changed or disappeared. Rows are written before the
  # old ones are removed, so a lookup never misses a trunk that exists in both versions.
  defp replace(trunks) do
    old =
      for {{:id, id}, trunk} <- :ets.match_object(@table, {{:id, :_}, :_}),
          into: %{},
          do: {id, trunk}

    new = Map.new(trunks, &{&1.id, &1})

    :ets.insert(@table, Enum.flat_map(trunks, &[{{:id, &1.id}, &1}, {{:user, &1.username}, &1}]))

    for {id, _trunk} <- old, not Map.has_key?(new, id) do
      :ets.delete(@table, {:id, id})
    end

    # A username that moved to another trunk, or a trunk whose username changed, must not leave a stale row.
    for {{:user, user}, trunk} <- :ets.match_object(@table, {{:user, :_}, :_}),
        Map.get(new, trunk.id) != trunk or new[trunk.id].username != user do
      :ets.delete(@table, {:user, user})
    end

    :ets.insert(@table, {:ready, true})
    for {id, trunk} <- old, Map.get(new, id) != trunk, do: id
  end

  defp schedule(state, ms) do
    _ = if state.timer, do: Process.cancel_timer(state.timer)
    %{state | timer: Process.send_after(self(), :refresh, ms)}
  end
end
