// Route map (§6.3): for one customer trunk, which rule and vendor each destination it sells
// gets today. Every destination with a sell line in the trunk's rate tables is run through the
// live rules in order (steady state: no receiver, content or warm-up), with the same engine as
// Rate Lookup and the Route Rules simulator. Rows are computed per trunk, kept a minute, and
// queried through the list engine, so filter, sort and paging stay server-side (rule 3).
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ListQuery, LookupDestination, RouteMapRow } from "@sms/contract";
import type pg from "pg";
import { withDb } from "../db.js";
import { compileQuery, runList } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { routeMapList, routeMapRows, routeMapTrunk } from "../lists/defs.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { PLATFORM_CURRENCY } from "../currency.js";
import { clientLines, routedVendors, type ClientLine, type Dest, type RouteOutcome } from "./rateLookup.js";
import { csvText } from "../csvSafe.js";

type Db = pg.Pool | pg.PoolClient;

const TTL_MS = 60_000;
const computedAt = new Map<number, number>();
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Every live destination with the codes a sell line may come from: its own, then its country's. */
async function allDestinations(db: Db): Promise<(Dest & { id: number })[]> {
  const { rows } = await db.query(
    `SELECT m.id, m.mccmnc, m.mcc, m.network, m.is_all_networks, co.name AS country, co.iso AS country_iso
       FROM mccmnc m JOIN countries co ON co.id = m.country_id WHERE m.deleted_at IS NULL`,
  );
  return rows.map((r) => {
    const d: LookupDestination = {
      mccmnc: r.mccmnc,
      mcc: String(r.mcc).trim(),
      country: r.country,
      countryIso: String(r.country_iso).trim(),
      network: r.is_all_networks ? "All networks" : r.network,
      allNetworks: !!r.is_all_networks,
    };
    return { ...d, id: Number(r.id), codes: d.allNetworks ? [d.mcc] : [d.mccmnc, d.mcc] };
  });
}

/** Computes (or reuses) the trunk's route map rows. */
export async function computeRouteMap(db: Db, trunkId: number, force = false) {
  const at = computedAt.get(trunkId);
  if (!force && at && Date.now() - at < TTL_MS && routeMapRows.has(trunkId)) return routeMapRows.get(trunkId)!;
  const gen = generation;
  const rows = await routeMapFor(db, trunkId);
  // Computed from data a save has changed meanwhile: answered, not kept (team trial round 12).
  if (gen !== generation) return rows;
  routeMapRows.set(trunkId, rows);
  computedAt.set(trunkId, Date.now());
  // Keep the cache small: a handful of recently viewed trunks.
  if (routeMapRows.size > 20) {
    const oldest = [...computedAt].sort((a, b) => a[1] - b[1])[0]![0];
    routeMapRows.delete(oldest);
    computedAt.delete(oldest);
  }
  return rows;
}

