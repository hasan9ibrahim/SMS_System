# Configuration for every app in the umbrella (spec §14). Secrets and hosts come from the environment in
# config/runtime.exs; nothing secret is ever written here.
import Config

config :sms_core, ecto_repos: [Sms.Core.Repo]

# The data stores and the event bus this node starts (Sms.Core.Application). Tests start them one by one.
config :sms_core, :services, [:repo, :redis, :clickhouse, :bus]

# Event bus (docs/BACKEND_PLAN.md: NATS JetStream behind one module). Every event goes to one stream, "SMS".
config :sms_core, Sms.Core.Bus,
  adapter: Sms.Core.Bus.Nats,
  stream: "SMS",
  subjects: ["sms.>"],
  # A message published twice with the same id within this window is stored once.
  duplicate_window_ms: 120_000,
  max_age_days: 7,
  replicas: 1,
  publish_timeout_ms: 5_000,
  # At start, how many times (1 s apart) to try reaching NATS before the node gives up.
  setup_attempts: 30

config :logger, :default_formatter,
  format: "$date $time [$level] $metadata$message\n",
  metadata: [:event_id, :subject, :consumer, :reason]

import_config "#{config_env()}.exs"
