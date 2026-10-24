-- Switch settings for backend build step 5 (docs/SMPP_SCENARIOS.md; contract v0.94.0), each "set per trunk" in the
-- scenarios: multipart reassembly timeout (S-3.2, D1), duplicate filter window (S-2.7, D6), empty messages (D10)
-- on customer trunks; the multipart format sent to each vendor (S-3.10).
ALTER TABLE customer_trunks
  ADD COLUMN IF NOT EXISTS reassembly_timeout_s integer NOT NULL DEFAULT 120 CHECK (reassembly_timeout_s BETWEEN 10 AND 600),
  ADD COLUMN IF NOT EXISTS duplicate_window_s integer NOT NULL DEFAULT 60 CHECK (duplicate_window_s BETWEEN 0 AND 3600),
  ADD COLUMN IF NOT EXISTS allow_empty_messages boolean NOT NULL DEFAULT false;

ALTER TABLE vendor_trunks
  ADD COLUMN IF NOT EXISTS multipart_format text NOT NULL DEFAULT 'udh8'
    CHECK (multipart_format IN ('udh8', 'udh16', 'sar', 'payload'));
