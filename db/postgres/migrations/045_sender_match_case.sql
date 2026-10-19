-- Match case for Sender ID conditions on route rules (§6.3) and translation rules (§6.4) (team trial round 1):
-- on = the sender pattern and list entries must match the exact capitals, off = any case. On by default.
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS sender_match_case boolean NOT NULL DEFAULT true;
ALTER TABLE translation_rules ADD COLUMN IF NOT EXISTS sender_match_case boolean NOT NULL DEFAULT true;
