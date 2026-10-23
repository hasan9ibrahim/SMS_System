-- Team trial round 4: our account number for a client (customers and bilateral partners), printed in the invoice
-- header (§7). Optional.
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS account_number text;
