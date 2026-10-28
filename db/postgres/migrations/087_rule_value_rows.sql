-- Sender ID and receiver values as rows (team trial round 8, §6.3, §6.4): each value with its own match
-- (is / starts / contains) and case. [{value, match, matchCase}], camelCase keys as the screens save them.
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS sender_values jsonb NOT NULL DEFAULT '[]';
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS receiver_values jsonb NOT NULL DEFAULT '[]';
ALTER TABLE translation_rules ADD COLUMN IF NOT EXISTS sender_values jsonb NOT NULL DEFAULT '[]';
ALTER TABLE translation_rules ADD COLUMN IF NOT EXISTS receiver_values jsonb NOT NULL DEFAULT '[]';
