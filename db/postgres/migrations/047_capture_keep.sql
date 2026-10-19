-- Signaling captures (§9, team trial round 1): capture files are deleted 30 days after they end unless
-- someone ticks Keep (e.g. during a dispute).
ALTER TABLE signaling_captures ADD COLUMN IF NOT EXISTS keep boolean NOT NULL DEFAULT false;
ALTER TABLE signaling_captures ADD COLUMN IF NOT EXISTS kept_by_id bigint REFERENCES users(id);
ALTER TABLE signaling_captures ADD COLUMN IF NOT EXISTS kept_at timestamptz;
