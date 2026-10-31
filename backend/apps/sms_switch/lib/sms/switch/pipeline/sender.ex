defmodule Sms.Switch.Pipeline.Sender do
  @moduledoc """
  The vendor leg (spec §2, §6, docs/SMPP_SCENARIOS.md §2, §5): takes each accepted message from the durable bus
  (`sms.msg.accepted`) and sends it to the vendor routing chose, re-routing when that vendor does not take it.

  For each vendor tried, in the rules' order (`Sms.Switch.Pipeline.Router`):

    * the message as that vendor's egress translation left it (S-4.8); a text a translation changed is encoded again,
      in UCS-2 when it no longer fits its alphabet (S-4.4); a message the switch must split goes as UDH parts (S-3.1,
      S-3.12) on one connection where possible (S-3.8); receipts are always asked of the vendor (S-2.14);
    * a temporary refusal (0x58, 0x14, 0x08) is tried again on the same vendor, up to 3 times within seconds (S-5.3,
      D2); the vendor's own TPS limit or a full window waits up to `:vendor_wait_ms` (S-5.1);
    * any other refusal, a Submit Timeout (possibly sent, D4) or a lost connection moves the message to the next
      vendor; a vendor with no bound connection is skipped (S-5.4);
    * when no vendor is left the message has failed: the customer gets a REJECTD receipt (UNKNOWN when the last
      vendor may have it) if it asked for receipts.

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
  alias Sms.Switch.Message.{Concat, Text}

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

      grows_parts?(msg, msg.ingress[:text]) ->
        # D3: a translation that adds parts never reaches a vendor; the customer is not billed.
        fail(msg, [], %{
          status: "REJECTD",
          error: "001",
          command_status: Status.code(:esme_rsubmitfail),
          reason: :translation_grows
        })

      true ->
        attempt(msg, msg.route, 1, MapSet.new([msg.route.vendor_trunk_id]), [])
    end

    :ok
  end

  # Cancelled by the customer while queued (S-2.15, D8): never sent, not billed, no receipt; one EDR row (attempt 0,
  # DELETED).
  defp cancelled(msg) do
    Logger.info("message #{msg.id} cancelled by the customer before it was sent (S-2.15)")

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

  # `held`: the message comes from this vendor's overflow buffer (`resume/1`), with when it was buffered.
  defp attempt(msg, route, no, tried, rows, held \\ nil) do
    vt = route.vendor_trunk_id
    tried = MapSet.put(tried, vt)

    case submits(msg, route) do
      {:skip, reason} ->
        Logger.info("message #{msg.id}: vendor trunk #{vt} skipped (#{reason})")
        left_buffer(held, vt)
        next(msg, no, tried, rows, nil)

      {:ok, submits, coding} ->
        started = System.os_time(:millisecond)
        outcome = send_parts(vt, submits, msg.id, first_part_deadline(held))
        finished = System.os_time(:millisecond)
        left_buffer(held, vt)
        vendor = Map.merge(route, %{data_coding: coding})

        attempt = %{
          edr_id: Edr.new_id(),
          no: no,
          vendor: vendor,
          submit_time: started,
          resp_time: finished,
          msg_count: length(submits)
        }

        case outcome do
          {:sent, results} ->
            sent(msg, route, Map.put(attempt, :tried, tried), results, rows)

          {:busy, reason} ->
            busy(msg, route, no, tried, rows, held, reason)

          {:unavailable, reason} ->
            Logger.info("message #{msg.id}: vendor trunk #{vt} unavailable (#{inspect(reason)})")
            next(msg, no, tried, rows, nil)

          {:rejected, status} ->
            row =
              %{attempt | vendor: vendor} |> Map.merge(%{success: false, command_status: status})

            next(
              msg,
              no + 1,
              tried,
              rows,
              {row, %{status: "REJECTD", error: err(status), command_status: status}}
            )

          {:possibly_sent, reason} ->
            Logger.warning(
              "message #{msg.id}: no answer from vendor trunk #{vt} (#{reason}); re-routing (D4)"
            )

            row = Map.merge(attempt, %{success: false, command_status: -1})
            _ = possibly_sent(msg, attempt, length(submits))

            next(
              msg,
              no + 1,
              tried,
              rows,
              {row, %{status: "UNKNOWN", error: "000", command_status: -1}}
            )
        end
    end
  end

  # A message from a vendor's buffer gives its place back once tried there, whatever happened.
  defp left_buffer(nil, _vt), do: :ok
  defp left_buffer(_held, vt), do: Throttle.buffer_release(vendor_buffer_key(vt))

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
      queue = Buffers.vendor_queue(vt)
      held = {msg, route, no, MapSet.to_list(tried), rows, System.os_time(:millisecond)}
      data = %{"id" => msg.id, "m" => Base.encode64(:erlang.term_to_binary(held, compressed: 1))}

      case Bus.put(queue, "msg.vendor_buffered", data, id: "vbuf:#{msg.id}:#{no}:#{vt}") do
        {:ok, _} ->
          Buffers.kick(queue)

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

  @doc """
  Runs a message taken from a vendor's overflow buffer (`Sms.Switch.Pipeline.Buffers`) on that vendor, waiting for
  room up to 30 s from when it was buffered, then the next vendor (S-5.1). A message already sent (a redelivery after a
  crash) is not sent again.
  """
  @spec resume(map()) :: :ok | {:error, :config_not_loaded}
  def resume(%{"m" => blob}) do
    {msg, route, no, tried, rows, queued_at} =
      blob |> Base.decode64!() |> :erlang.binary_to_term([:safe])

    cond do
      not Config.ready?() ->
        {:error, :config_not_loaded}

      Store.sent?(msg.id) == true ->
        Throttle.buffer_release(vendor_buffer_key(route.vendor_trunk_id))
        :ok

      true ->
        _ = attempt(msg, route, no, MapSet.new(tried), rows, %{queued_at: queued_at})
        :ok
    end
  end

  defp vendor_buffer_key(vendor_trunk_id), do: "vt:#{vendor_trunk_id}"

  # The first part waits for room on the vendor only when it comes from the vendor's buffer (until 30 s after it was
  # buffered); otherwise a busy vendor answers at once, for the buffer to decide.
  defp first_part_deadline(nil), do: System.monotonic_time(:millisecond)

  defp first_part_deadline(%{queued_at: queued_at}) do
    left = queued_at + vendor_buffer_wait_ms() - System.os_time(:millisecond)
    System.monotonic_time(:millisecond) + max(left, 0)
  end

  # D4: a late OK from this vendor flags the attempt as a possible duplicate (`Sms.Switch.Pipeline.LateResponses`).
  defp possibly_sent(msg, attempt, parts) do
    remembered = %{
      edr_id: attempt.edr_id,
      data: Forwarder.core(msg),
      vendor_trunk_id: attempt.vendor.vendor_trunk_id
    }

    for n <- 1..parts,
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
          attempt(msg, Intake.route_of(routed), resend.no + 1, tried, [])

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
  defp next(msg, no, tried, rows, failed) do
    rows = if failed, do: [elem(failed, 0) | rows], else: rows

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
    {bytes, alphabet, coding} = encoding(msg, text)
    vt = Config.vendor_trunk(route.vendor_trunk_id) || %{}

    case skip_reason(msg, text, bytes, alphabet, vt) do
      nil ->
        base = fields(msg, route, coding)
        tlvs = Enum.filter(msg.tlvs, fn {name, _} -> name in @passed_tlvs end)
        pieces = pieces(bytes, alphabet, vt[:multipart_format] || :udh8)
        {:ok, Enum.map(pieces, &submit_pdu(base, tlvs, &1)), coding}

      reason ->
        {:skip, reason}
    end
  end

  defp skip_reason(_msg, _text, :error, _alphabet, _vt), do: :unencodable

  defp skip_reason(msg, text, bytes, alphabet, vt) do
    cond do
      # Egress growing the part count: this vendor cannot take it unchanged (S-4.1, S-4.9).
      grows_parts?(msg, text) -> :translation_grows
      is_integer(vt[:max_msg_len]) and Text.units(bytes, alphabet) > vt[:max_msg_len] -> :too_long
      vt[:support_multipart] == false and length(Text.split(bytes, alphabet)) > 1 -> :no_multipart
      true -> nil
    end
  end

  defp submit_pdu(base, tlvs, {esm, short_message, extra}),
    do: {Map.merge(base, %{esm_class: esm, short_message: short_message}), tlvs ++ extra}

  @doc false
  # The parts as {esm_class, short_message, extra TLVs}: one when the message fits in one SMS, else per the format
  # (UDH with an 8- or 16-bit reference, SAR TLVs, or the whole message in message_payload).
  @spec pieces(binary(), Text.alphabet(), :udh8 | :udh16 | :sar | :payload) :: [
          {byte(), binary(), list()}
        ]
  def pieces(bytes, alphabet, :payload) do
    case Text.split(bytes, alphabet) do
      [single] -> [{0, single, []}]
      _parts -> [{0, "", [message_payload: bytes]}]
    end
  end

  def pieces(bytes, alphabet, format) do
    case Text.split(bytes, alphabet, header_octets(format)) do
      [single] ->
        [{0, single, []}]

      parts ->
        total = length(parts)
        ref = reference(format)
        parts |> Enum.with_index(1) |> Enum.map(fn {p, n} -> piece(format, ref, total, n, p) end)
    end
  end

  defp header_octets(:udh8), do: 6
  defp header_octets(:udh16), do: 7

  # SAR parts carry their link in TLVs, but the vendor's SMSC puts a concatenation header on air: the same room is left.
  defp header_octets(:sar), do: 6

  # A new reference for every message, so open messages on a connection do not share one (S-3.10).
  defp reference(:udh8), do: :rand.uniform(256) - 1
  defp reference(_format), do: :rand.uniform(65_536) - 1

  defp piece(:udh8, ref, total, n, p), do: {@udhi, Concat.udh8(ref, total, n) <> p, []}
  defp piece(:udh16, ref, total, n, p), do: {@udhi, Concat.udh16(ref, total, n) <> p, []}

  defp piece(:sar, ref, total, n, p),
    do: {0, p, [sar_msg_ref_num: ref, sar_total_segments: total, sar_segment_seqnum: n]}

  defp encoding(%{text: nil} = msg, _text), do: {msg.body, msg.alphabet, msg.data_coding}

  defp encoding(msg, text) when text == msg.text or is_nil(text),
    do: {msg.body, msg.alphabet, msg.data_coding}

  defp encoding(msg, text) do
    alphabet = Text.fit(text, msg.alphabet)

    case Text.encode(text, alphabet) do
      {:ok, bytes} -> {bytes, alphabet, Text.data_coding(alphabet, msg.data_coding)}
      :error -> {:error, alphabet, msg.data_coding}
    end
  end

  # Whether a changed text needs more parts than the customer sent (D3), counted like with like: the text as it goes
  # and as it came, both at 153 / 67 / 134 a part, or the parts the customer sent when it used more (a client's SAR
  # parts of 160 characters are counted again, never compared with the 153 we split at).
  defp grows_parts?(%{text: nil}, _text), do: false
  # No translation changed the text: it goes as the customer sent it.
  defp grows_parts?(msg, text) when text == msg.text or is_nil(text), do: false

  defp grows_parts?(msg, text) do
    case encoding(msg, text) do
      {:error, _, _} ->
        false

      {bytes, alphabet, _} ->
        Text.part_count(bytes, alphabet) > max(Text.part_count(msg.body, msg.alphabet), msg.parts)
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
      schedule_delivery_time: f[:schedule_delivery_time] || "",
      validity_period: f[:validity_period] || "",
      # Receipts are always asked of the vendor; the customer gets what it asked for (S-2.14).
      registered_delivery: 1,
      replace_if_present_flag: 0,
      data_coding: coding,
      sm_default_msg_id: 0
    }
  end

  defp first(values), do: Enum.find(values, 0, &(&1 != nil))

  # ---------------------------------------------------------------- sending

  # Every part to the same vendor, the same connection where possible; stops at the first part that does not go. A
  # service trunk (team trial round 12) sends nothing: each part gets an id of the switch's, and the trunk's receipt
  # comes from the timeout sweep after its delay (`receipt_timeout/2`).
  defp send_parts(vt, submits, message_id, first_deadline) do
    if (Config.vendor_trunk(vt) || %{})[:service] == true,
      do: {:sent, Enum.map(submits, fn _ -> service_result() end)},
      else: send_to_vendor(vt, submits, message_id, first_deadline)
  end

  defp service_result do
    id = "svc" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
    %{message_id: id, raw_message_id: id}
  end

  defp send_to_vendor(vt, submits, message_id, first_deadline) do
    submits
    |> Enum.with_index(1)
    |> Enum.reduce_while({:sent, [], nil}, fn {{fields, tlvs}, n}, {:sent, done, prefer} ->
      case submit(
             vt,
             fields,
             tlvs,
             "#{message_id}:#{n}",
             prefer,
             part_deadline(done, first_deadline)
           ) do
        {:ok, result} -> {:cont, {:sent, [result | done], result[:pid]}}
        failure when done == [] -> {:halt, failure}
        # A part refused after others went: the whole message moves on (D2), the earlier parts stay that attempt's.
        {reason, detail} when reason in [:unavailable, :busy] -> {:halt, {:possibly_sent, detail}}
        failure -> {:halt, failure}
      end
    end)
    |> case do
      {:sent, results, _} -> {:sent, Enum.reverse(results)}
      other -> other
    end
  end

  # Later parts wait for room as long as `:vendor_wait_ms`: the earlier parts are with the vendor already.
  defp part_deadline([], first_deadline), do: first_deadline
  defp part_deadline(_done, _first), do: System.monotonic_time(:millisecond) + vendor_wait_ms()

  # `deadline` (monotonic ms): how long to wait for room when the vendor is at its TPS or its window is full; past it
  # the vendor is busy.
  defp submit(vt, fields, tlvs, ref, prefer, deadline, temporary \\ 0) do
    case Vendor.submit(vt, :submit_sm, fields, tlvs, submit_opts(ref, prefer)) do
      {:ok, %{status: 0} = result} ->
        {:ok, result}

      {:ok, %{status: status}} when status in @temporary and temporary + 1 < @temporary_tries ->
        Process.sleep(500 * (temporary + 1))
        submit(vt, fields, tlvs, ref, prefer, deadline, temporary + 1)

      {:ok, %{status: status}} ->
        {:rejected, status}

      {:error, reason} when reason in [:throttled, :window_full] ->
        if System.monotonic_time(:millisecond) < deadline do
          Process.sleep(20)
          submit(vt, fields, tlvs, ref, prefer, deadline, temporary)
        else
          {:busy, reason}
        end

      {:error, reason} when reason in [:timeout, :connection_lost] ->
        {:possibly_sent, reason}

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

    _ = apply_orphans(msg, vt, parts)
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

  defp record_of(msg, route, trunk, attempt, parts, dims) do
    bill =
      msg
      |> Billing.of_attempt(route, parts)
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
