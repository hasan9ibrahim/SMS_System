-- Backend step 13 follow-up (QA 2026-10-31). Idempotent: the mock runs these files on start too, and the deploy on
-- every release (Sms.Core.Release.migrate).
--
-- edr_all's outcome branch read `FROM edr_receipt WHERE kind = 'outcome'`, and in ClickHouse a SELECT alias wins over
-- a column of the same name in WHERE: the branch's own `'outcome' AS kind` made the condition always true, so every
-- customer and vendor receipt came out as an outcome row (counted twice or three times in delivered, reported, delay,
-- billable and money figures on reports, QBR, route traffic, alerts and rate lookup). The view now names the table's
-- column (r.kind), as the materialized views of 005 and 008 always did; every other column is unchanged.
CREATE OR REPLACE VIEW edr_all AS
SELECT
    'attempt'            AS kind,
    edr_id,
    start_time,
    submit_time,
    msg_type,
    business_company_id,
    product_category_id,
    c_enterprise_id,
    c_trunk_id,
    c_am_user_id,
    c_ip,
    v_enterprise_id,
    v_trunk_id,
    v_am_user_id,
    v_ip,
    c_mccmnc,
    c_mcc,
    c_country_iso,
    v_mccmnc,
    src_addr,
    v_src_addr,
    route_rule_id,
    route_type,
    c_rate_table_id,
    v_rate_table_id,
    c_rate,
    v_rate,
    c_currency,
    c_ex_rate,
    v_currency,
    v_ex_rate,
    attempt_no,
    is_final_attempt,
    is_submit_success,
    command_status,
    dlr_reroute,
    msg_count,
    msg_status,
    if(c_msg_status = 'ACCEPTD', '', c_msg_status) AS c_msg_status,
    delivery_delay_ms,
    is_customer_billable,
    is_vendor_billable,
    revenue,
    cost,
    revenue_sys,
    cost_sys,
    hlr_provider_id,
    hlr_fetch_type,
    hlr_is_ported,
    hlr_is_accomplished,
    hlr_cost_sys,
    internal_kind
FROM edr
UNION ALL
SELECT
    'outcome'            AS kind,
    edr_id,
    start_time,
    start_time           AS submit_time,
    CAST('MT', 'Enum8(\'MT\' = 1, \'MO\' = 2)') AS msg_type,
    business_company_id,
    product_category_id,
    c_enterprise_id,
    c_trunk_id,
    c_am_user_id,
    c_ip,
    v_enterprise_id,
    v_trunk_id,
    v_am_user_id,
    v_ip,
    c_mccmnc,
    substring(c_mccmnc, 1, 3) AS c_mcc,
    c_country_iso,
    v_mccmnc,
    src_addr,
    v_src_addr,
    route_rule_id,
    route_type,
    c_rate_table_id,
    v_rate_table_id,
    c_rate,
    v_rate,
    c_currency,
    c_ex_rate,
    v_currency,
    v_ex_rate,
    attempt_no,
    toUInt8(0)           AS is_final_attempt,
    toUInt8(0)           AS is_submit_success,
    toInt16(0)           AS command_status,
    toUInt8(0)           AS dlr_reroute,
    msg_count,
    msg_status,
    c_msg_status,
    delivery_delay_ms,
    is_customer_billable,
    is_vendor_billable,
    revenue,
    cost,
    revenue_sys,
    cost_sys,
    hlr_provider_id,
    'none'               AS hlr_fetch_type,
    toUInt8(0)           AS hlr_is_ported,
    toUInt8(0)           AS hlr_is_accomplished,
    toDecimal64(0, 6)    AS hlr_cost_sys,
    internal_kind
FROM edr_receipt AS r
WHERE r.kind = 'outcome';

-- The long-term totals (008) took their first fill from this view, so the outcome rows of the days before their
-- materialized views started carry those receipts too; the views themselves read r.kind and are right. Repair, the
-- same on every run and nothing to do once right: per day still kept in detail, add to the totals the difference
-- between what the outcome receipts add up to (as edr_totals_outcome_mv / edr_sender_daily_outcome_mv write them) and
-- what the totals hold. The difference is negative, so the summed counters become signed; a row whose sums all reach
-- 0 is removed when ClickHouse merges. INSERTs only: one server computes them and both replicas get the same rows (a
-- mutation would be evaluated by each replica on its own).
--
-- Days checked: up to the day after the materialized views were created (rows after that were written by them), from
-- the first day the detailed receipts certainly keep: every day without a TTL, else two days inside the TTL's months
-- (Sms.Core.Release retention); a TTL in other units checks nothing. A receipt written while this runs can leave one
-- day off by it; the next run puts it right.
ALTER TABLE edr_totals MODIFY COLUMN rows Int64, MODIFY COLUMN msg_count Int64, MODIFY COLUMN delivery_delay_ms Int64;

