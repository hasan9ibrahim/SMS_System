-- Vendor Invoice "Input From/To Date" (spec §7, decided 2026-10-17): the exact window our figures
-- were counted for, kept at every check as UTC instants: midnight of the invoice From date and
-- midnight after the invoice To date, both in the invoice time zone (§13.31). Null = not counted.
SET search_path = sms, public;
ALTER TABLE vendor_invoices
  ADD COLUMN input_from timestamptz,
  ADD COLUMN input_to   timestamptz;
UPDATE vendor_invoices
   SET input_from = period_from::timestamp AT TIME ZONE timezone,
       input_to   = (period_to + 1)::timestamp AT TIME ZONE timezone
 WHERE comparison IN ('match', 'mismatch');
