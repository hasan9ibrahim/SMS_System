defmodule Sms.Switch.Vendor.Loader do
  @moduledoc """
  Reads the SMPP vendor trunks from PostgreSQL (`vendor_trunks`, spec §5.5), the rows the screens edit. Deleted
  trunks (safe delete, §13.29) and trunks of deleted enterprises are left out; inactive ones are kept so their
  connections can be closed. A trunk of an inactive enterprise counts as inactive.
  """
  require Logger
  alias Sms.Core.Repo
  alias Sms.Switch.Vendor.Trunk

  @query """
  SELECT t.id, t.enterprise_id, t.name, t.status, e.status, t.bind_type, t.username, t.password, t.host, t.port,
         host(t.source_host), t.max_connections, t.system_type, t.service_type, t.ssl_type, t.submit_interval_ms,
         t.submit_timeout_s, t.enquire_link_timeout_s, t.enquire_link_interval_s, t.reconnect_schedule_s,
         t.bind_alert_after_min, t.auth_fail_retry_min, t.msg_id_type, t.tps, t.overflow_buffer, t.window_size,
         t.bind_addr_ton, t.bind_addr_npi, t.bind_addr_range
    FROM vendor_trunks t
    JOIN enterprises e ON e.id = t.enterprise_id
   WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL AND t.protocol = 'smpp'
   ORDER BY t.id
  """

  @doc "Every SMPP vendor trunk, or the database error."
  @spec load() :: {:ok, [Trunk.t()]} | {:error, term()}
  def load do
    case Repo.query(@query, [], timeout: 10_000, log: false) do
      {:ok, result} -> {:ok, Enum.flat_map(result.rows, &trunk/1)}
      {:error, _} = error -> error
    end
  rescue
    # The pool is not running (the node is starting or stopping): same as the database being unreachable.
    e -> {:error, Exception.message(e)}
  end

  @doc false
  @spec trunk(list()) :: [Trunk.t()]
  def trunk([
        id,
        enterprise_id,
        name,
        status,
        ent_status,
        bind_type,
        username,
        password,
        host,
        port,
        source_host,
        max_conn,
        system_type,
        service_type,
        ssl_type,
        interval,
        submit_timeout,
        el_timeout,
        el_interval,
        schedule,
        alert_after,
        auth_retry,
        msg_id_type,
        tps,
        overflow,
        window,
        addr_ton,
        addr_npi,
        addr_range
      ]) do
    [
      %Trunk{
        id: id,
        enterprise_id: enterprise_id,
        name: name,
        status: if(status == "active" and ent_status == "active", do: :active, else: :inactive),
        bind_type: bind_type(bind_type),
        username: username,
        password: password,
        host: host,
        port: port,
        source_host: source_ip(id, source_host),
        max_connections: max_conn,
        system_type: blank_to_nil(system_type),
        service_type: blank_to_nil(service_type),
        tls: tls(ssl_type),
        submit_interval_ms: max(interval, 0),
        submit_timeout_s: max(submit_timeout, 1),
        enquire_link_timeout_s: max(el_timeout, 1),
        enquire_link_interval_s: max(el_interval, 1),
        reconnect_schedule_s: schedule(schedule),
        bind_alert_after_min: alert_after,
        auth_fail_retry_min: auth_retry,
        msg_id_type: msg_id_type(msg_id_type),
        tps: max(tps, 1),
        overflow_buffer: overflow,
        window_size: max(window, 1),
        bind_addr_ton: addr_ton,
        bind_addr_npi: addr_npi,
        bind_addr_range: blank_to_nil(addr_range)
      }
    ]
  rescue
    # A row the switch does not understand must never stop every other trunk from loading.
    e ->
      Logger.error("vendor trunk #{inspect(id)} skipped: #{Exception.message(e)}")
      []
  end

  defp bind_type("TX"), do: :tx
  defp bind_type("RX"), do: :rx
  defp bind_type("TR"), do: :trx

  defp tls("none"), do: :none
  defp tls("tls1.0"), do: :"tls1.0"
  defp tls("tls1.2"), do: :"tls1.2"
  defp tls("tls1.3"), do: :"tls1.3"

  defp msg_id_type("default"), do: :default
  defp msg_id_type("decimal"), do: :decimal
  defp msg_id_type("hexadecimal"), do: :hexadecimal

  defp schedule(values) when is_list(values) do
    case Enum.filter(values, &(is_integer(&1) and &1 > 0)) do
      [] -> [5, 10, 30, 60]
      good -> good
    end
  end

  defp schedule(_), do: [5, 10, 30, 60]

  defp source_ip(_id, nil), do: nil

  defp source_ip(id, text) do
    case :inet.parse_strict_address(String.to_charlist(text)) do
      {:ok, ip} ->
        ip

      {:error, _} ->
        Logger.error("vendor trunk #{id}: source host #{inspect(text)} ignored")
        nil
    end
  end

  defp blank_to_nil(nil), do: nil
  defp blank_to_nil(text), do: if(String.trim(text) == "", do: nil, else: text)
end