/** The trunk's route map rows, computed now (no cache; also used by the live traffic simulator). */
export async function routeMapFor(db: Db, trunkId: number): Promise<RouteMapRow[]> {
  const dests = await allDestinations(db);
  const byCode = new Map(dests.map((d) => [d.mccmnc, d]));
  const lines: ClientLine[] = await clientLines(db, dests, {
    at: new Date(),
    senderId: null,
    includeInactive: true,
    customerTrunkIds: [trunkId],
  });
  const outcomes = new Map<string, RouteOutcome>();
  const routed = await routedVendors(db, lines, undefined, outcomes);
  const ruleIds = [...new Set([...outcomes.values()].map((o) => o.ruleId).filter((x): x is number => x !== null))];
  const { rows: rules } = await db.query("SELECT id, name, priority, route_type FROM route_rules WHERE id = ANY($1)", [
    ruleIds,
  ]);
  const ruleById = new Map(rules.map((r) => [Number(r.id), r]));
  // Each rule's vendors as configured (team trial round 8): the Route map shows the whole split, not one vendor.
  const { rows: rv } = await db.query(
    `SELECT v.route_rule_id, v.vendor_trunk_id, vt.name, v.level, v.share_pct, v.is_backup
       FROM route_rule_vendors v JOIN vendor_trunks vt ON vt.id = v.vendor_trunk_id
      WHERE v.route_rule_id = ANY($1) ORDER BY v.route_rule_id, v.level, v.is_backup, v.share_pct DESC NULLS LAST, vt.name`,
    [ruleIds],
  );
  const setupOf = new Map<number, RouteMapRow["vendorSetup"]>();
  for (const v of rv)
    setupOf.set(Number(v.route_rule_id), [
      ...(setupOf.get(Number(v.route_rule_id)) ?? []),
      {
        vendorTrunkId: Number(v.vendor_trunk_id),
        name: String(v.name),
        level: Number(v.level),
        sharePct: v.share_pct === null ? null : Number(v.share_pct),
        backup: !!v.is_backup,
      },
    ]);
  const rows = lines.map((l) => {
    const d = byCode.get(l.req)!;
    const key = `${l.req}|${trunkId}`;
    const r = routed.get(key) ?? null;
    const o = outcomes.get(key) ?? { outcome: "no_rule" as const, ruleId: null };
    const rule = o.ruleId === null ? null : ruleById.get(o.ruleId);
    const margin = r?.cost == null ? null : round(l.conv - r.cost, 6);
    const status: RouteMapRow["status"] =
      o.outcome === "route" && r
        ? "routed"
        : o.outcome === "block"
          ? "blocked"
          : o.outcome === "no_rule"
            ? "no_rule"
            : "no_vendor";
    return {
      id: d.id,
      mccmnc: d.mccmnc,
      country: d.country,
      network: d.network,
      allNetworks: d.allNetworks,
      sellRate: l.rate,
      sellCurrency: l.currency,
      sellRateConverted: round(l.conv, 6),
      rateTableId: l.tableId,
      rateTableName: l.tableName,
      status,
      ruleId: rule ? Number(rule.id) : null,
      ruleName: rule ? (rule.name as string) : null,
      rulePriority: rule ? Number(rule.priority) : null,
      routeType: rule ? (rule.route_type as RouteMapRow["routeType"]) : null,
      vendorTrunkId: r?.vendorTrunkId ?? null,
      vendor: r?.name ?? null,
      vendorCost: r?.cost ?? null,
      margin,
      marginPct: margin === null || l.conv <= 0 ? null : round((margin / l.conv) * 100, 1),
      decidedBy: r?.decidedBy ?? null,
      vendorSetup: rule && rule.route_type === "static" ? (setupOf.get(Number(rule.id)) ?? []) : [],
    };
  });
  return rows as RouteMapRow[];
}

/**
 * Bumped by every change that can move routes; a computation that started before it is not kept as fresh (team trial
 * round 12: a refresh running during a save marked its old answer fresh for another minute).
 */
let generation = 0;
/** When the last such change was made (0 = none since the start). */
let changedAt = 0;

/** Forgets computed route maps (after a rate, rule or trunk change, or an undo); routed costs refresh on their next view. */
export function clearRouteMaps() {
  generation++;
  changedAt = Date.now();
  routeMapRows.clear();
  computedAt.clear();
}

// ---------------------------------------------------------------- routed costs (Rate Manager, team trial round 2)

/** When each trunk's routed costs were written to route_cost_cache (0 = due for a refresh). */
const costsAt = new Map<number, number>();
const refreshing = new Map<number, { gen: number; job: Promise<void> }>();

/** Writes the vendor and cost the route rules choose for each destination the trunk sells (Route map engine). */
export function refreshRouteCosts(db: Db, trunkId: number): Promise<void> {
  const running = refreshing.get(trunkId);
  if (running?.gen === generation) return running.job;
  // One started before the last change: a new one follows it, so the answer is from the changed data.
  const gen = generation;
  const job = (async () => {
    await running?.job.catch(() => undefined);
    const rows = await routeMapFor(db, trunkId);
    const { rows: fx } = await db.query("SELECT rate_per_eur FROM currency_latest WHERE iso = $1", [PLATFORM_CURRENCY]);
    const perEur = Number(fx[0]?.rate_per_eur ?? 1) || 1;
    const seen = new Set<number>();
    const keep = rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
    await db.query("DELETE FROM route_cost_cache WHERE customer_trunk_id = $1", [trunkId]);
    if (keep.length)
      await db.query(
        `INSERT INTO route_cost_cache (customer_trunk_id, mccmnc_id, vendor_trunk_id, vendor_name, cost_eur)
         SELECT $1, * FROM unnest($2::int[], $3::int[], $4::text[], $5::numeric[])`,
        [
          trunkId,
          keep.map((r) => r.id),
          keep.map((r) => r.vendorTrunkId),
          keep.map((r) => r.vendor),
          keep.map((r) => (r.vendorCost === null ? null : r.vendorCost / perEur)),
        ],
      );
    if (gen === generation) costsAt.set(trunkId, Date.now());
  })().finally(() => {
    if (refreshing.get(trunkId)?.job === job) refreshing.delete(trunkId);
  });
  refreshing.set(trunkId, { gen, job });
  return job;
}

/**
 * Routed costs for a sell table's first customer trunk: computed now when there are none yet, else served from
 * the cache and refreshed in the background once older than a minute.
 */
