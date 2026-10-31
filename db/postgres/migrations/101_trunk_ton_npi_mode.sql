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
