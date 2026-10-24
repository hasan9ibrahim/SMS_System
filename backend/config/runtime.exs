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
