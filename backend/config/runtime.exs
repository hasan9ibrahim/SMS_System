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

# The witness VM's node keeps no data store (SWITCH_ROLE below), so it needs none of their credentials.
witness? = System.get_env("SWITCH_ROLE") == "witness"

required = fn name, dev_default ->
  case System.get_env(name) do
    value when value not in [nil, ""] -> value
    _ when prod? and not witness? -> raise ArgumentError, "#{name} is required in production"
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

# On the servers (backend step 8) REDIS_SENTINELS lists the sentinels ("10.0.0.1:26379,..."); the connections follow
# the primary of REDIS_SENTINEL_GROUP. Without it, REDIS_HOST and REDIS_PORT.
sentinels =
  for part <- String.split(env.("REDIS_SENTINELS", ""), ",", trim: true) do
    case String.split(String.trim(part), ":") do
      [host, port] -> [host: host, port: String.to_integer(port)]
      [host] -> [host: host, port: 26_379]
    end
  end

config :sms_core, Sms.Core.Redis,
  host: env.("REDIS_HOST", "localhost"),
  port: int.("REDIS_PORT", "6379"),
  password: System.get_env("REDIS_PASSWORD"),
  sentinels: sentinels,
  sentinel_group: env.("REDIS_SENTINEL_GROUP", "sms"),
  sentinel_password: System.get_env("REDIS_SENTINEL_PASSWORD"),
  pool_size: int.("REDIS_POOL_SIZE", "5")

config :sms_core, Sms.Core.ClickHouse,
  hostname: env.("CLICKHOUSE_HOST", "localhost"),
  port: int.("CLICKHOUSE_HTTP_PORT", "8123"),
  database: env.("CLICKHOUSE_DB", "sms_edr"),
  username: env.("CLICKHOUSE_USER", "sms_dev"),
  password: required.("CLICKHOUSE_PASSWORD", "sms_dev_password"),
  pool_size: int.("CLICKHOUSE_POOL_SIZE", "5")

# The other servers' node names (BACKEND_PLAN §3), e.g. "sms@10.0.0.2"; empty on a single node.
# SWITCH_WITNESS (backend step 8) is the witness VM's node, one of the peers: it carries no traffic and breaks the tie
# when the two servers lose each other (Sms.Switch.Vendor.Quorum).
config :sms_core, Sms.Core.Cluster,
  peers: env.("SWITCH_PEERS", "") |> String.split(",", trim: true) |> Enum.map(&String.trim/1),
  witness: System.get_env("SWITCH_WITNESS")

# Which server steps back when the two lose each other (backend step 8, Sms.Switch.Fence): Patroni's /primary on this
# server, and the hook that moves the Redis primary and NATS leadership to the other one.
config :sms_switch, Sms.Switch.Fence,
  primary_url: System.get_env("SWITCH_PRIMARY_URL"),
  hook: System.get_env("SWITCH_FENCE_HOOK")

# The health and metrics endpoint for monitoring (backend step 8): GET /health and /metrics; 0 = off.
config :sms_core, Sms.Core.Http, port: String.to_integer(env.("SWITCH_HTTP_PORT", "0"))

# SWITCH_ROLE=witness (backend step 8): the witness VM runs the release only to join the cluster and break ties; no data
# store, no SMPP, no pipeline.
case env.("SWITCH_ROLE", "switch") do
  "switch" ->
    :ok

  "witness" ->
    config :sms_core, :services, []
    config :sms_switch, :role, :witness

  other ->
    raise ArgumentError, "SWITCH_ROLE must be switch or witness, got #{inspect(other)}"
end

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

    witness? ->
      []

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

# Overload guard (backend step 7, product owner 2026-10-25): new messages are refused with 0x58 while accepted ones wait
# longer than SWITCH_MAX_WAIT_MS for the sender, or more than SWITCH_MAX_BACKLOG are unfinished (a safety cap); 0 = off.
non_negative = fn name, default ->
  case Integer.parse(env.(name, default)) do
    {n, ""} when n >= 0 -> n
    _ -> raise ArgumentError, "#{name} must be 0 or more"
  end
end

config :sms_switch, Sms.Switch.Pipeline.Backlog,
  max: non_negative.("SWITCH_MAX_BACKLOG", "100000"),
  max_wait_ms: non_negative.("SWITCH_MAX_WAIT_MS", "10000")

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

# The API (backend step 9): API_PORT (0 = off, e.g. on the witness), the mock server it forwards unported calls to
# (MOCK_URL, with the shared MOCK_PROXY_SECRET the mock checks), the client address from nginx (TRUST_PROXY=1) and
# Secure cookies behind HTTPS (COOKIE_SECURE=1). API_IP: the address it listens on (127.0.0.1 on the servers, where
# only nginx on the same machine calls it; backend step 14).
api_port = String.to_integer(env.("API_PORT", "0"))
{:ok, api_ip} = :inet.parse_address(String.to_charlist(env.("API_IP", "0.0.0.0")))

config :sms_api, Sms.Api.Endpoint,
  http: [ip: api_ip, port: api_port],
  server: api_port > 0,
  secret_key_base:
    if(api_port > 0,
      do: required.("SECRET_KEY_BASE", String.duplicate("dev-only-not-a-secret-", 3)),
      else: String.duplicate("unused-", 10)
    )

config :sms_api, Sms.Api.Forward,
  url: env.("MOCK_URL", "http://127.0.0.1:4010"),
  secret:
    if(api_port > 0,
      do: required.("MOCK_PROXY_SECRET", "dev-only-proxy-secret"),
      else: System.get_env("MOCK_PROXY_SECRET")
    )

config :sms_api, Sms.Api.Auth, trust_proxy: System.get_env("TRUST_PROXY") == "1"

# Authenticator secrets are stored encrypted by the TypeScript service with MOCK_SECRET_KEY (backend step 12).
config :sms_api, Sms.Api.Secret,
  key:
    if(api_port > 0 and System.get_env("SMS_MODE") == "production",
      do: required.("MOCK_SECRET_KEY", "dev-only-not-a-real-key"),
      else: System.get_env("MOCK_SECRET_KEY", "dev-only-not-a-real-key")
    )

config :sms_api, Sms.Api.Sessions, secure_cookie: System.get_env("COOKIE_SECURE") == "1"

# Production (backend step 11): sign-in codes are queued for the TypeScript service's e-mail job (SMTP).
config :sms_api, Sms.Api.SignIn,
  email_status: if(System.get_env("SMS_MODE") == "production", do: "queued", else: "sent")
