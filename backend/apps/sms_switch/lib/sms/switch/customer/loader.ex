defmodule Sms.Switch.Customer.Loader do
  @moduledoc """
  Reads the SMPP customer trunks from PostgreSQL (`customer_trunks`, spec §5.4), the same rows the screens edit.
  Deleted trunks (safe delete, §13.29) and trunks of deleted enterprises are left out; inactive ones are kept so a
  bind can be refused with the right reason. A trunk of an inactive enterprise counts as inactive, and so does one a user
  stopped on Network Status (`trunk_binds` status `stopped`, §9.2, backend step 11c): its sessions are closed and binds
  refused until Start.
  """
  require Logger
  alias Sms.Core.Repo
  alias Sms.Switch.Customer.{IpRange, Trunk}

  @query """
  SELECT t.id, t.enterprise_id, e.business_company_id, bc.tps_limit, t.name, t.username, t.password,
         CASE WHEN EXISTS (SELECT 1 FROM trunk_binds b WHERE b.side = 'customer' AND b.trunk_id = t.id
                             AND b.status = 'stopped') THEN 'stopped' ELSE t.status END,
         e.status, t.bind_type, t.host_ips::text[], t.max_connections, t.system_type, t.port,
         t.ssl_type, t.tps, t.overflow_buffer, t.dlr_session_affinity, t.dlr_hold_hours, t.delayed_submit
    FROM customer_trunks t
    JOIN enterprises e ON e.id = t.enterprise_id
    JOIN business_companies bc ON bc.id = e.business_company_id
   WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL AND t.protocol = 'smpp'
   ORDER BY t.id
  """

  @doc "Every SMPP customer trunk, or the database error."
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
        company_id,
        company_tps,
        name,
        username,
        password,
        status,
        ent_status,
        bind_type,
        host_ips,
        max_conn,
        system_type,
        port,
        ssl_type,
        tps,
        overflow,
        affinity,
        hold_hours,
        delayed
      ]) do
    [
      %Trunk{
        id: id,
        enterprise_id: enterprise_id,
        business_company_id: company_id,
        company_tps_limit: positive_or_nil(company_tps),
        name: name,
        username: username,
        password: password,
        status: if(status == "active" and ent_status == "active", do: :active, else: :inactive),
        bind_type: bind_type(bind_type),
        host_ips: ranges(id, host_ips || []),
        max_connections: max_conn,
        system_type: blank_to_nil(system_type),
        port: port,
        tls: tls(ssl_type),
        tps: max(tps, 1),
        overflow_buffer: overflow,
        dlr_session_affinity: affinity(affinity),
        dlr_hold_hours: hold_hours,
        delayed_submit: delayed
      }
    ]
  rescue
    # A row the switch does not understand must never stop every other trunk from loading.
    e ->
      Logger.error("customer trunk #{inspect(id)} skipped: #{Exception.message(e)}")
      []
  end

  defp ranges(id, texts) do
    Enum.flat_map(texts, fn text ->
      case IpRange.parse(text) do
        {:ok, range} ->
          [range]

        {:error, _} ->
          Logger.error("customer trunk #{id}: host IP #{inspect(text)} ignored")
          []
      end
    end)
  end

  defp bind_type("TX"), do: :tx
  defp bind_type("RX"), do: :rx
  defp bind_type("TR"), do: :trx
  defp bind_type("AUTO"), do: :auto

  defp tls("none"), do: :none
  defp tls("tls1.0"), do: :"tls1.0"
  defp tls("tls1.2"), do: :"tls1.2"
  defp tls("tls1.3"), do: :"tls1.3"

  defp affinity("strict"), do: :strict
  defp affinity("same_ip"), do: :same_ip
  defp affinity("same_trunk"), do: :same_trunk

  defp positive_or_nil(n) when is_integer(n) and n > 0, do: n
  defp positive_or_nil(_), do: nil

  defp blank_to_nil(nil), do: nil
  defp blank_to_nil(text), do: if(String.trim(text) == "", do: nil, else: text)
end
