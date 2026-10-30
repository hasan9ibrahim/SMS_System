-- Team trial round 12 (§5.1, §5.3, §13.13).
-- The custom "all networks" code takes any symbol but a space after MCC, up to 10.
ALTER TABLE enterprises DROP CONSTRAINT IF EXISTS enterprises_all_networks_code_check;
ALTER TABLE enterprises ADD CONSTRAINT enterprises_all_networks_code_check
  CHECK (all_networks_code ~ '^(mcc|mcc0|mcc00|mcc000|mccStar|MCC\S{1,10})$');
-- The beneficiary's account currency is picked from the system's or typed, not only 3 letters (e.g. USDT): it is the
-- bank account's currency as written on invoices, not a currency the platform bills in.
ALTER TABLE enterprise_beneficiaries DROP CONSTRAINT IF EXISTS enterprise_beneficiaries_currency_fkey;
ALTER TABLE enterprise_beneficiaries ALTER COLUMN currency TYPE varchar(20) USING trim(currency);
