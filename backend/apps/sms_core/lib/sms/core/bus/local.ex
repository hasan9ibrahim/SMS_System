defmodule Sms.Core.Bus.Local do
  @moduledoc """
  An in-memory event bus for tests. It behaves like the NATS one where it matters: an event id is stored once
  (de-duplication), every consumer whose filter matches gets the event, a failed delivery is retried up to
  `max_deliver` times and a discarded one is not. Delivery happens in the publishing process before `publish`
  returns, so tests need no waiting.
  """
  @behaviour Sms.Core.Bus.Adapter
  use GenServer
  require Logger
  alias Sms.Core.Bus.{Consumer, Event, Subject}

  # ---------------------------------------------------------------- adapter

  @impl Sms.Core.Bus.Adapter
  def child_spec(_config),
    do: %{id: __MODULE__, start: {GenServer, :start_link, [__MODULE__, :ok, [name: __MODULE__]]}}

  @impl Sms.Core.Bus.Adapter
  def publish(subject, payload, msg_id, _timeout) do
    case GenServer.call(__MODULE__, {:store, msg_id, payload}) do
      :duplicate ->
        :ok

      {:new, consumers} ->
        {:ok, event} = Event.decode(payload)

        for {module, opts} <- consumers,
            Subject.matches?(opts[:filter], subject),
            do: deliver_first(module, opts, event)

        :ok
    end
  catch
    :exit, {:noproc, _} -> {:error, :not_connected}
  end

  @impl Sms.Core.Bus.Adapter
  def consumer_child_spec(module, opts) do
    %{
      id: {__MODULE__, module},
      start: {GenServer, :start_link, [__MODULE__.Subscription, {module, opts}]}
    }
  end

  @impl Sms.Core.Bus.Adapter
  def health, do: if(Process.whereis(__MODULE__), do: :ok, else: {:error, :not_running})

  # ---------------------------------------------------------------- test helpers

  @doc "The events stored so far, oldest first."
  @spec published() :: [Event.t()]
  def published do
    for payload <- GenServer.call(__MODULE__, :published), do: elem(Event.decode(payload), 1)
  end

  @doc "Forgets every stored event (consumers stay subscribed)."
  @spec reset() :: :ok
  def reset, do: GenServer.call(__MODULE__, :reset)

  # ---------------------------------------------------------------- delivery

  defp deliver_first(module, opts, event) do
    if opts[:batch_size],
      do: deliver_batch(module, opts, event, 1),
      else: deliver(module, opts, event, 1)
  end

  # A batch consumer gets each event as a batch of one; a failed batch is retried like a failed event.
  defp deliver_batch(module, opts, event, attempt) do
    case Consumer.run_batch(module, [event]) do
      :ok ->
        :ok

      {:error, reason} ->
        if Consumer.given_up?(local_max(opts), attempt) do
          Logger.error("batch failed on every delivery, given up",
            event_id: event.id,
            consumer: opts[:name],
            reason: inspect(reason)
          )
        else
          deliver_batch(module, opts, event, attempt + 1)
        end
    end
  end

  # In memory a consumer that never gives up is tried a bounded number of times, so a test cannot loop forever.
  defp local_max(opts) do
    case Keyword.fetch!(opts, :max_deliver) do
      :infinity -> 25
      max -> max
    end
  end

  defp deliver(module, opts, event, attempt) do
    max = local_max(opts)

    case Consumer.run(module, event) do
      :ok ->
        :ok

      {:discard, reason} ->
        Logger.error("event discarded",
          event_id: event.id,
          consumer: opts[:name],
          reason: inspect(reason)
        )

      {:error, reason} when attempt < max ->
        Logger.warning("event failed, retrying",
          event_id: event.id,
          consumer: opts[:name],
          reason: inspect(reason)
        )

        deliver(module, opts, event, attempt + 1)

      {:error, reason} ->
        Logger.error("event failed on every delivery, given up",
          event_id: event.id,
          consumer: opts[:name],
          reason: inspect(reason)
        )
    end
  end

  # ---------------------------------------------------------------- server

  @impl GenServer
  def init(:ok), do: {:ok, %{seen: MapSet.new(), log: [], consumers: %{}}}

  @impl GenServer
  def handle_call({:store, id, payload}, _from, state) do
    if MapSet.member?(state.seen, id) do
      {:reply, :duplicate, state}
    else
      state = %{state | seen: MapSet.put(state.seen, id), log: [payload | state.log]}
      {:reply, {:new, Map.values(state.consumers)}, state}
    end
  end

  def handle_call(:published, _from, state), do: {:reply, Enum.reverse(state.log), state}
  def handle_call(:reset, _from, state), do: {:reply, :ok, %{state | seen: MapSet.new(), log: []}}

  def handle_call({:subscribe, pid, module, opts}, _from, state) do
    Process.monitor(pid)
    {:reply, :ok, put_in(state.consumers[pid], {module, opts})}
  end

  @impl GenServer
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    {:noreply, %{state | consumers: Map.delete(state.consumers, pid)}}
  end

  defmodule Subscription do
    @moduledoc false
    # Keeps a consumer subscribed while it is in the supervision tree.
    use GenServer

    @impl true
    def init({module, opts}) do
      :ok = GenServer.call(Sms.Core.Bus.Local, {:subscribe, self(), module, opts})
      {:ok, module}
    end
  end
end
