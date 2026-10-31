-- SMS to voice (§8, decided 2026-10-31): an attempt that was a call (route_type 'voice') records which voice gateway
-- placed it, whether it was answered, the SIP-level end and how long it lasted. Add only; the code read out is never
-- stored in these columns.
ALTER TABLE edr ADD COLUMN IF NOT EXISTS voice_gateway_id UInt32 DEFAULT 0;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS voice_answered UInt8 DEFAULT 0;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS voice_hangup_cause String DEFAULT '';
ALTER TABLE edr ADD COLUMN IF NOT EXISTS voice_duration_ms UInt32 DEFAULT 0;
