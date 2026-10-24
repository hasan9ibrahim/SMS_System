defmodule Sms.Switch.Pipeline.Receipts do
  @moduledoc """
  Receipts from vendors (spec §2, docs/SMPP_SCENARIOS.md §5), the `Sms.Switch.Vendor.Receipts` implementation:

    * a receipt is matched to its message by the vendor's message id, normalised per the trunk's MsgID Type and tried
      in both bases (S-5.6); TLVs win over the receipt text (S-5.7);
    * a receipt for a message the switch has not recorded yet (it came before the submit_sm_resp was handled) is kept
      a minute and picked up by the sender (S-5.5); one for an unknown or expired message is answered OK and logged
      (S-5.12);
    * the first final status of a part wins (S-5.8); a message the switch split goes back to the customer as one
      receipt once every part has its final status: DELIVRD only when all were delivered, else the first failure
      (S-5.9);
    * intermediate statuses go to the customer only when it asked for them (registered_delivery bit 4, S-5.8).

  Every receipt from a vendor is an EDR receipt row; the customer's receipt goes out from the bus
  (`Sms.Switch.Pipeline.Forwarder`), so the vendor gets its deliver_sm_resp at once. MO messages (no receipt bit)
  are answered OK and logged (decision Q7: no MO in v1).
  """
  @behaviour Sms.Switch.Vendor.Receipts
  require Logger
  alias Sms.Switch.Pipeline.{Config, Edr, Forwarder, Receipt, Store}
  alias Sms.Switch.Vendor.MessageId

  @impl true
  def handle(context, pdu) do
    if Receipt.receipt?(pdu) do
      receipt(context, pdu)
    else
      Logger.info(
        "MO message from vendor trunk #{context.trunk.id} answered OK, not processed (no MO in v1, Q7)"
      )

      :ok
    end
  end

  defp receipt(context, pdu) do
    trunk = context.trunk

    case Receipt.parse(pdu) do
      {:error, reason} ->
        Logger.warning("receipt from vendor trunk #{trunk.id} answered OK and dropped: #{reason}")
        :ok

      {:ok, r} ->
        if r.mismatch != [],
          do:
            Logger.info(
              "receipt text and TLVs disagree on #{inspect(r.mismatch)}; TLVs used (S-5.7)"
            )

        receipt =
          Map.merge(r, %{
            received_at: DateTime.to_unix(context.received_at, :millisecond),
            vendor_trunk_id: trunk.id
          })

        keys = MessageId.receipt_keys(r.vendor_message_id, trunk.msg_id_type)

        case Store.find_vendor_id(trunk.id, keys) do
          {:ok, {message_id, part}} ->
            status(apply_receipt(message_id, part, receipt))

          :none ->
            # Kept under every key the id reads as, so the sender finds it with the resp's normalised id (S-5.5).
            Enum.each(keys, &Store.put_orphan(trunk.id, &1, receipt))
            :ok

          {:error, reason} ->
            Logger.error("receipt not matched, the vendor will send it again: #{inspect(reason)}")
            {:error, :esme_rsyserr}
        end
    end
  end

  defp status(:ok), do: :ok
  defp status({:error, _}), do: {:error, :esme_rsyserr}

  @doc "Applies a vendor receipt to part `part` of message `message_id` (also used for receipts that came early)."
  @spec apply_receipt(String.t(), pos_integer(), map()) :: :ok | {:error, term()}
  def apply_receipt(message_id, part, receipt) do
    case Store.message(message_id) do
      {:ok, rec} -> apply_to(message_id, part, receipt, rec)
      :none -> orphan(message_id)
      {:error, _} = error -> error
    end
  end

  defp orphan(message_id) do
    Logger.info(
      "receipt for message #{message_id} no longer known (expired): answered OK (S-5.12)"
    )

    :ok
  end

  defp apply_to(message_id, part, receipt, rec) do
    if Receipt.final?(receipt.status) do
      apply_final(message_id, part, receipt, rec)
    else
      vendor_row(rec.data, part, receipt, false)
      # Intermediate statuses only when the customer asked for them (registered_delivery bit 4).
      if Forwarder.wants_intermediate?(rec.data) and rec.data.parts == 1,
        do: Forwarder.publish(rec.data, Map.put(receipt, :intermediate, true)),
        else: :ok
    end
  end

  defp apply_final(message_id, part, receipt, rec) do
    final = Map.take(receipt, [:status, :error, :network_error, :done_at, :received_at])

    with {:ok, first} <- Store.put_final(message_id, part, final) do
      vendor_row(rec.data, part, receipt, not first)
      if first, do: maybe_forward(message_id), else: :ok
    end
  end

  # Once every part has its final status, one receipt for the message (S-5.9); only one caller gets to send it.
  defp maybe_forward(message_id) do
    with {:ok, rec} <- Store.message(message_id),
         true <- map_size(rec.finals) >= rec.data.parts,
         {:ok, true} <- Store.claim_forward(message_id) do
      Forwarder.publish(rec.data, aggregate(rec.finals))
    else
      false -> :ok
      {:ok, false} -> :ok
      :none -> :ok
      {:error, _} = error -> error
    end
  end

  @doc false
  # DELIVRD when every part was delivered; else the first part that was not, with its error.
  def aggregate(finals) do
    parts = finals |> Enum.sort_by(&elem(&1, 0)) |> Enum.map(&elem(&1, 1))

    case Enum.find(parts, &(&1.status != "DELIVRD")) do
      nil -> List.last(parts)
      failed -> failed
    end
  end

  # After the vendor trunk's DLR timeout (S-5.10): recorded as late.
  defp late?(data, receipt) do
    timeout_s =
      (Config.ready?() && (Config.vendor_trunk(receipt.vendor_trunk_id) || %{})[:dlr_timeout_s]) ||
        nil

    is_integer(timeout_s) and is_integer(data[:sent_at]) and
      receipt.received_at > data.sent_at + timeout_s * 1_000
  end

  defp vendor_row(data, part, receipt, duplicate) do
    row =
      Edr.receipt_row(%{
        edr_id: data.edr_id,
        kind: "vendor",
        at: receipt.received_at,
        msg: data,
        part: part,
        vendor_trunk_id: receipt.vendor_trunk_id,
        vendor_message_id: receipt.vendor_message_id,
        status: receipt.status,
        error: receipt.error,
        network_error: receipt.network_error,
        duplicate: duplicate,
        late: late?(data, receipt),
        source: "vendor"
      })

    case Edr.publish_receipt(row) do
      :ok -> :ok
      {:error, reason} -> Logger.error("receipt EDR not stored: #{inspect(reason)}")
    end
  end
end
