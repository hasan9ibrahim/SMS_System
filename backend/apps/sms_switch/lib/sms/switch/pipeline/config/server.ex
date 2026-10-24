defmodule Sms.Switch.Pipeline.Config.Server do
  @moduledoc """
  Keeps `Sms.Switch.Pipeline.Config` current (S-6.6: a saved change is live on every server within seconds).

    * Every `:refresh_ms` (5 s) it reads the configuration's fingerprint; when it changed, the whole snapshot is read
      again (one repeatable-read transaction) and replaced at once.
    * Every `:rates_refresh_ms` (15 s) it reads each rate table's fingerprint and reloads only the tables that changed;
      their lines are written before stale ones are removed, so a lookup never misses a line present in both.

  A failed read keeps what is in memory (S-7.2) and is tried again at the next tick; until the first complete load
  the pipeline is not ready and submits are answered 0x08 (system error, the client retries).
  """
  use GenServer
  require Logger
  alias Sms.Switch.Pipeline.Config
  alias Sms.Switch.Pipeline.Config.Loader

  @retry_ms 1_000
  @rate_batch 200

  @doc """
  Options: `:loader` (a module like `Sms.Switch.Pipeline.Config.Loader`), `:refresh_ms`, `:rates_refresh_ms`,
  `:platform_currency` (defaults from `config :sms_switch, Sms.Switch.Pipeline`).
  """
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Reads everything that changed now, and waits (after a save; also done on the timers)."
  @spec refresh(timeout()) :: :ok | {:error, term()}
  def refresh(timeout \\ 60_000), do: GenServer.call(__MODULE__, :refresh, timeout)

  @impl true
  def init(opts) do
    config = Keyword.merge(Application.get_env(:sms_switch, Sms.Switch.Pipeline, []), opts)
    _ = :ets.new(Config.rates_table(), [:named_table, :protected, :set, read_concurrency: true])

    _ =
      :ets.new(Config.options_table(), [
        :named_table,
        :public,
        :set,
        read_concurrency: true,
        write_concurrency: true
      ])

    state = %{
      loader: Keyword.get(config, :loader, Loader),
      refresh_ms: Keyword.get(config, :refresh_ms, 5_000),
      rates_refresh_ms: Keyword.get(config, :rates_refresh_ms, 15_000),
      platform_currency: Keyword.get(config, :platform_currency, "EUR"),
      fingerprint: nil,
      rate_fingerprints: %{}
    }

    {:ok, state, {:continue, :first_load}}
  end

  @impl true
  def handle_continue(:first_load, state) do
    case load_all(state) do
      {:ok, state} ->
        :ets.insert(Config.rates_table(), {:ready, true})
        schedule(:snapshot, state.refresh_ms)
        schedule(:rates, state.rates_refresh_ms)
        {:noreply, state}

      {:error, reason, state} ->
        Logger.error("pipeline configuration not loaded yet, retrying: #{inspect(reason)}")
        Process.send_after(self(), :first_load, @retry_ms)
        {:noreply, state}
    end
  end

  @impl true
  def handle_call(:refresh, _from, state) do
    case load_all(state) do
      {:ok, state} ->
        :ets.insert(Config.rates_table(), {:ready, true})
        {:reply, :ok, state}

      {:error, reason, state} ->
        {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_info(:first_load, state), do: {:noreply, state, {:continue, :first_load}}

  def handle_info(:snapshot, state) do
    schedule(:snapshot, state.refresh_ms)

    case load_snapshot(state) do
      {:ok, state} ->
        {:noreply, state}

      {:error, reason, state} ->
        Logger.error(
          "pipeline configuration not refreshed, keeping the previous one: #{inspect(reason)}"
        )

        {:noreply, state}
    end
  end

  def handle_info(:rates, state) do
    schedule(:rates, state.rates_refresh_ms)

    case load_rates(state) do
      {:ok, state} ->
        {:noreply, state}

      {:error, reason, state} ->
        Logger.error("rate lines not refreshed, keeping the previous ones: #{inspect(reason)}")
        {:noreply, state}
    end
  end

  defp schedule(what, ms), do: Process.send_after(self(), what, ms)

  defp load_all(state) do
    with {:ok, state} <- load_snapshot(state), do: load_rates(state)
  end

  defp load_snapshot(state) do
    case state.loader.fingerprint() do
      {:ok, fp} ->
        if fp == state.fingerprint, do: {:ok, state}, else: load_snapshot(state, fp)

      {:error, reason} ->
        {:error, reason, state}
    end
  end

  defp load_snapshot(state, fp) do
    case state.loader.load_snapshot(state.platform_currency) do
      {:ok, snapshot} ->
        Config.put_snapshot(snapshot)
        Logger.info("pipeline configuration loaded")
        {:ok, %{state | fingerprint: fp}}

      {:error, reason} ->
        {:error, reason, state}
    end
  end

  defp load_rates(state) do
    case state.loader.rate_fingerprints() do
      {:ok, fps} -> load_rates(state, fps)
      {:error, reason} -> {:error, reason, state}
    end
  end

  defp load_rates(state, fps) do
    changed = for {table, fp} <- fps, Map.get(state.rate_fingerprints, table) != fp, do: table
    gone = Map.keys(state.rate_fingerprints) -- Map.keys(fps)

    case load_tables(state.loader, changed) do
      :ok ->
        Enum.each(gone, &replace_table(&1, %{}))
        if changed != [] or gone != [], do: Config.clear_options()
        {:ok, %{state | rate_fingerprints: fps}}

      {:error, reason, loaded} ->
        # Keep the fingerprints of the tables that did load, so only the rest is read again.
        fps = Map.merge(state.rate_fingerprints, Map.take(fps, loaded))
        Config.clear_options()
        {:error, reason, %{state | rate_fingerprints: fps}}
    end
  end

  defp load_tables(loader, tables) do
    tables
    |> Enum.chunk_every(@rate_batch)
    |> Enum.reduce_while({:ok, []}, fn batch, {:ok, done} -> load_batch(loader, batch, done) end)
    |> case do
      {:ok, _} -> :ok
      error -> error
    end
  end

  defp load_batch(loader, batch, done) do
    case loader.load_rates(batch) do
      {:ok, by_table} ->
        Enum.each(by_table, fn {table, by_code} -> replace_table(table, by_code) end)
        {:cont, {:ok, batch ++ done}}

      {:error, reason} ->
        {:halt, {:error, reason, done}}
    end
  end

  # New lines first, then codes the table no longer has.
  defp replace_table(table, by_code) do
    rates = Config.rates_table()

    old =
      case :ets.lookup(rates, {:codes, table}) do
        [{_, codes}] -> codes
        [] -> []
      end

    :ets.insert(rates, Enum.map(by_code, fn {code, lines} -> {{table, code}, lines} end))
    for code <- old, not Map.has_key?(by_code, code), do: :ets.delete(rates, {table, code})

    if by_code == %{},
      do: :ets.delete(rates, {:codes, table}),
      else: :ets.insert(rates, {{:codes, table}, Map.keys(by_code)})
  end
end