ALTER TABLE edr_sender_daily MODIFY COLUMN rows Int64, MODIFY COLUMN msg_count Int64,
    MODIFY COLUMN delivery_delay_ms Int64;

INSERT INTO edr_totals (start_time, submit_time, kind, msg_type, internal_kind, business_company_id,
                        product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id,
                        v_am_user_id, c_mccmnc, c_mcc, c_country_iso, v_mccmnc, route_rule_id, route_type,
                        c_rate_table_id, v_rate_table_id, c_rate, v_rate, c_currency, c_ex_rate, v_currency,
                        v_ex_rate, attempt_no, is_final_attempt, is_submit_success, command_status, dlr_reroute,
                        msg_status, c_msg_status, is_customer_billable, is_vendor_billable, hlr_provider_id,
                        hlr_fetch_type, hlr_is_ported, hlr_is_accomplished, neg_margin,
                        rows, msg_count, delivery_delay_ms, revenue, cost, revenue_sys, cost_sys, hlr_cost_sys)
WITH (SELECT multiIf(position(engine_full, ' TTL ') = 0, toDate('1970-01-01'), empty(m), toDate('2149-06-06'),
                     toDate(now() - toIntervalMonth(arrayMax(m)), 'UTC') + 2)
        FROM (SELECT engine_full,
                     arrayMap(x -> toUInt32(x), extractAll(engine_full, 'toIntervalMonth\\((\\d+)\\)')) AS m
                FROM system.tables
               WHERE database = currentDatabase() AND name = 'edr_receipt')) AS first_day,
     (SELECT toDate(max(metadata_modification_time), 'UTC') + 1
        FROM system.tables
       WHERE database = currentDatabase() AND name IN ('edr_totals_mv', 'edr_totals_outcome_mv')) AS last_day
