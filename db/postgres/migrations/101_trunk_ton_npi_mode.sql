-- TON / NPI per trunk (docs/SMPP_SCENARIOS.md S-4.7, §5.4, §5.5): 'as_sent' keeps the source and destination TON / NPI
-- as the message has them (an unfit sender after translation is refused 0x0A, or the vendor passed over); 'auto' sets
-- them from the address after the trunk's translation (ingress on a customer trunk, egress on a vendor trunk). Every
-- trunk, new or existing, starts on 'as_sent', the behaviour so far.
SET search_path = sms, public;

ALTER TABLE customer_trunks ADD COLUMN IF NOT EXISTS ton_npi_mode text NOT NULL DEFAULT 'as_sent';
ALTER TABLE customer_trunks DROP CONSTRAINT IF EXISTS customer_trunks_ton_npi_mode_check;
ALTER TABLE customer_trunks ADD CONSTRAINT customer_trunks_ton_npi_mode_check CHECK (ton_npi_mode IN ('as_sent', 'auto'));

ALTER TABLE vendor_trunks ADD COLUMN IF NOT EXISTS ton_npi_mode text NOT NULL DEFAULT 'as_sent';
ALTER TABLE vendor_trunks DROP CONSTRAINT IF EXISTS vendor_trunks_ton_npi_mode_check;
ALTER TABLE vendor_trunks ADD CONSTRAINT vendor_trunks_ton_npi_mode_check CHECK (ton_npi_mode IN ('as_sent', 'auto'));

-- Refuse invalid senders per vendor trunk (S-2.10, S-4.7): on, a sender a handset cannot show (alphanumeric over 11
-- characters or not printable ASCII, a number over 20 digits) is not sent to this vendor; off, it takes such a sender
-- as it is. On for every trunk, new or existing: the behaviour so far.
ALTER TABLE vendor_trunks ADD COLUMN IF NOT EXISTS refuse_invalid_senders boolean NOT NULL DEFAULT true;
