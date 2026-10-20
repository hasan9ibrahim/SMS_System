-- Vendor bind policy per trunk (team trial round 2, §5.5, SMPP v3.4 session timers): an active vendor trunk binds
-- all Max Connections sessions when activated or saved and keeps them up; idle sessions send enquire_link every
-- enquire_link_interval_s and a missing answer within enquire_link_timeout_s drops the session; dropped or refused
-- binds are retried after reconnect_schedule_s (the last value repeats); a wrong password / system ID waits
-- auth_fail_retry_min; the Bind Down Alert waits bind_alert_after_min.
SET search_path = sms, public;

ALTER TABLE vendor_trunks ADD COLUMN IF NOT EXISTS enquire_link_interval_s int NOT NULL DEFAULT 30
  CHECK (enquire_link_interval_s BETWEEN 5 AND 3600);
ALTER TABLE vendor_trunks ADD COLUMN IF NOT EXISTS reconnect_schedule_s int[] NOT NULL DEFAULT '{5,10,30,60}';
ALTER TABLE vendor_trunks ADD COLUMN IF NOT EXISTS bind_alert_after_min int NOT NULL DEFAULT 2
  CHECK (bind_alert_after_min BETWEEN 1 AND 1440);
ALTER TABLE vendor_trunks ADD COLUMN IF NOT EXISTS auth_fail_retry_min int NOT NULL DEFAULT 15
  CHECK (auth_fail_retry_min BETWEEN 1 AND 1440);
