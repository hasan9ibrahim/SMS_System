defmodule Sms.Switch.Vendor.Manager do
  @moduledoc """
  Decides which vendor connections this node opens, and keeps them in line with the trunks (decision Q12: a vendor
  trunk's Max Connections are split between the servers, with one TPS limit shared by both).

  Every node running the vendor side joins one `:pg` group. Connection `i` of trunk `t` belongs to the node at
  position `rem(t + i, n)` in the sorted list of those `n` nodes, so the connections of every trunk are spread
  evenly, and a trunk with one connection does not always land on the same server. When a node joins or leaves, every
  node works its share out again: a server left alone opens every connection, and gives half back when the other one
  returns. During the hand-over a vendor may briefly see one connection more than Max Connections; a vendor that
  refuses it is retried on the reconnect schedule.

  On every trunk load (`Sms.Switch.Vendor.TrunkStore`) and every membership change it reconciles, once the receipts'
  handler is ready (`Sms.Switch.Vendor.Receipts.ready?/1`: a starting server binds only when it can take receipts):

    * an active trunk's connections owned here are started (`Sms.Switch.Vendor.Session`);
    * connections no longer owned here, of an inactive trunk, or of a trunk that is gone are unbound and stopped;
    * a changed trunk is passed to its sessions, which apply it in place or reconnect (`Trunk.reconnect_needed?/2`).

  A session that ends on its own (a crash) is started again on the next reconcile, a second later.
  """
  use GenServer
  require Logger
  alias Sms.Switch.Vendor.{Receipts, Session, TrunkStore}

  @scope :sms_vendor_sessions
  @group :vendor_nodes
  @sessions Sms.Switch.Vendor.Sessions
  @restart_after_ms 1_000

  @doc "Options: `:session` (session settings) and `:receipts` (the `Sms.Switch.Vendor.Receipts` module)."
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Works out the connections again (after a trunk load). Does nothing if the manager is not running."
  @spec reconcile() :: :ok
  def reconcile do
    case Process.whereis(__MODULE__) do
      nil ->
        :ok

      pid ->
        send(pid, :reconcile)
        :ok
    end
  end

  @doc "The nodes sharing the vendor connections, sorted."
  @spec nodes() :: [node()]
  def nodes,
    do: @scope |> :pg.get_members(@group) |> Enum.map(&node/1) |> Enum.uniq() |> Enum.sort()

  @doc "The node that owns connection `index` of trunk `trunk_id` among `nodes`."
  @spec owner(pos_integer(), non_neg_integer(), [node()]) :: node()
  def owner(trunk_id, index, nodes), do: Enum.at(nodes, rem(trunk_id + index, length(nodes)))

  @doc "The sessions running here: `{trunk_id, index} => pid`."
  @spec sessions() :: %{{pos_integer(), non_neg_integer()} => pid()}
  def sessions, do: GenServer.call(__MODULE__, :sessions)

  @impl true
  def init(opts) do
    :ok = :pg.join(@scope, @group, self())
    {ref, _members} = :pg.monitor(@scope, @group)

    state = %{
      opts: opts,
      monitor: ref,
      sessions: %{},
      trunks: %{},
      timer: nil
    }

    {:ok, state, {:continue, :reconcile}}
  end

  @impl true
  def handle_continue(:reconcile, state), do: {:noreply, do_reconcile(state)}

  @impl true
  def handle_call(:sessions, _from, state),
    do: {:reply, Map.new(state.sessions, fn {k, {pid, _}} -> {k, pid} end), state}

  @impl true
  def handle_info(:reconcile, state), do: {:noreply, do_reconcile(%{state | timer: nil})}

  # A node joined or left the vendor side.
  def handle_info({ref, change, @group, _pids}, %{monitor: ref} = state)
      when change in [:join, :leave] do
    Logger.info("vendor nodes now #{inspect(nodes())}; sharing the connections again")
    {:noreply, do_reconcile(state)}
  end

  def handle_info({:DOWN, mref, :process, _pid, reason}, state) do
    case Enum.find(state.sessions, fn {_key, {_pid, ref}} -> ref == mref end) do
      nil ->
        {:noreply, state}

      {key, _} ->
        if reason != :normal,
          do: Logger.warning("vendor session #{inspect(key)} ended: #{inspect(reason)}")

        state = %{state | sessions: Map.delete(state.sessions, key)}
        {:noreply, schedule(state, @restart_after_ms)}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  defp do_reconcile(state) do
    cond do
      not TrunkStore.ready?() ->
        state

      # The receipts' handler (the pipeline) not ready yet: no connection opened, tried again in a second.
      not Receipts.ready?(state.opts[:receipts] || Receipts.impl()) ->
        schedule(state, @restart_after_ms)

      true ->
        apply_trunks(state, TrunkStore.all())
    end
  end

  defp apply_trunks(state, trunks) do
    nodes = nodes()
    by_id = Map.new(trunks, &{&1.id, &1})

    wanted =
      for trunk <- trunks,
          trunk.status == :active,
          index <- 0..(trunk.max_connections - 1)//1,
          owner(trunk.id, index, nodes) == node(),
          into: MapSet.new(),
          do: {trunk.id, index}

    # Leaving: no longer wanted here.
    sessions =
      Enum.reduce(state.sessions, state.sessions, fn {{trunk_id, _} = key, {pid, ref}}, acc ->
        if MapSet.member?(wanted, key) do
          acc
        else
          Process.demonitor(ref, [:flush])
          Session.stop(pid, stop_reason(by_id[trunk_id], nodes))
          Map.delete(acc, key)
        end
      end)

    # Changed: passed on to the sessions that stay.
    for {{trunk_id, _}, {pid, _}} <- sessions,
        state.trunks[trunk_id] != by_id[trunk_id],
        do: Session.update(pid, by_id[trunk_id])

    sessions =
      wanted
      |> Enum.reject(&Map.has_key?(sessions, &1))
      |> Enum.reduce(sessions, fn {trunk_id, index} = key, acc ->
        case start_session(state, by_id[trunk_id], index) do
          {:ok, pid} -> Map.put(acc, key, {pid, Process.monitor(pid)})
          :error -> acc
        end
      end)

    state = %{state | sessions: sessions, trunks: by_id}

    if MapSet.size(wanted) > map_size(sessions),
      do: schedule(state, @restart_after_ms),
      else: state
  end

  defp stop_reason(nil, _nodes), do: :trunk_removed
  defp stop_reason(%{status: :inactive}, _nodes), do: :trunk_inactive
  defp stop_reason(_trunk, _nodes), do: :moved_to_other_node

  defp start_session(state, trunk, index) do
    opts = [trunk: trunk, index: index, settings: Keyword.get(state.opts, :session, [])]
    opts = if r = state.opts[:receipts], do: [{:receipts, r} | opts], else: opts

    case DynamicSupervisor.start_child(@sessions, {Session, opts}) do
      {:ok, pid} ->
        {:ok, pid}

      # Still running from before this manager restarted (or still leaving): take it over with the current trunk.
      {:error, {:already_started, pid}} ->
        Session.update(pid, trunk)
        {:ok, pid}

      {:error, reason} ->
        Logger.error("vendor session #{trunk.id}/#{index} not started: #{inspect(reason)}")
        :error
    end
  end

  defp schedule(%{timer: nil} = state, ms),
    do: %{state | timer: Process.send_after(self(), :reconcile, ms)}

  defp schedule(state, _ms), do: state
end
