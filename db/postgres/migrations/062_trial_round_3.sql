-- Team trial round 3: Live analytics columns per user (§13.4).
SET search_path = sms, public;

ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_settings jsonb;

-- The partner's "all networks" code may be any MCC + suffix form, e.g. MCC99 (§13.13, §13.14).
ALTER TABLE enterprises DROP CONSTRAINT IF EXISTS enterprises_all_networks_code_check;
ALTER TABLE enterprises ADD CONSTRAINT enterprises_all_networks_code_check
  CHECK (all_networks_code ~ '^(mcc|mcc0|mcc00|mcc000|mccStar|MCC[0-9A-Za-z*#._-]{1,6})$');
