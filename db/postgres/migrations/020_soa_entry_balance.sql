-- Manual SOA entries (spec §13.31, decided 2026-10-17): either on the SOA only, or changing the
-- balance by recording a real transaction, which the entry keeps a link to (taking the entry back
-- deletes the transaction).
SET search_path = sms, public;
ALTER TABLE soa_adjustments
  ADD COLUMN affects_balance boolean NOT NULL DEFAULT false,
  ADD COLUMN transaction_id bigint REFERENCES transactions(id);
