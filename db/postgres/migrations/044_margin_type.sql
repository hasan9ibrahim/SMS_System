-- Route rule margin as an amount per message or a percentage of the sell rate (team trial round 1, §6.3).
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS margin_type text NOT NULL DEFAULT 'amount'
  CHECK (margin_type IN ('amount', 'percent'));
