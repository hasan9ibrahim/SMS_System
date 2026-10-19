-- Team trial round 1 (build step 6, 2026-10-18): trunk defaults agreed by the team.
-- A trunk has 2 sessions by default, each up to 50 TPS (tps is per session; the trunk's total is
-- tps × max_connections), and an overflow buffer of 10,000 messages.
SET search_path = sms, public;

ALTER TABLE customer_trunks ALTER COLUMN max_connections SET DEFAULT 2,
                            ALTER COLUMN tps SET DEFAULT 50,
                            ALTER COLUMN overflow_buffer SET DEFAULT 10000;
ALTER TABLE vendor_trunks ALTER COLUMN max_connections SET DEFAULT 2,
                          ALTER COLUMN tps SET DEFAULT 50,
                          ALTER COLUMN overflow_buffer SET DEFAULT 10000;
COMMENT ON COLUMN customer_trunks.tps IS 'Messages per second per session (bind); trunk total = tps * max_connections';
COMMENT ON COLUMN vendor_trunks.tps IS 'Messages per second per session (bind); trunk total = tps * max_connections';
