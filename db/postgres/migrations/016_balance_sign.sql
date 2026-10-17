-- Balance sign (spec §7, decided 2026-10-17): Balance = Opening Balance + payments and credits −
-- usage charges, so a positive balance is the partner's credit and a negative one is what is
-- owed. Opening balances were entered the other way round (positive = owed); flip them once.
SET search_path = sms, public;
UPDATE enterprise_billing SET opening_balance = -opening_balance WHERE opening_balance <> 0;