SELECT start_time, submit_time, kind, msg_type, internal_kind, business_company_id, product_category_id,
       c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id, v_am_user_id, c_mccmnc, c_mcc,
       c_country_iso, v_mccmnc, route_rule_id, route_type, c_rate_table_id, v_rate_table_id, c_rate, v_rate,
       c_currency, c_ex_rate, v_currency, v_ex_rate, attempt_no, is_final_attempt, is_submit_success, command_status,
       dlr_reroute, msg_status, c_msg_status, is_customer_billable, is_vendor_billable, hlr_provider_id,
       hlr_fetch_type, hlr_is_ported, hlr_is_accomplished, neg_margin,
       sum(d.rows) AS rows, sum(d.msg_count) AS msg_count, sum(d.delivery_delay_ms) AS delivery_delay_ms,
       sum(d.revenue) AS revenue, sum(d.cost) AS cost, sum(d.revenue_sys) AS revenue_sys, sum(d.cost_sys) AS cost_sys,
       sum(d.hlr_cost_sys) AS hlr_cost_sys
  FROM (
        -- what the outcome receipts add up to
        SELECT toStartOfFifteenMinutes(r.start_time) AS start_time,
               toStartOfFifteenMinutes(r.start_time) AS submit_time, 'outcome' AS kind,
               CAST('MT', 'Enum8(\'MT\' = 1, \'MO\' = 2)') AS msg_type, internal_kind, business_company_id,
               product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id,
               v_am_user_id, c_mccmnc, substring(r.c_mccmnc, 1, 3) AS c_mcc, c_country_iso, v_mccmnc, route_rule_id,
               route_type, c_rate_table_id, v_rate_table_id, c_rate, v_rate, c_currency, c_ex_rate, v_currency,
               v_ex_rate, attempt_no, toUInt8(0) AS is_final_attempt, toUInt8(0) AS is_submit_success,
               toInt16(0) AS command_status, toUInt8(0) AS dlr_reroute, msg_status, c_msg_status,
               is_customer_billable, is_vendor_billable, hlr_provider_id, 'none' AS hlr_fetch_type,
               toUInt8(0) AS hlr_is_ported, toUInt8(0) AS hlr_is_accomplished,
               toUInt8(r.revenue_sys < r.cost_sys) AS neg_margin,
               toInt64(count()) AS rows, toInt64(sum(r.msg_count)) AS msg_count,
               toInt64(sum(r.delivery_delay_ms)) AS delivery_delay_ms, sum(r.revenue) AS revenue, sum(r.cost) AS cost,
               sum(r.revenue_sys) AS revenue_sys, sum(r.cost_sys) AS cost_sys, toDecimal64(0, 6) AS hlr_cost_sys
          FROM edr_receipt AS r
         WHERE r.kind = 'outcome' AND toDate(r.start_time) BETWEEN first_day AND last_day
         GROUP BY ALL
        UNION ALL
        -- less what the totals hold for them
        SELECT start_time, submit_time, kind, msg_type, internal_kind, business_company_id, product_category_id,
               c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id, v_am_user_id, c_mccmnc, c_mcc,
               c_country_iso, v_mccmnc, route_rule_id, route_type, c_rate_table_id, v_rate_table_id, c_rate, v_rate,
               c_currency, c_ex_rate, v_currency, v_ex_rate, attempt_no, is_final_attempt, is_submit_success,
               command_status, dlr_reroute, msg_status, c_msg_status, is_customer_billable, is_vendor_billable,
               hlr_provider_id, hlr_fetch_type, hlr_is_ported, hlr_is_accomplished, neg_margin,
               -sum(t.rows) AS rows, -sum(t.msg_count) AS msg_count, -sum(t.delivery_delay_ms) AS delivery_delay_ms,
               -sum(t.revenue) AS revenue, -sum(t.cost) AS cost, -sum(t.revenue_sys) AS revenue_sys,
               -sum(t.cost_sys) AS cost_sys, -sum(t.hlr_cost_sys) AS hlr_cost_sys
          FROM edr_totals AS t
         WHERE t.kind = 'outcome' AND toDate(t.start_time) BETWEEN first_day AND last_day
         GROUP BY ALL
       ) AS d
 GROUP BY ALL
HAVING rows != 0 OR msg_count != 0 OR delivery_delay_ms != 0 OR revenue != 0 OR cost != 0 OR revenue_sys != 0
    OR cost_sys != 0 OR hlr_cost_sys != 0;

INSERT INTO edr_sender_daily (start_time, src_addr, v_src_addr, kind, msg_type, internal_kind, business_company_id,
                              product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id,
                              v_trunk_id, v_am_user_id, c_mccmnc, c_country_iso, v_mccmnc, attempt_no,
                              is_submit_success, dlr_reroute, msg_status, c_msg_status, is_customer_billable,
                              is_vendor_billable, hlr_fetch_type, hlr_is_ported, hlr_is_accomplished,
                              rows, msg_count, delivery_delay_ms, revenue_sys, cost_sys, hlr_cost_sys)
WITH (SELECT multiIf(position(engine_full, ' TTL ') = 0, toDate('1970-01-01'), empty(m), toDate('2149-06-06'),
                     toDate(now() - toIntervalMonth(arrayMax(m)), 'UTC') + 2)
        FROM (SELECT engine_full,
                     arrayMap(x -> toUInt32(x), extractAll(engine_full, 'toIntervalMonth\\((\\d+)\\)')) AS m
                FROM system.tables
               WHERE database = currentDatabase() AND name = 'edr_receipt')) AS first_day,
     (SELECT toDate(max(metadata_modification_time), 'UTC') + 1
        FROM system.tables
       WHERE database = currentDatabase()
         AND name IN ('edr_sender_daily_mv', 'edr_sender_daily_outcome_mv')) AS last_day
