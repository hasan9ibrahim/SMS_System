-- Enterprise report time zone (build step 4.5, contract v0.8.0, spec §13.31): each trunk may
-- have its own billing time zone; NULL = its enterprise's billing_timezone.
SET search_path = sms, public;

ALTER TABLE customer_trunks ADD COLUMN billing_timezone text;
ALTER TABLE vendor_trunks ADD COLUMN billing_timezone text;
