-- Traffic recording (§9, team trial round 1): every SMPP packet is recorded and kept 60 days; a PCAP for a
-- time window and a trunk, IP, number or message ID is cut from it into the Signaling deck's file list.
ALTER TABLE signaling_captures ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'live';
ALTER TABLE signaling_captures ADD COLUMN IF NOT EXISTS recorded_from timestamptz;
ALTER TABLE signaling_captures ADD COLUMN IF NOT EXISTS recorded_to timestamptz;
ALTER TABLE signaling_captures ADD COLUMN IF NOT EXISTS criteria text;
