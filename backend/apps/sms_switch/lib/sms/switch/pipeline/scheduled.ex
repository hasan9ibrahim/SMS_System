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
    * **at its time** (`release_due/0`, run by `Sms.Switch.Pipeline.Timeouts` every second on both servers): the
      server that takes the entry from `sch` publishes the message to the normal accepted path (`sms.msg.accepted`,
      id `msg:<id>`); the sender then checks its validity period (EXPIRED if it ended), rates, holds its credit and
      routes it at the prices and routes valid when it goes (`Sms.Switch.Pipeline.Sender`). Refused then (no credit,
      no route): a REJECTD receipt if asked and an EDR row, not billed. The vendor gets no schedule_delivery_time for it
      (it goes when due) and its validity period as an absolute time in UTC. A release keeps a lease (`schl`) until
      its message is on the bus, so a server stopping mid-release leaves it to the other one;
    * **before its time**: query_sm answers ENROUTE (SMPP 3.4 has no scheduled state, `held?/2`); cancel_sm takes it
      out (`cancel/2`): a DELETED receipt if asked, an EDR row (attempt 0, DELETED), nothing billed.
  """
  require Logger
  alias Sms.Core.Bus
  alias Sms.Switch.Pipeline.{Edr, Forwarder, Intake, Store}

  @default_max_s 7 * 86_400
  @lease_ms 60_000
  @batch 500
  # A held message's keys outlive its time by a day (they go when it is released or cancelled).
  @keep_after_s 86_400
  # How long a queued or cancelled mark lasts (as the intake's).
  @queued_s 86_400

  @doc "How far ahead a message may be scheduled (ms): `:max_schedule_s`, 7 days by default."
  @spec max_ahead_ms() :: pos_integer()
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
  @spec hold(map()) :: :ok | {:error, term()}
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
  Releases the scheduled messages whose time came by `now` (Unix ms), and those a stopped server left leased; each by
  one server.
  """
  @spec release_due(integer()) :: :ok
  def release_due(now \\ System.os_time(:millisecond)) do
    _ = release_set(:waiting, now)
    _ = release_set(:leased, now)
    :ok
  end

  defp release_set(set, now) do
    case Store.due_scheduled(set, now, @batch) do
      {:ok, ids} ->
        Enum.each(ids, &take(set, &1, now))
        if length(ids) == @batch, do: release_set(set, now), else: :ok

      {:error, reason} ->
        Logger.warning("scheduled messages not released: #{inspect(reason)}")
    end
  end

  defp take(set, id, now) do
    if Store.claim_scheduled(set, id, now, now + @lease_ms), do: release(id), else: :ok
  end

  # On the bus as an accepted message, queued so cancel_sm and query_sm see it as any other (S-2.15); the lease ends
  # once it is there. Not published: the lease runs out and it is tried again.
  defp release(id) do
    case Store.scheduled(id) do
      {:ok, held} ->
        msg = :erlang.binary_to_term(held.blob, [:safe])

        with {:error, reason} <- Store.mark_queued(held.enterprise_id, held.ids, @queued_s),
             do: Logger.warning("released message #{id} not marked queued: #{inspect(reason)}")

        case Bus.publish("sms.msg.accepted", "msg.accepted", Intake.event_data(msg),
               id: "msg:#{id}"
             ) do
          {:ok, _} ->
            _ = Store.finish_scheduled(id, held.enterprise_id, held.ids)
            Logger.info("scheduled message #{id} released (S-2.12)")

          {:error, reason} ->
            Logger.warning(
              "scheduled message #{id} not released yet, tried again: #{inspect(reason)}"
            )
        end

      :none ->
        _ = Store.finish_scheduled(id, nil, [])

      {:error, reason} ->
        Logger.warning("scheduled message #{id} not read, tried again: #{inspect(reason)}")
    end
  end

  @doc "Whether a customer message id of the enterprise is held for its time (query_sm: ENROUTE)."
  @spec held?(integer(), String.t()) :: {:ok, boolean()} | {:error, term()}
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
  @spec cancel(integer(), String.t()) :: :ok | :not_held | {:error, term()}
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
