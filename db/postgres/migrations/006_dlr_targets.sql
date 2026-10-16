-- DLR targets (decided 2026-10-16: per rule or per destination for now; the traffic alert
-- thresholds of §13.6 take over when alerts exist). The Route Rules grid shows a rule's DLR
-- in amber when it is below its target (§15.4).
SET search_path = sms, public;

-- Target for a destination: a country-level code covers its networks unless a network has its own.
ALTER TABLE mccmnc ADD COLUMN dlr_target_pct numeric(5, 1) CHECK (dlr_target_pct BETWEEN 0 AND 100);

-- A rule's own target overrides its destinations' targets.
ALTER TABLE route_rules ADD COLUMN dlr_target_pct numeric(5, 1) CHECK (dlr_target_pct BETWEEN 0 AND 100);
