-- Backend build step 6. Idempotent: the mock runs these files on start too.
--
-- EDRs stay append-only (docs/BACKEND_PLAN.md §3.2). The switch writes the money of an attempt where it becomes known:
--
--   * on the `edr` attempt row when the billing type decides at send time (attempt, submit);
--   * on an `edr_receipt` row of kind 'outcome', one per attempt when its final status is known (all parts have their
--     final receipt, or the DLR timeout passed), for the billing types that wait for the receipt (reported, delivery).
--
-- The outcome row also carries the vendor's final status of the attempt, so delivered / reported counts and delivery
-- delays reach `edr_hourly` from it (the attempt row is written before any receipt and leaves msg_status empty). A
-- receipt after the DLR timeout (D5) adds an outcome row with the vendor's money only and an empty status.
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS business_company_id UInt32 DEFAULT 0 AFTER c_trunk_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS product_category_id UInt32 DEFAULT 0 AFTER business_company_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS c_am_user_id UInt32 DEFAULT 0 AFTER product_category_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_enterprise_id UInt32 DEFAULT 0 AFTER c_am_user_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_am_user_id UInt32 DEFAULT 0 AFTER v_trunk_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS c_mccmnc LowCardinality(String) DEFAULT '' AFTER v_am_user_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS c_country_iso LowCardinality(String) DEFAULT '' AFTER c_mccmnc;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS route_rule_id UInt32 DEFAULT 0 AFTER c_country_iso;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS attempt_no UInt8 DEFAULT 0 AFTER route_rule_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS is_customer_billable UInt8 DEFAULT 0 AFTER source;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS is_vendor_billable UInt8 DEFAULT 0 AFTER is_customer_billable;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS revenue Decimal(14, 6) DEFAULT 0 AFTER is_vendor_billable;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS cost Decimal(14, 6) DEFAULT 0 AFTER revenue;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS revenue_sys Decimal(14, 6) DEFAULT 0 AFTER cost;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS cost_sys Decimal(14, 6) DEFAULT 0 AFTER revenue_sys;

CREATE MATERIALIZED VIEW IF NOT EXISTS edr_outcome_hourly_mv TO edr_hourly AS
SELECT
    toStartOfHour(start_time)                  AS hour,
    business_company_id, product_category_id,
    c_enterprise_id, c_trunk_id, c_am_user_id,
    v_enterprise_id, v_trunk_id, v_am_user_id,
    c_mccmnc, c_country_iso, route_rule_id,
    toUInt64(0)                                AS attempts,
    toUInt64(0)                                AS final_attempts,
    toUInt64(0)                                AS submitted,
    countIf(msg_status = 'DELIVRD')            AS delivered,
    countIf(msg_status NOT IN ('', 'ENROUTE')) AS reported,
    countIf(is_customer_billable = 1)          AS billable_c,
    countIf(is_vendor_billable = 1)            AS billable_v,
    toUInt64(0)                                AS messages,
    sum(revenue_sys)                           AS revenue_sys,
    sum(cost_sys)                              AS cost_sys,
    sum(delivery_delay_ms)                     AS delay_ms_sum,
    toUInt64(0)                                AS hlr_live,
    toUInt64(0)                                AS hlr_cached,
    toUInt64(0)                                AS hlr_ported,
    toDecimal64(0, 6)                          AS hlr_cost_sys
FROM edr_receipt
WHERE kind = 'outcome'
GROUP BY hour, business_company_id, product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id,
         v_enterprise_id, v_trunk_id, v_am_user_id, c_mccmnc, c_country_iso, route_rule_id;
