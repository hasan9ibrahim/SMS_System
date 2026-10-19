-- One-time data upgrades already built into a fresh seed (team trial round 1), so the upgrade scripts in
-- db/postgres/upgrades never apply them twice. A fresh seed stores route rule priorities high-first.
CREATE TABLE IF NOT EXISTS upgrade_marks (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO upgrade_marks (name) VALUES ('priority_high_first') ON CONFLICT DO NOTHING;
