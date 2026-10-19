-- Team trial round 1 (§6.3): Quality rules rank vendors by weights in %; null = ASR 35, DLR 35, delay 20, cost 10.
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS qbr_weights jsonb;
