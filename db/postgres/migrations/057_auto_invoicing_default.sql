-- Auto invoicing is on by default for new customer billing (team trial round 2, §7). Existing rows keep theirs.
SET search_path = sms, public;
ALTER TABLE enterprise_billing ALTER COLUMN auto_invoicing SET DEFAULT true;
