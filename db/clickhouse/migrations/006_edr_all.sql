-- Backend step 11b. Idempotent: the mock runs these files on start too.
--
-- The switch writes an attempt's final status, delivery delay and the money billed on the receipt on an edr_receipt
-- row of kind 'outcome' (005), not on the edr attempt row, which stays as written at send time (append-only). Screens
-- that count deliveries, delays or money over a period read edr_all: the attempt rows and the outcome rows under the
-- same report columns, so a sum over both is right whichever row carries a figure.
--
--   * attempts, submits, message parts: countIf(kind = 'attempt') / sumIf(msg_count, kind = 'attempt');
--   * delivered, delay: countIf(msg_status = 'DELIVRD') and sumIf(delivery_delay_ms, msg_status = 'DELIVRD'); the
--     attempt rows carry no final status from the switch (the fake data's attempt rows do, and have no outcome rows);
--   * customer status: c_msg_status; the switch's attempt rows say only ACCEPTD there (shown as '' here), the
--     customer's final status comes on the outcome row;
--   * money: sum(revenue_sys) over both.
--
-- A query's WHERE on these columns reaches both tables (ClickHouse pushes it into each UNION ALL branch), so a
-- period reads only its own partitions.
--
-- Outcome rows repeat the attempt's report columns beyond edr_hourly's (the switch from step 11b,
-- Sms.Switch.Pipeline.Edr.outcome_dims/2): IPs, the vendor's MCCMNC, both Sender IDs, route type, both rate tables
-- and rates, HLR provider, both sides' currencies and exchange rates, and the attempt's message parts, so a receipt's
-- figures group and convert like the attempt's and its billable messages count (msg_count * is_*_billable). Message
-- volume is sumIf(msg_count, kind = 'attempt').
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS c_ip IPv4 DEFAULT toIPv4('0.0.0.0') AFTER cost_sys;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_ip IPv4 DEFAULT toIPv4('0.0.0.0') AFTER c_ip;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_mccmnc LowCardinality(String) DEFAULT '' AFTER v_ip;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS src_addr String DEFAULT '' AFTER v_mccmnc;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_src_addr String DEFAULT '' AFTER src_addr;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS route_type LowCardinality(String) DEFAULT '' AFTER v_src_addr;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS c_rate_table_id UInt32 DEFAULT 0 AFTER route_type;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_rate_table_id UInt32 DEFAULT 0 AFTER c_rate_table_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS hlr_provider_id UInt32 DEFAULT 0 AFTER v_rate_table_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS c_rate Decimal(12, 6) DEFAULT 0 AFTER hlr_provider_id;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_rate Decimal(12, 6) DEFAULT 0 AFTER c_rate;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS c_currency LowCardinality(String) DEFAULT '' AFTER v_rate;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS c_ex_rate Decimal(18, 8) DEFAULT 0 AFTER c_currency;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_currency LowCardinality(String) DEFAULT '' AFTER c_ex_rate;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS v_ex_rate Decimal(18, 8) DEFAULT 0 AFTER v_currency;
ALTER TABLE edr_receipt ADD COLUMN IF NOT EXISTS msg_count UInt8 DEFAULT 0 AFTER v_ex_rate;

CREATE VIEW IF NOT EXISTS edr_all AS
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
    hlr_cost_sys
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
    toDecimal64(0, 6)    AS hlr_cost_sys
FROM edr_receipt
WHERE kind = 'outcome';
