-- Go-live defaults (backend step 15, product owner 2026-10-26).
-- Incoming RNs (§13.13 A): accepted automatically unless an increase hits live traffic without its notice period, a
-- rate is back-dated or the file has errors (mock/src/api/rn.ts); a rejection is e-mailed to the vendor at once with
-- the reason, on the business company's "Auto upload rejected" template.
ALTER TABLE rn_settings ALTER COLUMN auto_accept SET DEFAULT true;
ALTER TABLE rn_settings ALTER COLUMN reply_rejected SET DEFAULT 'auto';
UPDATE rn_settings SET auto_accept = true, reply_rejected = 'auto' WHERE id = 1;

-- Cleanup Center (§13.19): changes wait for an approval.
ALTER TABLE cleanup_settings ALTER COLUMN require_approval SET DEFAULT true;
