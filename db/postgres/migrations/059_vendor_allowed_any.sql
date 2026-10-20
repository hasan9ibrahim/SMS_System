-- Vendor trunk "Any" for allowed data codings, TON, NPI and max message length (team trial round 2, §5.5): NULL = no restriction.
-- A new trunk allows any data coding, source TON and source NPI; destination TON/NPI keep the default {1}.
-- Max message length: NULL = any length (new default). Existing trunks keep their values.
SET search_path = sms, public;

ALTER TABLE vendor_trunks ALTER COLUMN allowed_data_codings DROP NOT NULL, ALTER COLUMN allowed_data_codings SET DEFAULT NULL;
ALTER TABLE vendor_trunks ALTER COLUMN allowed_src_ton DROP NOT NULL, ALTER COLUMN allowed_src_ton SET DEFAULT NULL;
ALTER TABLE vendor_trunks ALTER COLUMN allowed_src_npi DROP NOT NULL, ALTER COLUMN allowed_src_npi SET DEFAULT NULL;
ALTER TABLE vendor_trunks ALTER COLUMN allowed_dst_ton DROP NOT NULL;
ALTER TABLE vendor_trunks ALTER COLUMN allowed_dst_npi DROP NOT NULL;
ALTER TABLE vendor_trunks ALTER COLUMN max_msg_len DROP NOT NULL, ALTER COLUMN max_msg_len SET DEFAULT NULL;
