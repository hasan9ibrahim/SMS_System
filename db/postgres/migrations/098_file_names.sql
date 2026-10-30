-- File names of the files partners receive (team trial round 12, §11): besides the Customer Rate File Name, the
-- business company sets the SOA and invoice file names, with [Key] / {Key} variables (mock/src/billing/fileNames.ts).
ALTER TABLE business_companies ADD COLUMN IF NOT EXISTS soa_file_name text;
ALTER TABLE business_companies ADD COLUMN IF NOT EXISTS invoice_file_name text;
