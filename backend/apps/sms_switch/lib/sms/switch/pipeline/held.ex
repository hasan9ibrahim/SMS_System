defmodule Sms.Switch.Pipeline.Held do
  @moduledoc """
  Customer receipts held while no session of their trunk could take them (spec §13.1, store and forward): kept in
  `Sms.Switch.Pipeline.Store` per trunk, oldest first, and sent when a session binds (`Held.OnBind`) or on the
  next sweep (every `@sweep_ms`), until the trunk's DLR hold hours run out (then recorded as given up).

  One node at a time sends a trunk's held receipts (a Redis lock), so a receipt is not sent twice by two servers;
  the sessions are found cluster-wide, so either server can send them.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Pipeline.{Forwarder, Store}

  @sweep_ms 15_000
  @batch 200
  @lock_s 60

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Sends the held receipts of `trunk_id` now (a session of the trunk bound)."
  @spec drain(integer()) :: :ok
  def drain(trunk_id), do: GenServer.cast(__MODULE__, {:drain, trunk_id})

  @impl true
  def init(opts) do
    every = Keyword.get(opts, :sweep_ms, @sweep_ms)
    {:ok, _} = :timer.send_interval(every, :sweep)
    {:ok, nil}
  end

  @impl true
  def handle_cast({:drain, trunk_id}, state) do
    run(trunk_id)
    {:noreply, state}
  end

  @impl true
  def handle_info(:sweep, state) do
    case Store.held_trunks() do
      {:ok, ids} -> Enum.each(ids, &run/1)
      {:error, reason} -> Logger.warning("held receipts not swept: #{inspect(reason)}")
    end

    {:noreply, state}
  end

  @doc false
  # Sends what a trunk has held; public for tests (runs in the caller).
  @spec run(integer()) :: :ok
  def run(trunk_id) do
    if Store.lock_held(trunk_id, @lock_s) do
      try do
        send_held(trunk_id)
      after
        Store.unlock_held(trunk_id)
      end
    end

    :ok
  end

  defp send_held(trunk_id) do
    case Store.held(trunk_id, @batch) do
      {:ok, []} ->
        :ok

      {:ok, entries} ->
        # Stops at the first receipt no session can take; a full batch sent goes on with the next one.
        if Enum.all?(entries, &send_one(trunk_id, &1)) and length(entries) == @batch,
          do: send_held(trunk_id)

      {:error, reason} ->
        Logger.warning("held receipts of trunk #{trunk_id} not read: #{inspect(reason)}")
    end
  end

  defp send_one(trunk_id, {member, entry}) do
    now = System.os_time(:millisecond)

    if now > entry.until do
      Forwarder.give_up(entry)
      _ = Store.release(trunk_id, member)
      true
    else
      case Forwarder.deliver(entry.data, entry.receipt, max(1, now - entry.held_at)) do
        :ok ->
          _ = Store.release(trunk_id, member)
          true

        _hold_or_error ->
          false
      end
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
