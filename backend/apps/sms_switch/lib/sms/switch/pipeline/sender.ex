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
    ack_wait_ms: 300_000,
    concurrency: 50

  require Logger
  import Bitwise
  alias Sms.Switch.Customer.Trunk
  alias Sms.Switch.Message.{Concat, Text}
  alias Sms.Switch.Pipeline.{Config, Edr, Forwarder, Intake, Receipts, Router, Store}
  alias Sms.Switch.Smpp.Status
  alias Sms.Switch.{Throttle, Vendor}

  @pace_max_ms 60_000
  @temporary [0x58, 0x14, 0x08]
  @temporary_tries 3
  @udhi 0x40
  # TLVs passed on to the vendor; the rest (vendor-specific ones included) stay with the customer leg.
  @passed_tlvs [:user_message_reference, :source_port, :destination_port, :language_indicator]

  @impl true
  def handle_event(event) do
    msg = Intake.decode(event.data)

    case Store.sent?(msg.id) do
      false -> send_message(msg)
      true -> :ok
      {:error, reason} -> {:error, {:store, reason}}
    end
  end

  @doc false
  # Sends one message; public for tests that run the vendor leg without the bus.
  @spec send_message(%{required(:ingress) => map() | nil, optional(atom()) => term()}) :: :ok
  def send_message(msg) do
    pace(msg)

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

    :ok
  end

  # A message accepted into the customer trunk's overflow buffer waits for a place in its TPS (S-2.4), at most
  # @pace_max_ms (then it goes, logged), and gives its buffer place back.
  defp pace(%{buffered: true} = msg) do
    waited = wait_slot(msg.tps_counters, 0)

    if waited >= @pace_max_ms,
      do: Logger.warning("message #{msg.id} sent from the overflow buffer without a TPS place")

    Throttle.buffer_release(Trunk.buffer_key(msg.trunk.id))
  end

  defp pace(_msg), do: :ok

  defp wait_slot(counters, waited) do
    cond do
      waited >= @pace_max_ms ->
        waited

      Throttle.acquire(counters) == :ok ->
        waited

      true ->
        Process.sleep(20)
        wait_slot(counters, waited + 20)
    end
  end

  # ---------------------------------------------------------------- one vendor

  defp attempt(msg, route, no, tried, rows) do
    vt = route.vendor_trunk_id
    tried = MapSet.put(tried, vt)

    case submits(msg, route) do
      {:skip, reason} ->
        Logger.info("message #{msg.id}: vendor trunk #{vt} skipped (#{reason})")
        next(msg, no, tried, rows, nil)

      {:ok, submits, coding} ->
        started = System.os_time(:millisecond)
        outcome = send_parts(vt, submits, msg.id)
        finished = System.os_time(:millisecond)
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
            sent(msg, route, attempt, results, rows)

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

  # The next vendor in the rules' order; none left → the message has failed.
  defp next(msg, no, tried, rows, failed) do
    rows = if failed, do: [elem(failed, 0) | rows], else: rows

    case Router.route(Intake.router_input(msg), tried) do
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
  # it; split when longer than one SMS (unless the customer sent it as one part of its own multipart message).
  defp submits(msg, route) do
    text = route.egress[:text]
    {bytes, alphabet, coding} = encoding(msg, text)

    cond do
      bytes == :error ->
        {:skip, :unencodable}

      grows_parts?(msg, text) ->
        # Egress growing the part count: this vendor cannot take it unchanged (S-4.1, S-4.9).
        {:skip, :translation_grows}

      true ->
        base = fields(msg, route, coding)
        tlvs = tlvs(msg)

        parts =
          if msg.concat != nil,
            do: [{Concat.udhi?(msg.fields[:esm_class] || 0) && msg.udh != <<>>, msg.udh <> bytes}],
            else: split(bytes, alphabet)

        {:ok, Enum.map(parts, &submit_pdu(base, tlvs, &1)), coding}
    end
  end

  defp submit_pdu(base, tlvs, {udh?, short_message}) do
    esm = if udh?, do: @udhi, else: 0
    {Map.merge(base, %{esm_class: esm, short_message: short_message}), tlvs}
  end

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

  # Whether a changed text needs more parts than the customer sent (D3).
  defp grows_parts?(%{text: nil}, _text), do: false
  defp grows_parts?(%{concat: c}, _text) when c != nil, do: false

  defp grows_parts?(msg, text) do
    case encoding(msg, text) do
      {:error, _, _} -> false
      {bytes, alphabet, _} -> Text.part_count(bytes, alphabet) > msg.parts
    end
  end

  defp split(bytes, alphabet) do
    case Text.split(bytes, alphabet) do
      [single] ->
        [{false, single}]

      parts ->
        ref = :rand.uniform(256) - 1
        total = length(parts)

        parts
        |> Enum.with_index(1)
        |> Enum.map(fn {p, i} -> {true, Concat.udh8(ref, total, i) <> p} end)
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

  # A customer's SAR part keeps its SAR TLVs (format conversion per vendor comes with build step 5, S-3.10).
  defp tlvs(msg) do
    keep =
      if msg.concat && msg.concat.kind == :sar, do: @passed_tlvs ++ sar_tlvs(), else: @passed_tlvs

    Enum.filter(msg.tlvs, fn {name, _} -> name in keep end)
  end

  defp sar_tlvs, do: [:sar_msg_ref_num, :sar_total_segments, :sar_segment_seqnum]

  # ---------------------------------------------------------------- sending

  # Every part to the same vendor, the same connection where possible; stops at the first part that does not go.
  defp send_parts(vt, submits, message_id) do
    submits
    |> Enum.with_index(1)
    |> Enum.reduce_while({:sent, [], nil}, fn {{fields, tlvs}, n}, {:sent, done, prefer} ->
      case submit(vt, fields, tlvs, "#{message_id}:#{n}", prefer) do
        {:ok, result} -> {:cont, {:sent, [result | done], result[:pid]}}
        failure when done == [] -> {:halt, failure}
        # A part refused after others went: the whole message moves on (D2), the earlier parts stay that attempt's.
        {:unavailable, reason} -> {:halt, {:possibly_sent, reason}}
        failure -> {:halt, failure}
      end
    end)
    |> case do
      {:sent, results, _} -> {:sent, Enum.reverse(results)}
      other -> other
    end
  end

  defp submit(vt, fields, tlvs, ref, prefer, temporary \\ 0, waited \\ 0) do
    case Vendor.submit(vt, :submit_sm, fields, tlvs, submit_opts(ref, prefer)) do
      {:ok, %{status: 0} = result} ->
        {:ok, result}

      {:ok, %{status: status}} when status in @temporary and temporary + 1 < @temporary_tries ->
        Process.sleep(500 * (temporary + 1))
        submit(vt, fields, tlvs, ref, prefer, temporary + 1, waited)

      {:ok, %{status: status}} ->
        {:rejected, status}

      {:error, reason} when reason in [:throttled, :window_full] ->
        if waited < vendor_wait_ms() do
          Process.sleep(50)
          submit(vt, fields, tlvs, ref, prefer, temporary, waited + 50)
        else
          {:unavailable, reason}
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

  # ---------------------------------------------------------------- outcomes

  defp sent(msg, route, attempt, results, rows) do
    vt = route.vendor_trunk_id
    trunk = Config.vendor_trunk(vt) || %{}
    ids = Enum.map(results, & &1.message_id)
    ttl = (trunk[:dlr_timeout_s] || 172_800) + 3_600

    record =
      Map.merge(Forwarder.core(msg), %{
        edr_id: attempt.edr_id,
        vendor_trunk_id: vt,
        parts: length(results),
        sent_at: attempt.resp_time
      })

    # A vendor that answered without a message id cannot send a receipt we could match (S-5.12).
    parts = for {id, n} <- Enum.with_index(ids, 1), id not in [nil, ""], do: {n, vt, id}

    case record_sent(msg.id, record, parts, ttl, 3) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error(
          "message #{msg.id} sent but not recorded, its receipts will be orphans: #{inspect(reason)}"
        )
    end

    row =
      Map.merge(attempt, %{
        success: true,
        final: true,
        command_status: 0,
        vendor_message_id: Enum.map_join(results, ",", & &1.raw_message_id)
      })

    publish_rows(msg, rows, false)
    publish_rows(msg, [row], true)

    # Receipts that came before the submit_sm_resp was handled (S-5.5): kept under every key their id reads as, so
    # the resp's normalised id finds them.
    for {n, _vt, id} <- parts do
      _ =
        case Store.take_orphan(vt, id) do
          {:ok, receipt} -> Receipts.apply_receipt(msg.id, n, receipt)
          _ -> :ok
        end
    end

    :ok
  end

  defp record_sent(id, record, parts, ttl, tries) do
    case Store.record_sent(id, record, parts, ttl) do
      :ok ->
        :ok

      {:error, _} when tries > 1 ->
        Process.sleep(200)
        record_sent(id, record, parts, ttl, tries - 1)

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
    Forwarder.switch_receipt(msg, last.edr_id, failure.status, failure.error)
  end

  defp publish_rows(msg, rows, final) do
    rows
    |> Enum.reverse()
    |> Enum.each(fn row ->
      row = row |> Map.put_new(:final, final) |> Map.put_new(:success, false)

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
