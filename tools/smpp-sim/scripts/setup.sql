-- Load-test configuration (backend step 7), run inside the sms_load copy of the seeded database by setup.sh. Fake
-- data only: every name, login and host below is invented; the vendor trunks point at the simulator's fake SMSC.
--
-- psql variables: customer_trunks, vendor_trunks, vendor_host, vendor_port, vendor_connections.
SET search_path = sms, public;

-- The seeded trunks stay in the copy (realistic configuration size) but are switched off, so the switch never tries
-- to reach their (fake) vendors.
UPDATE vendor_trunks SET status = 'inactive';
UPDATE customer_trunks SET status = 'inactive';
-- The load-test rule is evaluated first: the seeded rules keep their order below it.
UPDATE route_rules SET priority = 99 WHERE priority = 100;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM currencies WHERE iso = 'EUR') THEN
    INSERT INTO currencies (iso, name, symbol) VALUES ('EUR', 'Euro', '€');
  END IF;
END $$;

INSERT INTO business_companies (name, base_currency, tps_limit) VALUES ('LoadTest Co', 'EUR', 1000000);

INSERT INTO enterprises (business_company_id, name, alias, type, tier, address_line1, status)
SELECT id, 'LoadTest Customer', 'LT-CUST', 'customer', 'tier1', '1 Load Test Way', 'active'
  FROM business_companies WHERE name = 'LoadTest Co';
INSERT INTO enterprises (business_company_id, name, alias, type, tier, address_line1, status)
SELECT id, 'LoadTest Vendor', 'LT-VEND', 'vendor', 'tier1', '2 Load Test Way', 'active'
  FROM business_companies WHERE name = 'LoadTest Co';

-- Billing on both sides, so every message runs the credit check and is charged (step 6): a postpaid customer with a
-- limit no test reaches.
INSERT INTO enterprise_billing (enterprise_id, side, currency, billing_cycle_id, billing_type, credit_limit, opening_balance)
SELECT e.id, 'customer', 'EUR', (SELECT min(id) FROM billing_cycles), 'postpaid', 1000000000, 0
  FROM enterprises e WHERE e.name = 'LoadTest Customer';
INSERT INTO enterprise_billing (enterprise_id, side, currency, billing_cycle_id, billing_type, opening_balance)
SELECT e.id, 'vendor', 'EUR', (SELECT min(id) FROM billing_cycles), 'postpaid', 0
  FROM enterprises e WHERE e.name = 'LoadTest Vendor';

-- Customer trunks: 10 connections each, a TPS no test reaches (the switch's own capacity is what is measured).
INSERT INTO customer_trunks (enterprise_id, name, protocol, product_category_id, billing_type, status, bind_type,
                             host_ips, username, password, max_connections, ssl_type, tps, overflow_buffer,
                             dlr_session_affinity, dlr_hold_hours)
SELECT e.id, 'LOADTEST_C' || lpad(n::text, 2, '0'), 'smpp', (SELECT min(id) FROM product_categories), 'delivery',
       'active', 'TR', '{127.0.0.1}', 'ltc' || lpad(n::text, 2, '0'), 'ltpass', 10, 'none', 5000, 0, 'strict', 72
  FROM enterprises e, generate_series(1, :customer_trunks) n
 WHERE e.name = 'LoadTest Customer';

-- Vendor trunks: all on the simulator's fake SMSC.
INSERT INTO vendor_trunks (enterprise_id, name, protocol, product_category_id, billing_type, status, bind_type,
                           username, password, host, port, max_connections, ssl_type, submit_interval_ms,
                           submit_timeout_s, enquire_link_timeout_s, enquire_link_interval_s, msg_id_type, tps,
                           overflow_buffer, window_size, allowed_data_codings, reroute_on, max_msg_len,
                           support_multipart, dlr_timeout_s, dlr_timeout_stat, reconnect_schedule_s,
                           bind_alert_after_min, auth_fail_retry_min, multipart_format)
SELECT e.id, 'LOADTEST_V' || lpad(n::text, 2, '0'), 'smpp', (SELECT min(id) FROM product_categories), 'delivery',
       'active', 'TR', 'ltv' || lpad(n::text, 2, '0'), 'ltpass', :'vendor_host', :vendor_port, :vendor_connections,
       'none', 0, 30, 30, 30, 'default', 10000, 0, 200, '{0,3,8}', '{}', NULL, true, 600, 'UNKNOWN', '{1,2,5}', 2, 1,
       'udh8'
  FROM enterprises e, generate_series(1, :vendor_trunks) n
 WHERE e.name = 'LoadTest Vendor';

-- Rates for every destination with a dial code: the customer pays 0.0100 EUR, each vendor costs 0.0050 EUR.
INSERT INTO rate_tables (kind, name, product_category_id, currency)
VALUES ('customer', 'LoadTest customer rates', (SELECT min(id) FROM product_categories), 'EUR');
INSERT INTO customer_trunk_rate_tables (customer_trunk_id, rate_table_id, position)
SELECT t.id, (SELECT id FROM rate_tables WHERE name = 'LoadTest customer rates'), 1
  FROM customer_trunks t WHERE t.name LIKE 'LOADTEST_C%';
INSERT INTO rate_tables (kind, name, product_category_id, currency, vendor_trunk_id)
SELECT 'vendor', 'LoadTest rates ' || t.name, t.product_category_id, 'EUR', t.id
  FROM vendor_trunks t WHERE t.name LIKE 'LOADTEST_V%';

WITH dests AS (
  SELECT DISTINCT m.id, m.mccmnc FROM mccmnc m JOIN dial_codes d ON d.mccmnc_id = m.id
   WHERE d.profile = 'All' AND d.deleted_at IS NULL AND m.deleted_at IS NULL
)
INSERT INTO rate_lines (rate_table_id, mccmnc_id, mccmnc, rate, currency, valid_from, change_type)
SELECT rt.id, d.id, d.mccmnc, CASE WHEN rt.kind = 'customer' THEN 0.0100 ELSE 0.0050 END, 'EUR',
       now() - interval '1 day', 'new'
  FROM rate_tables rt, dests d
 WHERE rt.name LIKE 'LoadTest%';

-- One route rule for the load-test trunks: every destination, round robin over the load-test vendors.
INSERT INTO route_rules (name, priority, status, starts_at, stops_at, continue_routing, match_mode, category_mode,
                         category_ids, customer_trunk_mode, customer_trunk_ids, mccmnc_mode, mccmncs, route_type,
                         hunt_policy, enable_backup_routes, vendor_category_mode, vendor_category_ids,
                         vendor_trunk_mode, vendor_trunk_ids, max_route_level, margin_type, comment)
SELECT 'LoadTest route', 100, 'active', now() - interval '1 day', '2100-01-01', 'stop', 'all', 'all', '{}',
       'inclusive', array_agg(t.id ORDER BY t.id), 'all', '{}', 'static', 'round_robin', false, 'all', '{}', 'all',
       '{}', 1, 'amount', 'Backend step 7 load test (fake data)'
  FROM customer_trunks t WHERE t.name LIKE 'LOADTEST_C%';
INSERT INTO route_rule_vendors (route_rule_id, level, vendor_trunk_id)
SELECT r.id, 1, t.id FROM route_rules r, vendor_trunks t
 WHERE r.name = 'LoadTest route' AND t.name LIKE 'LOADTEST_V%';
