defmodule Sms.Switch.Pipeline.Buffers do
  @moduledoc """
  Overflow buffers (S-2.4, S-5.1; product owner 2026-10-25, backend step 7b). Each customer trunk (`ct.<id>`) and each
  vendor trunk (`vt.<id>`) has its own durable queue on the bus (`Sms.Core.Bus.put/4`), drained at that trunk's own
  pace by a `Drain` process, so a buffer of any size never takes the sender's workers or holds other trunks back.

    * **Customer trunk:** a message accepted over the trunk's TPS (while its buffer has room, else 0x58 at the
      session) waits in `ct.<id>`; the drain takes it once the trunk's TPS has room, gives its buffer place back and
      hands it to the sender (`sms.msg.accepted`), oldest first.
    * **Vendor trunk:** a message whose vendor is at its TPS or has its window full waits in `vt.<id>` (while that
      trunk's buffer has room, else it goes to the next vendor; a buffer of 0 skips the vendor at once). The drain
      runs it on that vendor (`Sms.Switch.Pipeline.Sender.resume/1`), several at a time, waiting for room up to 30 s
      from when it was buffered; then it goes to the next vendor.

  A drain runs on each server that has something to drain (both servers drain the same queue; the TPS and buffer
  counts are shared in Redis) and stops after a few idle seconds. `kick/1` starts it when a message is buffered;
  every `@discover_ms` the queues with something waiting are listed, so buffers left by a restart are drained too.
  """
  use Supervisor
  require Logger
  alias Sms.Core.Bus

  @registry __MODULE__.Registry
  @drains __MODULE__.Drains

  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    children = [
      {Registry, keys: :unique, name: @registry},
      {Task.Supervisor, name: __MODULE__.Tasks},
      {DynamicSupervisor, name: @drains, strategy: :one_for_one},
      {__MODULE__.Discovery, opts}
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end

  @doc "The queue of a customer trunk's overflow buffer."
  @spec customer_queue(integer()) :: String.t()
  def customer_queue(trunk_id), do: "ct.#{trunk_id}"

  @doc "The queue of a vendor trunk's overflow buffer."
  @spec vendor_queue(integer()) :: String.t()
  def vendor_queue(trunk_id), do: "vt.#{trunk_id}"

  @doc "Starts the queue's drain on this server unless it runs already."
  @spec kick(String.t()) :: :ok
  def kick(queue) do
    case Registry.lookup(@registry, queue) do
      [{pid, _}] ->
        send(pid, :kick)
        :ok

      [] ->
        case DynamicSupervisor.start_child(@drains, {__MODULE__.Drain, queue}) do
          {:ok, _} -> :ok
          {:error, {:already_started, _}} -> :ok
          {:error, reason} -> Logger.error("drain of #{queue} not started: #{inspect(reason)}")
        end
    end
  rescue
    # The buffers are not running on this node (yet): discovery starts the drain.
    ArgumentError -> :ok
  catch
    :exit, _ -> :ok
  end

  @doc false
  def via(queue), do: {:via, Registry, {@registry, queue}}

  defmodule Discovery do
    @moduledoc false
    # Every `:discover_ms`, starts a drain for each buffer queue with something waiting (left by a restart, or put on
    # the bus by the other server).
    use GenServer
    require Logger
    alias Sms.Switch.Pipeline.Buffers

    def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

    @impl true
    def init(opts) do
      interval = Keyword.get(opts, :discover_ms, 2_000)
      send(self(), :discover)
      {:ok, interval}
    end

    @impl true
    def handle_info(:discover, interval) do
      case Bus.queues() do
        {:ok, queues} ->
          for {queue, _n} <- queues,
              match?("ct." <> _, queue) or match?("vt." <> _, queue),
              do: Buffers.kick(queue)

        {:error, reason} ->
          Logger.debug("buffer queues not listed: #{inspect(reason)}")
      end

      Process.send_after(self(), :discover, interval)
      {:noreply, interval}
    end
  end
end

defmodule Sms.Switch.Pipeline.Buffers.Drain do
  @moduledoc false
  # Drains one buffer queue on this server (see `Sms.Switch.Pipeline.Buffers`). A customer queue is drained one
  # message at a time, each when the trunk's TPS has room; a vendor queue runs up to `@vendor_tasks` messages at once
  # on its vendor. Stops after `@idle_ms` with nothing to do.
  use GenServer, restart: :temporary
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Customer.Trunk
  alias Sms.Switch.Pipeline.{Buffers, Intake, Sender}
  alias Sms.Switch.Throttle

  @idle_ms 5_000
  @poll_ms 200
  @tps_retry_ms 10
  @vendor_tasks 50

  def start_link(queue), do: GenServer.start_link(__MODULE__, queue, name: Buffers.via(queue))

  def child_spec(queue),
    do: %{id: {__MODULE__, queue}, start: {__MODULE__, :start_link, [queue]}, restart: :temporary}

  @impl true
  def init(queue) do
    send(self(), :work)
    kind = if String.starts_with?(queue, "vt."), do: :vendor, else: :customer
    {:ok, %{queue: queue, kind: kind, held: nil, tasks: %{}, idle_since: nil, timer: nil}}
  end

  @impl true
  def handle_info(:kick, state), do: {:noreply, work(%{state | idle_since: nil})}
  def handle_info(:work, state), do: {:noreply, work(%{state | timer: nil})}

  # A vendor message finished: acknowledged unless it is to be tried again (redelivered after the queue's ack wait).
  def handle_info({ref, result}, %{tasks: tasks} = state) when is_map_key(tasks, ref) do
    Process.demonitor(ref, [:flush])
    {handle, tasks} = Map.pop(tasks, ref)

    case result do
      :ok ->
        _ = Bus.ack(handle)

      other ->
        Logger.warning("buffered message on #{state.queue} not finished: #{inspect(other)}")
    end

    {:noreply, work(%{state | tasks: tasks})}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{tasks: tasks} = state)
      when is_map_key(tasks, ref) do
    Logger.error("buffered message on #{state.queue} crashed: #{inspect(reason)}")
    {:noreply, work(%{state | tasks: Map.delete(tasks, ref)})}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---------------------------------------------------------------- customer: one at a time, at the trunk's TPS

  defp work(%{kind: :customer, held: nil} = state) do
    case Bus.take(state.queue) do
      {:ok, event, handle} ->
        work(%{state | held: {Intake.decode(event.data), handle}, idle_since: nil})

      :empty ->
        idle(state)

      {:error, reason} ->
        retry(state, reason)
    end
  end

  defp work(%{kind: :customer, held: {msg, handle}} = state) do
    case Throttle.acquire(msg.tps_counters) do
      :ok -> release(msg, handle, state)
      {:error, _counter} -> later(state, @tps_retry_ms)
    end
  end

  # ---------------------------------------------------------------- vendor: several at once on the vendor

  defp work(%{kind: :vendor} = state) when map_size(state.tasks) >= @vendor_tasks, do: state

  defp work(%{kind: :vendor} = state) do
    case Bus.take(state.queue) do
      {:ok, event, handle} ->
        task = Task.Supervisor.async_nolink(Buffers.Tasks, fn -> Sender.resume(event.data) end)
        work(%{state | tasks: Map.put(state.tasks, task.ref, handle), idle_since: nil})

      :empty ->
        if state.tasks == %{}, do: idle(state), else: state

      {:error, reason} ->
        retry(state, reason)
    end
  end

  # The message had its TPS place: to the sender, with its buffer place given back. If the bus refuses it, it stays
  # held here (its place in the TPS this second is lost, never the message).
  defp release(msg, handle, state) do
    msg = %{msg | tps_counters: []}

    case Bus.publish("sms.msg.accepted", "msg.accepted", Intake.event_data(msg),
           id: "msg:#{msg.id}"
         ) do
      {:ok, _} ->
        Throttle.buffer_release(Trunk.buffer_key(msg.trunk.id))
        _ = Bus.ack(handle)
        work(%{state | held: nil})

      {:error, reason} ->
        Logger.warning(
          "buffered message #{msg.id} not handed to the sender yet: #{inspect(reason)}"
        )

        later(%{state | held: {msg, handle}}, 500)
    end
  end

  defp idle(%{idle_since: nil} = state), do: later(%{state | idle_since: now()}, @poll_ms)

  defp idle(state) do
    if now() - state.idle_since >= @idle_ms,
      do: exit(:normal),
      else: later(state, @poll_ms)
  end

  defp retry(state, reason) do
    Logger.debug("buffer #{state.queue} not read: #{inspect(reason)}")
    later(state, 1_000)
  end

  defp later(%{timer: nil} = state, ms),
    do: %{state | timer: Process.send_after(self(), :work, ms)}

  defp later(state, _ms), do: state

  defp now, do: System.monotonic_time(:millisecond)
end
