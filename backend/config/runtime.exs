# Hosts, ports and credentials from the environment (the same names as the repo's .env.example), read at boot.
import Config

env = fn name, default -> System.get_env(name, default) end

int = fn name, default ->
  value = env.(name, default)

  case Integer.parse(value) do
    {n, ""} when n > 0 -> n
    _ -> raise ArgumentError, "#{name} must be a positive integer, got #{inspect(value)}"
  end
end

prod? = config_env() == :prod

required = fn name, dev_default ->
  case System.get_env(name) do
    value when value not in [nil, ""] -> value
    _ when prod? -> raise ArgumentError, "#{name} is required in production"
    _ -> dev_default
  end
end

config :sms_core, Sms.Core.Repo,
  hostname: env.("POSTGRES_HOST", "localhost"),
  port: int.("POSTGRES_PORT", "5432"),
  database: env.("POSTGRES_DB", "sms_config"),
  username: env.("POSTGRES_USER", "sms_dev"),
  password: required.("POSTGRES_PASSWORD", "sms_dev_password"),
  pool_size: int.("POSTGRES_POOL_SIZE", "10"),
  # The schema is the one the mock server and the screens use today (db/postgres/migrations).
  parameters: [search_path: env.("PG_SCHEMA", "sms") <> ",public"]

config :sms_core, Sms.Core.Redis,
  host: env.("REDIS_HOST", "localhost"),
  port: int.("REDIS_PORT", "6379"),
  password: System.get_env("REDIS_PASSWORD"),
  pool_size: int.("REDIS_POOL_SIZE", "5")

config :sms_core, Sms.Core.ClickHouse,
  hostname: env.("CLICKHOUSE_HOST", "localhost"),
  port: int.("CLICKHOUSE_HTTP_PORT", "8123"),
  database: env.("CLICKHOUSE_DB", "sms_edr"),
  username: env.("CLICKHOUSE_USER", "sms_dev"),
  password: required.("CLICKHOUSE_PASSWORD", "sms_dev_password"),
  pool_size: int.("CLICKHOUSE_POOL_SIZE", "5")

config :sms_core, Sms.Core.Bus.Nats,
  hosts: env.("NATS_HOSTS", "localhost:4222"),
  username: System.get_env("NATS_USER"),
  password: System.get_env("NATS_PASSWORD")

# SMPP listeners for customers (spec §2, §5.4): comma-separated ports. A customer trunk binds only on its own Port, and
# a TLS trunk only on a TLS port. SMPP_PROXY_PORTS are the ports behind a load balancer that sends a PROXY header
# (S-1.15); they are listed in SMPP_PORTS or SMPP_TLS_PORTS too.
ports = fn name, default ->
  for part <- String.split(env.(name, default), ",", trim: true) do
    case Integer.parse(String.trim(part)) do
      {port, ""} when port in 1..65_535 -> port
      _ -> raise ArgumentError, "#{name} must list ports (1-65535), got #{inspect(part)}"
    end
  end
end

plain_ports = ports.("SMPP_PORTS", "2775")
tls_ports = ports.("SMPP_TLS_PORTS", "")
proxy_ports = ports.("SMPP_PROXY_PORTS", "")

if overlap = Enum.find(plain_ports, &(&1 in tls_ports)) do
  raise ArgumentError, "port #{overlap} is in both SMPP_PORTS and SMPP_TLS_PORTS"
end

listeners =
  Enum.map(plain_ports, &[port: &1, proxy_protocol: &1 in proxy_ports]) ++
    Enum.map(tls_ports, &[port: &1, tls: true, proxy_protocol: &1 in proxy_ports])

tls =
  if tls_ports == [] do
    []
  else
    file = fn name ->
      case System.get_env(name) do
        path when path not in [nil, ""] -> path
        _ -> raise ArgumentError, "#{name} is required when SMPP_TLS_PORTS is set"
      end
    end

    [certfile: file.("SMPP_TLS_CERTFILE"), keyfile: file.("SMPP_TLS_KEYFILE")]
  end

config :sms_switch, Sms.Switch.Customer,
  listeners: listeners,
  tls: tls,
  session: [system_id: env.("SMPP_SYSTEM_ID", "SMSC")]

config :sms_switch, Sms.Switch.Customer.Throttle, cluster_size: int.("SWITCH_CLUSTER_SIZE", "2")
