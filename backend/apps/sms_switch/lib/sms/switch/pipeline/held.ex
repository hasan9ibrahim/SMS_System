defmodule Sms.Switch.Pipeline.Held do
  @moduledoc """
  Customer receipts held while no session of their trunk could take them (spec §13.1, store and forward): kept in
  `Sms.Switch.Pipeline.Store` per trunk, oldest first, and sent when a session binds (`Held.OnBind`) or on the
  next sweep (every `@sweep_ms`), until the trunk's DLR hold hours run out (then recorded as given up).

  One node at a time sends a trunk's held receipts (a Redis lock), so a receipt is not sent twice by two servers;
  the sessions are found cluster-wide, so either server can send them.

  Each trunk's receipts are sent by a process of their own, one at a time per trunk, so a slow customer never holds
  another trunk's receipts back (S-1.18). In a run:

    * a receipt no session can take now (none bound for its IP, S-5.13, or windows full) is passed over, never
      blocking the ones after it;
    * a receipt the customer refused for now, or one its session did not answer, is tried again later, each time
      later (S-5.14; the session takes no more receipts meanwhile, `Sms.Switch.Customer.Session`);
    * the run stops well before its lock runs out, so another server never sends the same receipts meanwhile.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Pipeline.{Forwarder, Store}

  @sweep_ms 15_000
  @batch 200
  @lock_s 60
  # A run stops after half its lock time; what is left goes on the next sweep.
  @run_ms div(@lock_s * 1_000, 2)

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Sends the held receipts of `trunk_id` now (a session of the trunk bound)."
  @spec drain(integer()) :: :ok
  def drain(trunk_id), do: GenServer.cast(__MODULE__, {:drain, trunk_id})

  @impl true
  def init(opts) do
    every = Keyword.get(opts, :sweep_ms, @sweep_ms)
    {:ok, _} = :timer.send_interval(every, :sweep)
    # The trunks being sent (monitor → trunk) and those asked for again meanwhile.
    {:ok, %{runs: %{}, again: MapSet.new()}}
  end

  @impl true
  def handle_cast({:drain, trunk_id}, state), do: {:noreply, start_run(state, trunk_id)}

  @impl true
  def handle_info(:sweep, state) do
    case Store.held_trunks() do
      {:ok, ids} ->
        {:noreply, Enum.reduce(ids, state, &start_run(&2, &1))}

      {:error, reason} ->
        Logger.warning("held receipts not swept: #{inspect(reason)}")
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{runs: runs} = state)
      when is_map_key(runs, ref) do
    {trunk_id, runs} = Map.pop(runs, ref)

    if reason != :normal,
      do: Logger.error("held receipts of trunk #{trunk_id}: #{inspect(reason)}")

    state = %{state | runs: runs}

    if MapSet.member?(state.again, trunk_id),
      do: {:noreply, start_run(%{state | again: MapSet.delete(state.again, trunk_id)}, trunk_id)},
      else: {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # A trunk already being sent is sent again once that run ends (a session that bound meanwhile).
  defp start_run(state, trunk_id) do
    if trunk_id in Map.values(state.runs) do
      %{state | again: MapSet.put(state.again, trunk_id)}
    else
      {_pid, ref} = spawn_monitor(fn -> run(trunk_id) end)
      %{state | runs: Map.put(state.runs, ref, trunk_id)}
    end
  end

  @doc false
  # Sends what a trunk has held; public for tests (runs in the caller).
  @spec run(integer()) :: :ok
  def run(trunk_id) do
    if Store.lock_held(trunk_id, @lock_s) do
      try do
        send_held(trunk_id, 0, System.monotonic_time(:millisecond) + @run_ms)
      after
        Store.unlock_held(trunk_id)
      end
    end

    :ok
  end

  # `offset`: the receipts passed over so far, still held before the next batch.
  defp send_held(trunk_id, offset, deadline) do
    case Store.held(trunk_id, @batch, offset) do
      {:ok, []} ->
        :ok

      {:ok, entries} ->
        case send_batch(trunk_id, entries, deadline) do
          {:cont, kept} when length(entries) == @batch ->
            send_held(trunk_id, offset + kept, deadline)

          _done_or_stopped ->
            :ok
        end

      {:error, reason} ->
        Logger.warning("held receipts of trunk #{trunk_id} not read: #{inspect(reason)}")
    end
  end

  # Past the run's deadline, the rest wait for the next sweep.
  defp send_batch(trunk_id, entries, deadline) do
    Enum.reduce_while(entries, {:cont, 0}, fn entry, {:cont, kept} ->
      cond do
        System.monotonic_time(:millisecond) > deadline -> {:halt, :stop}
        send_one(trunk_id, entry) == :sent -> {:cont, {:cont, kept}}
        true -> {:cont, {:cont, kept + 1}}
      end
    end)
  end

  # An entry that can no longer be read is dropped.
  defp send_one(trunk_id, {member, nil}) do
    _ = Store.release(trunk_id, member)
    :sent
  end

  defp send_one(trunk_id, {member, entry}) do
    now = System.os_time(:millisecond)

    cond do
      now > entry.until ->
        Forwarder.give_up(entry)
        _ = Store.release(trunk_id, member)
        :sent

      Map.get(entry, :retry_at, 0) > now ->
        :kept

      true ->
        deliver(trunk_id, member, entry, now)
    end
  end

  defp deliver(trunk_id, member, entry, now) do
    case Forwarder.deliver(entry.data, entry.receipt, max(1, now - entry.held_at)) do
      :ok ->
        _ = Store.release(trunk_id, member)
        :sent

      why when why in [:retry, :slow] ->
        _ = Store.update_held(trunk_id, member, Forwarder.retry_later(entry, now))
        :kept

      _hold_or_error ->
        :kept
    end
  end

  defmodule OnBind do
    @moduledoc "Sends a trunk's held receipts as soon as one of its sessions binds (§13.1)."
    use Sms.Core.Bus.Consumer,
      name: "pipeline-held-on-bind",
      filter: "sms.session.customer.bound",
      max_deliver: 3

    alias Sms.Switch.Pipeline.Held

    @impl true
    def handle_event(%{data: %{"trunk_id" => trunk_id}}) when is_integer(trunk_id) do
      Held.drain(trunk_id)
    end

    def handle_event(_event), do: :ok
  end
end
