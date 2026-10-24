-- Backend build step 5. Idempotent: the mock runs these files on start too.
--
-- Receipts that come after a message left the switch's Redis (D5, S-5.10): the DLR timeout already answered the
-- customer, or the message was finished and a vendor sent its receipt again. The switch finds the attempt by vendor
-- trunk and the vendor's normalised message ids, and writes the receipt as a late (or duplicate) edr_receipt row.
ALTER TABLE edr ADD COLUMN IF NOT EXISTS v_message_keys Array(String) DEFAULT [] AFTER v_message_id;
ALTER TABLE edr ADD INDEX IF NOT EXISTS idx_v_message_keys v_message_keys TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE edr_receipt ADD INDEX IF NOT EXISTS idx_edr_id edr_id TYPE bloom_filter(0.01) GRANULARITY 1;

-- A message the switch put together from a customer's parts (S-3.2) is one attempt with every part's message id
-- here; c_message_id keeps the first.
ALTER TABLE edr ADD COLUMN IF NOT EXISTS c_message_ids Array(String) DEFAULT [] AFTER c_message_id;
