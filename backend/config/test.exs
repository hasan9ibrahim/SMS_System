import Config

# Unit tests start no data store; tests tagged :integration start what they need (test/support).
config :sms_core, :services, []
config :sms_core, Sms.Core.Bus, adapter: Sms.Core.Bus.Local

config :logger, level: :warning

# Tests start each side themselves (test/support/customer_case.ex, vendor_case.ex) and count TPS in memory.
config :sms_switch, Sms.Switch.Customer, enabled: false
config :sms_switch, Sms.Switch.Vendor, enabled: false
config :sms_switch, Sms.Switch.Pipeline, enabled: false, vendor_wait_ms: 200
config :sms_switch, Sms.Switch.Pipeline.Store, backend: :local
config :sms_switch, Sms.Switch.Throttle, backend: :local
config :sms_switch, Sms.Switch.Customer.Firewall, backend: :local
