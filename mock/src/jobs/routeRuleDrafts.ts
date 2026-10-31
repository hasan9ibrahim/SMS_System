// Never-saved New rule drafts (§6.3, §13.10, contract v0.129.0). The New rule window adds its rule at once as a draft
// (route_rules.draft, migration 104) and discards it on ×, tab close, reload or window close; only its Save keeps it.
// A draft is still left behind when the page reloads while the window is adding it (the id never reached the page),
// so once an hour the server that runs the jobs (leader.ts) removes the drafts older than 24 hours, by the definition
// discard uses: never turned on, not on now, no traffic ever. They go as discard removes them, with their vendors,
// whitelists, traffic rows and change history: a draft that was never saved leaves no history.
import type pg from "pg";
import { db } from "../db.js";
import { everTurnedOnSql, removeNeverAdded, ruleAttempts } from "../api/routeRules.js";
import { inTransaction } from "../api/views.js";

const MAX_AGE_HOURS = 24;
const BATCH = 500;

/** One round: removes the drafts that qualify; returns their ids. Nothing is removed while the EDR store is down. */
export async function sweepRouteRuleDrafts(pool: pg.Pool = db()): Promise<number[]> {
  const { rows } = await pool.query(
    `SELECT r.id FROM route_rules r
      WHERE r.draft AND r.inserted_at < now() - make_interval(hours => $1) AND r.status <> 'active'
        AND NOT ${everTurnedOnSql("r.id")}
      ORDER BY r.id LIMIT ${BATCH}`,
    [MAX_AGE_HOURS],
  );
  const ids = rows.map((r) => Number(r.id));
  // Traffic decides like discard: unknown traffic (the EDR store did not answer) keeps every draft for the next round.
  const attempts = await ruleAttempts(ids);
  if (!attempts) return [];
  const gone: number[] = [];
  for (const id of ids) {
    if ((attempts.get(id) ?? 0) > 0) continue;
    // Checked again in the transaction, under the row's lock: a Save that kept it in the meantime wins.
    const removed = await inTransaction(pool, async (c) => {
      const { rows: still } = await c.query(
        `SELECT 1 FROM route_rules r WHERE r.id = $1 AND r.draft AND r.status <> 'active'
            AND NOT ${everTurnedOnSql("r.id")} FOR UPDATE`,
        [id],
      );
      if (!still[0]) return false;
      await removeNeverAdded(c, id);
      return true;
    });
    if (removed) gone.push(id);
  }
  return gone;
}

/** Hourly on the server that runs the jobs; the first round a few minutes after start. */
export function startRouteRuleDraftSweep() {
  const tick = () =>
    void sweepRouteRuleDrafts()
      .then((ids) => ids.length && console.info(`route rule drafts: removed never saved ${ids.join(", ")}`))
      .catch((err: Error) => console.warn(`route rule drafts: ${err.message}`));
  setTimeout(tick, 5 * 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
