-- Business company (§11, team trial round 1): which department mailbox sends each kind of e-mail.
-- Keys are the contract's SenderEmail values; a missing key uses the default department (rates, noc, billing).
ALTER TABLE business_companies ADD COLUMN IF NOT EXISTS senders jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The shared Invoice template carries the invoice figures and the issuing business company's bank account,
-- so each entity's invoices show its own bank (§11). Only while nobody has edited the template.
UPDATE email_templates
   SET subject = 'Invoice {invoice_no} for {from} to {to} – {company}',
       body = E'Dear {enterprise} team,\n\nPlease find attached invoice {invoice_no} for {from} to {to}.\nAmount due: {due_amount} {currency}, payable by {due_date}.\n\nPayment details:\n{bank_details}\n\nPlease quote the invoice number with your payment.\n\nKind regards,\nBilling team, {company}'
 WHERE name = 'Invoice – standard' AND email_type = 'invoice'
   AND body = E'Dear {enterprise} team,\n\nPlease find attached your invoice.\n\nKind regards,\nBilling team, {company}';
