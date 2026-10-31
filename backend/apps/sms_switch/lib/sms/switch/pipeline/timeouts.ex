defmodule Sms.Switch.Pipeline.Timeouts do
  @moduledoc """
  The vendor DLR timeout (spec §5.5 DLR Timeout / DLR Timeout Status, S-5.10): every `:sweep_ms` this server takes the
  messages whose deadline passed from the shared list in Redis (`Sms.Switch.Pipeline.Store`, key `t`) and answers
  them with the trunk's DLR Timeout Status (`Sms.Switch.Pipeline.Receipts.timeout/1`); it also fails the multipart
  groups still incomplete after their reassembly timeout (`Sms.Switch.Pipeline.Reassembly`, D1), and releases the
  credit holds whose expiry passed (`Sms.Switch.Pipeline.Ledger.sweep_holds/0`, §7: a lost message never locks credit).
  Both servers sweep; each message is taken by one. A message whose answer could not be queued is tried again in half a
  minute.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Pipeline.{Ledger, Reassembly, Receipts, Store}

  @sweep_ms 1_000
  @batch 500
  @retry_ms 30_000

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    {:ok, _} = :timer.send_interval(Keyword.get(opts, :sweep_ms, @sweep_ms), :sweep)
    {:ok, nil}
  end

  @impl true
  def handle_info(:sweep, state) do
    _ = sweep()
    {:noreply, state}
  end

  @doc false
  # Answers every due timeout now; public for tests.
  @spec sweep() :: :ok
  def sweep do
    # Multipart groups whose reassembly timeout passed (D1).
    _ = Reassembly.sweep()
    # Credit holds of messages whose outcome never came (§7).
    _ = Ledger.sweep_holds()

    case Store.due_timeouts(System.os_time(:millisecond), @batch) do
      {:ok, []} ->
        :ok

      {:ok, ids} ->
        Enum.each(ids, &take/1)
        # A full batch: more may be due.
        if length(ids) == @batch, do: sweep(), else: :ok

      {:error, reason} ->
        Logger.warning("DLR timeouts not swept: #{inspect(reason)}")
    end
  end

  defp take(id) do
    if Store.claim_timeout(id) do
      case Receipts.timeout(id) do
        :ok ->
          :ok

        {:error, reason} ->
          Logger.warning("DLR timeout of #{id} not answered yet, tried again: #{inspect(reason)}")
          _ = Store.schedule_timeout(id, System.os_time(:millisecond) + @retry_ms)
          :ok
      end
    end
  end
end