SELECT start_time, src_addr, v_src_addr, kind, msg_type, internal_kind, business_company_id, product_category_id,
       c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id, v_am_user_id, c_mccmnc, c_country_iso,
       v_mccmnc, attempt_no, is_submit_success, dlr_reroute, msg_status, c_msg_status, is_customer_billable,
       is_vendor_billable, hlr_fetch_type, hlr_is_ported, hlr_is_accomplished,
       sum(d.rows) AS rows, sum(d.msg_count) AS msg_count, sum(d.delivery_delay_ms) AS delivery_delay_ms,
       sum(d.revenue_sys) AS revenue_sys, sum(d.cost_sys) AS cost_sys, sum(d.hlr_cost_sys) AS hlr_cost_sys
  FROM (
        SELECT toStartOfDay(r.start_time) AS start_time, src_addr, v_src_addr, 'outcome' AS kind,
               CAST('MT', 'Enum8(\'MT\' = 1, \'MO\' = 2)') AS msg_type, internal_kind, business_company_id,
               product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id,
               v_am_user_id, c_mccmnc, c_country_iso, v_mccmnc, attempt_no, toUInt8(0) AS is_submit_success,
               toUInt8(0) AS dlr_reroute, msg_status, c_msg_status, is_customer_billable, is_vendor_billable,
               'none' AS hlr_fetch_type, toUInt8(0) AS hlr_is_ported, toUInt8(0) AS hlr_is_accomplished,
               toInt64(count()) AS rows, toInt64(sum(r.msg_count)) AS msg_count,
               toInt64(sum(r.delivery_delay_ms)) AS delivery_delay_ms, sum(r.revenue_sys) AS revenue_sys,
               sum(r.cost_sys) AS cost_sys, toDecimal64(0, 6) AS hlr_cost_sys
          FROM edr_receipt AS r
         WHERE r.kind = 'outcome' AND toDate(r.start_time) BETWEEN first_day AND last_day
         GROUP BY ALL
        UNION ALL
        SELECT start_time, src_addr, v_src_addr, kind, msg_type, internal_kind, business_company_id,
               product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id, v_enterprise_id, v_trunk_id,
               v_am_user_id, c_mccmnc, c_country_iso, v_mccmnc, attempt_no, is_submit_success, dlr_reroute,
               msg_status, c_msg_status, is_customer_billable, is_vendor_billable, hlr_fetch_type, hlr_is_ported,
               hlr_is_accomplished,
               -sum(t.rows) AS rows, -sum(t.msg_count) AS msg_count, -sum(t.delivery_delay_ms) AS delivery_delay_ms,
               -sum(t.revenue_sys) AS revenue_sys, -sum(t.cost_sys) AS cost_sys, -sum(t.hlr_cost_sys) AS hlr_cost_sys
          FROM edr_sender_daily AS t
         WHERE t.kind = 'outcome' AND toDate(t.start_time) BETWEEN first_day AND last_day
         GROUP BY ALL
       ) AS d
 GROUP BY ALL
HAVING rows != 0 OR msg_count != 0 OR delivery_delay_ms != 0 OR revenue_sys != 0 OR cost_sys != 0
    OR hlr_cost_sys != 0;

-- Until ClickHouse merges them, a key the receipts alone made (a vendor receipt's statuses, company 0) is still there
-- twice, +n and -n: no sum sees it, but a report listing groups or counting companies would. Merge the months that
-- hold such rows now, the earliest each time (edr_receipt exists since late October 2026, so three are plenty; a next
-- run merges any left). No negative row, nothing done: a month has none once merged.
OPTIMIZE TABLE edr_totals PARTITION tuple((SELECT toYYYYMM(min(start_time)) FROM edr_totals WHERE rows < 0)) FINAL;

OPTIMIZE TABLE edr_totals PARTITION tuple((SELECT toYYYYMM(min(start_time)) FROM edr_totals WHERE rows < 0)) FINAL;

OPTIMIZE TABLE edr_totals PARTITION tuple((SELECT toYYYYMM(min(start_time)) FROM edr_totals WHERE rows < 0)) FINAL;

OPTIMIZE TABLE edr_sender_daily
    PARTITION tuple((SELECT toYYYYMM(min(start_time)) FROM edr_sender_daily WHERE rows < 0)) FINAL;

OPTIMIZE TABLE edr_sender_daily
    PARTITION tuple((SELECT toYYYYMM(min(start_time)) FROM edr_sender_daily WHERE rows < 0)) FINAL;

OPTIMIZE TABLE edr_sender_daily
    PARTITION tuple((SELECT toYYYYMM(min(start_time)) FROM edr_sender_daily WHERE rows < 0)) FINAL;
