-- Translation rules (team trial round 2, §6.4, §13.2): an MCCMNC regex beside the picked networks (as on route
-- rules), and Is Continue off by default for a new rule.
SET search_path = sms, public;

ALTER TABLE translation_rules ADD COLUMN IF NOT EXISTS mccmnc_pattern text;
ALTER TABLE translation_rules ALTER COLUMN continue_after SET DEFAULT false;
