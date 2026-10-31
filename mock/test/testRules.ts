// Removes route rules a test created (QA 2026-10-31): archiving left them in the shared database, and the ones a test
// leaves active route live traffic and show on Route rules (§6.3). Every rule whose name holds the test run's tag goes,
// with its vendors, whitelists, traffic rows and change history. A hard delete for test data only; the app archives
// (§13.29).
import { db } from "../src/db.js";

/** Deletes the route rules whose name contains ` <tag>` (a test run's unique tag, e.g. Date.now().toString(36)). */
export async function deleteTestRouteRules(tag: string): Promise<number> {
  if (!/^[a-z0-9]{6,}$/.test(tag)) throw new Error(`not a test run tag: ${tag}`);
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query<{ id: string }>("SELECT id FROM route_rules WHERE name LIKE $1", [`% ${tag}%`]);
    const ids = rows.map((r) => Number(r.id));
    if (ids.length) {
      await c.query("DELETE FROM changes WHERE entity_type = 'route_rule' AND entity_ids <@ $1::bigint[]", [ids]);
      for (const table of ["route_rule_vendors", "route_rule_whitelists", "route_rule_traffic"])
        await c.query(`DELETE FROM ${table} WHERE route_rule_id = ANY($1)`, [ids]);
      await c.query("DELETE FROM route_rules WHERE id = ANY($1)", [ids]);
    }
    await c.query("COMMIT");
    return ids.length;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}
