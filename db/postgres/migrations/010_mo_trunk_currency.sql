-- MO reference book (§6.1, decided 2026-10-17): amounts are in the customer trunk's currency
-- (its first rate table's, else the enterprise's customer billing currency), so the entry no
-- longer stores its own.
SET search_path = sms, public;

ALTER TABLE mo_numbers DROP COLUMN currency;
