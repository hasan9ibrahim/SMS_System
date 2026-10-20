-- Both sides of every translatable field (team trial round 2, §6.4, §9): what the customer sent us and what we
-- sent the vendor after translation rules. Customer side: src_addr, dst_addr, message_text, c_src_ton/npi,
-- c_dst_ton/npi, c_coding, registered_delivery, c_msg_status, c_delivery_error. Vendor side: v_src_addr,
-- routed_dst_addr, v_message_text, v_src_ton/npi, v_dst_ton/npi, v_coding, v_registered_delivery, msg_status,
-- delivery_error. A missing value means no rule changed it (the default copies the customer side).
-- Idempotent: the mock runs these files on start too.
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_src_addr String DEFAULT src_addr AFTER routed_dst_addr;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_message_text String DEFAULT message_text AFTER message_text;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_src_ton UInt8 DEFAULT c_src_ton AFTER c_dst_npi;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_src_npi UInt8 DEFAULT c_src_npi AFTER v_src_ton;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_dst_ton UInt8 DEFAULT c_dst_ton AFTER v_src_npi;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_dst_npi UInt8 DEFAULT c_dst_npi AFTER v_dst_ton;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_coding UInt8 DEFAULT c_coding AFTER c_coding;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_registered_delivery UInt8 DEFAULT registered_delivery AFTER registered_delivery;
ALTER TABLE edr ADD COLUMN IF NOT EXISTS c_delivery_error LowCardinality(String) DEFAULT delivery_error AFTER delivery_error;
