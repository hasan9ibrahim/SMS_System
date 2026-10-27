-- Warm-up Reset (team trial round 6, §13.27): when someone last started a route rule vendor's warm-up count again.
-- The switch keys the count by its period and this time, so saving the rule never restarts it.
ALTER TABLE route_rule_vendors ADD COLUMN IF NOT EXISTS warmup_reset_at timestamptz;
