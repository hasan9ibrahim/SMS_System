-- Long-term report totals (product owner 2026-10-27, docs/BACKEND_PLAN.md §3.7). Idempotent: the mock runs these files
-- on start too.
--
-- Detailed EDRs are kept 12 months (6 on the servers, 6 more on S3); every figure on the reports stays right forever.
-- Reports read edr_all while their period is within the detailed months, and these totals for anything older:
--
--   * edr_totals: edr_all rows summed per 15 minutes (any time zone's days, hours and quarter-hour bounds) and per
--     every column a report groups, filters or multiplies by: partners, trunks, AMs, destinations, route, rate
--     tables, rates, currencies and exchange rates, statuses, cause codes, billable flags, HLR. `start_time` and
--     `submit_time` hold the quarter hours of each, so a report's SQL keeps its column names; a count over edr_all
--     is sum(rows) here, and sum(x * key) stays exact because the key is the same on every row summed.
--   * edr_sender_daily: the same by UTC day with both Sender IDs, for Sender ID reports (product owner 2026-10-27:
--     sender totals per day).
--
-- Not kept past the detailed months: the EDRs themselves (search, downloads, repush, re-rating), IPs, seconds and
-- minutes. Rows are added as EDRs are written (materialized views); deleting EDRs never touches them.

CREATE TABLE IF NOT EXISTS edr_totals
(
    start_time              DateTime('UTC'),              -- quarter hour the message arrived
    submit_time             DateTime('UTC'),              -- quarter hour it was sent to the vendor
    kind                    LowCardinality(String),       -- attempt / outcome, as in edr_all
    msg_type                Enum8('MT' = 1, 'MO' = 2),
    internal_kind           LowCardinality(String),
    business_company_id     UInt32,
    product_category_id     UInt32,
    c_enterprise_id         UInt32,
    c_trunk_id              UInt32,
    c_am_user_id            UInt32,
    v_enterprise_id         UInt32,
    v_trunk_id              UInt32,
    v_am_user_id            UInt32,
    c_mccmnc                LowCardinality(String),
    c_mcc                   LowCardinality(String),
    c_country_iso           LowCardinality(String),
    v_mccmnc                LowCardinality(String),
    route_rule_id           UInt32,
    route_type              LowCardinality(String),
    c_rate_table_id         UInt32,
    v_rate_table_id         UInt32,
    c_rate                  Decimal(12, 6),
    v_rate                  Decimal(12, 6),
    c_currency              LowCardinality(String),
    c_ex_rate               Decimal(18, 8),
    v_currency              LowCardinality(String),
    v_ex_rate               Decimal(18, 8),
    attempt_no              UInt8,
    is_final_attempt        UInt8,
    is_submit_success       UInt8,
    command_status          Int16,
    dlr_reroute             UInt8,
    msg_status              LowCardinality(String),
    c_msg_status            LowCardinality(String),
    is_customer_billable    UInt8,
    is_vendor_billable      UInt8,
    hlr_provider_id         UInt32,
    hlr_fetch_type          LowCardinality(String),
    hlr_is_ported           UInt8,
    hlr_is_accomplished     UInt8,
    neg_margin              UInt8,                        -- revenue_sys < cost_sys on the row (billing report)
    -- summed
    rows                    UInt64,                       -- edr_all rows: count() there is sum(rows) here
    msg_count               UInt64,
    delivery_delay_ms       UInt64,
    revenue                 Decimal(18, 6),
    cost                    Decimal(18, 6),
    revenue_sys             Decimal(18, 6),
    cost_sys                Decimal(18, 6),
    hlr_cost_sys            Decimal(18, 6)
)
ENGINE = SummingMergeTree((rows, msg_count, delivery_delay_ms, revenue, cost, revenue_sys, cost_sys, hlr_cost_sys))
PARTITION BY toYYYYMM(start_time)
PRIMARY KEY (start_time, c_enterprise_id, c_trunk_id)
ORDER BY (start_time, c_enterprise_id, c_trunk_id, v_enterprise_id, v_trunk_id, c_mccmnc, v_mccmnc, submit_time,
          kind, msg_type, internal_kind, business_company_id, product_category_id, c_am_user_id, v_am_user_id, c_mcc,
          c_country_iso, route_rule_id, route_type, c_rate_table_id, v_rate_table_id, c_rate, v_rate, c_currency,
          c_ex_rate, v_currency, v_ex_rate, attempt_no, is_final_attempt, is_submit_success, command_status,
          dlr_reroute, msg_status, c_msg_status, is_customer_billable, is_vendor_billable, hlr_provider_id,
          hlr_fetch_type, hlr_is_ported, hlr_is_accomplished, neg_margin);

CREATE TABLE IF NOT EXISTS edr_sender_daily
(
    start_time              DateTime('UTC'),              -- UTC day the message arrived
    src_addr                String,                       -- Sender ID from the customer
    v_src_addr              String,                       -- Sender ID sent to the vendor
    kind                    LowCardinality(String),
    msg_type                Enum8('MT' = 1, 'MO' = 2),
    internal_kind           LowCardinality(String),
    business_company_id     UInt32,
    product_category_id     UInt32,
    c_enterprise_id         UInt32,
    c_trunk_id              UInt32,
    c_am_user_id            UInt32,
    v_enterprise_id         UInt32,
    v_trunk_id              UInt32,
    v_am_user_id            UInt32,
    c_mccmnc                LowCardinality(String),
    c_country_iso           LowCardinality(String),
    v_mccmnc                LowCardinality(String),
    attempt_no              UInt8,
    is_submit_success       UInt8,
    dlr_reroute             UInt8,
    msg_status              LowCardinality(String),
    c_msg_status            LowCardinality(String),
    is_customer_billable    UInt8,
    is_vendor_billable      UInt8,
    hlr_fetch_type          LowCardinality(String),
    hlr_is_ported           UInt8,
    hlr_is_accomplished     UInt8,
    -- summed
    rows                    UInt64,
    msg_count               UInt64,
    delivery_delay_ms       UInt64,
    revenue_sys             Decimal(18, 6),
    cost_sys                Decimal(18, 6),
    hlr_cost_sys            Decimal(18, 6)
)
ENGINE = SummingMergeTree((rows, msg_count, delivery_delay_ms, revenue_sys, cost_sys, hlr_cost_sys))
PARTITION BY toYYYYMM(start_time)
PRIMARY KEY (start_time, c_enterprise_id, src_addr)
ORDER BY (start_time, c_enterprise_id, src_addr, v_src_addr, c_trunk_id, v_enterprise_id, v_trunk_id, c_mccmnc,
          v_mccmnc, kind, msg_type, internal_kind, business_company_id, product_category_id, c_am_user_id,
          v_am_user_id, c_country_iso, attempt_no, is_submit_success, dlr_reroute, msg_status, c_msg_status,
          is_customer_billable, is_vendor_billable, hlr_fetch_type, hlr_is_ported, hlr_is_accomplished);

-- What is already in the store, once (an empty table); from here on the views below add each insert. EDRs written
-- between this fill and the views' creation would be missed, so on a live system this file runs before traffic.
INSERT INTO edr_totals
SELECT toStartOfFifteenMinutes(a.start_time) AS start_time, toStartOfFifteenMinutes(a.submit_time) AS submit_time,
       kind, msg_type, internal_kind, business_company_id, product_category_id, c_enterprise_id, c_trunk_id,
       c_am_user_id, v_enterprise_id, v_trunk_id, v_am_user_id, c_mccmnc, c_mcc, c_country_iso, v_mccmnc,
       route_rule_id, route_type, c_rate_table_id, v_rate_table_id, c_rate, v_rate, c_currency, c_ex_rate,
       v_currency, v_ex_rate, attempt_no, is_final_attempt, is_submit_success, command_status, dlr_reroute,
       msg_status, c_msg_status, is_customer_billable, is_vendor_billable, hlr_provider_id, hlr_fetch_type,
       hlr_is_ported, hlr_is_accomplished, toUInt8(revenue_sys < cost_sys) AS neg_margin,
       count() AS rows, sum(msg_count) AS msg_count, sum(delivery_delay_ms) AS delivery_delay_ms,
       sum(revenue) AS revenue, sum(cost) AS cost, sum(revenue_sys) AS revenue_sys, sum(cost_sys) AS cost_sys,
       sum(hlr_cost_sys) AS hlr_cost_sys
  FROM edr_all AS a
 WHERE (SELECT count() FROM edr_totals) = 0
 GROUP BY ALL;

INSERT INTO edr_sender_daily
SELECT toStartOfDay(a.start_time) AS start_time, src_addr, v_src_addr, kind, msg_type, internal_kind,
       business_company_id, product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id,
       v_trunk_id, v_am_user_id, c_mccmnc, c_country_iso, v_mccmnc, attempt_no, is_submit_success, dlr_reroute,
       msg_status, c_msg_status, is_customer_billable, is_vendor_billable, hlr_fetch_type, hlr_is_ported,
       hlr_is_accomplished,
       count() AS rows, sum(msg_count) AS msg_count, sum(delivery_delay_ms) AS delivery_delay_ms,
       sum(revenue_sys) AS revenue_sys, sum(cost_sys) AS cost_sys, sum(hlr_cost_sys) AS hlr_cost_sys
  FROM edr_all AS a
 WHERE (SELECT count() FROM edr_sender_daily) = 0
 GROUP BY ALL;

-- Attempt rows (the edr branch of edr_all, 007).
CREATE MATERIALIZED VIEW IF NOT EXISTS edr_totals_mv TO edr_totals AS
SELECT toStartOfFifteenMinutes(e.start_time) AS start_time, toStartOfFifteenMinutes(e.submit_time) AS submit_time,
       'attempt' AS kind, msg_type, internal_kind, business_company_id, product_category_id, c_enterprise_id,
       c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id, v_am_user_id, c_mccmnc, c_mcc, c_country_iso,
       v_mccmnc, route_rule_id, route_type, c_rate_table_id, v_rate_table_id, c_rate, v_rate, c_currency, c_ex_rate,
       v_currency, v_ex_rate, attempt_no, is_final_attempt, is_submit_success, command_status, dlr_reroute,
       msg_status, if(e.c_msg_status = 'ACCEPTD', '', e.c_msg_status) AS c_msg_status, is_customer_billable,
       is_vendor_billable, hlr_provider_id, hlr_fetch_type, hlr_is_ported, hlr_is_accomplished,
       toUInt8(e.revenue_sys < e.cost_sys) AS neg_margin,
       count() AS rows, sum(e.msg_count) AS msg_count, sum(e.delivery_delay_ms) AS delivery_delay_ms,
       sum(e.revenue) AS revenue, sum(e.cost) AS cost, sum(e.revenue_sys) AS revenue_sys,
       sum(e.cost_sys) AS cost_sys, sum(e.hlr_cost_sys) AS hlr_cost_sys
  FROM edr AS e
 GROUP BY ALL;

-- The switch's outcome rows (the edr_receipt branch of edr_all, 007).
CREATE MATERIALIZED VIEW IF NOT EXISTS edr_totals_outcome_mv TO edr_totals AS
SELECT toStartOfFifteenMinutes(r.start_time) AS start_time, toStartOfFifteenMinutes(r.start_time) AS submit_time,
       'outcome' AS kind, CAST('MT', 'Enum8(\'MT\' = 1, \'MO\' = 2)') AS msg_type, internal_kind,
       business_company_id, product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id,
       v_trunk_id, v_am_user_id, c_mccmnc, substring(r.c_mccmnc, 1, 3) AS c_mcc, c_country_iso, v_mccmnc,
       route_rule_id, route_type, c_rate_table_id, v_rate_table_id, c_rate, v_rate, c_currency, c_ex_rate,
       v_currency, v_ex_rate, attempt_no, toUInt8(0) AS is_final_attempt, toUInt8(0) AS is_submit_success,
       toInt16(0) AS command_status, toUInt8(0) AS dlr_reroute, msg_status, c_msg_status, is_customer_billable,
       is_vendor_billable, hlr_provider_id, 'none' AS hlr_fetch_type, toUInt8(0) AS hlr_is_ported,
       toUInt8(0) AS hlr_is_accomplished, toUInt8(r.revenue_sys < r.cost_sys) AS neg_margin,
       count() AS rows, sum(r.msg_count) AS msg_count, sum(r.delivery_delay_ms) AS delivery_delay_ms,
       sum(r.revenue) AS revenue, sum(r.cost) AS cost, sum(r.revenue_sys) AS revenue_sys,
       sum(r.cost_sys) AS cost_sys, toDecimal64(0, 6) AS hlr_cost_sys
  FROM edr_receipt AS r
 WHERE r.kind = 'outcome'
 GROUP BY ALL;

CREATE MATERIALIZED VIEW IF NOT EXISTS edr_sender_daily_mv TO edr_sender_daily AS
SELECT toStartOfDay(e.start_time) AS start_time, src_addr, v_src_addr, 'attempt' AS kind, msg_type, internal_kind,
       business_company_id, product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id,
       v_trunk_id, v_am_user_id, c_mccmnc, c_country_iso, v_mccmnc, attempt_no, is_submit_success, dlr_reroute,
       msg_status, if(e.c_msg_status = 'ACCEPTD', '', e.c_msg_status) AS c_msg_status, is_customer_billable,
       is_vendor_billable, hlr_fetch_type, hlr_is_ported, hlr_is_accomplished,
       count() AS rows, sum(e.msg_count) AS msg_count, sum(e.delivery_delay_ms) AS delivery_delay_ms,
       sum(e.revenue_sys) AS revenue_sys, sum(e.cost_sys) AS cost_sys, sum(e.hlr_cost_sys) AS hlr_cost_sys
  FROM edr AS e
 GROUP BY ALL;

CREATE MATERIALIZED VIEW IF NOT EXISTS edr_sender_daily_outcome_mv TO edr_sender_daily AS
SELECT toStartOfDay(r.start_time) AS start_time, src_addr, v_src_addr, 'outcome' AS kind,
       CAST('MT', 'Enum8(\'MT\' = 1, \'MO\' = 2)') AS msg_type, internal_kind, business_company_id,
       product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id, v_am_user_id,
       c_mccmnc, c_country_iso, v_mccmnc, attempt_no, toUInt8(0) AS is_submit_success, toUInt8(0) AS dlr_reroute,
       msg_status, c_msg_status, is_customer_billable, is_vendor_billable, 'none' AS hlr_fetch_type,
       toUInt8(0) AS hlr_is_ported, toUInt8(0) AS hlr_is_accomplished,
       count() AS rows, sum(r.msg_count) AS msg_count, sum(r.delivery_delay_ms) AS delivery_delay_ms,
       sum(r.revenue_sys) AS revenue_sys, sum(r.cost_sys) AS cost_sys, toDecimal64(0, 6) AS hlr_cost_sys
  FROM edr_receipt AS r
 WHERE r.kind = 'outcome'
 GROUP BY ALL;
