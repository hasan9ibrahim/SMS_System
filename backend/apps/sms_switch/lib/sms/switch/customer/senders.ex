defmodule Sms.Switch.Customer.Senders do
  @moduledoc """
  How many client addresses each customer trunk has bound with a sending bind (TX or TRX), on every server (team trial
  round 14, spec §5.4): each address may open Max Connections sessions, so the trunk's TPS pool is TPS × Max
  Connections × that count, at least one (`Sms.Switch.Customer.Trunk.trunk_tps/1`).

  Every sending session joins the `:pg` group `{:sender_ip, trunk_id, ip}` (`Sms.Switch.Customer.Sessions`). This
  process follows the scope (`:pg.monitor_scope/1`) and keeps, in an ETS table every process reads, the members of
  each group and the number of non-empty groups per trunk, so `count/1` is a single ETS read on the submit path. `:pg`
  drops a session that ends, and every session of a server that goes away; the counts follow.
  """
  use GenServer

  @table __MODULE__

  @doc "Options: `:scope`, the `:pg` scope of the customer sessions."
  def start_link(opts),
    do: GenServer.start_link(__MODULE__, Keyword.fetch!(opts, :scope), name: __MODULE__)

  @doc "The number of client addresses `trunk_id` sends from now, on every server (0 when none, or not running)."
  @spec count(pos_integer()) :: non_neg_integer()
  def count(trunk_id) do
    case :ets.lookup(@table, {:trunk, trunk_id}) do
      [{_, n}] -> n
      [] -> 0
    end
  rescue
    ArgumentError -> 0
  end

  @impl true
  def init(scope) do
    @table = :ets.new(@table, [:named_table, :protected, read_concurrency: true])
    {ref, groups} = :pg.monitor_scope(scope)
    for {group, pids} <- groups, do: change(group, length(pids))
    {:ok, ref}
  end

  @impl true
  def handle_info({ref, :join, group, pids}, ref) do
    change(group, length(pids))
    {:noreply, ref}
  end

  def handle_info({ref, :leave, group, pids}, ref) do
    change(group, -length(pids))
    {:noreply, ref}
  end

  def handle_info(_other, ref), do: {:noreply, ref}

  # Members of one {:sender_ip, trunk, ip} group, and the trunk's count when the group fills up or empties.
  defp change({:sender_ip, trunk_id, _ip} = group, delta) do
    before = members(group)
    now = max(before + delta, 0)
    if now == 0, do: :ets.delete(@table, group), else: :ets.insert(@table, {group, now})

    cond do
      before == 0 and now > 0 -> bump(trunk_id, 1)
      before > 0 and now == 0 -> bump(trunk_id, -1)
      true -> :ok
    end
  end

  defp change(_other_group, _delta), do: :ok

  defp members(group) do
    case :ets.lookup(@table, group) do
      [{_, n}] -> n
      [] -> 0
    end
  end

  defp bump(trunk_id, delta) do
    key = {:trunk, trunk_id}
    n = max(count(trunk_id) + delta, 0)
    if n == 0, do: :ets.delete(@table, key), else: :ets.insert(@table, {key, n})
    :ok
  end
end
