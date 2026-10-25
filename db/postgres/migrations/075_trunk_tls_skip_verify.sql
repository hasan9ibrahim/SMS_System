-- Vendor TLS certificates (backend step 10, decision Q3 2026-10-25). The switch checks a vendor's TLS certificate
-- (trusted CA and matching host name) before it binds; "Skip certificate check" lets a vendor with a self-signed
-- certificate bind. Off by default.

ALTER TABLE vendor_trunks ADD COLUMN IF NOT EXISTS tls_skip_verify boolean NOT NULL DEFAULT false;
