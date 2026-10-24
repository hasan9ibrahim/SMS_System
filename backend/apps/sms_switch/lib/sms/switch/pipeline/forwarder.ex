defmodule Sms.Switch.Pipeline.Forwarder do
  @moduledoc """
  The customer's receipts (spec §2, §13.1, docs/SMPP_SCENARIOS.md §5): takes each receipt to forward from the bus
  (`sms.receipt.forward`, published by `Sms.Switch.Pipeline.Receipts` and by the sender for a message that failed)
  and sends it at once:

    * only what the customer asked for: registered_delivery 1 every final status, 2 failures only, bit 4 the
      intermediate ones too (an ingress translation that set registered delivery wins, §6.4);
    * the status and error as the DLR status maps of the vendor trunk's rules, then the customer trunk's, leave them
      (§6.4, §13.2: when a translation rule rewrites the receipt, the translated one is forwarded);
    * on the session the message came in on, else another the trunk's DLR Session Affinity allows
      (`Sms.Switch.Customer.Affinity`, §13.1);
    * when no session can take it, it is held (`Sms.Switch.Pipeline.Held`) and sent when one binds, until the trunk's
      DLR hold hours (default 72) run out.

  Every receipt that went out, or was given up, is an EDR receipt row of kind customer.
  """
  use Sms.Core.Bus.Consumer,
    name: "pipeline-forwarder",
    filter: "sms.receipt.forward",
    max_deliver: 20,
    ack_wait_ms: 30_000,
    concurrency: 20

  require Logger
  import Bitwise
  alias Sms.Core.Bus
  alias Sms.Switch.Customer
  alias Sms.Switch.Pipeline.{Config, Edr, Receipt, Router, Store}
  alias Sms.Switch.Rules.Translation

  @default_hold_hours 72
  @intermediate 0x10

  @doc """
  What the pipeline keeps of a message for its receipts (stored with the message when it is sent, `Store`): the
  customer leg's ids, addresses and receipt request, and the trunk fields the EDR receipt rows need.
  """
  @spec core(map()) :: map()
  def core(msg) do
    f = msg.fields

    %{
      id: msg.id,
      received_at: msg.received_at,
      origin: msg.origin,
      trunk: Map.take(msg.trunk, [:id, :enterprise_id, :dlr_session_affinity, :dlr_hold_hours]),
      source: f[:source_addr] || "",
      source_ton: f[:source_addr_ton] || 0,
      source_npi: f[:source_addr_npi] || 0,
      destination: f[:destination_addr] || "",
      destination_ton: f[:dest_addr_ton] || 0,
      destination_npi: f[:dest_addr_npi] || 0,
      registered_delivery: registered_delivery(msg),
      text: msg.text,
      parts: 1,
      vendor_trunk_id: nil
    }
  end

  # An ingress translation's registered delivery wins over the customer's own (§6.4).
  defp registered_delivery(msg),
    do: msg.ingress[:registered_delivery] || msg.fields[:registered_delivery] || 0

  @doc "Whether the customer asked for intermediate statuses (registered_delivery bit 4)."
  @spec wants_intermediate?(map()) :: boolean()
  def wants_intermediate?(data), do: (data.registered_delivery &&& @intermediate) != 0

  @doc "Whether the customer asked for a receipt with this status."
  @spec wants?(map(), String.t(), boolean()) :: boolean()
  def wants?(data, status, intermediate \\ false)
  def wants?(data, _status, true), do: wants_intermediate?(data)

  def wants?(data, status, false) do
    case data.registered_delivery &&& 0x03 do
      1 -> true
      2 -> status != "DELIVRD"
      _ -> false
    end
  end

  @doc "Queues the customer's receipt for message `data` (once per final status; intermediates each)."
  @spec publish(map(), map()) :: :ok | {:error, term()}
  def publish(data, receipt) do
    key = if receipt[:intermediate], do: "#{receipt.status}:#{receipt.received_at}", else: "final"
    blob = Base.encode64(:erlang.term_to_binary(%{data: data, receipt: receipt}, [:compressed]))

    case Bus.publish("sms.receipt.forward", "receipt.forward", %{"id" => data.id, "r" => blob},
           id: "fwd:#{data.id}:#{key}"
         ) do
      {:ok, _} ->
        :ok

      {:error, reason} = error ->
        Logger.error("receipt of message #{data.id} not queued: #{inspect(reason)}")
        error
    end
  end

  @doc """
  The receipt for a message that never reached a vendor or that no vendor took (S-4.1, S-5.4): made by the switch,
  REJECTD (UNKNOWN when the last vendor may have it), sent when the customer asked for failures.
  """
  @spec switch_receipt(map(), String.t(), String.t(), String.t()) :: :ok
  def switch_receipt(msg, edr_id, status, error) do
    data = Map.put(core(msg), :edr_id, edr_id)
    now = System.os_time(:millisecond)

    _ =
      if wants?(data, status) do
        receipt = %{
          status: status,
          error: error,
          network_error: 0,
          done_at: now,
          received_at: now,
          source: "switch"
        }

        publish(data, receipt)
      end

    :ok
  end

  @impl true
  def handle_event(event) do
    %{data: data, receipt: receipt} =
      event.data["r"] |> Base.decode64!() |> :erlang.binary_to_term([:safe])

    deliver(data, receipt)
  end

  @doc false
  # Sends one receipt; held when no session can take it. Public for the held queue and tests.
  @spec deliver(map(), map(), non_neg_integer()) :: :ok | :hold | {:error, term()}
  def deliver(data, receipt, held_ms \\ 0) do
    intermediate = receipt[:intermediate] == true
    {status, error} = mapped(data, receipt)

    if wants?(data, status, intermediate),
      do: send_receipt(data, receipt, status, error, held_ms),
      else: :ok
  end

  defp send_receipt(data, receipt, status, error, held_ms) do
    trunk = trunk(data)
    {fields, tlvs} = Receipt.build(build_input(data, receipt, status, error))

    case Customer.deliver(data.origin, trunk.dlr_session_affinity, fields, tlvs) do
      {:ok, session_id, response} ->
        if response.status != 0,
          do:
            Logger.info(
              "customer refused the receipt of #{data.id}: 0x#{Integer.to_string(response.status, 16)}"
            )

        customer_row(data, receipt, status, error, session_id, held_ms)

      # The session did not answer; it may have it. Held and tried again on the next sweep, the same session first
      # (S-5.14), so a slow client never makes the bus give the receipt up.
      {:error, :timeout, _session} when held_ms > 0 ->
        :hold

      {:error, :timeout, _session} ->
        hold(data, receipt, trunk)

      {:error, {:invalid_pdu, reason}} ->
        Logger.error("receipt of #{data.id} could not be encoded, dropped: #{inspect(reason)}")
        :ok

      :hold when held_ms > 0 ->
        :hold

      :hold ->
        hold(data, receipt, trunk)
    end
  end

  defp hold(data, receipt, trunk) do
    now = System.os_time(:millisecond)
    hours = trunk[:dlr_hold_hours] || @default_hold_hours
    entry = %{data: data, receipt: receipt, held_at: now, until: now + hours * 3_600_000}

    case Store.hold(data.trunk.id, entry, now) do
      :ok -> :ok
      {:error, _} = error -> error
    end
  end

  @doc false
  # A held receipt whose hold hours ran out: recorded as never sent.
  @spec give_up(%{data: map(), receipt: map(), held_at: integer()}) :: :ok
  def give_up(%{data: data, receipt: receipt, held_at: held_at}) do
    Logger.warning(
      "receipt of message #{data.id} given up: no session of trunk #{data.trunk.id} took it in time (§13.1)"
    )

    {status, error} = mapped(data, receipt)
    customer_row(data, receipt, status, error, "", System.os_time(:millisecond) - held_at)
  end

  # The trunk as configured now (its affinity or hold hours may have changed), else as when the message came.
  defp trunk(data) do
    current = Config.ready?() && Config.customer_trunk(data.trunk.id)
    t = if current, do: current, else: data.trunk

    %{
      dlr_session_affinity: t[:dlr_session_affinity] || :strict,
      dlr_hold_hours: t[:dlr_hold_hours]
    }
  end

  defp build_input(data, receipt, status, error) do
    %{
      message_id: data.id,
      # A receipt goes from the receiver back to the sender (SMPP 3.4 §4.6.1).
      source: data.destination,
      source_ton: data.destination_ton,
      source_npi: data.destination_npi,
      destination: data.source,
      destination_ton: data.source_ton,
      destination_npi: data.source_npi,
      status: status,
      error: error,
      submitted_at: data.received_at,
      done_at: receipt[:done_at],
      text: data.text,
      network_error: receipt[:network_error]
    }
  end

  @doc false
  # The status and error after the DLR status maps of the vendor trunk's rules, then the customer trunk's (§6.4).
  @spec mapped(map(), map()) :: {String.t(), String.t()}
  def mapped(data, receipt) do
    if Config.ready?() do
      message = %{
        sender: data.source,
        receiver: data.destination,
        text: data.text || "",
        sender_ton: data.source_ton,
        sender_npi: data.source_npi,
        dlr_status: receipt.status,
        dlr_error: receipt.error
      }

      ctx = Router.translation_context()

      vendor =
        if data.vendor_trunk_id,
          do: Config.translation_rules(:vendor, data.vendor_trunk_id),
          else: []

      after_vendor = Translation.run(vendor, message, ctx).after

      message = %{
        message
        | dlr_status: after_vendor.dlr_status,
          dlr_error: after_vendor.dlr_error
      }

      after_customer =
        Translation.run(Config.translation_rules(:customer, data.trunk.id), message, ctx).after

      {after_customer.dlr_status || receipt.status, after_customer.dlr_error || receipt.error}
    else
      {receipt.status, receipt.error}
    end
  end

  defp customer_row(data, receipt, status, error, session_id, held_ms) do
    now = System.os_time(:millisecond)

    row =
      Edr.receipt_row(%{
        edr_id: data.edr_id,
        kind: "customer",
        at: now,
        msg: data,
        part: 1,
        vendor_trunk_id: data.vendor_trunk_id,
        vendor_message_id: receipt[:vendor_message_id],
        status: receipt.status,
        error: receipt.error,
        network_error: receipt[:network_error],
        customer_status: status,
        customer_error: error,
        session_id: session_id,
        held_ms: held_ms,
        source: receipt[:source] || "vendor"
      })

    case Edr.publish_receipt(row) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.error("customer receipt EDR of #{data.id} not stored: #{inspect(reason)}")
    end

    :ok
  end
end
