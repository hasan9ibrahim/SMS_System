defmodule Sms.Switch.Pipeline.LateReceipts do
  @moduledoc """
  Vendor receipts whose message is no longer in Redis (D5, S-5.10, S-5.12): the DLR timeout already answered the
  customer, or the message was finished and the vendor sent its receipt again. Each unmatched receipt is published
  (`sms.receipt.unmatched`); a minute later, when no sender has taken it as an early receipt (S-5.5), it is looked up
  in the EDRs by vendor trunk and the vendor's normalised message id (`edr.v_message_keys`):

    * the part already has a receipt from the vendor: written as a duplicate (S-5.8);
    * else (only the switch's DLR timeout answered it): written as a late receipt, the real outcome for vendor checks;
    * no attempt found: an unknown or very old id, logged (S-5.12).

  The customer is never sent anything here: its receipt went out already (D5).
  """
  use Sms.Core.Bus.Consumer,
    name: "pipeline-late-receipts",
    filter: "sms.receipt.unmatched",
    max_deliver: 10,
    ack_wait_ms: 70_000

  require Logger
  alias Sms.Core.{Bus, ClickHouse}
  alias Sms.Switch.Pipeline.{Edr, Store}

  # How far back an attempt is looked for: the longest DLR timeout plus the hold of a late receipt.
  @days 7

  @doc "Queues a receipt that matched no message in Redis."
  @spec publish(integer(), [String.t()], map()) :: :ok | {:error, term()}
  def publish(vendor_trunk_id, keys, receipt) do
    blob =
      Base.encode64(:erlang.term_to_binary(%{vt: vendor_trunk_id, keys: keys, receipt: receipt}))

    id = "unmatched:#{vendor_trunk_id}:#{hd(keys)}:#{receipt.status}:#{receipt.received_at}"

    case Bus.publish("sms.receipt.unmatched", "receipt.unmatched", %{"r" => blob}, id: id) do
      {:ok, _} -> :ok
      {:error, reason} = error -> log_error(reason, error)
    end
  end

  defp log_error(reason, error) do
    Logger.error("unmatched receipt not queued: #{inspect(reason)}")
    error
  end

  @impl true
  def handle_event(event) do
    %{vt: vt, keys: keys, receipt: receipt} =
      event.data["r"] |> Base.decode64!() |> :erlang.binary_to_term([:safe])

    if System.os_time(:millisecond) - receipt.received_at < wait_ms(),
      # Redelivered after ack_wait: by then an early receipt has been taken by its sender (S-5.5).
      do: {:error, :not_yet},
      else: settle(vt, keys, receipt)
  end

  defp wait_ms,
    do:
      :sms_switch
      |> Application.get_env(Sms.Switch.Pipeline, [])
      |> Keyword.get(:late_wait_ms, 65_000)

  @doc false
  # Public for tests that run it without the bus.
  @spec settle(integer(), [String.t()], map()) :: :ok | {:error, term()}
  def settle(vt, keys, receipt) do
    case Store.find_vendor_id(vt, keys) do
      # Recorded since: the sender applied it as an early receipt.
      {:ok, _} -> :ok
      :none -> look_up(vt, keys, receipt)
      {:error, _} = error -> error
    end
  end

  defp look_up(vt, keys, receipt) do
    case attempt(vt, keys) do
      {:ok, nil} ->
        Logger.info("receipt from vendor trunk #{vt} for unknown message id #{hd(keys)} (S-5.12)")
        :ok

      {:ok, attempt} ->
        write(attempt, receipt)

      {:error, _} = error ->
        error
    end
  end

  @attempt """
  SELECT edr_id, start_time, c_enterprise_id, c_trunk_id, c_message_id,
         arrayFirstIndex(k -> has({keys:Array(String)}, k), v_message_keys) AS part
    FROM edr
   WHERE v_trunk_id = {vt:UInt32} AND is_submit_success = 1 AND hasAny(v_message_keys, {keys:Array(String)})
     AND start_time >= now() - INTERVAL #{@days} DAY
   ORDER BY start_time DESC
   LIMIT 1
  """

  defp attempt(vt, keys) do
    case ClickHouse.query(@attempt, %{"vt" => vt, "keys" => keys}) do
      {:ok, %{rows: []}} ->
        {:ok, nil}

      {:ok, %{rows: [[edr_id, start, ent, trunk, message_id, part]]}} ->
        {:ok, attempt_map(edr_id, start, ent, trunk, message_id, part)}

      {:error, _} = error ->
        error
    end
  end

  defp attempt_map(edr_id, start, ent, trunk, message_id, part) do
    %{
      edr_id: edr_id,
      part: max(part, 1),
      msg: %{id: message_id, received_at: ms(start), trunk: %{id: trunk, enterprise_id: ent}}
    }
  end

  @vendor_rows """
  SELECT count() FROM edr_receipt
   WHERE edr_id = {id:UUID} AND kind = 'vendor' AND part_no = {part:UInt8} AND source = 'vendor'
  """

  defp write(attempt, receipt) do
    case ClickHouse.query(@vendor_rows, %{"id" => attempt.edr_id, "part" => attempt.part}) do
      {:ok, %{rows: [[n]]}} ->
        duplicate = n > 0

        row =
          Edr.receipt_row(%{
            edr_id: attempt.edr_id,
            kind: "vendor",
            at: receipt.received_at,
            msg: attempt.msg,
            part: attempt.part,
            vendor_trunk_id: receipt.vendor_trunk_id,
            vendor_message_id: receipt.vendor_message_id,
            status: receipt.status,
            error: receipt.error,
            network_error: receipt.network_error,
            duplicate: duplicate,
            late: not duplicate,
            source: "vendor"
          })

        Edr.publish_receipt(row)

      {:error, _} = error ->
        error
    end
  end

  defp ms(%DateTime{} = at), do: DateTime.to_unix(at, :millisecond)
  defp ms(%NaiveDateTime{} = at), do: at |> DateTime.from_naive!("Etc/UTC") |> ms()
end
