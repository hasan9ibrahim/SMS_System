defmodule Sms.Switch.Pipeline.Sender do
  @moduledoc """
  The vendor leg (spec §2, §6, docs/SMPP_SCENARIOS.md §2, §5): takes each accepted message from the durable bus
  (`sms.msg.accepted`) and sends it to the vendor routing chose, re-routing when that vendor does not take it.

  For each vendor tried, in the rules' order (`Sms.Switch.Pipeline.Router`):

    * the message as that vendor's egress translation left it (S-4.8); a text a translation changed is encoded again,
      in UCS-2 when it no longer fits its alphabet (S-4.4); a message the switch must split goes as UDH parts (S-3.1,
      S-3.12) on one connection where possible (S-3.8); receipts are always asked of the vendor (S-2.14);
    * a temporary refusal (0x58, 0x14, 0x08) is tried again on the same vendor with the same reference, up to 3 times
      within seconds (S-5.3, D2); the vendor at its TPS limit or with its window full keeps the message in its
      overflow buffer (S-5.1), and a later part waits up to `:vendor_wait_ms` for room. A sender worker never waits:
      whatever must wait goes on in the vendor's own queue (`Sms.Switch.Pipeline.Buffers`, `resume/1`);
    * any other refusal, a Submit Timeout (possibly sent, D4) or a lost connection moves the message to the next
      vendor, with new references; parts the vendor accepted before stay as that attempt's, with their cost (D2); a
      vendor with no bound connection is skipped (S-5.4);
    * when no vendor is left the message has failed: the customer gets a REJECTD receipt (UNKNOWN when the last
      vendor may have it) if it asked for receipts;
    * a message whose validity period ended before a vendor took it is not sent: an EXPIRED receipt (S-2.13). A
      vendor gets the validity period and scheduled time as absolute times in UTC;
    * a scheduled message the switch held (S-2.12, `Sms.Switch.Pipeline.Scheduled`) comes at its time: rated, routed
      and its credit held then, and sent without a schedule.

  Every attempt that reached a vendor is an EDR row (`Sms.Switch.Pipeline.Edr`); a message sent is recorded
  (`Sms.Switch.Pipeline.Store`) so its receipts find it, and a receipt that came before its submit_sm_resp is picked
  up then (S-5.5). Translation growing the part count fails the message unsent (D3).

  A message delivered to this consumer again (after a crash, at least once, S-7.1) that is already recorded as sent is
  not sent again.
  """
  use Sms.Core.Bus.Consumer,
    name: "pipeline-sender",
    filter: "sms.msg.accepted",
    max_deliver: 5,
    # A message may take minutes (30 s per vendor, re-routes); it is reported in progress every 10 s, so one whose
    # sender died with its connection is handed out again within 30 s (backend step 8).
    ack_wait_ms: 30_000,
    progress_ms: 10_000,
    concurrency: 50

  require Logger
  import Bitwise
  alias Sms.Core.Bus
  alias Sms.Switch.Message.{Coding, Concat, Text}

  alias Sms.Switch.Pipeline.{
    Backlog,
    Billing,
    Buffers,
    Config,
    Delayed,
    Edr,
    Forwarder,
    Intake,
    Ledger,
    LiveTps,
    Receipts,
    Revenue,
    Router,
    Store
  }

  alias Sms.Switch.Smpp.Status
  alias Sms.Switch.Smpp.Time, as: SmppTime
  alias Sms.Switch.{Throttle, Vendor}

  # How long a timed-out submit waits for a late answer (D4), and a sent message counts as in flight (S-5.16).
  @late_keep_s 3_600
  @in_flight_s 120
  # How long a cancelled message is remembered for query_sm (S-2.15).
  @cancelled_keep_s 86_400
  @temporary [0x58, 0x14, 0x08]
  @temporary_tries 3
  @udhi 0x40
  # TLVs passed on to the vendor; the rest (vendor-specific ones included) stay with the customer leg.
  @passed_tlvs [:user_message_reference, :source_port, :destination_port, :language_indicator]

  @impl true
  def handle_event(event) do
    if Config.ready?() do
      # How long it waited for the sender, for the overload guard (backend step 7). A message from an overflow
      # buffer or a resend is published when it leaves the buffer or is resent, so its wait in a buffer never counts.
      Backlog.observe(event.occurred_at)
      handle_message(Intake.decode(event.data))
    else
      {:error, :config_not_loaded}
    end
  end

  defp handle_message(msg) do
    # A resend after a failed receipt (S-5.11): its message was forgotten; the claim stops a redelivery sending twice.
    if is_map(msg[:resend]) do
      if Store.claim_resend(msg.id, msg.resend.no), do: send_message(msg), else: :ok
    else
      send_unless_sent(msg)
    end
  end

  defp send_unless_sent(msg) do
    case Store.sent?(msg.id) do
      false -> send_message(msg)
      true -> :ok
      {:error, reason} -> {:error, {:store, reason}}
    end
  end

  @doc false
  # Sends one message; public for tests that run the vendor leg without the bus.
  @spec send_message(%{required(:ingress) => map() | nil, optional(atom()) => term()}) :: :ok
  def send_message(%{resend: resend} = msg) when is_map(resend), do: resend(msg, resend)

  def send_message(msg) do
    cond do
      Store.take_queued(msg.trunk.enterprise_id, Map.get(msg, :ids, [msg.id]), @cancelled_keep_s) ==
          :cancelled ->
        cancelled(msg)

      msg[:release] == true ->
        released(Map.delete(msg, :release))

      true ->
        go(msg)
    end

    :ok
  end

  defp go(msg) do
    if grows_parts?(msg, msg.ingress[:text]) do
      # D3: a translation that adds parts never reaches a vendor; the customer is not billed.
      fail(msg, [], %{
        status: "REJECTD",
        error: "001",
        command_status: Status.code(:esme_rsubmitfail),
        reason: :translation_grows
      })
    else
      attempt(msg, msg.route, 1, MapSet.new([msg.route.vendor_trunk_id]), [])
    end
  end

  # S-2.12 (decided 2026-10-31): a scheduled message at its time (`Sms.Switch.Pipeline.Scheduled`). Its validity period
  # first (EXPIRED if it ended, S-2.13); then rated, routed and its credit held now. Refused then (no rate, no route, no
  # credit): a REJECTD receipt if asked and an EDR row, not billed.
  defp released(msg) do
    if expired?(msg, nil) do
      expired(msg, [])
    else
      case Intake.release(msg) do
        {:ok, msg} ->
          go(msg)

        {:reject, status, reason, msg} ->
          code = Status.code(status)
          Logger.info("scheduled message #{msg.id} refused at its time (#{inspect(reason)})")

          fail(msg, [], %{
            status: "REJECTD",
            error: err(code),
            command_status: code,
            reason: reason
          })
      end
    end
  end

  # S-2.13: its validity period ended before a vendor took it: not sent, an EXPIRED receipt if the customer asked for
  # one (a Delayed Submit customer gets the failure in its resp), not billed; the attempts before stay as they were. One
  # more EDR row (attempt 0, EXPIRED).
  defp expired(msg, rows) do
    Logger.info("message #{msg.id} expired before a vendor took it (S-2.13)")
    publish_rows(msg, rows, false)
    release_hold(msg)
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
      |> Map.put("c_msg_status", "EXPIRED")

    _ = Edr.publish_attempt(row)

    unless Delayed.notify(msg.id, {:error, Status.code(:esme_rsubmitfail)}),
      do: Forwarder.switch_receipt(msg, edr_id, "EXPIRED", "000")

    :ok
  end

  # Cancelled by the customer while queued (S-2.15, D8): never sent, not billed, no receipt; one EDR row (attempt 0,
  # DELETED).
  defp cancelled(msg) do
    Logger.info("message #{msg.id} cancelled by the customer before it was sent (S-2.15)")
    release_hold(msg)

    row =
      msg
      |> Edr.attempt_row(%{
        edr_id: Edr.new_id(),
        no: 0,
        final: true,
        success: false,
        vendor: nil,
        command_status: 0
      })
      |> Map.put("c_msg_status", "DELETED")

    _ = Edr.publish_attempt(row)
    :ok
  end

  # ---------------------------------------------------------------- one vendor

  # `held`: the message comes from this vendor's queue (`resume/1`): when it was queued, whether it holds a place of the
  # overflow buffer, and the parts still to send when it was part-way through (`job`).
  defp attempt(msg, route, no, tried, rows, held \\ nil) do
    vt = route.vendor_trunk_id
    tried = MapSet.put(tried, vt)

    if expired?(msg, held) do
      left_buffer(held, vt)
      expired(msg, rows)
    else
      try_vendor(msg, route, no, tried, rows, held)
    end
  end

  # S-2.13: checked before each vendor is tried (a re-route, a resend, the message leaving a vendor's queue); a message
  # part-way through on a vendor finishes there.
  defp expired?(_msg, %{job: %{done: [_ | _]}}), do: false

  defp expired?(msg, _held) do
    expires = Map.get(msg, :expires_at)
    is_integer(expires) and System.os_time(:millisecond) >= expires
  end

  defp try_vendor(msg, route, no, tried, rows, held) do
    vt = route.vendor_trunk_id

    case job(msg, route, held) do
      {:skip, reason} ->
        Logger.info("message #{msg.id}: vendor trunk #{vt} skipped (#{reason})")
        left_buffer(held, vt)
        next(msg, no, tried, rows, nil)

      {:ok, job} ->
        outcome = send_parts(vt, job, msg.id, held)
        left_buffer(held, vt)
        outcome(outcome, {msg, route, no, tried, rows, held})
    end
  end

  # A message part-way through goes on with the parts it has (the same reference, D2); otherwise they are built now.
  defp job(_msg, _route, %{job: %{} = job}), do: {:ok, job}
  defp job(msg, route, _held), do: new_job(msg, route)

  defp new_job(msg, route) do
    with {:ok, submits, coding, parts} <- submits(msg, route) do
      {:ok,
       %{
         submits: submits,
         coding: coding,
         parts: parts,
         done: [],
         temporary: 0,
         not_before: 0,
         # The vendor's address as connected, from its last answer (EDR v_ip / v_port).
         peer: nil,
         started: System.os_time(:millisecond)
       }}
    end
  end

  # What happened on the vendor; `job` as it ended (the parts the vendor accepted, the parts left).
  defp outcome({:sent, job}, {msg, route, no, tried, rows, _held}) do
    attempt = no |> attempt_of(route, job) |> Map.put(:tried, tried)
    sent(msg, route, attempt, Enum.reverse(job.done), rows)
  end

  defp outcome({:busy, reason}, {msg, route, no, tried, rows, held}),
    do: busy(msg, route, no, tried, rows, held, reason)

  defp outcome({:later, job}, {msg, route, no, tried, rows, _held}),
    do: park(msg, route, no, tried, rows, job)

  # S-4.7: a message whose PDU cannot be built (an address unfit to send) fails 0x0A unless another vendor takes it.
  defp outcome({:invalid, reason}, {msg, route, no, tried, rows, _held}) do
    Logger.error(
      "message #{msg.id}: its PDU for vendor trunk #{route.vendor_trunk_id} cannot be encoded (#{inspect(reason)})"
    )

    code = Status.code(:esme_rinvsrcadr)

    next(
      msg,
      no,
      tried,
      rows,
      {nil, %{status: "REJECTD", error: err(code), command_status: code}}
    )
  end

  defp outcome({:unavailable, reason}, {msg, route, no, tried, rows, _held}) do
    Logger.info(
      "message #{msg.id}: vendor trunk #{route.vendor_trunk_id} unavailable (#{inspect(reason)})"
    )

    next(msg, no, tried, rows, nil)
  end

  defp outcome({:rejected, status, job}, {msg, route, no, tried, rows, _held}) do
    row = no |> attempt_of(route, job) |> refused(job.done, status)

    next(
      msg,
      no + 1,
      tried,
      rows,
      {row, %{status: "REJECTD", error: err(status), command_status: status}}
    )
  end

  defp outcome({:possibly_sent, reason, job}, {msg, route, no, tried, rows, _held}) do
    Logger.warning(
      "message #{msg.id}: no answer from vendor trunk #{route.vendor_trunk_id} (#{reason}); re-routing (D4)"
    )

    attempt = attempt_of(no, route, job)
    # The parts not answered: from the first one not accepted to the last.
    _ = possibly_sent(msg, attempt, length(job.done) + 1, length(job.done) + length(job.submits))
    row = refused(attempt, job.done, -1)
    next(msg, no + 1, tried, rows, {row, %{status: "UNKNOWN", error: "000", command_status: -1}})
  end

  defp attempt_of(no, route, job) do
    %{
      edr_id: Edr.new_id(),
      no: no,
      vendor: Map.merge(route, %{data_coding: job.coding, peer: job[:peer]}),
      submit_time: job.started,
      resp_time: System.os_time(:millisecond),
      # The parts the message counts as, not the PDUs (one message_payload is billed per part, S-3.1).
      msg_count: job.parts
    }
  end

  # D2: a part refused after others went; the parts the vendor accepted stay as that attempt's, with their ids and cost.
  defp refused(attempt, [], status),
    do: Map.merge(attempt, %{success: false, command_status: status})

  defp refused(attempt, done, status) do
    ids = done |> Enum.reverse() |> Enum.map(& &1.message_id)

    Map.merge(attempt, %{
      success: false,
      command_status: status,
      accepted: length(done),
      msg_count: length(done),
      vendor_message_id: done |> Enum.reverse() |> Enum.map_join(",", & &1.raw_message_id),
      vendor_message_keys: Enum.reject(ids, &(&1 in [nil, ""]))
    })
  end

  # A message from a vendor's buffer gives its place back once tried there, whatever happened.
  defp left_buffer(%{place: true}, vt), do: Throttle.buffer_release(vendor_buffer_key(vt))
  defp left_buffer(_held, _vt), do: :ok

  # The vendor is at its TPS or its window is full: its overflow buffer, or the next vendor (S-5.1); a message that
  # waited its time in the buffer already goes to the next vendor.
  defp busy(msg, route, no, tried, rows, nil, reason),
    do: buffer(msg, route, no, tried, rows, reason)

  defp busy(msg, route, no, tried, rows, _held, reason) do
    Logger.info(
      "message #{msg.id}: vendor trunk #{route.vendor_trunk_id} still #{reason} after #{vendor_buffer_wait_ms()} ms " <>
        "in its buffer; next vendor (S-5.1)"
    )

    next(msg, no, tried, rows, nil)
  end

  # S-5.1 (product owner 2026-10-25): a vendor with an overflow buffer keeps the message for when it has room, while
  # the buffer has room; a buffer of 0, or a full one, sends it to the next vendor at once.
  defp buffer(msg, route, no, tried, rows, reason) do
    vt = route.vendor_trunk_id
    size = (Config.vendor_trunk(vt) || %{})[:overflow_buffer] || 0

    if size > 0 and Throttle.buffer_take(vendor_buffer_key(vt), size) do
      held = %{queued_at: System.os_time(:millisecond), place: true, job: nil}

      case queue(msg, route, no, tried, rows, held, "vbuf:#{msg.id}:#{no}:#{vt}") do
        :ok ->
          :ok

        {:error, error} ->
          Logger.warning(
            "message #{msg.id} not buffered for vendor trunk #{vt}: #{inspect(error)}"
          )

          Throttle.buffer_release(vendor_buffer_key(vt))
          next(msg, no, tried, rows, nil)
      end
    else
      Logger.info(
        "message #{msg.id}: vendor trunk #{vt} #{reason}, no room in its buffer; next vendor"
      )

      next(msg, no, tried, rows, nil)
    end
  end

  # A message that must wait on its vendor (a part refused for now and tried again after a pause, or a later part
  # waiting for room) goes on in the vendor's own queue, so no sender worker sleeps (S-5.1, D2). It takes no place of
  # the overflow buffer: it is that vendor's already. If the queue cannot take it, it waits here.
  defp park(msg, route, no, tried, rows, job) do
    vt = route.vendor_trunk_id
    held = %{queued_at: System.os_time(:millisecond), place: false, job: job}
    id = "vbuf:#{msg.id}:#{no}:#{vt}:#{length(job.done)}:#{job.temporary}"

    case queue(msg, route, no, tried, rows, held, id) do
      :ok ->
        :ok

      {:error, error} ->
        Logger.warning("message #{msg.id} not queued for vendor trunk #{vt}: #{inspect(error)}")
        wait_until(job.not_before)
        outcome(send_parts(vt, job, msg.id, held), {msg, route, no, tried, rows, held})
    end
  end

  defp queue(msg, route, no, tried, rows, held, id) do
    queue = Buffers.vendor_queue(route.vendor_trunk_id)

    blob =
      :erlang.term_to_binary({msg, route, no, MapSet.to_list(tried), rows, held}, compressed: 1)

    case Bus.put(queue, "msg.vendor_buffered", %{"id" => msg.id, "m" => Base.encode64(blob)},
           id: id
         ) do
      {:ok, _} -> Buffers.kick(queue)
      {:error, _} = error -> error
    end
  end

  @doc """
  Runs a message taken from a vendor's queue (`Sms.Switch.Pipeline.Buffers`) on that vendor: one from its overflow
  buffer waits for room up to 30 s from when it was buffered, then goes to the next vendor (S-5.1); one part-way
  through goes on with its remaining parts after its pause (D2). A message already sent (a redelivery after a crash)
  is not sent again.
  """
  @spec resume(map()) :: :ok | {:error, :config_not_loaded}
  def resume(%{"m" => blob}) do
    {msg, route, no, tried, rows, held} =
      blob |> Base.decode64!() |> :erlang.binary_to_term([:safe])

    # Queued before the vendor queue held parts in progress: a buffered message with its place.
    held = if is_integer(held), do: %{queued_at: held, place: true, job: nil}, else: held

    cond do
      not Config.ready?() ->
        {:error, :config_not_loaded}

      held.job == nil and Store.sent?(msg.id) == true ->
        left_buffer(held, route.vendor_trunk_id)
        :ok

      true ->
        wait_until((held.job || %{})[:not_before] || 0)
        _ = attempt(msg, route, no, MapSet.new(tried), rows, held)
        :ok
    end
  end

  # In the vendor's own queue only (`resume/1`): its pause before a part refused for now is tried again.
  defp wait_until(at_ms) do
    left = at_ms - System.os_time(:millisecond)
    if left > 0, do: Process.sleep(left), else: :ok
  end

  defp vendor_buffer_key(vendor_trunk_id), do: "vt:#{vendor_trunk_id}"

  # The first part waits for room on the vendor only when it comes from the vendor's queue, until 30 s after it was
  # queued (in a sender worker a busy vendor answers at once, for the buffer to decide).
  defp first_part_deadline(%{queued_at: queued_at}) do
    left = queued_at + vendor_buffer_wait_ms() - System.os_time(:millisecond)
    System.monotonic_time(:millisecond) + max(left, 0)
  end

  # D4: a late OK from this vendor for a part not answered (`from`..`to`) flags the attempt as a possible duplicate
  # (`Sms.Switch.Pipeline.LateResponses`).
  defp possibly_sent(msg, attempt, from, to) do
    remembered = %{
      edr_id: attempt.edr_id,
      data: Forwarder.core(msg),
      vendor_trunk_id: attempt.vendor.vendor_trunk_id
    }

    for n <- from..to//1,
        do: Store.put_possibly_sent("#{msg.id}:#{n}", Map.put(remembered, :part, n), @late_keep_s)
  end

  # S-5.11, D2: the message comes back after a failed receipt from the vendor it was sent to; it goes to the next
  # vendor in the rules' order, or, with none left, the customer gets that failed receipt.
  defp resend(msg, resend) do
    msg = Map.delete(msg, :resend)
    tried = MapSet.new(resend.tried)

    _ =
      case reroute(msg, tried) do
        {:ok, routed} ->
          # The EDR marks this attempt as a DLR re-route.
          route = routed |> Intake.route_of() |> Map.put(:dlr_reroute, true)
          attempt(msg, route, resend.no + 1, tried, [])

        {:error, reason, _} ->
          Logger.info(
            "message #{msg.id}: no vendor left after its failed receipt (#{inspect(reason)})"
          )

          data =
            Map.merge(Forwarder.core(msg), %{
              edr_id: resend.edr_id,
              vendor_trunk_id: resend.vendor_trunk_id
            })

          _ = Forwarder.publish(data, resend.receipt)
      end

    :ok
  end

  @doc """
  Sends a message again after a failed receipt (S-5.11, D2): `resend` names the vendors tried, the attempt number, its
  EDR id and the failed receipt.
  """
  @spec publish_resend(map(), map()) :: :ok | {:error, term()}
  def publish_resend(msg, resend) do
    data = %{
      "id" => msg.id,
      "trunk_id" => msg.trunk.id,
      "m" => Base.encode64(:erlang.term_to_binary(Map.put(msg, :resend, resend), compressed: 1))
    }

    case Bus.publish("sms.msg.accepted", "msg.accepted", data, id: "msg:#{msg.id}:r#{resend.no}") do
      {:ok, _} -> :ok
      {:error, _} = error -> error
    end
  end

  # The next vendor in the rules' order. A Test SMS or Repush to a chosen vendor goes nowhere else (backend step 11c).
  defp reroute(%{internal: %{vendor_trunk_id: vt}}, _tried) when is_integer(vt),
    do: {:error, :chosen_vendor, nil}

  defp reroute(msg, tried), do: Router.route(Intake.router_input(msg), tried)

  # The next vendor in the rules' order; none left → the message has failed.
  # `failed`: the attempt's row (nil when no vendor was reached) and how the message fails if no vendor is left.
  defp next(msg, no, tried, rows, failed) do
    rows =
      case failed do
        {%{} = row, _failure} -> [row | rows]
        _none -> rows
      end

    case reroute(msg, tried) do
      {:ok, routed} ->
        publish_rows(msg, rows, false)
        attempt(msg, Intake.route_of(routed), no, tried, [])

      {:error, reason, _} ->
        failure =
          case failed do
            {_row, f} ->
              f

            nil ->
              %{status: "REJECTD", error: "000", command_status: Status.code(:esme_rsubmitfail)}
          end

        fail(msg, rows, Map.put(failure, :reason, reason))
    end
  end

  # ---------------------------------------------------------------- building the parts

  # The PDUs for this vendor: the text after its egress translation, encoded again only when a translation changed
  # it, split in the vendor trunk's multipart format when longer than one SMS (S-3.1, S-3.10). A vendor that cannot
  # take it (no multipart, a maximum length) is skipped for the next one (S-3.9).
  defp submits(msg, route) do
    text = route.egress[:text]
    vt = Config.vendor_trunk(route.vendor_trunk_id) || %{}

    # A coding the vendor does not allow is converted when the text fits another it allows (S-2.11, S-4.4).
    with {:ok, bytes, alphabet, coding} <- Coding.for_vendor(msg, text, vt[:allowed_data_codings]),
         ies = elements(msg, alphabet),
         nil <- skip_reason(msg, text, {bytes, alphabet, ies}, vt) do
      base = fields(msg, route, coding)
      tlvs = Enum.filter(msg.tlvs, fn {name, _} -> name in @passed_tlvs end)
      format = vt[:multipart_format] || :udh8
      reference = fn -> reference(format, base.destination_addr) end
      pieces = pieces(bytes, alphabet, format, ies, reference)

      # Billed per part as counted (153 / 67 / 134), also when one message_payload carries them all (S-3.1).
      parts = max(length(pieces), Text.part_count(bytes, alphabet, byte_size(ies)))
      {:ok, Enum.map(pieces, &submit_pdu(base, tlvs, &1)), coding, parts}
    else
      {:error, reason} -> {:skip, reason}
      reason -> {:skip, reason}
    end
  end

  defp skip_reason(msg, text, {bytes, alphabet, ies}, vt) do
    cond do
      # Egress growing the part count: this vendor cannot take it unchanged (S-4.1, S-4.9).
      grows_parts?(msg, text) ->
        :translation_grows

      is_integer(vt[:max_msg_len]) and Text.units(bytes, alphabet) > vt[:max_msg_len] ->
        :too_long

      vt[:support_multipart] == false and Text.part_count(bytes, alphabet, byte_size(ies)) > 1 ->
        :no_multipart

      true ->
        nil
    end
  end

  # A client's UDH elements other than concatenation (ports, a language shift table) go with the message (D9,
  # S-3.12); a shift table only means something in GSM 7-bit, so a text a translation moved to another alphabet goes
  # without it.
  defp elements(msg, :gsm), do: Concat.other_elements(msg.udh)
  defp elements(msg, _alphabet), do: Concat.other_elements(msg.udh, [0x00, 0x08, 0x24, 0x25])

  defp submit_pdu(base, tlvs, {esm, short_message, extra}),
    do: {Map.merge(base, %{esm_class: esm, short_message: short_message}), tlvs ++ extra}

  # The parts as {esm_class, short_message, extra TLVs}: one when the message fits in one SMS, else per the format
  # (UDH with an 8- or 16-bit reference, SAR TLVs, or the whole message in message_payload). `ies`: the message's
  # other UDH elements, in a UDH of their own on a single message, after the concatenation element in each part (D9).
  # `reference`: gives the message's concatenation reference when it is split.
  @spec pieces(
          binary(),
          Text.alphabet(),
          :udh8 | :udh16 | :sar | :payload,
          binary(),
          (-> non_neg_integer())
        ) ::
          [{byte(), binary(), list()}]
  defp pieces(bytes, alphabet, :payload, ies, _reference) do
    case Text.split(bytes, alphabet, 6, byte_size(ies)) do
      [single] -> [single(single, ies, [])]
      _parts -> [{esm(ies), "", [message_payload: Concat.udh(ies) <> bytes]}]
    end
  end

  defp pieces(bytes, alphabet, format, ies, reference) do
    case Text.split(bytes, alphabet, header_octets(format), byte_size(ies)) do
      [single] ->
        [single(single, ies, [])]

      parts ->
        total = length(parts)
        ref = reference.()

        parts
        |> Enum.with_index(1)
        |> Enum.map(fn {p, n} -> piece(format, ref, total, n, p, ies) end)
    end
  end

  # One PDU: the bytes after a UDH of the other elements, if any.
  defp single(bytes, ies, tlvs), do: {esm(ies), Concat.udh(ies) <> bytes, tlvs}

  defp esm(<<>>), do: 0
  defp esm(_ies), do: @udhi

  defp header_octets(:udh8), do: 6
  defp header_octets(:udh16), do: 7

  # SAR parts carry their link in TLVs, but the vendor's SMSC puts a concatenation header on air: the same room is left.
  defp header_octets(:sar), do: 6

  # S-3.10: references count up per handset, so messages open together never share one on any session, nor does a
  # message sent again via the next vendor with its first try (D2); an 8-bit one comes round after 256 messages to the
  # same handset. Without Redis, this server's own count, still never the same for two messages in a row.
  defp reference(format, destination) do
    modulo = if format == :udh8, do: 256, else: 65_536

    case Store.next_reference(destination || "") do
      {:ok, n} -> rem(n, modulo)
      {:error, _} -> rem(System.unique_integer([:positive, :monotonic]), modulo)
    end
  end

  defp piece(:udh8, ref, total, n, p, ies), do: {@udhi, Concat.udh8(ref, total, n, ies) <> p, []}

  defp piece(:udh16, ref, total, n, p, ies),
    do: {@udhi, Concat.udh16(ref, total, n, ies) <> p, []}

  defp piece(:sar, ref, total, n, p, ies),
    do: single(p, ies, sar_msg_ref_num: ref, sar_total_segments: total, sar_segment_seqnum: n)

  # Whether a changed text needs more parts than the customer sent (D3), counted like with like: the text as it goes
  # and as it came, both at 153 / 67 / 134 a part, or the parts the customer sent when it used more (a client's SAR
  # parts of 160 characters are counted again, never compared with the 153 we split at).
  defp grows_parts?(%{text: nil}, _text), do: false
  # No translation changed the text: it goes as the customer sent it.
  defp grows_parts?(msg, text) when text == msg.text or is_nil(text), do: false

  defp grows_parts?(msg, text) do
    case Coding.natural(msg, text) do
      {:error, _, _} ->
        false

      {bytes, alphabet, _} ->
        Text.part_count(bytes, alphabet, byte_size(elements(msg, alphabet))) >
          max(
            Text.part_count(msg.body, msg.alphabet, byte_size(elements(msg, msg.alphabet))),
            msg.parts
          )
    end
  end

  defp fields(msg, route, coding) do
    f = msg.fields
    i = msg.ingress
    e = route.egress

    %{
      service_type: f[:service_type] || "",
      source_addr_ton: first([e[:sender_ton], i[:sender_ton], f[:source_addr_ton]]),
      source_addr_npi: first([e[:sender_npi], i[:sender_npi], f[:source_addr_npi]]),
      source_addr: e[:sender] || i[:sender],
      dest_addr_ton: first([e[:dest_ton], i[:dest_ton], f[:dest_addr_ton]]),
      dest_addr_npi: first([e[:dest_npi], i[:dest_npi], f[:dest_addr_npi]]),
      destination_addr: e[:receiver] || i[:receiver],
      protocol_id: f[:protocol_id] || 0,
      priority_flag: f[:priority_flag] || 0,
      # S-2.12: a message the switch held goes when due, without a schedule of its own.
      schedule_delivery_time:
        if(Map.get(msg, :scheduled, false),
          do: "",
          else: vendor_time(msg, :scheduled_at, f[:schedule_delivery_time])
        ),
      validity_period: vendor_time(msg, :expires_at, f[:validity_period]),
      # Receipts are always asked of the vendor; the customer gets what it asked for (S-2.14).
      registered_delivery: 1,
      replace_if_present_flag: 0,
      data_coding: coding,
      sm_default_msg_id: 0
    }
  end

  defp first(values), do: Enum.find(values, 0, &(&1 != nil))

  # S-2.12, S-2.13: as an absolute time in UTC, so a relative one never starts again at the vendor.
  defp vendor_time(msg, key, raw) do
    case Map.fetch(msg, key) do
      {:ok, ms} -> SmppTime.absolute(ms)
      :error -> raw || ""
    end
  end

  # ---------------------------------------------------------------- sending

  # Every part to the same vendor, the same connection where possible; stops at the first part that does not go. A
  # service trunk (team trial round 12) sends nothing: each part gets an id of the switch's, and the trunk's receipt
  # comes from the timeout sweep after its delay (`receipt_timeout/2`). `held`: nil in a sender worker, which never
  # waits (what must wait goes on in the vendor's queue, `{:later, job}`); the vendor's queue entry otherwise.
  defp send_parts(vt, job, message_id, held) do
    if (Config.vendor_trunk(vt) || %{})[:service] == true,
      do:
        {:sent, %{job | submits: [], done: Enum.map(job.submits, fn _ -> service_result() end)}},
      else: send_all(vt, job, message_id, held)
  end

  defp service_result do
    id = "svc" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
    %{message_id: id, raw_message_id: id}
  end

  defp send_all(_vt, %{submits: []} = job, _message_id, _held), do: {:sent, job}

  defp send_all(vt, %{submits: [{fields, tlvs} | rest]} = job, message_id, held) do
    ref = "#{message_id}:#{length(job.done) + 1}"

    case submit(vt, fields, tlvs, ref, prefer(job.done), part_deadline(job.done, held)) do
      {:ok, result} ->
        job = Map.merge(job, %{submits: rest, done: [result | job.done], temporary: 0})
        send_all(vt, Map.put(job, :peer, result[:peer]), message_id, held)

      {refusal, status, peer} ->
        part_failed({refusal, status}, vt, Map.put(job, :peer, peer), message_id, held)

      failure ->
        part_failed(failure, vt, job, message_id, held)
    end
  end

  defp prefer([last | _]), do: last[:pid]
  defp prefer([]), do: nil

  # D2: a part refused for now (0x58, 0x14, 0x08) is tried again on the same vendor, with the same reference, after a
  # pause (0.5 s, then 1 s): in the vendor's queue, never in a sender worker. Past the tries it is refused.
  defp part_failed({:temporary, status}, vt, job, message_id, held) do
    if job.temporary + 1 < @temporary_tries do
      pause = 500 * (job.temporary + 1)

      job = %{
        job
        | temporary: job.temporary + 1,
          not_before: System.os_time(:millisecond) + pause
      }

      if held == nil do
        {:later, job}
      else
        wait_until(job.not_before)
        send_all(vt, job, message_id, held)
      end
    else
      {:rejected, status, job}
    end
  end

  # The first part finding no room: the vendor is busy (its buffer decides) or unavailable (the next vendor); or it
  # could not be encoded.
  defp part_failed({reason, detail}, _vt, %{done: []}, _message_id, _held)
       when reason in [:busy, :unavailable, :invalid],
       do: {reason, detail}

  defp part_failed({:invalid, _reason}, _vt, job, _message_id, _held),
    do: {:rejected, Status.code(:esme_rinvsrcadr), job}

  # A later part finding no room waits for it in the vendor's queue (`:vendor_wait_ms`): the earlier parts are with the
  # vendor already. Still none there, or no connection: the whole message moves on (D2).
  defp part_failed({:busy, _reason}, _vt, job, _message_id, nil), do: {:later, job}

  defp part_failed({reason, detail}, _vt, job, _message_id, _held)
       when reason in [:busy, :unavailable, :possibly_sent],
       do: {:possibly_sent, detail, job}

  defp part_failed({:rejected, status}, _vt, job, _message_id, _held),
    do: {:rejected, status, job}

  # How long a part waits for room when the vendor is at its TPS or its window is full: never in a sender worker; in the
  # vendor's queue the first part until 30 s after it was queued, a later part `:vendor_wait_ms`.
  defp part_deadline(_done, nil), do: System.monotonic_time(:millisecond)
  defp part_deadline([], held), do: first_part_deadline(held)
  defp part_deadline(_done, _held), do: System.monotonic_time(:millisecond) + vendor_wait_ms()

  # `deadline` (monotonic ms): how long to wait for room when the vendor is at its TPS or its window is full; past it
  # the vendor is busy.
  defp submit(vt, fields, tlvs, ref, prefer, deadline) do
    case Vendor.submit(vt, :submit_sm, fields, tlvs, submit_opts(ref, prefer)) do
      {:ok, %{status: 0} = result} ->
        {:ok, result}

      {:ok, %{status: status} = result} when status in @temporary ->
        {:temporary, status, result[:peer]}

      {:ok, %{status: status} = result} ->
        {:rejected, status, result[:peer]}

      {:error, reason} when reason in [:throttled, :window_full] ->
        if System.monotonic_time(:millisecond) < deadline do
          Process.sleep(20)
          submit(vt, fields, tlvs, ref, prefer, deadline)
        else
          {:busy, reason}
        end

      {:error, reason} when reason in [:timeout, :connection_lost] ->
        {:possibly_sent, reason}

      # A PDU that cannot be encoded never left: no vendor problem, but nothing the next vendor would take either.
      {:error, {:invalid_pdu, reason}} ->
        {:invalid, reason}

      {:error, reason} ->
        {:unavailable, reason}
    end
  end

  defp submit_opts(ref, nil), do: [ref: ref]
  defp submit_opts(ref, false), do: [ref: ref]
  defp submit_opts(ref, prefer), do: [ref: ref, prefer: prefer]

  defp vendor_wait_ms,
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline, [])
      |> Keyword.get(:vendor_wait_ms, 10_000)

  # How long a message may wait in a vendor's overflow buffer for room on that vendor before the next vendor (S-5.1,
  # product owner 2026-10-25: 30 s).
  defp vendor_buffer_wait_ms,
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline, [])
      |> Keyword.get(:vendor_buffer_wait_ms, 30_000)

  # ---------------------------------------------------------------- outcomes

  defp sent(msg, route, attempt, results, rows) do
    # A Delayed Submit trunk's resp was waiting for this (S-2.18, D11).
    _ = Delayed.notify(msg.id, :ok)
    # The vendor's live TPS, in submits (§13.8 vendor capacity, §13.23 at limit).
    LiveTps.count(["vt:#{route.vendor_trunk_id}"], length(results))
    vt = route.vendor_trunk_id
    trunk = Config.vendor_trunk(vt) || %{}
    ids = Enum.map(results, & &1.message_id)
    {timeout_s, timeout_stat} = receipt_timeout(trunk, msg)

    # S-5.10: with no final receipt by then, the switch answers with the trunk's DLR Timeout Status.
    timeout_at = attempt.resp_time + timeout_s * 1_000

    _ = mark_in_flight(msg, route)

    row =
      Map.merge(attempt, %{
        success: true,
        final: true,
        command_status: 0,
        vendor_message_id: Enum.map_join(results, ",", & &1.raw_message_id),
        # The normalised ids, so a receipt that comes after the message left Redis is found in the EDRs (D5).
        vendor_message_keys: Enum.reject(ids, &(&1 in [nil, ""]))
      })

    row = Map.merge(row, Billing.flags(msg, row))
    # §7: billed once; a re-route after a failed receipt does not bill the customer again.
    charged = Map.update(msg, :charged, row.customer_billable, &(&1 or row.customer_billable))

    # A vendor that answered without a message id cannot send a receipt we could match (S-5.12).
    parts = for {id, n} <- Enum.with_index(ids, 1), id not in [nil, ""], do: {n, vt, id}

    record =
      charged
      |> record_of(route, trunk, attempt, length(results), Edr.outcome_dims(msg, row))
      # The timeout this message got, so the receipt side applies the same one (team trial round 12).
      |> Map.merge(%{timeout_s: timeout_s, timeout_stat: timeout_stat})

    with {:error, reason} <-
           record_sent(msg.id, record, parts, {timeout_s + 3_600, timeout_at}, 3),
         do:
           Logger.error(
             "message #{msg.id} sent but not recorded, its receipts will be orphans: #{inspect(reason)}"
           )

    publish_rows(msg, rows, false)
    publish_rows(msg, [row], true)

    # Not billed yet (reported or delivery billing): its credit hold waits for the receipt, as its record does (§7).
    unless charged.charged,
      do: Ledger.extend_hold(msg.trunk.enterprise_id, msg.id, timeout_s)

    _ = apply_orphans(msg, vt, parts)
    :ok
  end

  # §7, decision 2026-10-31: a message that ends without being billed gives its credit hold back. A Test SMS or Repush
  # held none; a message billed already had its hold replaced by the charge.
  defp release_hold(%{internal: %{}}), do: :ok
  defp release_hold(%{charged: true}), do: :ok
  # A scheduled message refused or expired at its time before its credit was held (S-2.12).
  defp release_hold(%{credit_held: false}), do: :ok

  defp release_hold(msg) do
    _ = Ledger.release(msg.trunk.enterprise_id, msg.id)
    :ok
  end

  # §7: the balances are charged when the attempt row makes the message billable (`Sms.Switch.Pipeline.Ledger`).
  defp charge(msg, row) do
    _ =
      if row.customer_billable do
        # §13.9: the revenue earned counts for accumulated revenue conditions with the charge.
        revenue =
          {Revenue.keys(msg, (row[:vendor] || %{})[:rule_id]),
           Revenue.platform_micro(msg.sell, msg.parts)}

        Ledger.charge(:customer, msg.trunk.enterprise_id, msg.id, msg.sell, msg.parts, revenue)
      end

    if row.vendor_billable do
      vt = Config.vendor_trunk(row.vendor.vendor_trunk_id) || %{}

      Ledger.charge(
        :vendor,
        vt[:enterprise_id],
        row.edr_id,
        row.vendor[:cost],
        row[:msg_count] || msg.parts
      )
    end
  end

  # `parts`: the PDUs sent, each with its receipt; the vendor is billed per part as counted (`msg_count`, S-3.1).
  defp record_of(msg, route, trunk, attempt, parts, dims) do
    bill =
      msg
      |> Billing.of_attempt(route, attempt[:msg_count] || parts)
      |> Map.put(:attempt_no, attempt.no)
      |> Map.update!(:dims, &Map.merge(&1, dims))

    Map.merge(Forwarder.core(msg), %{
      edr_id: attempt.edr_id,
      vendor_trunk_id: route.vendor_trunk_id,
      parts: parts,
      sent_at: attempt.resp_time,
      # What the outcome row needs once the final status is known (§7, `Billing`), with the attempt's report columns.
      bill: bill,
      # What a re-route after a failed receipt needs (S-5.11, D2), kept only where one can happen.
      resend:
        if(reroutable?(trunk),
          do: %{msg: msg, tried: MapSet.to_list(attempt.tried), no: attempt.no}
        )
    })
  end

  @default_receipt_timeout_s 172_800

  @doc false
  # The vendor trunk's Receipt Timeout and its status (S-5.10), for the destinations it lists (team trial round 12):
  # none listed = every destination; a message to another destination waits the default 48 h, then UNKNOWN.
  # A service trunk: its receipt status after its delay, for every destination.
  def receipt_timeout(%{service: true} = trunk, _msg),
    do: {trunk[:dlr_timeout_s] || 0, trunk[:dlr_timeout_stat] || "DELIVRD"}

  def receipt_timeout(trunk, msg) do
    codes = trunk[:dlr_timeout_mccmncs] || MapSet.new()
    mccmnc = (Map.get(msg, :destination) || %{})[:mccmnc]

    if Enum.empty?(codes) or (is_binary(mccmnc) and MapSet.member?(codes, mccmnc)),
      do:
        {trunk[:dlr_timeout_s] || @default_receipt_timeout_s,
         trunk[:dlr_timeout_stat] || "UNKNOWN"},
      else: {@default_receipt_timeout_s, "UNKNOWN"}
  end

  # Receipts that came before the submit_sm_resp was handled (S-5.5): kept under every key their id reads as, so the
  # resp's normalised id finds them.
  defp apply_orphans(msg, vt, parts) do
    for {n, _vt, id} <- parts do
      case Store.take_orphan(vt, id) do
        {:ok, receipt} -> Receipts.apply_receipt(msg.id, n, receipt)
        _ -> :ok
      end
    end
  end

  # A failed receipt is re-routed only from a vendor that bills on delivery and lists that status in Re-Route On (D2).
  defp reroutable?(trunk),
    do: trunk[:billing_type] == "delivery" and (trunk[:reroute_on] || []) != []

  # Loop Detection (S-5.16): what we sent, so the same message coming back on another trunk is caught at intake.
  defp mark_in_flight(msg, route) do
    sender = route.egress[:sender] || msg.ingress[:sender]
    receiver = route.egress[:receiver] || msg.ingress[:receiver]
    text = route.egress[:text] || msg.ingress[:text] || msg.body

    _ =
      Store.mark_in_flight(Intake.fingerprint(sender, receiver, text), msg.trunk.id, @in_flight_s)
  end

  defp record_sent(id, record, parts, {ttl, timeout_at} = times, tries) do
    case Store.record_sent(id, record, parts, ttl, timeout_at) do
      :ok ->
        :ok

      {:error, _} when tries > 1 ->
        Process.sleep(200)
        record_sent(id, record, parts, times, tries - 1)

      error ->
        error
    end
  end

  # No vendor took the message: the last attempt (or a row without a vendor) is final, and the customer is told.
  defp fail(msg, rows, failure) do
    Logger.warning("message #{msg.id} failed: #{inspect(failure.reason)}")

    {last, earlier} =
      case rows do
        [last | earlier] ->
          {Map.merge(last, %{final: true}), earlier}

        [] ->
          {%{
             edr_id: Edr.new_id(),
             no: 0,
             vendor: nil,
             success: false,
             final: true,
             command_status: failure.command_status
           }, []}
      end

    publish_rows(msg, earlier, false)
    publish_rows(msg, [last], true)

    # Attempt billing bills a message no vendor took (its charge replaces the hold); otherwise the hold goes back.
    unless Billing.flags(msg, Map.put_new(last, :success, false)).customer_billable,
      do: release_hold(msg)

    # A Delayed Submit customer waiting for its resp gets the failure there, not as a receipt (S-2.18, D11).
    unless Delayed.notify(msg.id, {:error, failure.command_status}),
      do: Forwarder.switch_receipt(msg, last.edr_id, failure.status, failure.error)
  end

  defp publish_rows(msg, rows, final) do
    rows
    |> Enum.reverse()
    |> Enum.each(fn row ->
      row = row |> Map.put_new(:final, final) |> Map.put_new(:success, false)
      row = Map.merge(Billing.flags(msg, row), row)
      _ = charge(msg, row)

      case Edr.publish_attempt(Edr.attempt_row(msg, row)) do
        :ok ->
          :ok

        {:error, reason} ->
          Logger.error("EDR of message #{msg.id} not stored: #{inspect(reason)}")
      end
    end)
  end

  defp err(status),
    do:
      status
      |> band(0xFFF)
      |> Integer.to_string(16)
      |> String.pad_leading(3, "0")
      |> String.slice(-3, 3)
end
