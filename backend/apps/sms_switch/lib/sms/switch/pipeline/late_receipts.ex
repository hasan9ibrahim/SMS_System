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
  alias Sms.Switch.Pipeline.{Billing, Edr, Ledger, Store}

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
  SELECT toString(edr_id), start_time, c_enterprise_id, c_trunk_id, c_message_id,
         arrayFirstIndex(k -> has({keys:Array(String)}, k), v_message_keys) AS part,
         v_billing_type, toString(v_rate), toString(v_sys_rate), msg_count, attempt_no, v_currency, business_company_id,
         product_category_id, c_am_user_id, v_enterprise_id, v_am_user_id, c_mccmnc, c_country_iso, route_rule_id
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

      {:ok, %{rows: [[edr_id, start, ent, trunk, message_id, part | billing]]}} ->
        {:ok,
         Map.put(attempt_map(edr_id, start, ent, trunk, message_id, part), :billing, billing)}

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

        with :ok <- Edr.publish_receipt(row),
             do: if(duplicate, do: :ok, else: vendor_cost(attempt, receipt))

      {:error, _} = error ->
        error
    end
  end

  # §7, D5: a vendor billing on its receipt bills on the real status, even after the DLR timeout answered the customer;
  # the outcome row carries that cost only (no status, so delivered counts are not taken twice).
  defp vendor_cost(%{billing: [type, rate, sys, parts, no, currency | dims]} = attempt, receipt) do
    if Billing.on_receipt?(type, receipt.status) do
      keys =
        ~w(business_company_id product_category_id c_am_user_id v_enterprise_id v_am_user_id c_mccmnc
                c_country_iso route_rule_id)

      data =
        Map.merge(attempt.msg, %{
          edr_id: attempt.edr_id,
          vendor_trunk_id: receipt.vendor_trunk_id,
          bill: %{
            base_currency: nil,
            sell: nil,
            cost: nil,
            c_parts: 0,
            v_parts: 0,
            attempt_no: no,
            dims: Map.new(Enum.zip(keys, dims))
          }
        })

      _ =
        Ledger.charge(
          :vendor,
          data.bill.dims["v_enterprise_id"],
          "#{attempt.edr_id}:late",
          %{rate: Decimal.new(rate), currency: currency},
          parts
        )

      data
      |> Edr.outcome_row(%{
        at: receipt.received_at,
        status: "",
        customer_billable: false,
        vendor_billable: false
      })
      |> Map.merge(%{
        "is_vendor_billable" => 1,
        "cost" => times(rate, parts),
        "cost_sys" => times(sys, parts)
      })
      |> Edr.publish_receipt()
    else
      :ok
    end
  end

  defp times(rate, parts),
    do:
      rate
      |> Decimal.new()
      |> Decimal.mult(parts)
      |> Decimal.round(6)
      |> Decimal.to_string(:normal)

  defp ms(%DateTime{} = at), do: DateTime.to_unix(at, :millisecond)
  defp ms(%NaiveDateTime{} = at), do: at |> DateTime.from_naive!("Etc/UTC") |> ms()
end
