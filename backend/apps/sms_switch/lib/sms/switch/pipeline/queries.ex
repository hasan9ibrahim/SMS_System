defmodule Sms.Switch.Pipeline.Queries do
  @moduledoc """
  `query_sm` and `cancel_sm` from a customer (docs/SMPP_SCENARIOS.md S-2.15, decision D8). A customer only ever sees
  its own messages (the same business partner, any of its trunks); someone else's id answers as unknown.

    * **cancel_sm**: only while the message is still queued with us (not yet taken by the sender): the sender then
      drops it, with an EDR row and no receipt. Otherwise 0x11 (cancel failed). Cancelling by source and destination
      without a message id is not supported (0x11).
    * **query_sm**: from our records. Queued or waiting for its receipt (Redis) → ENROUTE; cancelled → DELETED;
      otherwise from the EDRs: the customer's receipt (its status after the DLR maps, and when it was made) or, with
      none yet, ENROUTE / REJECTED by the attempt. Not found → 0x67 (query failed). A message finished in the last
      few seconds may not be in the EDRs yet (they are written in batches) and also answers 0x67.

  The message id carries its creation time (`Sms.Switch.Pipeline.MessageId`), so the EDR lookup reads a few minutes
  of one customer's rows only.
  """
  import Bitwise
  require Logger
  alias Sms.Core.ClickHouse
  alias Sms.Switch.Pipeline.{Config, MessageId, Store}

  # How long a cancelled message is remembered for query_sm.
  @keep_s 86_400
  # A message put together from its parts starts with its first part (up to the longest reassembly timeout earlier).
  @before_ms 700_000
  @after_ms 5_000

  # SMPP 3.4 §5.2.28 message_state.
  @states %{
    "ENROUTE" => 1,
    "DELIVRD" => 2,
    "EXPIRED" => 3,
    "DELETED" => 4,
    "UNDELIV" => 5,
    "ACCEPTD" => 6,
    "UNKNOWN" => 7,
    "REJECTD" => 8
  }

  @doc "Answers a `cancel_sm`."
  @spec cancel(map(), map()) :: {:ok, map(), list()} | {:error, atom()}
  def cancel(context, fields) do
    id = fields[:message_id] || ""

    with {:ok, ent} <- enterprise(context),
         true <- id != "" || :not_queued,
         :ok <- Store.cancel_queued(ent, id, @keep_s) do
      Logger.info("message #{id} cancelled while queued (S-2.15)")
      {:ok, %{}, []}
    else
      :not_queued ->
        {:error, :esme_rcancelfail}

      {:status, status} ->
        {:error, status}

      {:error, reason} ->
        Logger.error("cancel_sm of #{id} not checked: #{inspect(reason)}")
        {:error, :esme_rsyserr}
    end
  end

  @doc "Answers a `query_sm`."
  @spec query(map(), map()) :: {:ok, map(), list()} | {:error, atom()}
  def query(context, fields) do
    id = fields[:message_id] || ""

    with {:ok, ent} <- enterprise(context),
         {:ok, %{ms: ms}} <- decode(id),
         {:ok, state} <- state(ent, id, ms) do
      reply(id, state)
    else
      {:status, status} ->
        {:error, status}

      {:error, reason} ->
        Logger.error("query_sm of #{id} not answered: #{inspect(reason)}")
        {:error, :esme_rsyserr}
    end
  end

  defp enterprise(context) do
    case Config.ready?() && Config.customer_trunk(context.origin.trunk_id) do
      %{enterprise_id: ent} -> {:ok, ent}
      _ -> {:status, :esme_rsyserr}
    end
  end

  defp decode(id) do
    case MessageId.decode(id) do
      {:ok, _} = ok -> ok
      :error -> {:status, :esme_rqueryfail}
    end
  end

  defp state(ent, id, ms) do
    case Store.queued(ent, id) do
      {:ok, :queued} -> {:ok, {"ENROUTE", nil, 0}}
      {:ok, :cancelled} -> {:ok, {"DELETED", nil, 0}}
      {:ok, :none} -> pending_or_edr(ent, id, ms)
      {:error, _} = error -> error
    end
  end

  defp pending_or_edr(ent, id, ms) do
    case Store.message(id) do
      {:ok, %{data: %{trunk: %{enterprise_id: ^ent}}}} -> {:ok, {"ENROUTE", nil, 0}}
      {:error, _} = error -> error
      _ -> edr(ent, id, ms)
    end
  end

  @attempt """
  SELECT toString(edr_id), is_final_attempt, is_submit_success, command_status
    FROM edr
   WHERE toDate(start_time) BETWEEN toDate({from:DateTime64(3)}) AND toDate({to:DateTime64(3)})
     AND c_enterprise_id = {ent:UInt32}
     AND start_time BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
     AND (c_message_id = {id:String} OR has(c_message_ids, {id:String}))
   ORDER BY attempt_no DESC
   LIMIT 1
  """

  @receipt """
  SELECT c_msg_status, c_delivery_error, toUnixTimestamp64Milli(receipt_time)
    FROM edr_receipt
   WHERE toDate(start_time) BETWEEN toDate({from:DateTime64(3)}) AND toDate({to:DateTime64(3)})
     AND c_enterprise_id = {ent:UInt32}
     AND edr_id = {edr:UUID} AND kind = 'customer'
   ORDER BY receipt_time DESC
   LIMIT 1
  """

  defp edr(ent, id, ms) do
    window = %{"from" => time(ms - @before_ms), "to" => time(ms + @after_ms), "ent" => ent}

    case ClickHouse.query(@attempt, Map.put(window, "id", id)) do
      {:ok, %{rows: []}} ->
        {:status, :esme_rqueryfail}

      {:ok, %{rows: [[edr_id, final, success, status]]}} ->
        receipt(window, edr_id, {final, success, status})

      {:error, _} = error ->
        error
    end
  end

  defp receipt(window, edr_id, {final, success, command_status}) do
    case ClickHouse.query(@receipt, Map.put(window, "edr", edr_id)) do
      {:ok, %{rows: [[status, error, at]]}} ->
        {:ok, {status, at, error_code(error)}}

      {:ok, %{rows: []}} when final == 1 and success == 0 ->
        {:ok, {"REJECTD", nil, command_status &&& 0xFF}}

      {:ok, %{rows: []}} ->
        {:ok, {"ENROUTE", nil, 0}}

      {:error, _} = error ->
        error
    end
  end

  defp reply(id, {status, at, error}) do
    {:ok,
     %{
       message_id: id,
       final_date: if(at, do: smpp_time(at), else: ""),
       message_state: Map.get(@states, status, 7),
       error_code: error
     }, []}
  end

  # The receipt's error (three digits, often hex) as the one octet query_sm_resp has.
  defp error_code(error) do
    case Integer.parse(error || "", 16) do
      {n, ""} -> n &&& 0xFF
      _ -> 0
    end
  end

  defp time(ms),
    do:
      ms |> DateTime.from_unix!(:millisecond) |> DateTime.to_naive() |> NaiveDateTime.to_string()

  # SMPP absolute time, UTC: YYMMDDhhmmsstnn+ (SMPP 3.4 §7.1.1).
  defp smpp_time(ms) do
    dt = DateTime.from_unix!(ms, :millisecond)
    tenth = div(elem(dt.microsecond, 0), 100_000)
    Calendar.strftime(dt, "%y%m%d%H%M%S") <> "#{tenth}00+"
  end
end
