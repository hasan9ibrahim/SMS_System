defmodule Sms.Switch.Customer.Sessions do
  @moduledoc """
  Every bound customer session, on this node and across the cluster (spec §13.1, Network Status).

    * A local `Registry` keyed by trunk holds each session's details: the authoritative list on this node, updated
      synchronously, used to count binds and to list sessions.
    * A `:pg` scope spans the cluster and holds the sessions that can receive (RX and TRX), grouped by session id,
      by trunk + client IP and by trunk, so a receipt can find its session on whichever server it lives
      (`Sms.Switch.Customer.Affinity`).

  `register/2` enforces Max Connections across every server (S-1.2), for each client address (team trial round 14:
  every address the customer binds from may open Max Connections sessions, also inside an allowed network): it holds
  a cluster-wide lock for the trunk, counts the trunk's sessions from that address on every reachable node, and
  registers only below the limit, so two binds racing on two servers cannot both take the last slot.

  Every sending session (TX or TRX) also joins `{:sender_ip, trunk_id, ip}`, which `Sms.Switch.Customer.Senders`
  follows to count the addresses a trunk sends from (the trunk's TPS pool, `Trunk.trunk_tps/1`).
  """
  alias Sms.Switch.Customer.{Senders, Trunk}

  @registry Sms.Switch.Customer.Registry
  @scope :sms_customer_sessions

  @type bind :: :tx | :rx | :trx

  @type meta :: %{
          id: String.t(),
          trunk_id: pos_integer(),
          system_id: String.t(),
          ip: :inet.ip_address(),
          port: :inet.port_number(),
          bind: bind(),
          node: node(),
          bound_at: DateTime.t(),
          tls: atom() | nil
        }

  @doc false
  def child_specs do
    [
      {Registry, keys: :duplicate, name: @registry},
      %{id: @scope, start: {:pg, :start_link, [@scope]}},
      {Senders, scope: @scope}
    ]
  end

  @doc """
  Registers the calling session process for `trunk` if the trunk has fewer than Max Connections sessions from the
  session's client address across the cluster. Returns `{:error, :max_connections}` otherwise, or
  `{:error, :lock_failed}` if the lock was not obtained.
  """
  @spec register(Trunk.t(), meta()) :: :ok | {:error, :max_connections | :lock_failed}
  def register(%Trunk{id: id, max_connections: max}, meta) do
    nodes = [node() | Node.list()]

    result =
      :global.trans(
        {{__MODULE__, id}, self()},
        fn ->
          if cluster_count(id, meta.ip) >= max do
            {:error, :max_connections}
          else
            {:ok, _} = Registry.register(@registry, {:trunk, id}, meta)
            join_receiver_groups(meta)
            join_sender_group(meta)
            :ok
          end
        end,
        nodes,
        10
      )

    if result == :aborted, do: {:error, :lock_failed}, else: result
  end

  defp join_receiver_groups(%{bind: bind} = meta) when bind in [:rx, :trx] do
    :ok = :pg.join(@scope, {:session, meta.id}, self())
    :ok = :pg.join(@scope, {:trunk_ip, meta.trunk_id, meta.ip}, self())
    :ok = :pg.join(@scope, {:trunk, meta.trunk_id}, self())
  end

  defp join_receiver_groups(_meta), do: :ok

  defp join_sender_group(%{bind: bind} = meta) when bind in [:tx, :trx],
    do: :ok = :pg.join(@scope, {:sender_ip, meta.trunk_id, meta.ip}, self())

  defp join_sender_group(_meta), do: :ok

  @doc "The number of sessions of a trunk on every reachable node."
  @spec cluster_count(pos_integer()) :: non_neg_integer()
  def cluster_count(trunk_id) do
    remote = :erpc.multicall(Node.list(), __MODULE__, :local_count, [trunk_id], 2_000)
    sum_counts(remote, local_count(trunk_id))
  end

  @doc "The number of sessions of a trunk from one client address on every reachable node (its Max Connections)."
  @spec cluster_count(pos_integer(), :inet.ip_address()) :: non_neg_integer()
  def cluster_count(trunk_id, ip) do
    remote = :erpc.multicall(Node.list(), __MODULE__, :local_count, [trunk_id, ip], 2_000)
    sum_counts(remote, local_count(trunk_id, ip))
  end

  @doc "The number of client addresses a trunk has bound with a sending bind (TX or TRX), on every server."
  @spec sending_addresses(pos_integer()) :: non_neg_integer()
  defdelegate sending_addresses(trunk_id), to: Senders, as: :count

  # A node that does not answer in time (or has no switch running) counts as 0.
  defp sum_counts([], acc), do: acc

  defp sum_counts([{:ok, n} | rest], acc) when is_integer(n) and n >= 0,
    do: sum_counts(rest, acc + n)

  defp sum_counts([_unreachable | rest], acc), do: sum_counts(rest, acc)

  @doc false
  @spec local_count(pos_integer()) :: non_neg_integer()
  def local_count(trunk_id), do: Registry.count_match(@registry, {:trunk, trunk_id}, :_)

  @doc false
  @spec local_count(pos_integer(), :inet.ip_address()) :: non_neg_integer()
  def local_count(trunk_id, ip),
    do: Enum.count(local(trunk_id), fn {_pid, meta} -> meta.ip == ip end)

  @doc "The sessions bound on this node, with their details."
  @spec local() :: [{pid(), meta()}]
  def local do
    Registry.select(@registry, [{{:_, :"$1", :"$2"}, [], [{{:"$1", :"$2"}}]}])
  end

  @doc "The sessions of a trunk bound on this node."
  @spec local(pos_integer()) :: [{pid(), meta()}]
  def local(trunk_id), do: Registry.lookup(@registry, {:trunk, trunk_id})

  @doc "Asks every session of the trunk on this node to re-check its trunk (it changed or was removed)."
  @spec revalidate(pos_integer()) :: :ok
  def revalidate(trunk_id) do
    for {pid, _meta} <- local(trunk_id), do: send(pid, :revalidate)
    :ok
  end

  @doc "The receiving session with this id, wherever it is bound (empty when it is gone or cannot receive)."
  @spec receiver(String.t()) :: [pid()]
  def receiver(session_id), do: :pg.get_members(@scope, {:session, session_id})

  @doc "The receiving sessions of a trunk from one client IP, those on this node first."
  @spec receivers(pos_integer(), :inet.ip_address()) :: [pid()]
  def receivers(trunk_id, ip), do: local_first({:trunk_ip, trunk_id, ip})

  @doc "Every receiving session of a trunk, those on this node first."
  @spec receivers(pos_integer()) :: [pid()]
  def receivers(trunk_id), do: local_first({:trunk, trunk_id})

  # Local sessions first (no network hop), each part shuffled so receipts spread over the sessions.
  defp local_first(group) do
    local = :pg.get_local_members(@scope, group)
    remote = :pg.get_members(@scope, group) -- local
    Enum.shuffle(local) ++ Enum.shuffle(remote)
  end
end
