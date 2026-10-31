defmodule Sms.Switch.Pipeline.Scheduled do
  @moduledoc """
  Scheduled messages held in the switch (docs/SMPP_SCENARIOS.md S-2.12, decided 2026-10-31): a message with a
  `schedule_delivery_time` still ahead is accepted at once (submit_sm_resp with our message id) and goes to a vendor
  when its time comes.

    * **at intake** (`Sms.Switch.Pipeline.Intake`): the message is checked as for sending now (the checks, ingress
      translation, a rate and a route, the credit without a hold) and refused as usual if it could not go; a schedule
      more than `:max_schedule_s` ahead (7 days) is refused with 0x61. It is then held in Redis (`hold/1`): `sch:<id>`
      and the sorted set `sch` by its time (`Sms.Switch.Pipeline.Store`), so it survives a restart and either server
      releases it;
    * **at its time** (`release_due/0`, started by `Sms.Switch.Pipeline.Timeouts` every second on both servers): the
      server that takes the entry from `sch` sends the message on at its customer trunk's TPS, as the session holds
      live traffic to it (`Sms.Switch.Customer.Trunk.admit/2`, S-2.4): within the TPS it goes to the normal accepted
      path (`sms.msg.accepted`, id `msg:<id>`); over it, to the trunk's overflow buffer while that has room (released
      from there at the TPS, `Sms.Switch.Pipeline.Buffers`); with both full (or no buffer) it stays held, in its
      trunk's own waiting set by its time (`schq:<trunk>`), and goes on a later sweep, before any message of that
      trunk due after it. Never refused nor dropped for its TPS. The sender then checks its validity period (EXPIRED if
      it ended), rates, holds its credit and routes it at the prices and routes valid when it goes
      (`Sms.Switch.Pipeline.Sender`). Refused then (no credit, no route): a REJECTD receipt if asked and an EDR row,
      not billed. The vendor gets no schedule_delivery_time for it (it goes when due) and its validity period as an
      absolute time in UTC. A release keeps a lease (`schl`) until its message is on the bus or waiting, so a server
      stopping mid-release leaves it to the other one, and each message is sent on by one server only;
    * **before it goes**: query_sm answers ENROUTE (SMPP 3.4 has no scheduled state, `held?/2`); cancel_sm takes it
      out (`cancel/2`), also while it waits for its trunk's TPS: a DELETED receipt if asked, an EDR row (attempt 0,
      DELETED), nothing billed.
  """
  require Logger
  alias Sms.Switch.Customer.{Trunk, TrunkStore}
  alias Sms.Switch.Pipeline.{Edr, Forwarder, Intake, Store}

  @default_max_s 7 * 86_400
  @lease_ms 60_000
  @batch 500
  # A held message's keys outlive its time by a day (they go when it is released or cancelled).
  @keep_after_s 86_400
  # ... and once it waits for its trunk's TPS, as long as a schedule may be ahead (S-2.4).
  @waiting_keep_s 7 * 86_400
  # How long a queued or cancelled mark lasts (as the intake's).
  @queued_s 86_400

  @doc "How far ahead a message may be scheduled (ms): `:max_schedule_s`, 7 days by default."
  @spec max_ahead_ms() :: number()
  def max_ahead_ms,
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline, [])
      |> Keyword.get(:max_schedule_s, @default_max_s)
      |> Kernel.*(1_000)

  @doc """
  Holds an accepted message until its scheduled time. It gives back the overflow buffer place it took (it waits here,
  not in the trunk's buffer, S-2.4) and goes on as an ordinary message when released.
  """
  def hold(msg) do
    released =
      Map.merge(msg, %{release: true, buffered: false, tps_counters: [], credit_held: false})

    ids = Map.get(msg, :ids, [msg.id])
    blob = :erlang.term_to_binary(released, compressed: 1)
    ttl_s = max(div(msg.scheduled_at - System.os_time(:millisecond), 1_000), 0) + @keep_after_s

    case Store.schedule(msg.id, msg.trunk.enterprise_id, ids, blob, msg.scheduled_at, ttl_s) do
      :ok ->
        Logger.info("message #{msg.id} held until #{msg.scheduled_at} (S-2.12)")
        Intake.leave_buffer(msg)

      # Not held: the intake answers 0x14 and gives the buffer place back itself.
      {:error, _} = error ->
        error
    end
  end

  @doc """
  Releases the scheduled messages whose time came by `now` (Unix ms), and those a stopped server left leased, at their
  customer trunks' TPS (S-2.4); each by one server. First the ones that waited for their trunk's TPS (the oldest), then
  the newly due ones by time; a trunk that still has waiting ones gets its newly due ones queued behind them.

  The trunks' TPS and buffers are the customer side's (`Sms.Switch.Customer.TrunkStore`): until it has loaded them,
  nothing is released here (the other server does, or this one a moment later).
  """
  @spec release_due(integer()) :: :ok
  def release_due(now \\ System.os_time(:millisecond)) do
    if TrunkStore.ready?() do
      busy = release_waiting(now)
      busy = release_set(:waiting, now, busy)
      _ = release_set(:leased, now, busy)
    end

    :ok
  end

  # ---------------------------------------------------------------- waiting for their trunk's TPS (S-2.4)

  # Each trunk with waiting messages in turn, a batch at a time, the earliest first, until its TPS and buffer are full
  # or it has none left. Returns the trunks still busy (their newly due messages wait behind).
  defp release_waiting(now) do
    case Store.waiting_trunks() do
      {:ok, trunks} ->
        release_waiting(trunks, now, MapSet.new())

      {:error, reason} ->
        Logger.warning(
          "scheduled messages waiting for their TPS not released: #{inspect(reason)}"
        )

        MapSet.new()
    end
  end

  defp release_waiting([], _now, busy), do: busy

  defp release_waiting(trunks, now, busy) do
    {more, busy} =
      Enum.reduce(trunks, {[], busy}, fn t, {more, busy} ->
        case release_trunk(t, now) do
          :more -> {[t | more], busy}
          :full -> {more, MapSet.put(busy, t)}
          :done -> {more, busy}
        end
      end)

    release_waiting(Enum.reverse(more), now, busy)
  end

  # `:more` when the whole batch went on (more may wait), `:full` when the trunk can take no more now (or nothing could
  # be taken: tried again on the next sweep), `:done` when nothing waits any more.
  defp release_trunk(t, now) do
    case Store.waiting_scheduled(t, @batch) do
      {:ok, []} ->
        _ = Store.forget_waiting(t)
        :done

      {:ok, ids} ->
        release_waiting_ids(trunk(t), t, ids, now, false)

      {:error, reason} ->
        Logger.warning("scheduled messages of trunk #{t} not read: #{inspect(reason)}")
        :full
    end
  end

  # The trunk's place is taken before the message, so a full trunk costs no more than that; a message the other server
  # took first (or cancel_sm) gives its place back.
  defp release_waiting_ids(_trunk, _t, [], _now, progress),
    do: if(progress, do: :more, else: :full)

  defp release_waiting_ids(trunk, t, [id | rest], now, progress) do
    second = System.os_time(:second)

    case admit(trunk, second) do
      :full ->
        :full

      admission ->
        lease = now + @lease_ms

        if Store.claim_waiting(t, id, lease) do
          release_claimed(id, trunk, admission, second)
          release_waiting_ids(trunk, t, rest, now, true)
        else
          unadmit(trunk, admission, second)
          release_waiting_ids(trunk, t, rest, now, progress)
        end
    end
  end

  defp release_claimed(id, trunk, admission, second) do
    case Store.scheduled(id) do
      {:ok, held} ->
        send_on(id, held, decode(held), trunk, admission, second)

      other ->
        unadmit(trunk, admission, second)
        unreadable(id, other)
    end
  end

  # ---------------------------------------------------------------- due now

  defp release_set(set, now, busy) do
    case Store.due_scheduled(set, now, @batch) do
      {:ok, ids} ->
        busy = Enum.reduce(ids, busy, &take(set, &1, now, &2))
        if length(ids) == @batch, do: release_set(set, now, busy), else: busy

      {:error, reason} ->
        Logger.warning("scheduled messages not released: #{inspect(reason)}")
        busy
    end
  end

  defp take(set, id, now, busy) do
    lease = now + @lease_ms

    with true <- Store.claim_scheduled(set, id, now, lease),
         {:ok, held} <- Store.scheduled(id) do
      due(id, held, decode(held), lease, busy)
    else
      false ->
        busy

      other ->
        unreadable(id, other)
        busy
    end
  end

  # Behind its trunk's waiting messages if it has any; else on within the trunk's TPS, into its overflow buffer over it,
  # or waiting when both are full (S-2.4).
  defp due(id, held, msg, lease, busy) do
    t = msg.trunk.id

    if MapSet.member?(busy, t) do
      wait(id, held, msg, lease)
      busy
    else
      trunk = trunk(t)
      second = System.os_time(:second)

      case admit(trunk, second) do
        :full ->
          wait(id, held, msg, lease)
          MapSet.put(busy, t)

        admission ->
          send_on(id, held, msg, trunk, admission, second)
          busy
      end
    end
  end

  # Held on in its trunk's waiting set, by its time. Not moved (Redis failed): its lease runs out and it is tried again;
  # a lease another server took over leaves it to that one.
  defp wait(id, held, msg, lease) do
    at = msg[:scheduled_at] || System.os_time(:millisecond)

    case Store.defer_scheduled(
           id,
           msg.trunk.id,
           at,
           lease,
           held.enterprise_id,
           held.ids,
           @waiting_keep_s
         ) do
      true ->
        Logger.info("scheduled message #{id} waits for its trunk's TPS (S-2.12, S-2.4)")

      false ->
        :ok

      {:error, reason} ->
        Logger.warning("scheduled message #{id} not set to wait, tried again: #{inspect(reason)}")
    end
  end

  # On the bus as an accepted message (within the TPS) or in the trunk's overflow buffer (over it, with its place),
  # queued so cancel_sm and query_sm see it as any other (S-2.15, `Intake.store/1`); the lease ends once it is there.
  # Not stored: its place is given back and the lease runs out (tried again).
  defp send_on(id, held, msg, trunk, admission, second) do
    msg =
      case admission do
        :buffered -> %{msg | buffered: true, tps_counters: Trunk.tps_counters(trunk)}
        :ok -> msg
      end

    case Intake.store(msg) do
      :ok ->
        _ = Store.finish_scheduled(id, held.enterprise_id, held.ids)
        Logger.info("scheduled message #{id} released (S-2.12)")

      {:error, reason} ->
        unadmit(trunk, admission, second)

        Logger.warning(
          "scheduled message #{id} not released yet, tried again: #{inspect(reason)}"
        )
    end
  end

  # Gone (its keys expired): forgotten. Not read: its lease runs out and it is tried again.
  defp unreadable(id, :none) do
    _ = Store.finish_scheduled(id, nil, [])
    :ok
  end

  defp unreadable(id, {:error, reason}),
    do: Logger.warning("scheduled message #{id} not read, tried again: #{inspect(reason)}")

  defp decode(held), do: :erlang.binary_to_term(held.blob, [:safe])

  # The customer trunk as the session counts it; nil once it is no customer trunk here any more (deleted): the sender
  # then decides, as for any message of an unknown trunk.
  defp trunk(id) do
    case TrunkStore.get(id) do
      {:ok, trunk} -> trunk
      :error -> nil
    end
  end

  defp admit(nil, _second), do: :ok
  defp admit(trunk, second), do: Trunk.admit(trunk, second)

  defp unadmit(nil, _admission, _second), do: :ok
  defp unadmit(trunk, admission, second), do: Trunk.unadmit(trunk, admission, second)

  @doc "Whether a customer message id of the enterprise is held for its time (query_sm: ENROUTE)."
  def held?(enterprise_id, id) do
    case Store.scheduled_id(enterprise_id, id) do
      {:ok, nil} -> {:ok, false}
      {:ok, _} -> {:ok, true}
      error -> error
    end
  end

  @doc """
  Cancels a message held for its time (cancel_sm, any of its customer message ids): `:ok`, or `:not_held` when it is
  not held (released already: the queued cancel decides).
  """
  def cancel(enterprise_id, id) do
    with {:ok, sid} when is_binary(sid) <- Store.scheduled_id(enterprise_id, id),
         {:ok, held} <- Store.take_scheduled(sid) do
      cancelled(:erlang.binary_to_term(held.blob, [:safe]), held)
    else
      {:ok, nil} -> :not_held
      :none -> :not_held
      {:error, _} = error -> error
    end
  end

  # Never sent, not billed: DELETED for query_sm, an EDR row (attempt 0, DELETED), a DELETED receipt if asked.
  defp cancelled(msg, held) do
    Logger.info("scheduled message #{msg.id} cancelled before its time (S-2.12, S-2.15)")
    _ = Store.mark_cancelled(held.enterprise_id, held.ids, @queued_s)
    edr_id = Edr.new_id()

    row =
      msg
      |> Edr.attempt_row(%{
        edr_id: edr_id,
        no: 0,
        final: true,
        success: false,
        vendor: nil,
        command_status: 0
      })
      |> Map.put("c_msg_status", "DELETED")

    _ = Edr.publish_attempt(row)
    Forwarder.switch_receipt(msg, edr_id, "DELETED", "000")
  end
end
