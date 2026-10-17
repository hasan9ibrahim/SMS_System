-- Redundancy for the Cleanup Center (spec §13.19, §13.20), loaded after the generated data so the scan
-- finds every kind of finding. Deterministic: copies chosen by id. Fake data only (CLAUDE.md rule 1).
SET search_path = sms, public;

-- Route rules copied from active static rules with one vendor list (picked by id).
CREATE TEMP TABLE fx_src AS
  SELECT r.* FROM route_rules r
   WHERE r.deleted_at IS NULL AND r.status = 'active' AND r.route_type = 'static' AND r.customer_trunk_mode = 'inclusive'
     AND cardinality(r.customer_trunk_ids) BETWEEN 1 AND 3 AND r.mccmnc_mode = 'inclusive'
     AND (r.stops_at IS NULL OR r.stops_at > now() + interval '1 year')
     AND EXISTS (SELECT 1 FROM route_rule_vendors v WHERE v.route_rule_id = r.id)
   ORDER BY r.id LIMIT 12;

CREATE OR REPLACE FUNCTION pg_temp.fx_copy(src bigint, new_name text, new_priority int, trunks bigint[], vendor_shift int)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE nid bigint;
BEGIN
  INSERT INTO route_rules (name, priority, status, starts_at, stops_at, route_rule_group_id, next_route_rule_group_id,
      continue_routing, match_mode, category_mode, category_ids, customer_trunk_mode, customer_trunk_ids, mccmnc_mode,
      mccmncs, mccmnc_pattern, sender_pattern, sender_pattern_negate, receiver_pattern, receiver_pattern_negate,
      content_pattern, content_pattern_negate, sender_list_id, receiver_list_id, tps_condition, revenue_condition,
      route_type, hunt_policy, enable_backup_routes, vendor_category_mode, vendor_category_ids, vendor_trunk_mode,
      vendor_trunk_ids, max_route_level, margin, qbr_formula, skip_vendor_at_tps_pct, hlr_action, hlr_ported,
      deny_multipart, threshold, threshold_interval, comment, created_by_id, updated_by_id, inserted_at, updated_at,
      dlr_target_pct, lcr_profile_id)
  SELECT new_name, coalesce(new_priority, priority), status, starts_at, stops_at, route_rule_group_id, next_route_rule_group_id,
      continue_routing, match_mode, category_mode, category_ids, customer_trunk_mode, coalesce(trunks, customer_trunk_ids), mccmnc_mode,
      mccmncs, mccmnc_pattern, sender_pattern, sender_pattern_negate, receiver_pattern, receiver_pattern_negate,
      content_pattern, content_pattern_negate, sender_list_id, receiver_list_id, tps_condition, revenue_condition,
      route_type, hunt_policy, enable_backup_routes, vendor_category_mode, vendor_category_ids, vendor_trunk_mode,
      vendor_trunk_ids, max_route_level, margin, qbr_formula, skip_vendor_at_tps_pct, hlr_action, hlr_ported,
      deny_multipart, threshold, threshold_interval, 'Copy for the Cleanup Center (fake)', created_by_id, updated_by_id,
      inserted_at, updated_at, dlr_target_pct, lcr_profile_id
    FROM route_rules WHERE id = src RETURNING id INTO nid;
  -- With a vendor shift, each vendor row gets a different replacement trunk (none of the source rule's own),
  -- so a source with several vendors on one level never yields the same level and trunk twice.
  INSERT INTO route_rule_vendors (route_rule_id, level, vendor_trunk_id, share_pct, is_backup, warmup_count, warmup_reset, warmup_per)
  SELECT nid, v.level,
         CASE WHEN vendor_shift = 0 THEN v.vendor_trunk_id
              ELSE coalesce((SELECT vt.id FROM vendor_trunks vt
                              WHERE vt.deleted_at IS NULL AND vt.status = 'active'
                                AND vt.id NOT IN (SELECT x.vendor_trunk_id FROM route_rule_vendors x WHERE x.route_rule_id = src)
                              ORDER BY vt.id OFFSET vendor_shift + v.rn LIMIT 1), v.vendor_trunk_id) END,
         v.share_pct, v.is_backup, v.warmup_count, v.warmup_reset, v.warmup_per
    FROM (SELECT y.*, row_number() OVER (ORDER BY y.id) - 1 AS rn FROM route_rule_vendors y WHERE y.route_rule_id = src) v
  ON CONFLICT DO NOTHING;
  RETURN nid;
END $$;

-- Identical: the first source gets 5 copies differing only in name (6 rules in all); two more get one copy each.
SELECT pg_temp.fx_copy(s.id, s.name || ' copy ' || g, NULL, NULL, 0)
  FROM (SELECT * FROM fx_src ORDER BY id LIMIT 1) s, generate_series(1, 5) g;
SELECT pg_temp.fx_copy(s.id, s.name || ' (old)', NULL, NULL, 0) FROM (SELECT * FROM fx_src ORDER BY id OFFSET 1 LIMIT 2) s;
-- Near-duplicates: same rule for other client trunks.
SELECT pg_temp.fx_copy(s.id, s.name || ' – other trunks', NULL,
         ARRAY(SELECT t.id FROM customer_trunks t WHERE t.deleted_at IS NULL AND t.id <> ALL(s.customer_trunk_ids) ORDER BY t.id LIMIT 2), 0)
  FROM (SELECT * FROM fx_src ORDER BY id OFFSET 3 LIMIT 3) s;
-- Conflicting: same priority and conditions, another vendor.
SELECT pg_temp.fx_copy(s.id, s.name || ' – alt vendor', NULL, NULL, 7) FROM (SELECT * FROM fx_src ORDER BY id OFFSET 6 LIMIT 2) s;
-- Shadowed: the same traffic again further down the list (the original decides first).
SELECT pg_temp.fx_copy(s.id, s.name || ' – fallback', least(s.priority + 20, 100), NULL, 11) FROM (SELECT * FROM fx_src ORDER BY id OFFSET 8 LIMIT 2) s;

-- Duplicate enterprises: the same company entered again (name with punctuation, same VAT number).
INSERT INTO enterprises (business_company_id, name, alias, type, tier, status, account_manager_id, bind_alert, credit_alert,
    credit_alert_notice, credit_alert_warning, credit_alert_critical, address_line1, city, country_id, vat_number,
    billing_timezone, rate_notice_days, created_by_id, updated_by_id, inserted_at, updated_at)
SELECT business_company_id, upper(name) || '.', alias || '2', type, tier, 'inactive', account_manager_id, bind_alert, credit_alert,
    credit_alert_notice, credit_alert_warning, credit_alert_critical, address_line1, city, country_id, vat_number,
    billing_timezone, rate_notice_days, created_by_id, updated_by_id, inserted_at + interval '200 days', updated_at
  FROM enterprises WHERE deleted_at IS NULL AND vat_number IS NOT NULL ORDER BY id LIMIT 3;

-- An identical rate table: a customer table copied line for line, not attached to any trunk.
WITH src AS (
  SELECT rt.* FROM rate_tables rt WHERE rt.kind = 'customer' AND rt.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM customer_trunk_rate_tables x WHERE x.rate_table_id = rt.id)
   ORDER BY (SELECT count(*) FROM rate_lines l WHERE l.rate_table_id = rt.id), rt.id LIMIT 1
), t AS (
  INSERT INTO rate_tables (kind, name, product_category_id, currency, description, created_by_id, updated_by_id, inserted_at, updated_at)
  SELECT kind, name || ' (copy)', product_category_id, currency, 'Line-for-line copy (fake)', created_by_id, updated_by_id, inserted_at, updated_at
    FROM src RETURNING id
)
INSERT INTO rate_lines (rate_table_id, mccmnc_id, mccmnc, dial_code, sender_id, rate, currency, valid_from, valid_to, is_blocked,
    change_type, created_by_id, inserted_at, updated_at)
SELECT t.id, l.mccmnc_id, l.mccmnc, l.dial_code, l.sender_id, l.rate, l.currency, l.valid_from, l.valid_to, l.is_blocked,
       l.change_type, l.created_by_id, l.inserted_at, l.updated_at
  FROM t, rate_lines l, src WHERE l.rate_table_id = src.id;

DROP TABLE fx_src;
