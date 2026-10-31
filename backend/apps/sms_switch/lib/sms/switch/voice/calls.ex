defmodule Sms.Switch.Voice.Calls do
  @moduledoc """
  The calls (§8 SMS to voice, docs/SMS_TO_VOICE.md, S-6.9): a message that became a call waits in its voice gateway's
  durable queue (`vg.<id>` on the bus, as the vendor overflow buffers do, `Sms.Switch.Pipeline.Buffers`) and is
  called from there by the server's own Asterisk (`Sms.Switch.Voice.AmiClient`).

    * **At most `max_calls` calls at once per gateway on both servers:** each call holds a place
      (`Sms.Switch.Throttle.lease_take/4`, shared in Redis; a place a stopped server held comes back when its lease
      ends). A queue's drain runs on every server whose Asterisk is connected, takes a message only once it holds a
      place, and runs each call in its own task; more wait in the queue and go as calls end. A server whose Asterisk
      is not connected takes nothing, so the other server's Asterisk calls them; with neither, they wait.
    * **One call per try:** a try is claimed before it is placed (`Store.claim_voice_call/2`), so an entry handed out
      again never calls the person twice. A message the customer cancelled while queued (cancel_sm, S-2.15) is not
      called (DELETED, not billed); one whose validity period ended while it waited is not called (EXPIRED, not
      billed, S-2.13).
    * **Answered:** a DELIVRD receipt (if asked), the message billed at the customer's SMS rate as one unit, the
      charge replacing its credit hold (§7).
    * **Not answered** (no answer in the ring timeout, busy, rejected, congestion, the gateway unreachable): one retry
      after the gateway's `retry_delay_s`, held in Redis (`Store.hold_voice_retry/4`) and put back on the queue when
      due by either server; still not answered: an UNDELIV receipt with error 001, not billed, the credit hold
      released. A gateway no longer active when its message comes up: UNDELIV at once.
    * **EDRs:** one `edr` row per try (`Sms.Switch.Pipeline.Edr.voice_row/3`), the last one final.
  """
  use Supervisor
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Pipeline.{Config, Edr, Forwarder, Ledger, Revenue, Store}
  alias Sms.Switch.Voice
  alias Sms.Switch.Voice.{AmiClient, Pjsip, Prompts}

  @registry __MODULE__.Registry
  @drains __MODULE__.Drains

  # How long a placed try, a waiting retry, a queued mark and a cancelled one are remembered.
  @claim_s 86_400
  @retry_keep_s 86_400
  @queued_s 86_400
  @cancelled_keep_s 86_400
  # How long an answered call is followed to its hangup, and a retry being put back on its queue stays leased.
  @max_call_ms 900_000
  @retry_lease_ms 60_000
  @retry_batch 100

  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    children = [
      {Registry, keys: :unique, name: @registry},
      {Task.Supervisor, name: __MODULE__.Tasks},
      {DynamicSupervisor, name: @drains, strategy: :one_for_one},
      {__MODULE__.Sweep, opts}
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end

  @doc "A voice gateway's queue."
  @spec queue(integer()) :: String.t()
  def queue(gateway_id), do: "vg.#{gateway_id}"

  @doc "The places of a voice gateway's calls at once (`Sms.Switch.Throttle.lease_take/4`)."
  @spec lease_key(integer()) :: String.t()
  def lease_key(gateway_id), do: "vg:#{gateway_id}"

  @doc "How long a call holds its place at most: its ring timeout, the longest call followed and a margin."
  @spec lease_ms(%{required(:ring_timeout_s) => integer(), optional(atom()) => term()}) ::
          integer()
  def lease_ms(%{ring_timeout_s: ring}) when is_integer(ring),
    do: ring * 1_000 + @max_call_ms + 60_000

  @doc """
  Puts a message that became a call (`msg.voice`, `Sms.Switch.Voice.as_call/2`) on its gateway's queue, stored before
  this returns. It is queued for query_sm and cancel_sm until its first try (S-2.15).
  """
  @spec enqueue(map()) :: :ok | {:error, term()}
  def enqueue(msg) do
    ids = Map.get(msg, :ids, [msg.id])
    ent = msg.trunk.enterprise_id

    with {:error, reason} <- Store.mark_queued(ent, ids, @queued_s),
         do:
           Logger.warning(
             "call #{msg.id} not marked queued, cannot be cancelled: #{inspect(reason)}"
           )

    case put(msg, 1, "voice:#{msg.id}:1") do
      :ok ->
        :ok

      {:error, _} = error ->
        Store.drop_queued(ent, ids)
        error
    end
  end

  defp put(msg, try, id) do
    queue = queue(msg.voice.gateway_id)

    data = %{
      "id" => msg.id,
      "m" => Base.encode64(:erlang.term_to_binary({msg, try}, compressed: 1))
    }

    case Bus.put(queue, "voice.call", data, id: id) do
      {:ok, _} -> kick(queue)
      {:error, _} = error -> error
    end
  end

  defp decode(blob), do: blob |> Base.decode64!() |> :erlang.binary_to_term([:safe])

  @doc "Starts the queue's drain on this server unless it runs already (nothing where voice is off)."
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
    # Voice is off on this server, or not started yet: a server with voice finds the queue.
    ArgumentError -> :ok
  catch
    :exit, _ -> :ok
  end

  @doc false
  def via(queue), do: {:via, Registry, {@registry, queue}}

  # ---------------------------------------------------------------- one try

  @doc """
  Runs one queue entry (in a task of its queue's drain): the try, start to end. `:ok` once it is done (the entry is
  acknowledged), or an error when it must run again (Asterisk went away before the call was placed and the entry could
  not be put back).
  """
  @spec run(map()) :: :ok | {:error, :not_connected}
  def run(%{"m" => blob}) do
    {msg, try} = decode(blob)
    key = "#{msg.id}:#{try}"

    cond do
      not Store.claim_voice_call(key, @claim_s) ->
        Logger.info(
          "call #{key} was placed already (queue entry handed out again): not called twice"
        )

        :ok

      cancelled?(msg, try) ->
        ended_uncalled(msg, "DELETED")

      expired?(msg) ->
        ended_uncalled(msg, "EXPIRED")

      true ->
        place(msg, try, key, Config.ready?() && Config.voice_gateway(msg.voice.gateway_id))
    end
  end

  # Queued for cancel_sm until its first try (S-2.15): taken out of the queued ones now, unless it was cancelled.
  defp cancelled?(msg, 1) do
    ids = Map.get(msg, :ids, [msg.id])
    Store.take_queued(msg.trunk.enterprise_id, ids, @cancelled_keep_s) == :cancelled
  end

  defp cancelled?(_msg, _try), do: false

  defp expired?(msg) do
    expires = Map.get(msg, :expires_at)
    is_integer(expires) and System.os_time(:millisecond) >= expires
  end

  defp place(msg, try, key, gateway) when gateway in [nil, false] do
    Logger.warning(
      "call #{key}: voice gateway #{msg.voice.gateway_id} is no longer active, not called"
    )

    now = System.os_time(:millisecond)

    result = %{
      answered: false,
      cause: "GATEWAY_INACTIVE",
      placed_at: now,
      answered_at: nil,
      ended_at: now,
      duration_ms: 0
    }

    failed(msg, try, msg.voice.gateway_id, result)
  end

  defp place(msg, try, key, gateway) do
    call = msg.voice

    params = %{
      action_id: key,
      channel: "PJSIP/#{call.dial}@#{Pjsip.name(gateway.id)}",
      caller_id: call.caller_id,
      timeout_ms: gateway.ring_timeout_s * 1_000,
      variables: [
        {"CODE", call.code},
        {"REPEAT", Integer.to_string(call.repeat)},
        {"PROMPT", Prompts.variable(Voice.sounds_dir(), call.prompt)}
      ]
    }

    case AmiClient.originate(params, @max_call_ms) do
      {:ok, %{answered: true} = result} -> answered(msg, try, gateway.id, result)
      {:ok, result} when try == 1 -> retry(msg, gateway, result)
      {:ok, result} -> failed(msg, try, gateway.id, result)
      {:error, :not_connected} -> back_on_queue(msg, try, key)
    end
  end

  # Asterisk went away between taking the entry and placing the call: back at the end of the queue, for this server
  # or the other.
  defp back_on_queue(msg, try, key) do
    _ = Store.unclaim_voice_call(key)

    case put(msg, try, "voice:#{key}:r#{System.unique_integer([:positive])}") do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "call #{key} not placed (Asterisk not connected) nor queued again: #{inspect(reason)}"
        )

        {:error, :not_connected}
    end
  end

  # ---------------------------------------------------------------- outcomes

  defp answered(msg, try, gateway_id, result) do
    edr_id = Edr.new_id()

    publish(
      msg,
      attempt(edr_id, try, true, result, true),
      voice(msg, gateway_id, result, "DELIVRD", "000")
    )

    charge(msg)
    Forwarder.switch_receipt(msg, edr_id, "DELIVRD", "000")
  end

  # Not answered on the first try: tried once more after the gateway's retry delay.
  defp retry(msg, gateway, result) do
    at = System.os_time(:millisecond) + gateway.retry_delay_s * 1_000
    blob = :erlang.term_to_binary({msg, 2}, compressed: 1)

    case Store.hold_voice_retry(msg.id, blob, at, @retry_keep_s) do
      :ok ->
        Logger.info(
          "call #{msg.id} not answered (#{result.cause}): tried again in #{gateway.retry_delay_s} s"
        )

        publish(
          msg,
          attempt(Edr.new_id(), 1, false, result, false),
          voice(msg, gateway.id, result, nil, nil)
        )

      {:error, reason} ->
        Logger.error(
          "call #{msg.id} not answered and its retry not held (#{inspect(reason)}): undelivered"
        )

        failed(msg, 1, gateway.id, result)
    end
  end

  # Not answered on its last try: UNDELIV 001, not billed.
  defp failed(msg, try, gateway_id, result) do
    Logger.info("call #{msg.id} not answered (#{result.cause}) on try #{try}: undelivered")
    edr_id = Edr.new_id()

    publish(
      msg,
      attempt(edr_id, try, true, result, false),
      voice(msg, gateway_id, result, "UNDELIV", "001")
    )

    release_hold(msg)
    Forwarder.switch_receipt(msg, edr_id, "UNDELIV", "001")
  end

  # Cancelled by the customer (DELETED, no receipt) or expired while it waited (EXPIRED): not called, not billed.
  defp ended_uncalled(msg, status) do
    Logger.info("call #{msg.id} not placed: #{status}")
    release_hold(msg)
    edr_id = Edr.new_id()

    publish(msg, %{edr_id: edr_id, no: 0, final: true, success: false, command_status: 0}, %{
      gateway_id: msg.voice.gateway_id,
      customer_status: status,
      dial: msg.voice.dial,
      caller_id: msg.voice.caller_id
    })

    if status == "EXPIRED", do: Forwarder.switch_receipt(msg, edr_id, "EXPIRED", "000"), else: :ok
  end

  defp attempt(edr_id, try, final, result, billable) do
    %{
      edr_id: edr_id,
      no: try,
      final: final,
      success: result.answered,
      command_status: 0,
      submit_time: result.placed_at,
      resp_time: result.answered_at || result.ended_at,
      msg_count: 1,
      customer_billable: billable
    }
  end

  defp voice(msg, gateway_id, result, status, error) do
    %{
      gateway_id: gateway_id,
      answered: result.answered,
      cause: result.cause,
      duration_ms: result.duration_ms,
      answered_at: result.answered_at,
      dial: msg.voice.dial,
      caller_id: msg.voice.caller_id,
      status: status,
      error: error
    }
  end

  defp publish(msg, attempt, voice) do
    case Edr.publish_attempt(Edr.voice_row(msg, attempt, voice)) do
      :ok -> :ok
      {:error, reason} -> Logger.error("EDR of call #{msg.id} not stored: #{inspect(reason)}")
    end
  end

  # §7: an answered call bills the message once at the customer's SMS rate, one unit whatever its parts; the charge
  # replaces its credit hold.
  defp charge(msg) do
    revenue = {Revenue.keys(msg, nil), Revenue.platform_micro(msg.sell, 1)}
    _ = Ledger.charge(:customer, msg.trunk.enterprise_id, msg.id, msg.sell, 1, revenue)
    :ok
  end

  defp release_hold(msg) do
    _ = Ledger.release(msg.trunk.enterprise_id, msg.id)
    :ok
  end

  # ---------------------------------------------------------------- retries

  @doc false
  # Puts the retries that are due back on their gateways' queues; each by one server (leased while it is moved, so a
  # server stopping meanwhile never loses one).
  @spec release_retries() :: :ok
  def release_retries do
    now = System.os_time(:millisecond)

    for set <- [:waiting, :leased],
        {:ok, ids} <- [Store.due_voice_retries(set, now, @retry_batch)],
        id <- ids,
        Store.claim_voice_retry(set, id, now, now + @retry_lease_ms),
        do: requeue(id)

    :ok
  end

  defp requeue(id) do
    case Store.voice_retry(id) do
      {:ok, blob} when is_binary(blob) ->
        {msg, try} = :erlang.binary_to_term(blob, [:safe])

        case put(msg, try, "voice:#{msg.id}:#{try}") do
          :ok ->
            finished(id)

          {:error, reason} ->
            Logger.warning("retry of call #{id} not queued yet: #{inspect(reason)}")
        end

      {:ok, nil} ->
        finished(id)

      {:error, reason} ->
        Logger.warning("retry of call #{id} not read: #{inspect(reason)}")
    end
  end

  defp finished(id) do
    _ = Store.finish_voice_retry(id)
    :ok
  end
