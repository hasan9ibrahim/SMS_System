-- Runs once, on first start of an empty volume (docker-entrypoint-initdb.d).
-- The database itself is created from CLICKHOUSE_DB. The EDR table (spec §9.1 schema)
-- and the pre-computed report summaries (spec §14.2) come with the data generator in
-- build-order step 2, under db/clickhouse/migrations/.
SELECT 1;
