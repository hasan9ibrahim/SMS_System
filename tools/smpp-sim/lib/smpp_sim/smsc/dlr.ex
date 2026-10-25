defmodule SmppSim.Smsc.Dlr do
  @moduledoc """
  The fake SMSCs' delivery receipts: each accepted submit gets one receipt after the configured delay
  (`SmppSim.Smsc` `:dlr_ms`), with a final state drawn from `:dlr_mix`, in the format of spec §2 (text
  `id:… sub:001 dlvrd:… submit date:… done date:… stat:… err:… text:`, TLVs `receipted_message_id` and
  `message_state`).

  Receipts wait in an ordered ETS table by due time; every 10 ms the due ones go out on a bound receiver connection
  of the same `system_id`, taken in turn. With none bound (the switch is reconnecting) a receipt is tried again
  every second for a minute, then counted as dropped. A receipt the switch answers with an error, or that was
  waiting for its answer on a connection that dropped, is sent again a second later.
  """
  use GenServer
  import Bitwise
  alias SmppSim.Smsc.Conn
  alias SmppSim.Stats

  @table :sim_dlr
  @registry SmppSim.SmscRegistry
  @tick_ms 10
  @retry_ms 1_000
  @give_up_ms 60_000
  @states %{"DELIVRD" => 2, "EXPIRED" => 3, "UNDELIV" => 5, "REJECTD" => 8}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @doc "A new vendor message id, unique for this run (hexadecimal)."
  @spec next_id() :: String.t()
  def next_id do
    n = :atomics.add_get(:persistent_term.get({__MODULE__, :ids}), 1, 1)
    Integer.to_string(n, 16)
  end

  @doc "Schedules the receipt of an accepted submit."
  @spec schedule(String.t(), String.t(), Sms.Switch.Smpp.Pdu.t(), map()) :: :ok
  def schedule(system_id, id, pdu, config) do
    {min, max} = config.dlr_ms
    now = System.monotonic_time(:millisecond)
    due = now + min + :rand.uniform(max - min + 1) - 1
    item = {system_id, id, pdu.fields[:source_addr], pdu.fields[:destination_addr], pick(config.dlr_mix), now}
    true = :ets.insert(@table, {{due, id}, item})
    :ok
  end

  @doc "Sends a receipt again in a second (refused by the switch, or its connection dropped before the answer)."
  @spec retry(tuple()) :: :ok
  def retry({_system_id, id, _src, _dst, _stat, _submitted} = item) do
    true = :ets.insert(@table, {{System.monotonic_time(:millisecond) + @retry_ms, id}, item})
    :ok
  end

  @doc "Receipts waiting to be sent."
  @spec pending() :: non_neg_integer()
  def pending, do: :ets.info(@table, :size)

  @doc "Forgets every waiting receipt (between runs)."
  @spec clear() :: :ok
  def clear do
    true = :ets.delete_all_objects(@table)
    :ok
  end

  defp pick(mix) do
    total = mix |> Enum.map(&elem(&1, 1)) |> Enum.sum()
    roll = :rand.uniform() * total

    Enum.reduce_while(mix, roll, fn {stat, weight}, left ->
      if left <= weight, do: {:halt, stat}, else: {:cont, left - weight}
    end)
    |> case do
      stat when is_binary(stat) -> stat
      _ -> mix |> List.first() |> elem(0)
    end
  end

  @impl true
  def init(nil) do
    @table = :ets.new(@table, [:ordered_set, :named_table, :public, write_concurrency: true])
    :persistent_term.put({__MODULE__, :ids}, :atomics.new(1, signed: false))
    :ok = :atomics.put(:persistent_term.get({__MODULE__, :ids}), 1, :rand.uniform(1 <<< 24) <<< 20)
    Process.send_after(self(), :tick, @tick_ms)
    {:ok, %{turn: 0}}
  end

  @impl true
  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, @tick_ms)
    {:noreply, send_due(:ets.first(@table), System.monotonic_time(:millisecond), state)}
  end

  defp send_due(:"$end_of_table", _now, state), do: state
  defp send_due({due, _}, now, state) when due > now, do: state

  defp send_due(key, now, state) do
    next = :ets.next(@table, key)
    [{_, item}] = :ets.lookup(@table, key)
    true = :ets.delete(@table, key)
    send_due(next, now, deliver(item, now, state))
  end

  defp deliver({system_id, id, src, dst, stat, submitted} = item, now, state) do
    case Registry.lookup(@registry, system_id) do
      [] ->
        if now - submitted > @give_up_ms do
          Stats.incr(:smsc_receipts_dropped)
        else
          Stats.incr(:smsc_receipts_retried)
          true = :ets.insert(@table, {{now + @retry_ms, id}, item})
        end

        state

      conns ->
        {pid, _} = Enum.at(conns, rem(state.turn, length(conns)))
        {fields, tlvs} = receipt(id, src, dst, stat, submitted)
        Conn.deliver(pid, fields, tlvs, item)
        %{state | turn: state.turn + 1}
    end
  end

  @doc false
  def receipt(id, src, dst, stat, _submitted) do
    date = Calendar.strftime(DateTime.utc_now(), "%y%m%d%H%M")
    dlvrd = if stat == "DELIVRD", do: "001", else: "000"
    err = if stat == "DELIVRD", do: "000", else: "001"

    text =
      "id:#{id} sub:001 dlvrd:#{dlvrd} submit date:#{date} done date:#{date} stat:#{stat} err:#{err} text:"

    fields = %{
      source_addr_ton: 1,
      source_addr_npi: 1,
      source_addr: dst || "",
      dest_addr_ton: 5,
      dest_addr_npi: 0,
      destination_addr: src || "",
      esm_class: 0x04,
      short_message: text
    }

    {fields, [receipted_message_id: id, message_state: Map.fetch!(@states, stat)]}
  end
end
