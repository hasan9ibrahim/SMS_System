-- EDRs: one row per message attempt with both legs (spec §9.1 EDR schema),
-- plus the new-platform columns: session affinity (§13.1), AM at send time (§13.30),
-- TPS / revenue routing values (§13.8, §13.9). Rates and costs are copied at send
-- time so later rate changes never re-rate past traffic (§13.29, §13.32).
--
-- Runs inside the CLICKHOUSE_DB database (sms_edr by default), so names are unqualified.
-- Statements end with ';' at the end of a line so a loader can split them.

CREATE TABLE IF NOT EXISTS edr
(
    edr_id                  UUID,
    start_time              DateTime64(3, 'UTC'),
    submit_time             DateTime64(3, 'UTC'),
    submit_resp_time        Nullable(DateTime64(3, 'UTC')),
    delivery_time           Nullable(DateTime64(3, 'UTC')),
    msg_type                Enum8('MT' = 1, 'MO' = 2),
    business_company_id     UInt32,
    product_category_id     UInt32,

    -- customer leg
    c_enterprise_id         UInt32,
    c_trunk_id              UInt32,
    c_am_user_id            UInt32,                       -- AM at send time (§13.30), 0 = none
    c_ip                    IPv4,
    c_port                  UInt16,
    c_session_id            String,                       -- §13.1
    c_bind_type             LowCardinality(String),       -- TX / RX / TR
    c_protocol              LowCardinality(String),
    c_message_id            String,
    c_src_ton               UInt8,
    c_src_npi               UInt8,
    c_dst_ton               UInt8,
    c_dst_npi               UInt8,
    c_coding                UInt8,
    src_addr                String,                       -- sender ID
    dst_addr                String,                       -- DNID
    routed_dst_addr         String,
    message_text            String,
    c_mccmnc                LowCardinality(String),
    c_mcc                   LowCardinality(String),
    c_mnc                   LowCardinality(String),
    c_country_iso           LowCardinality(String),
    c_billing_type          LowCardinality(String),
    c_rate_table_id         UInt32,
    c_rate_line_id          UInt64,
    c_rate                  Decimal(12, 6),
    c_currency              LowCardinality(String),
    c_ex_rate               Decimal(18, 8),               -- currency units per base unit
    c_sys_rate              Decimal(12, 6),               -- rate in base currency
    c_translation_rule_ids  Array(UInt32),
    c_msg_status            LowCardinality(String),       -- status reported to the customer
    receipt_session_id      String,                       -- §13.1
    receipt_held_ms         UInt32,                       -- §13.1

    -- vendor leg (0 / empty when not routed)
    v_enterprise_id         UInt32,
    v_trunk_id              UInt32,
    v_am_user_id            UInt32,
    v_ip                    IPv4,
    v_port                  UInt16,
    v_message_id            String,
    v_mccmnc                LowCardinality(String),
    v_billing_type          LowCardinality(String),
    v_rate_table_id         UInt32,
    v_rate_line_id          UInt64,
    v_rate                  Decimal(12, 6),
    v_currency              LowCardinality(String),
    v_ex_rate               Decimal(18, 8),
    v_sys_rate              Decimal(12, 6),
    v_translation_rule_ids  Array(UInt32),

    -- routing
    route_rule_id           UInt32,
    route_rule_group_id     UInt32,
    route_type              LowCardinality(String),
    route_level             UInt8,
    route_decided_by        LowCardinality(String),       -- whitelist / warmup / split (§13.27)
    measured_tps            Float32,                      -- §13.8
    revenue_checked         Decimal(12, 6),               -- §13.9
    dlr_reroute             UInt8,
    repush_request_id       UInt32,

    -- outcome
    attempt_no              UInt8,
    is_final_attempt        UInt8,
    is_submit_success       UInt8,
    command_status          Int16,                        -- SMPP cause code (§2), 0 = OK
    msg_status              LowCardinality(String),       -- vendor receipt stat
    delivery_error          LowCardinality(String),
    network_error           UInt16,
    registered_delivery     UInt8,
    msg_count               UInt8,
    udh                     String,
    delivery_delay_ms       UInt32,
    is_buffered             UInt8,

    -- money (per attempt, already multiplied by msg_count and billable flags)
    is_customer_billable    UInt8,
    is_vendor_billable      UInt8,
    revenue                 Decimal(14, 6),               -- customer currency
    cost                    Decimal(14, 6),               -- vendor currency
    revenue_sys             Decimal(14, 6),               -- base currency
    cost_sys                Decimal(14, 6),

    -- HLR (§6.5, §13.24)
    hlr_provider_id         UInt32,
    hlr_fetch_type          LowCardinality(String),       -- none / cached / live
    hlr_is_ported           UInt8,
    hlr_is_accomplished     UInt8,
    hlr_error_code          UInt16,
    hlr_cost_sys            Decimal(12, 6)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(start_time)
ORDER BY (toDate(start_time), c_enterprise_id, c_trunk_id, start_time)
SETTINGS index_granularity = 8192;

-- Hourly pre-computed totals for reports and dashboards (§14.2 "reports read
-- ClickHouse pre-computed summaries"). Summed on merge.
CREATE TABLE IF NOT EXISTS edr_hourly
(
    hour                    DateTime('UTC'),
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
    route_rule_id           UInt32,
    attempts                UInt64,
    final_attempts          UInt64,
    submitted               UInt64,
    delivered               UInt64,
    reported                UInt64,
    billable_c              UInt64,
    billable_v              UInt64,
    messages                UInt64,
    revenue_sys             Decimal(18, 6),
    cost_sys                Decimal(18, 6),
    delay_ms_sum            UInt64,
    hlr_live                UInt64,
    hlr_cached              UInt64,
    hlr_ported              UInt64,
    hlr_cost_sys            Decimal(18, 6)
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, c_enterprise_id, c_trunk_id, v_enterprise_id, v_trunk_id, c_mccmnc, route_rule_id,
          business_company_id, product_category_id, c_am_user_id, v_am_user_id, c_country_iso);

CREATE MATERIALIZED VIEW IF NOT EXISTS edr_hourly_mv TO edr_hourly AS
SELECT
    toStartOfHour(start_time)                  AS hour,
    business_company_id, product_category_id,
    c_enterprise_id, c_trunk_id, c_am_user_id,
    v_enterprise_id, v_trunk_id, v_am_user_id,
    c_mccmnc, c_country_iso, route_rule_id,
    count()                                    AS attempts,
    countIf(is_final_attempt = 1)              AS final_attempts,
    countIf(is_submit_success = 1)             AS submitted,
    countIf(msg_status = 'DELIVRD')            AS delivered,
    countIf(msg_status NOT IN ('', 'ENROUTE')) AS reported,
    countIf(is_customer_billable = 1)          AS billable_c,
    countIf(is_vendor_billable = 1)            AS billable_v,
    sum(msg_count)                             AS messages,
    sum(revenue_sys)                           AS revenue_sys,
    sum(cost_sys)                              AS cost_sys,
    sum(delivery_delay_ms)                     AS delay_ms_sum,
    countIf(hlr_fetch_type = 'live')           AS hlr_live,
    countIf(hlr_fetch_type = 'cached')         AS hlr_cached,
    countIf(hlr_is_ported = 1)                 AS hlr_ported,
    sum(hlr_cost_sys)                          AS hlr_cost_sys
FROM edr
GROUP BY hour, business_company_id, product_category_id, c_enterprise_id, c_trunk_id, c_am_user_id,
         v_enterprise_id, v_trunk_id, v_am_user_id, c_mccmnc, c_country_iso, route_rule_id;
