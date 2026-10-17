// Removes enterprises a test created, with their trunks, rate tables, contacts, billing,
// finance rows and change history, so test partners never reach the live simulator,
// dashboard or alert incidents (§13.3, §13.4). This is a hard delete for test data only;
// the app itself archives (§13.29). Dependent rows go first, in foreign-key order.
import { db } from "../src/db.js";

const IDS = `
CREATE TEMP TABLE x_ct ON COMMIT DROP AS SELECT id FROM customer_trunks WHERE enterprise_id IN (SELECT id FROM x_ent);
CREATE TEMP TABLE x_vt ON COMMIT DROP AS SELECT id FROM vendor_trunks WHERE enterprise_id IN (SELECT id FROM x_ent);
CREATE TEMP TABLE x_rt ON COMMIT DROP AS SELECT id FROM rate_tables WHERE vendor_trunk_id IN (SELECT id FROM x_vt);
CREATE TEMP TABLE x_doc ON COMMIT DROP AS SELECT id FROM enterprise_docs WHERE enterprise_id IN (SELECT id FROM x_ent);
CREATE TEMP TABLE x_inv ON COMMIT DROP AS SELECT id FROM invoices WHERE enterprise_id IN (SELECT id FROM x_ent);
CREATE TEMP TABLE x_vinv ON COMMIT DROP AS SELECT id FROM vendor_invoices WHERE enterprise_id IN (SELECT id FROM x_ent);
CREATE TEMP TABLE x_tx ON COMMIT DROP AS SELECT id FROM transactions
  WHERE enterprise_id IN (SELECT id FROM x_ent) OR invoice_id IN (SELECT id FROM x_inv);
CREATE TEMP TABLE x_rr ON COMMIT DROP AS SELECT id FROM rerating_requests WHERE rate_table_id IN (SELECT id FROM x_rt);
`;

/** The delete statements, run after x_ent holds the enterprise ids. Also the body of the
 *  one-off dev-database cleanup documented in the PR. */
