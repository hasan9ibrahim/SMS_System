import Config

# Unit tests start no data store; tests tagged :integration start what they need (test/support).
config :sms_core, :services, []
config :sms_core, Sms.Core.Bus, adapter: Sms.Core.Bus.Local

config :logger, level: :warning
