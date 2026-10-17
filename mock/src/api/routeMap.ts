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
import { clientLines, routedVendors, type ClientLine, type Dest, type RouteOutcome } from "./rateLookup.js";

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
    };
  });
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

/** Forgets computed route maps (after a rate change or an undo). */
export function clearRouteMaps() {
  routeMapRows.clear();
  computedAt.clear();
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
  if (v == null) return "";
  const s = String(v);
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