export async function ensureRouteCosts(db: Db, rateTableId: number): Promise<void> {
  const { rows } = await db.query(
    `SELECT min(x.customer_trunk_id) AS t FROM customer_trunk_rate_tables x
       JOIN customer_trunks xt ON xt.id = x.customer_trunk_id AND xt.deleted_at IS NULL
       JOIN rate_tables rt ON rt.id = x.rate_table_id AND rt.kind = 'customer'
      WHERE x.rate_table_id = $1`,
    [rateTableId],
  );
  const trunk = rows[0]?.t == null ? null : Number(rows[0].t);
  if (trunk === null) return;
  if (!costsAt.has(trunk)) {
    const { rows: cached } = await db.query("SELECT 1 FROM route_cost_cache WHERE customer_trunk_id = $1 LIMIT 1", [
      trunk,
    ]);
    if (!cached.length) return refreshRouteCosts(db, trunk);
    costsAt.set(trunk, 0);
  }
  // Written before the last change: this view waits for the new routed costs, so a rate or rule just saved shows at
  // once (team trial round 12). Merely older than a minute: refreshed in the background.
  if (costsAt.get(trunk)! < changedAt) return refreshRouteCosts(db, trunk);
  if (Date.now() - costsAt.get(trunk)! > TTL_MS) void refreshRouteCosts(db, trunk).catch(() => undefined);
}

/** Fills the routed costs of every sell table slowly in the background, oldest first (one trunk at a time). */
export function startRouteCostWarmer(db: Db, everyMs = 5_000): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { rows } = await db.query(
        `SELECT t.id FROM (SELECT min(x.customer_trunk_id) AS id FROM customer_trunk_rate_tables x
             JOIN customer_trunks xt ON xt.id = x.customer_trunk_id AND xt.deleted_at IS NULL
             JOIN rate_tables rt ON rt.id = x.rate_table_id AND rt.kind = 'customer' GROUP BY x.rate_table_id) t
           LEFT JOIN (SELECT customer_trunk_id, max(computed_at) AS at FROM route_cost_cache GROUP BY 1) c
             ON c.customer_trunk_id = t.id
          ORDER BY c.at NULLS FIRST LIMIT 1`,
      );
      const id = rows[0]?.id;
      if (id != null) await refreshRouteCosts(db, Number(id));
    } catch {
      // The next tick tries again.
    } finally {
      busy = false;
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function checkQuery(reply: FastifyReply, query: ListQuery): number | FastifyReply {
  const trunk = routeMapTrunk(query);
  if (trunk === null)
    return sendProblem(reply, 400, "Invalid list query", {
      errors: [{ path: "/filter", message: "the filter needs a top-level customerTrunkId eq condition" }],
    });
  const errors = checkListQuery(query, listFields.route_map);
  return errors.length ? sendProblem(reply, 400, "Invalid list query", { errors }) : trunk;
}

export function queryRouteMap(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const trunk = checkQuery(reply, query);
  if (typeof trunk !== "number") return trunk;
  return withDb(reply, async (pool) => {
    await computeRouteMap(pool, trunk);
    return runList(pool, routeMapList, query);
  });
}

const csvCell = (v: unknown) => {
  const s = csvText(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function exportRouteMap(request: FastifyRequest, reply: FastifyReply) {
  const query = { ...(request.body as ListQuery), limit: 100_000, cursor: null };
  const trunk = checkQuery(reply, query);
  if (typeof trunk !== "number") return trunk;
  return withDb(reply, async (pool) => {
    await computeRouteMap(pool, trunk);
    const q = compileQuery(routeMapList as never, query);
    const { rows } = await pool.query(q.sql, q.values);
    const cols: [string, keyof RouteMapRow][] = [
      ["Country", "country"],
      ["Network", "network"],
      ["MCCMNC", "mccmnc"],
      ["Sell rate", "sellRate"],
      ["Currency", "sellCurrency"],
      ["Rate table", "rateTableName"],
      ["Route", "status"],
      ["Rule", "ruleName"],
      ["Priority", "rulePriority"],
      ["Type", "routeType"],
      ["Vendor", "vendor"],
      ["Vendor cost", "vendorCost"],
      ["Margin", "margin"],
      ["Margin %", "marginPct"],
      ["Decided by", "decidedBy"],
    ];
    const lines = rows.slice(0, q.limit).map((r) => {
      const row = routeMapList.mapRow(r);
      return cols.map(([, k]) => csvCell(row[k])).join(",");
    });
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="route_map_trunk_${trunk}.csv"`)
      .send([cols.map(([h]) => h).join(","), ...lines].join("\r\n") + "\r\n");
  });
}