export const DELETE_SQL = `${IDS}
-- change history (§13.10) and audit trail of the removed records
DELETE FROM changes WHERE
     (entity_type = 'enterprise' AND entity_ids && ARRAY(SELECT id FROM x_ent))
  OR (entity_type = 'enterprise_doc' AND entity_ids && ARRAY(SELECT id FROM x_doc))
  OR (entity_type = 'customer_trunk' AND entity_ids && ARRAY(SELECT id FROM x_ct))
  OR (entity_type = 'vendor_trunk' AND entity_ids && ARRAY(SELECT id FROM x_vt))
  OR (entity_type = 'rate_table' AND entity_ids && ARRAY(SELECT id FROM x_rt));
DELETE FROM audit_log WHERE
     (table_name = 'enterprises' AND master_id IN (SELECT id::text FROM x_ent))
  OR (table_name = 'customer_trunks' AND master_id IN (SELECT id::text FROM x_ct))
  OR (table_name = 'vendor_trunks' AND master_id IN (SELECT id::text FROM x_vt));

-- finance (§7)
DELETE FROM soa_adjustments WHERE enterprise_id IN (SELECT id FROM x_ent) OR invoice_id IN (SELECT id FROM x_inv)
  OR transaction_id IN (SELECT id FROM x_tx) OR vendor_invoice_id IN (SELECT id FROM x_vinv);
DELETE FROM rerating_results WHERE enterprise_id IN (SELECT id FROM x_ent) OR transaction_id IN (SELECT id FROM x_tx)
  OR request_id IN (SELECT id FROM x_rr);
DELETE FROM transactions WHERE id IN (SELECT id FROM x_tx);
DELETE FROM invoice_requests WHERE enterprise_id IN (SELECT id FROM x_ent) OR invoice_id IN (SELECT id FROM x_inv);
DELETE FROM invoices WHERE id IN (SELECT id FROM x_inv);
DELETE FROM vendor_invoice_events WHERE vendor_invoice_id IN (SELECT id FROM x_vinv);
DELETE FROM vendor_invoice_lines WHERE vendor_invoice_id IN (SELECT id FROM x_vinv);
DELETE FROM vendor_invoices WHERE id IN (SELECT id FROM x_vinv);
DELETE FROM soa_reports WHERE enterprise_id IN (SELECT id FROM x_ent);
DELETE FROM recon_rules WHERE enterprise_id IN (SELECT id FROM x_ent);

-- alerts, logs and portal users
DELETE FROM daily_traffic_alerts WHERE enterprise_id IN (SELECT id FROM x_ent);
DELETE FROM customer_portal_users WHERE enterprise_id IN (SELECT id FROM x_ent);
DELETE FROM email_logs WHERE enterprise_id IN (SELECT id FROM x_ent)
  OR customer_trunk_id IN (SELECT id FROM x_ct) OR vendor_trunk_id IN (SELECT id FROM x_vt);
DELETE FROM traffic_alerts WHERE customer_trunk_id IN (SELECT id FROM x_ct) OR vendor_trunk_id IN (SELECT id FROM x_vt);

-- trunk links and rule settings (§5.4, §5.5, §13.2)
DELETE FROM mo_numbers WHERE customer_trunk_id IN (SELECT id FROM x_ct);
DELETE FROM hlr_rule_trunk_settings WHERE customer_trunk_id IN (SELECT id FROM x_ct);
DELETE FROM hlr_rule_targets WHERE (target_type = 'trunk' AND target_id IN (SELECT id FROM x_ct))
  OR (target_type = 'enterprise' AND target_id IN (SELECT id FROM x_ent));
DELETE FROM translation_rule_trunk_settings WHERE (trunk_kind = 'customer' AND trunk_id IN (SELECT id FROM x_ct))
  OR (trunk_kind = 'vendor' AND trunk_id IN (SELECT id FROM x_vt));
DELETE FROM translation_rule_targets WHERE (target_type = 'trunk' AND trunk_kind = 'customer' AND target_id IN (SELECT id FROM x_ct))
  OR (target_type = 'trunk' AND trunk_kind = 'vendor' AND target_id IN (SELECT id FROM x_vt))
  OR (target_type = 'enterprise' AND target_id IN (SELECT id FROM x_ent));
DELETE FROM customer_trunk_rate_tables WHERE customer_trunk_id IN (SELECT id FROM x_ct) OR rate_table_id IN (SELECT id FROM x_rt);
DELETE FROM route_rule_vendors WHERE vendor_trunk_id IN (SELECT id FROM x_vt);
DELETE FROM route_rule_whitelists WHERE vendor_trunk_id IN (SELECT id FROM x_vt);
DELETE FROM repush_requests WHERE vendor_trunk_id IN (SELECT id FROM x_vt);
UPDATE customer_trunks SET express_vendor_trunk_id = NULL WHERE express_vendor_trunk_id IN (SELECT id FROM x_vt);
DELETE FROM trunk_binds WHERE (side = 'customer' AND trunk_id IN (SELECT id FROM x_ct)) OR (side = 'vendor' AND trunk_id IN (SELECT id FROM x_vt));
DELETE FROM bind_sessions WHERE (side = 'customer' AND trunk_id IN (SELECT id FROM x_ct)) OR (side = 'vendor' AND trunk_id IN (SELECT id FROM x_vt));
DELETE FROM qbr_stats WHERE (side = 'customer' AND trunk_id IN (SELECT id FROM x_ct)) OR (side = 'vendor' AND trunk_id IN (SELECT id FROM x_vt));

-- vendor-owned rate tables (§13.12)
DELETE FROM rerating_requests WHERE id IN (SELECT id FROM x_rr);
DELETE FROM rate_imports WHERE rate_table_id IN (SELECT id FROM x_rt);
DELETE FROM rate_table_stats WHERE rate_table_id IN (SELECT id FROM x_rt);
DELETE FROM rate_lines WHERE rate_table_id IN (SELECT id FROM x_rt);
DELETE FROM rate_tables WHERE id IN (SELECT id FROM x_rt);

-- trunks, then the enterprise record (§5.1–5.5)
DELETE FROM customer_trunks WHERE id IN (SELECT id FROM x_ct);
DELETE FROM vendor_trunks WHERE id IN (SELECT id FROM x_vt);
DELETE FROM enterprise_am_history WHERE enterprise_id IN (SELECT id FROM x_ent);
DELETE FROM enterprise_beneficiaries WHERE enterprise_id IN (SELECT id FROM x_ent);
DELETE FROM enterprise_billing WHERE enterprise_id IN (SELECT id FROM x_ent);
DELETE FROM enterprise_contacts WHERE enterprise_id IN (SELECT id FROM x_ent);
DELETE FROM enterprise_docs WHERE enterprise_id IN (SELECT id FROM x_ent);
DELETE FROM enterprises WHERE id IN (SELECT id FROM x_ent);
`;

/** Deletes every enterprise whose name matches the LIKE pattern, and all that hangs off it.
 *  Returns the number of enterprises removed. */
export async function deleteTestEnterprises(namePattern: string): Promise<number> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      "CREATE TEMP TABLE x_ent ON COMMIT DROP AS SELECT id FROM enterprises WHERE name LIKE $1",
      [namePattern],
    );
    await client.query(DELETE_SQL);
    await client.query("COMMIT");
    return rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
