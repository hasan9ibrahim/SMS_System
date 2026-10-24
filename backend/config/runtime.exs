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

# SMPP listeners for customers (spec §2, §5.4): 2775 plain and 2776 TLS on every server (product owner, 2026-10-24).
# A TLS trunk binds only over TLS. SMPP_PROXY_PORTS are ports behind a load balancer that sends a PROXY header
# (S-1.15). TLS needs a certificate: required in production; in development the TLS port is skipped without one.
ports = fn name, default ->
  for part <- String.split(env.(name, default), ",", trim: true) do
    case Integer.parse(String.trim(part)) do
      {port, ""} when port in 1..65_535 -> port
      _ -> raise ArgumentError, "#{name} must list ports (1-65535), got #{inspect(part)}"
    end
  end
end

plain_ports = ports.("SMPP_PORTS", "2775")
tls_ports = ports.("SMPP_TLS_PORTS", "2776")
proxy_ports = ports.("SMPP_PROXY_PORTS", "")

if overlap = Enum.find(plain_ports, &(&1 in tls_ports)) do
  raise ArgumentError, "port #{overlap} is in both SMPP_PORTS and SMPP_TLS_PORTS"
end

certfile = System.get_env("SMPP_TLS_CERTFILE", "")
keyfile = System.get_env("SMPP_TLS_KEYFILE", "")

tls_ports =
  cond do
    tls_ports == [] or (certfile != "" and keyfile != "") ->
      tls_ports

    prod? ->
      raise ArgumentError,
            "SMPP_TLS_CERTFILE and SMPP_TLS_KEYFILE are required for SMPP_TLS_PORTS"

    config_env() == :test ->
      []

    true ->
      IO.warn(
        "SMPP TLS port(s) #{inspect(tls_ports)} not opened: set SMPP_TLS_CERTFILE and SMPP_TLS_KEYFILE",
        []
      )

      []
  end

listeners =
  Enum.map(plain_ports, &[port: &1, proxy_protocol: &1 in proxy_ports]) ++
    Enum.map(tls_ports, &[port: &1, tls: true, proxy_protocol: &1 in proxy_ports])

tls = if tls_ports == [], do: [], else: [certfile: certfile, keyfile: keyfile]

config :sms_switch, Sms.Switch.Customer,
  listeners: listeners,
  tls: tls,
  session: [system_id: env.("SMPP_SYSTEM_ID", "SMSC")]

config :sms_switch, Sms.Switch.Throttle, cluster_size: int.("SWITCH_CLUSTER_SIZE", "2")

# Each server's own number (0–255) in the message ids it gives customers; the platform currency for margins.
node_id =
  case Integer.parse(env.("SWITCH_NODE_ID", "0")) do
    {n, ""} when n in 0..255 ->
      n

    _ ->
      raise ArgumentError,
            "SWITCH_NODE_ID must be 0 to 255, got #{inspect(env.("SWITCH_NODE_ID", ""))}"
  end

config :sms_switch, Sms.Switch.Pipeline,
  node_id: node_id,
  platform_currency: env.("PLATFORM_CURRENCY", "EUR")

# Vendor TLS connections check the vendor's certificate against the system CAs and its host name ("peer"); "none"
# accepts any certificate (a vendor with a self-signed one).
tls_verify =
  case env.("VENDOR_TLS_VERIFY", "peer") do
    "peer" -> :peer
    "none" -> :none
    other -> raise ArgumentError, "VENDOR_TLS_VERIFY must be peer or none, got #{inspect(other)}"
  end

config :sms_switch, Sms.Switch.Vendor, session: [tls_verify: tls_verify]
