-- Team trial round 5 (§2, §16): TLS 1.0 offered as a legacy option for partners that cannot move to TLS 1.2 / 1.3.
-- SSLv2 / SSLv3 stay out (broken, removed from current TLS libraries).
ALTER TABLE customer_trunks DROP CONSTRAINT IF EXISTS customer_trunks_ssl_type_check;
ALTER TABLE customer_trunks ADD CONSTRAINT customer_trunks_ssl_type_check
  CHECK (ssl_type IN ('none', 'tls1.0', 'tls1.2', 'tls1.3'));
ALTER TABLE vendor_trunks DROP CONSTRAINT IF EXISTS vendor_trunks_ssl_type_check;
ALTER TABLE vendor_trunks ADD CONSTRAINT vendor_trunks_ssl_type_check
  CHECK (ssl_type IN ('none', 'tls1.0', 'tls1.2', 'tls1.3'));
