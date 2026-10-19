-- Live dashboard (build step 4.6, spec §13.3): time window, thresholds and panels saved per user.
SET search_path = sms, public;

ALTER TABLE users ADD COLUMN dashboard_settings jsonb;
