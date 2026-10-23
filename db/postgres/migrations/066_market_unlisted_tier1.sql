-- Team trial round 5 (§13.14): destinations without a hand-picked top vendor list use their Tier 1 vendors by
-- default; with fewer Tier 1 vendors than the minimum, the destination is not watched.
ALTER TABLE market_move_settings DROP CONSTRAINT IF EXISTS market_move_settings_unlisted_mode_check;
ALTER TABLE market_move_settings ALTER COLUMN unlisted_mode SET DEFAULT 'tier1';
ALTER TABLE market_move_settings ADD CONSTRAINT market_move_settings_unlisted_mode_check
  CHECK (unlisted_mode IN ('tier1', 'cheapest', 'skip'));
UPDATE market_move_settings SET unlisted_mode = 'tier1' WHERE unlisted_mode = 'cheapest';
