-- Incidents (§13.6, team trial round 1): the destinations behind a margin / ASR / DLR incident, shown in
-- its message ("Worst: India (IN) -9.10 EUR"), refreshed every few minutes while it is open.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS breakdown text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS breakdown_at timestamptz;
