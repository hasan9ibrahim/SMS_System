defmodule Sms.Switch.Vendor do
  @moduledoc """
  The vendor side of the switch, where it is the client of each vendor's SMSC (spec §2, §5.5; build step 3).

  `Sms.Switch.Vendor.Manager` opens each active vendor trunk's connections, split between the servers (decision
  Q12); each connection is a `Sms.Switch.Vendor.Session` that binds, keeps itself alive and reconnects on the
  trunk's schedule. Receipts and MO from vendors go to `Sms.Switch.Vendor.Receipts` (the message pipeline, step 4).

  This module is the entry point for the rest of the switch: sending a message to a vendor trunk (`submit/5`),
  listing connections (Network Status, §13.1) and reloading the trunks.

  Settings live under `config :sms_switch, Sms.Switch.Vendor`:

    * `:enabled`: start the vendor side (off in unit tests, which start the parts they need);
    * `:session`: see `Sms.Switch.Vendor.Session` (connect and bind timeouts, `tls_verify`, windows);
    * `:receipts`: the `Sms.Switch.Vendor.Receipts` implementation;
    * `:trunk_refresh_ms`.
  """
  alias Sms.Switch.Throttle
  alias Sms.Switch.Vendor.{Manager, Session, Trunk, TrunkStore}

  @scope :sms_vendor_sessions

  @doc """
  Sends a `submit_sm` (or `data_sm`) to vendor trunk `trunk_id` and waits for the vendor's response.

  The submit counts against the trunk's TPS limit shared by both servers (`tps × max_connections`), then goes to a
  bound connection of the trunk, this server's first; a full window moves on to the next connection.

  Returns what `Sms.Switch.Vendor.Session.submit/5` returns, or, before anything is sent: `{:error, :unknown_trunk}`,
  `{:error, :trunk_inactive}`, `{:error, :no_connection}` (no bound connection: the bind is down, S-5.4),
  `{:error, :throttled}` (over the TPS limit this second) or `{:error, :window_full}` (every connection is full).
  `:timeout` and `:connection_lost` mean the message may have been sent (decision D4).

  Options: `:ref`, the caller's id for the message, returned in a `late_response` event; `:prefer`, a connection
  (the `pid` of an earlier result) to try first, so the parts of one message go on the same session where possible
  (S-3.8). A successful result carries the connection's `pid`.
  """
  @spec submit(pos_integer(), :submit_sm | :data_sm, map(), list(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def submit(trunk_id, command, fields, tlvs \\ [], opts \\ []) do
    with {:ok, trunk} <- trunk(trunk_id),
         [_ | _] = pids <- connections(trunk_id, opts[:prefer]),
         :ok <- throttle(trunk) do
      try_submit(pids, command, fields, tlvs, opts)
    else
      [] -> {:error, :no_connection}
      {:error, _} = error -> error
    end
  end

  defp trunk(id) do
    case TrunkStore.get(id) do
      {:ok, %Trunk{status: :active} = trunk} -> {:ok, trunk}
      {:ok, _inactive} -> {:error, :trunk_inactive}
      :error -> {:error, :unknown_trunk}
    end
  end

  defp throttle(trunk) do
    case Throttle.acquire(Trunk.tps_counters(trunk)) do
      :ok -> :ok
      {:error, _counter} -> {:error, :throttled}
    end
  end

  # The trunk's bound connections that can send, this node's first, each group in random order to spread the load.
  defp connections(trunk_id, prefer) do
    local = :pg.get_local_members(@scope, {:tx, trunk_id})
    remote = :pg.get_members(@scope, {:tx, trunk_id}) -- local
    pids = Enum.shuffle(local) ++ Enum.shuffle(remote)
    if prefer in pids, do: [prefer | List.delete(pids, prefer)], else: pids
  rescue
    # The vendor side is not running on this node.
    ArgumentError -> []
  end

  defp try_submit([pid | rest], command, fields, tlvs, opts) do
    case Session.submit(pid, command, fields, tlvs, opts) do
      {:ok, result} ->
        {:ok, Map.put(result, :pid, pid)}

      {:error, reason} when reason in [:window_full, :closed] and rest != [] ->
        try_submit(rest, command, fields, tlvs, opts)

      {:error, :closed} ->
        {:error, :no_connection}

      result ->
        result
    end
  end

  @doc "The vendor connections run by this node (Network Status, §13.1)."
  @spec sessions() :: [map()]
  def sessions do
    for {_key, pid} <- Manager.sessions(), info = safe_info(pid), do: Map.put(info, :pid, pid)
  end

  defp safe_info(pid) do
    Session.info(pid)
  catch
    :exit, _ -> nil
  end

  @doc "Reloads the vendor trunks now (after a trunk is saved; also done every few seconds)."
  @spec reload_trunks() :: {:ok, non_neg_integer()} | {:error, term()}
  def reload_trunks, do: TrunkStore.refresh()
end
