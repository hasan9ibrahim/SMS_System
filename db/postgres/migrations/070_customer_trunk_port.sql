-- Customer trunk port fixed by its connection type (product owner, 2026-10-24; spec §5.4, §2): every customer binds on
-- 2775 (Non secure) or 2776 (TLS), so the port is no longer typed in. The column stays, worked out from ssl_type, so
-- reads (the form, Send Tech Info, exports, the switch) keep working and it can never disagree with the SSL setting.
ALTER TABLE customer_trunks DROP COLUMN port;
ALTER TABLE customer_trunks
  ADD COLUMN port integer GENERATED ALWAYS AS (CASE WHEN ssl_type = 'none' THEN 2775 ELSE 2776 END) STORED;
COMMENT ON COLUMN customer_trunks.port IS 'SMPP port the customer binds on: 2775 for ssl_type none, 2776 for TLS (generated)';
