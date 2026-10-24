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

# The message pipeline (build step 4, Sms.Switch.Pipeline): routing configuration in memory, the vendor leg,
# receipts and EDRs. `node_id` (SWITCH_NODE_ID) makes each server's message ids unique; `vendor_wait_ms` is how long
# a message waits for a vendor's TPS slot or window before trying the next vendor; `credit` checks the customer's
# credit before the message is accepted (balances come with build step 6).
config :sms_switch, Sms.Switch.Pipeline,
  enabled: true,
  node_id: 0,
  platform_currency: "EUR",
  vendor_wait_ms: 10_000,
  credit: Sms.Switch.Pipeline.Credit.Open

# What the pipeline keeps about messages in flight is shared by both servers through Redis (§13.1).
config :sms_switch, Sms.Switch.Pipeline.Store, backend: :redis

# The customer side of the switch (build step 2, Sms.Switch.Customer): listeners and ports come from the environment
# in config/runtime.exs; timeouts and windows are in Sms.Switch.Customer.Session. Submits go to the pipeline.
config :sms_switch, Sms.Switch.Customer, enabled: true, intake: Sms.Switch.Pipeline.Intake

# The vendor side (build step 3, Sms.Switch.Vendor): connections come from the vendor trunks; timeouts and TLS
# certificate checks are in Sms.Switch.Vendor.Session. Receipts go to the pipeline.
config :sms_switch, Sms.Switch.Vendor, enabled: true, receipts: Sms.Switch.Pipeline.Receipts

# Failed binds counted by the Firewall filters (spec §8) are shared by both servers through Redis.
config :sms_switch, Sms.Switch.Customer.Firewall, backend: :redis

# TPS limits shared by both servers through Redis (decision Q13), for customer and vendor trunks alike; per server,
# divided by the cluster size, while Redis is unavailable (S-7.4).
config :sms_switch, Sms.Switch.Throttle,
  backend: :redis,
  cluster_size: 2,
  redis_timeout_ms: 50,
  retry_redis_after_ms: 1_000

config :logger, :default_formatter,
  format: "$date $time [$level] $metadata$message\n",
  metadata: [
    :event_id,
    :subject,
    :consumer,
    :reason,
    :session_id,
    :trunk_id,
    :peer,
    :vendor_trunk_id,
    :connection,
    :events
  ]

import_config "#{config_env()}.exs"
