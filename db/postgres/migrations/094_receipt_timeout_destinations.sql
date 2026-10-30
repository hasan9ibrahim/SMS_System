-- Team trial round 12 (§5.3, S-5.10): a vendor trunk's Receipt timeout can apply to some destinations only. The
-- MCCMNC codes it applies to; none = every destination. A message to another destination waits the default 48 hours
-- for its receipt, then gets UNKNOWN.
ALTER TABLE vendor_trunks ADD COLUMN IF NOT EXISTS dlr_timeout_mccmncs text[] NOT NULL DEFAULT '{}';
