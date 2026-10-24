import Config

# JSON log lines for the log shipper; three copies of every event across the 2 servers + witness.
config :logger, level: :info

config :logger, :default_handler,
  formatter: {LoggerJSON.Formatters.Basic, metadata: [:event_id, :subject, :consumer, :reason]}

config :sms_core, Sms.Core.Bus, replicas: 3
