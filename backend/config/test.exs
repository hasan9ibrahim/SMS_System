import Config

# Unit tests start no data store; tests tagged :integration start what they need (test/support).
config :sms_core, :services, []
config :sms_core, Sms.Core.Bus, adapter: Sms.Core.Bus.Local

config :logger, level: :warning

# Tests start each side themselves (test/support/customer_case.ex, vendor_case.ex) and count TPS in memory.
config :sms_switch, Sms.Switch.Customer, enabled: false
config :sms_switch, Sms.Switch.Vendor, enabled: false
config :sms_switch, Sms.Switch.Pipeline, enabled: false, vendor_wait_ms: 200, late_wait_ms: 0
config :sms_switch, Sms.Switch.Pipeline.Store, backend: :local
# The tests' fake HLR provider listens on 127.0.0.1 (production refuses private addresses).
config :sms_switch, Sms.Switch.Pipeline.Hlr.Http, allow_private_hosts: true
config :sms_switch, Sms.Switch.Throttle, backend: :local
config :sms_switch, Sms.Switch.Customer.Firewall, backend: :local

# The sign-in tests share 127.0.0.1; the code and resend calls count too (security audit, team trial round 12).
config :sms_api, Sms.Api.RateLimit, limit: 1_000, window_s: 60
