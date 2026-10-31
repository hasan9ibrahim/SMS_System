-- EDR rows written twice (QA 2026-10-31, S-7.3, §9.1). Idempotent: the mock runs these files on start too, and the
-- deploy on every release (Sms.Core.Release.migrate).
--
-- The switch's EDR writer (Sms.Switch.Pipeline.EdrWriter) takes its rows from the bus. When an insert outlasted the
-- bus's ack wait, the bus handed the batch out again and its rows were stored twice; the materialized views (001,
-- 005, 008) counted them twice too, so reports, invoices and balances were too high. Four guards:
--
--   * row_key: the row's key on the bus, kept as a column (empty on rows written before this): `<edr_id>:<attempt
--     no>` on attempt rows, `<edr_id>:<kind>:<part>:<receipt time>:<status>` on receipt rows. Before each insert the
--     writer looks up which keys of its batch the same days already hold (one query, through the bloom filter below)
--     and leaves those rows out.
--   * Each insert carries an insert_deduplication_token made from the bus sequence numbers of its rows, with
--     deduplicate_blocks_in_dependent_materialized_views = 1: a batch handed out again while the first insert of it
--     is still running is dropped by ClickHouse, in these tables and in the totals their views feed. On a plain
--     MergeTree (development, CI) that needs non_replicated_deduplication_window on the tables; on the servers the
--     tables are Replicated (deploy/ansible/roles/clickhouse) and deduplicate by default (the setting is kept but not
--     used there). The window is the last 1000 inserts of each table. An identical block inserted again without a
--     token is dropped too, as the Replicated tables always did; in ClickHouse 24.8 the views still count such a
--     block unless the insert sends deduplicate_blocks_in_dependent_materialized_views = 1, so every EDR insert does
--     (the switch's writer, and the mock's chQuery).
--   * Readers that list single rows (EDR Search, Failed EDRs, the portal's messages) take one row per non-empty key.
--   * A nightly job (mock/src/jobs/edrRepair.ts) removes copies left in the last days and puts the totals right.
ALTER TABLE edr ADD COLUMN IF NOT EXISTS row_key String DEFAULT '' AFTER edr_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS row_key String DEFAULT '' AFTER edr_id;
ALTER TABLE edr ADD INDEX IF NOT EXISTS idx_row_key row_key TYPE bloom_filter(0.001) GRANULARITY 1;
ALTER TABLE edr_receipt ADD INDEX IF NOT EXISTS idx_row_key row_key TYPE bloom_filter(0.001) GRANULARITY 1;

ALTER TABLE edr MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE edr_receipt MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE edr_hourly MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE edr_totals MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE edr_sender_daily MODIFY SETTING non_replicated_deduplication_window = 1000;

-- The repair job takes the copies it removes out of the totals with negative rows, as 009 did for edr_totals and
-- edr_sender_daily: the hourly figures' counters become signed too.
ALTER TABLE edr_hourly MODIFY COLUMN attempts Int64, MODIFY COLUMN final_attempts Int64, MODIFY COLUMN submitted Int64,
    MODIFY COLUMN delivered Int64, MODIFY COLUMN reported Int64, MODIFY COLUMN billable_c Int64,
    MODIFY COLUMN billable_v Int64, MODIFY COLUMN messages Int64, MODIFY COLUMN delay_ms_sum Int64,
    MODIFY COLUMN hlr_live Int64, MODIFY COLUMN hlr_cached Int64, MODIFY COLUMN hlr_ported Int64;

-- What each run of the repair job found and did, for the log and for the next run: a run that stopped after removing
-- copies (status 'started' with no later 'done') has its totals put right by the next one. Kept a year.
CREATE TABLE IF NOT EXISTS edr_repair_runs
(
    run_id                  UUID,
    run_at                  DateTime64(3, 'UTC'),
    status                  LowCardinality(String),       -- started / done / failed
    table_name              LowCardinality(String),       -- edr / edr_receipt; '' on the run's summary row
    day                     Date,
    row_keys                Array(String),                -- keys found with more than one row
    keys_found              UInt64,
    rows_removed            UInt64,
    totals_rows             UInt64,                       -- compensating rows written to the totals
    keys_left               UInt64,                       -- still more than one row after the run (retried next run)
    message                 String
)
ENGINE = MergeTree
ORDER BY (run_at, run_id)
TTL toDateTime(run_at) + INTERVAL 1 YEAR;