end

defmodule Sms.Switch.Voice.Calls.Sweep do
  @moduledoc false
  # Every `:retry_ms` (1 s) puts the due retries back on their queues; every `:discover_ms` (2 s) starts a drain for
  # each voice gateway queue with something waiting (left by a restart, or put there by the other server).
  use GenServer
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Voice.Calls

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    state = %{
      retry_ms: Keyword.get(opts, :retry_ms, 1_000),
      discover_ms: Keyword.get(opts, :discover_ms, 2_000)
    }

    send(self(), :retries)
    send(self(), :discover)
    {:ok, state}
  end

  @impl true
  def handle_info(:retries, state) do
    :ok = Calls.release_retries()
    Process.send_after(self(), :retries, state.retry_ms)
    {:noreply, state}
  end

  def handle_info(:discover, state) do
    _ =
      case Bus.queues() do
        {:ok, queues} ->
          for {queue, _n} <- queues, match?("vg." <> _, queue), do: Calls.kick(queue)

        {:error, reason} ->
          Logger.debug("voice queues not listed: #{inspect(reason)}")
      end

    Process.send_after(self(), :discover, state.discover_ms)
    {:noreply, state}
  end
end

defmodule Sms.Switch.Voice.Calls.Drain do
  @moduledoc false
  # Drains one voice gateway's queue on this server (see `Sms.Switch.Voice.Calls`): while Asterisk is connected, takes a
  # message each time it holds one of the gateway's places, up to `max_calls` calls at once, each in its own task.
  # Stops after `@idle_ms` with nothing to do. A gateway no longer active: its messages are taken (no place, no
  # Asterisk needed) and end undelivered.
  use GenServer, restart: :temporary
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Pipeline.Config
  alias Sms.Switch.Throttle
  alias Sms.Switch.Voice.{AmiClient, Calls}

  @idle_ms 5_000
  @poll_ms 200

  def start_link(queue), do: GenServer.start_link(__MODULE__, queue, name: Calls.via(queue))

  def child_spec(queue),
    do: %{id: {__MODULE__, queue}, start: {__MODULE__, :start_link, [queue]}, restart: :temporary}

  @impl true
  def init("vg." <> id = queue) do
    send(self(), :work)

    {:ok,
     %{queue: queue, gateway_id: String.to_integer(id), tasks: %{}, idle_since: nil, timer: nil}}
  end

  @impl true
  def handle_info(:kick, state), do: {:noreply, work(%{state | idle_since: nil})}
  def handle_info(:work, state), do: {:noreply, work(%{state | timer: nil})}

  def handle_info({ref, result}, %{tasks: tasks} = state) when is_map_key(tasks, ref) do
    Process.demonitor(ref, [:flush])
    {{handle, lease}, tasks} = Map.pop(tasks, ref)
    give_back(state, lease)

    _ =
      case result do
        :ok ->
          Bus.ack(handle)

        other ->
          Logger.warning("call on #{state.queue} not finished, it runs again: #{inspect(other)}")
      end

    {:noreply, work(%{state | tasks: tasks})}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{tasks: tasks} = state)
      when is_map_key(tasks, ref) do
    {{_handle, lease}, tasks} = Map.pop(tasks, ref)
    give_back(state, lease)
    Logger.error("call on #{state.queue} crashed: #{inspect(reason)}")
    {:noreply, work(%{state | tasks: tasks})}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp work(state) do
    gateway = Config.ready?() && Config.voice_gateway(state.gateway_id)

    cond do
      not Config.ready?() -> later(state, 1_000)
      gateway == nil -> take(state, nil)
      not AmiClient.ready?() -> idle(state)
      map_size(state.tasks) >= gateway.max_calls -> state
      true -> with_place(state, gateway)
    end
  end

  defp with_place(state, gateway) do
    lease = Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)

    if Throttle.lease_take(
         Calls.lease_key(gateway.id),
         lease,
         gateway.max_calls,
         Calls.lease_ms(gateway)
       ),
       do: take(state, lease),
       # Every line of the gateway busy (here or on the other server): looked at again shortly.
       else: later(%{state | idle_since: nil}, @poll_ms)
  end

  defp take(state, lease) do
    case Bus.take(state.queue) do
      {:ok, event, handle} ->
        task = Task.Supervisor.async_nolink(Calls.Tasks, fn -> Calls.run(event.data) end)
        work(%{state | tasks: Map.put(state.tasks, task.ref, {handle, lease}), idle_since: nil})

      :empty ->
        give_back(state, lease)
        if state.tasks == %{}, do: idle(state), else: state

      {:error, reason} ->
        give_back(state, lease)
        Logger.debug("voice queue #{state.queue} not read: #{inspect(reason)}")
        later(state, 1_000)
    end
  end

  defp give_back(_state, nil), do: :ok

  defp give_back(state, lease),
    do: Throttle.lease_release(Calls.lease_key(state.gateway_id), lease)

  defp idle(%{idle_since: nil} = state), do: later(%{state | idle_since: now()}, @poll_ms)

  defp idle(state) do
    if now() - state.idle_since >= @idle_ms and state.tasks == %{},
      do: exit(:normal),
      else: later(state, @poll_ms)
  end

  defp later(%{timer: nil} = state, ms),
    do: %{state | timer: Process.send_after(self(), :work, ms)}

  defp later(state, _ms), do: state

  defp now, do: System.monotonic_time(:millisecond)
end
