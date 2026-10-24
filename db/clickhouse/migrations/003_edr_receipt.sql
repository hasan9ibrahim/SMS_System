-- Receipts as appended rows (docs/BACKEND_PLAN.md §3.2, decided 2026-10-24): the Elixir switch (backend step 4)
-- writes one `edr` row per vendor attempt when it ends, and here one row per receipt from the vendor (kind = vendor)
-- and one when the customer's receipt was delivered or given up (kind = customer). EDR search and reports join them
-- to the attempt by edr_id. Rows are never updated (S-7.3: written again from the event bus after an outage, so the
-- same receipt may appear twice; readers take one per edr_id, part_no, kind and receipt_time).
-- Idempotent: the mock runs these files on start too.
CREATE TABLE IF NOT EXISTS edr_receipt
(
    edr_id                  UUID,
    kind                    LowCardinality(String),       -- vendor / customer
    receipt_time            DateTime64(3, 'UTC'),
    start_time              DateTime64(3, 'UTC'),         -- of the message, for partitions and joins
    c_enterprise_id         UInt32,
    c_trunk_id              UInt32,
    v_trunk_id              UInt32,
    c_message_id            String,
    part_no                 UInt8,
    v_message_id            String,
    msg_status              LowCardinality(String),       -- vendor receipt stat
    delivery_error          LowCardinality(String),
    network_error           UInt16,
    c_msg_status            LowCardinality(String),       -- what the customer was (or will be) told, after DLR maps
    c_delivery_error        LowCardinality(String),
    delivery_delay_ms       UInt32,                       -- from submit to this receipt
    receipt_session_id      String,                       -- §13.1: the session the customer's receipt went out on
    receipt_held_ms         UInt32,                       -- §13.1: how long it waited for a session
    is_late                 UInt8,                        -- after the DLR timeout (S-5.10)
    is_duplicate            UInt8,                        -- a second final status (S-5.8): recorded, not forwarded
    source                  LowCardinality(String)        -- vendor / switch (a receipt the switch made)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(start_time)
ORDER BY (toDate(start_time), c_enterprise_id, c_trunk_id, start_time, edr_id)
SETTINGS index_granularity = 8192;
