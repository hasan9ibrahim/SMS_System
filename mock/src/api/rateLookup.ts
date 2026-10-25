// Rate Lookup (§13.16): find a destination as you type (name, MCCMNC, dial code or phone
// number), compare every vendor cost with every client rate for it, and an advanced matrix
// over many destinations with filters, a point in time, four views and highlights. Saved
// lookups are private with optional read-only sharing, like saved views (§13.25).
import { atLimit, qbrQuality, qualityFor, tpsNow, vendorTiers } from "../lcr/data.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  LookupClientRate,
  LookupDestination,
  LookupResolution,
  LookupVendorCost,
  MatrixCell,
  MatrixColumn,
  MatrixHighlight,
  MatrixRow,
  RateLookupQuery,
  RateLookupRequest,
  RateLookupResult,
  RateMatrix,
  RateMatrixRequest,
  SavedLookup,
  SavedLookupInput,
} from "@sms/contract";
import { PLATFORM_CURRENCY, toPlatformSql } from "../currency.js";
import { withDb } from "../db.js";
import { chRows } from "../edr.js";
import { qbrDlrByCode } from "./qbr.js";
import { sendProblem } from "../problem.js";
import { rulesForDestination, type VendorOption } from "../routing/evaluate.js";
import { loadRulesInOrder, routeThrough, vendorQuality, type RuleCore } from "./routeRules.js";
import { windowEnd } from "./routeTraffic.js";
import { currentUserId, getCurrentUser } from "./session.js";
import { inputProblem, inTransaction, writeShares } from "./views.js";
import { production } from "../mode.js";

type Db = pg.Pool | pg.PoolClient;
/** Converted figures and margins are in the platform currency (decided 2026-10-16: EUR by default). */
export const LOOKUP_CURRENCY = PLATFORM_CURRENCY;
const MAX_COLUMNS = 60;
const EXPIRING_MS = 14 * 86_400_000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const round2 = (v: number) => Math.round(v * 100) / 100;
const pct = (margin: number | null, sell: number) =>
  margin === null || sell <= 0 ? null : Math.round((margin / sell) * 1000) / 10;

// ---------------------------------------------------------------- destinations

const DEST_SELECT = `SELECT m.mccmnc, m.mcc, m.network, m.is_all_networks, co.name AS country, co.iso AS country_iso
  FROM mccmnc m JOIN countries co ON co.id = m.country_id`;

const toDest = (r: Record<string, unknown>): LookupDestination => ({
  mccmnc: r.mccmnc as string,
  mcc: String(r.mcc).trim(),
  country: r.country as string,
  countryIso: String(r.country_iso).trim(),
  network: r.is_all_networks ? "All networks" : (r.network as string),
  allNetworks: !!r.is_all_networks,
});

const prefixesOf = (n: string) => Array.from({ length: n.length }, (_, i) => n.slice(0, i + 1));
export const normaliseNumber = (q: string) => q.replace(/[\s\-().]/g, "").replace(/^\+/, "");

/** A stable fake HLR answer: about one number in seven is ported to another network of its country. */
function fakeHlrPorted(number: string): boolean {
  let h = 7;
  for (const ch of number) h = (h * 131 + ch.charCodeAt(0)) % 1_000_003;
  return h % 7 === 0;
}

export async function resolveDestinations(db: Db, q: string, live: boolean): Promise<LookupResolution> {
  const text = q.trim();
  const digits = normaliseNumber(text);
  if (/^[0-9]{6,15}$/.test(digits) && !/^[0-9]{3,6}$/.test(text)) {
    const { rows } = await db.query(
      `SELECT d.prefix, m.id, m.country_id, m.mccmnc, m.mcc, m.network, m.is_all_networks, co.name AS country, co.iso AS country_iso
         FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id JOIN countries co ON co.id = m.country_id
        WHERE d.prefix = ANY($1) AND d.profile = 'All' AND d.deleted_at IS NULL ORDER BY length(d.prefix) DESC LIMIT 1`,
      [prefixesOf(digits)],
    );
    const hit = rows[0];
    if (!hit)
      return {
        kind: "number",
        number: { resolvedBy: live ? "hlr" : "prefix", prefix: null, ported: null },
        destinations: [],
      };
    let dest = hit;
    let ported: boolean | null = null;
    // Production (backend step 11): no invented HLR answer. A live lookup from this screen needs the switch's HLR
    // client (docs/BACKEND_TODO.md); until then the number resolves by its prefix.
    if (live && !production) {
      ported = fakeHlrPorted(digits);
      if (ported) {
        const { rows: others } = await db.query(
          `${DEST_SELECT} WHERE m.country_id = $1 AND NOT m.is_all_networks AND m.id <> $2 ORDER BY m.mccmnc`,
          [hit.country_id, hit.id],
        );
        if (others.length) dest = others[Number(digits.slice(-3)) % others.length];
        else ported = false;
      }
    }
    const { rows: country } = await db.query(`${DEST_SELECT} WHERE m.mccmnc = $1`, [String(hit.mcc).trim()]);
    return {
      kind: "number",
      number: { resolvedBy: live ? "hlr" : "prefix", prefix: hit.prefix, ported },
      destinations: [toDest(dest), ...country.filter((c) => c.mccmnc !== dest.mccmnc).map(toDest)],
    };
  }
  if (/^[0-9]{1,6}$/.test(text)) {
    // MCCMNC prefix, or a country dial code ("61"), or a numbering-plan prefix.
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (m.mccmnc) m.mccmnc, m.mcc, m.network, m.is_all_networks, co.name AS country, co.iso AS country_iso,
                CASE WHEN m.mccmnc = $1 THEN 0 WHEN co.dial_code = $1 AND m.is_all_networks THEN 1
                     WHEN co.dial_code = $1 THEN 2 WHEN m.mccmnc LIKE $1 || '%' THEN 3 ELSE 4 END AS rank
           FROM mccmnc m JOIN countries co ON co.id = m.country_id
          WHERE m.deleted_at IS NULL AND (m.mccmnc LIKE $1 || '%' OR co.dial_code = $1
             OR m.id IN (SELECT mccmnc_id FROM dial_codes WHERE prefix = $1 AND profile = 'All' AND deleted_at IS NULL))
          ORDER BY m.mccmnc) x
        ORDER BY rank, length(mccmnc), mccmnc LIMIT 20`,
      [text],
    );
    return { kind: "text", number: null, destinations: rows.map(toDest) };
  }
  const { rows } = await db.query(
    `SELECT m.mccmnc, m.mcc, m.network, m.is_all_networks, co.name AS country, co.iso AS country_iso
       FROM mccmnc m JOIN countries co ON co.id = m.country_id
      WHERE m.deleted_at IS NULL AND (co.name ILIKE $1 || '%' OR co.name ILIKE '% ' || $1 || '%' OR m.network ILIKE '%' || $1 || '%')
      ORDER BY CASE WHEN co.name ILIKE $1 || '%' THEN (CASE WHEN m.is_all_networks THEN 0 ELSE 1 END)
                    WHEN m.network ILIKE $1 || '%' THEN 2 ELSE 3 END,
               co.name, m.is_all_networks DESC, m.network
      LIMIT 20`,
    [text.replace(/[%_\\]/g, "\\$&")],
  );
  return { kind: "text", number: null, destinations: rows.map(toDest) };
}

export function resolveLookupDestinations(request: FastifyRequest, reply: FastifyReply) {
  const { q, live } = request.query as { q: string; live?: boolean };
  return withDb(reply, (pool) => resolveDestinations(pool, q, !!live));
}

// ---------------------------------------------------------------- rate lines

interface Dest extends LookupDestination {
  /** Codes whose lines count for this destination, best first: the code, then the country line. */
  codes: string[];
}

/** A network falls back to its country line; a country uses its own line, else its cheapest network. */
export async function withCodes(db: Db, dests: LookupDestination[]): Promise<Dest[]> {
  const countries = [...new Set(dests.filter((d) => d.allNetworks).map((d) => d.mcc))];
  const networks = new Map<string, string[]>();
  if (countries.length) {
    const { rows } = await db.query(
      "SELECT mcc, array_agg(mccmnc ORDER BY mccmnc) AS codes FROM mccmnc WHERE mcc = ANY($1) AND NOT is_all_networks GROUP BY mcc",
      [countries],
    );
    for (const r of rows) networks.set(String(r.mcc).trim(), r.codes as string[]);
  }
  return dests.map((d) => ({
    ...d,
    codes: d.allNetworks ? [d.mccmnc, ...(networks.get(d.mcc) ?? [])] : [d.mccmnc, d.mcc],
  }));
}

interface Filters {
  at: Date;
  senderId: string | null;
  includeInactive: boolean;
  vendorTrunkIds?: number[] | undefined;
  vendorEnterpriseIds?: number[] | undefined;
  tiers?: string[] | undefined;
  categoryIds?: number[] | undefined;
  businessCompanyIds?: number[] | undefined;
  currencies?: string[] | undefined;
  accountManagerIds?: number[] | undefined;
  customerEnterpriseIds?: number[] | undefined;
  customerTrunkIds?: number[] | undefined;
  rateTableIds?: number[] | undefined;
}

interface Line {
  req: string;
  tableId: number;
  rate: number;
  currency: string;
  conv: number;
  code: string;
  senderId: string | null;
  from: string;
  to: string | null;
  next: { rate: number; conv: number; from: string } | null;
}

interface VendorLine extends Line {
  trunkId: number;
  trunkName: string;
  enterpriseId: number;
  enterpriseName: string;
  tier: "tier1" | "tier2" | "tier3";
  category: string;
  status: "active" | "inactive";
}

interface ClientLine extends Line {
  trunkId: number;
  trunkName: string;
  trunkCategoryId: number | null;
  enterpriseId: number;
  enterpriseName: string;
  tableName: string;
  category: string | null;
  status: "active" | "inactive";
  am: { id: number; name: string } | null;
}

/** (requested code, candidate code, preference) pairs for SQL. */
function pairs(dests: Dest[]) {
  const req: string[] = [];
  const code: string[] = [];
  const pref: number[] = [];
  for (const d of dests)
    d.codes.forEach((c, i) => {
      req.push(d.mccmnc);
      code.push(c);
      pref.push(i === 0 ? 0 : d.allNetworks ? 2 : 1);
    });
  return { req, code, pref };
}

const valid = (alias: string, at: string) =>
  `${alias}.valid_from <= ${at} AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ${at})`;

/** Next version of a line after the one valid at `at` (§13.12 scheduled change). */
const NEXT = `LEFT JOIN LATERAL (
    SELECT n.rate, ${toPlatformSql("n.rate", "ncl.rate_per_eur")} AS conv, n.valid_from FROM rate_lines n
      JOIN currency_latest ncl ON ncl.iso = n.currency
     WHERE n.rate_table_id = x.table_id AND n.mccmnc = x.code AND n.sender_id IS NOT DISTINCT FROM x.sender_id
       AND n.valid_from > $4 AND NOT n.is_blocked
     ORDER BY n.valid_from LIMIT 1) nx ON true`;

const lineOf = (r: Record<string, unknown>): Line => ({
  req: r.req as string,
  tableId: Number(r.table_id),
  rate: Number(r.rate),
  currency: String(r.currency).trim(),
  conv: round6(Number(r.conv)),
  code: r.code as string,
  senderId: (r.sender_id as string | null) ?? null,
  from: (r.valid_from as Date).toISOString(),
  to: r.valid_to ? (r.valid_to as Date).toISOString() : null,
  next:
    r.next_rate === null || r.next_rate === undefined
      ? null
      : { rate: Number(r.next_rate), conv: round6(Number(r.next_conv)), from: (r.next_from as Date).toISOString() },
});

function tableFilters(f: Filters, values: unknown[], side: "vendor" | "customer"): string {
  const add = (sql: string, v: unknown) => {
    values.push(v);
    return sql.replace("$?", `$${values.length}`);
  };
  const where: string[] = [];
  if (f.categoryIds?.length) where.push(add("rt.product_category_id = ANY($?)", f.categoryIds));
  if (f.currencies?.length) where.push(add("rt.currency = ANY($?)", f.currencies));
  if (f.businessCompanyIds?.length) where.push(add("e.business_company_id = ANY($?)", f.businessCompanyIds));
  if (side === "vendor") {
    if (f.vendorTrunkIds?.length) where.push(add("vt.id = ANY($?)", f.vendorTrunkIds));
    if (f.vendorEnterpriseIds?.length) where.push(add("e.id = ANY($?)", f.vendorEnterpriseIds));
    if (f.tiers?.length) where.push(add("e.tier = ANY($?)", f.tiers));
    if (!f.includeInactive) where.push("vt.status = 'active'");
  } else {
    if (f.customerTrunkIds?.length) where.push(add("ct.id = ANY($?)", f.customerTrunkIds));
    if (f.customerEnterpriseIds?.length) where.push(add("e.id = ANY($?)", f.customerEnterpriseIds));
    if (f.accountManagerIds?.length) where.push(add("e.account_manager_id = ANY($?)", f.accountManagerIds));
    if (f.rateTableIds?.length) where.push(add("rt.id = ANY($?)", f.rateTableIds));
    if (!f.includeInactive) where.push("ct.status = 'active'");
  }
  return where.length ? `AND ${where.join(" AND ")}` : "";
}

/** Each vendor trunk's line valid at `at` for each destination. */
export async function vendorLines(db: Db, dests: Dest[], f: Filters): Promise<VendorLine[]> {
  if (!dests.length) return [];
  const p = pairs(dests);
  const values: unknown[] = [p.req, p.code, p.pref, f.at, f.senderId];
  const extra = tableFilters(f, values, "vendor");
  const { rows } = await db.query(
    `SELECT x.*, nx.rate AS next_rate, nx.conv AS next_conv, nx.valid_from AS next_from FROM (
       SELECT DISTINCT ON (d.req, rt.id) d.req, rt.id AS table_id, l.mccmnc AS code, l.rate, l.currency,
              ${toPlatformSql("l.rate")} AS conv, l.sender_id, l.valid_from, l.valid_to,
              vt.id AS trunk_id, vt.name AS trunk_name, vt.status, e.id AS enterprise_id, e.name AS enterprise_name,
              e.tier, pc.name AS category
         FROM unnest($1::text[], $2::text[], $3::int[]) AS d(req, code, pref)
         JOIN rate_lines l ON l.mccmnc = d.code AND ${valid("l", "$4")} AND NOT l.is_blocked
              AND (l.sender_id IS NULL OR l.sender_id = $5)
         JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
         JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id AND vt.deleted_at IS NULL
         JOIN enterprises e ON e.id = vt.enterprise_id
         JOIN product_categories pc ON pc.id = rt.product_category_id
         JOIN currency_latest cl ON cl.iso = l.currency
        WHERE true ${extra}
        ORDER BY d.req, rt.id, (l.sender_id IS NOT NULL) DESC, d.pref, l.rate / cl.rate_per_eur) x
     ${NEXT}`,
    values,
  );
  return rows.map((r) => ({
    ...lineOf(r),
    trunkId: Number(r.trunk_id),
    trunkName: r.trunk_name,
    enterpriseId: Number(r.enterprise_id),
    enterpriseName: r.enterprise_name,
    tier: r.tier,
    category: r.category,
    status: r.status,
  }));
}

/** Each customer trunk's sell rate: the first of its rate tables with a line (§5.4). */
export type { ClientLine, Dest };

export async function clientLines(db: Db, dests: Dest[], f: Filters): Promise<ClientLine[]> {
  if (!dests.length) return [];
  const p = pairs(dests);
  const values: unknown[] = [p.req, p.code, p.pref, f.at, f.senderId];
  const extra = tableFilters(f, values, "customer");
  const { rows } = await db.query(
    `SELECT x.*, nx.rate AS next_rate, nx.conv AS next_conv, nx.valid_from AS next_from FROM (
       SELECT DISTINCT ON (d.req, ct.id) d.req, rt.id AS table_id, rt.name AS table_name, l.mccmnc AS code, l.rate,
              l.currency, ${toPlatformSql("l.rate")} AS conv, l.sender_id, l.valid_from, l.valid_to,
              ct.id AS trunk_id, ct.name AS trunk_name, ct.status, ct.product_category_id AS trunk_category_id,
              e.id AS enterprise_id, e.name AS enterprise_name, pc.name AS category,
              am.id AS am_id, am.first_name || ' ' || am.last_name AS am_name
         FROM unnest($1::text[], $2::text[], $3::int[]) AS d(req, code, pref)
         JOIN rate_lines l ON l.mccmnc = d.code AND ${valid("l", "$4")} AND NOT l.is_blocked
              AND (l.sender_id IS NULL OR l.sender_id = $5)
         JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'customer' AND rt.deleted_at IS NULL
         JOIN customer_trunk_rate_tables ctr ON ctr.rate_table_id = rt.id
         JOIN customer_trunks ct ON ct.id = ctr.customer_trunk_id AND ct.deleted_at IS NULL
         JOIN enterprises e ON e.id = ct.enterprise_id
         LEFT JOIN product_categories pc ON pc.id = ct.product_category_id
         LEFT JOIN users am ON am.id = e.account_manager_id
         JOIN currency_latest cl ON cl.iso = l.currency
        WHERE true ${extra}
        ORDER BY d.req, ct.id, ctr.position, (l.sender_id IS NOT NULL) DESC, d.pref, l.rate / cl.rate_per_eur) x
     ${NEXT}`,
    values,
  );
  return rows.map((r) => ({
    ...lineOf(r),
    trunkId: Number(r.trunk_id),
    trunkName: r.trunk_name,
    trunkCategoryId: r.trunk_category_id === null ? null : Number(r.trunk_category_id),
    enterpriseId: Number(r.enterprise_id),
    enterpriseName: r.enterprise_name,
    tableName: r.table_name,
    category: r.category ?? null,
    status: r.status,
    am: r.am_id ? { id: Number(r.am_id), name: r.am_name } : null,
  }));
}

// ---------------------------------------------------------------- routing and traffic

let rulesCache: { key: string; rules: RuleCore[] } | null = null;

/** All live rules, reloaded when a rule changes (any save touches updated_at or the count). */
async function rulesNow(db: Db): Promise<RuleCore[]> {
  const { rows } = await db.query(
    `SELECT max(updated_at)::text AS at, count(*) AS n, count(*) FILTER (WHERE deleted_at IS NULL) AS live,
            (SELECT max(updated_at)::text || count(*) FROM lcr_profiles) AS lcr FROM route_rules`,
  );
  const key = `${rows[0].at}|${rows[0].n}|${rows[0].live}|${rows[0].lcr}`;
  if (rulesCache?.key !== key) rulesCache = { key, rules: await loadRulesInOrder(db) };
  return rulesCache.rules;
}

const COST_TTL_MS = 60_000;
const costCache = new Map<string, { at: number; costs: { trunkId: number; conv: number }[] }>();

/** Forgets cached routing costs (after a rate change, so routes follow it at once). */
export function clearRoutingCostCache() {
  costCache.clear();
}

/**
 * Each vendor trunk's buy rate now (platform currency) per destination code, for routing: the
 * line for the code, else its country's (a country-level code never takes a network's line).
 * Costs do not depend on the client, so they are kept a minute across Route map trunks.
 */
async function routingCosts(db: Db, reqs: string[]): Promise<{ req: string; trunkId: number; conv: number }[]> {
  const now = Date.now();
  const missing = reqs.filter((r) => (costCache.get(r)?.at ?? 0) < now - COST_TTL_MS);
  if (missing.length) {
    const req: string[] = [];
    const code: string[] = [];
    const pref: number[] = [];
    for (const r of missing)
      (r.length === 3 ? [r] : [r, r.slice(0, 3)]).forEach((c, i) => {
        req.push(r);
        code.push(c);
        pref.push(i);
      });
    const { rows } = await db.query(
      `SELECT DISTINCT ON (d.req, rt.vendor_trunk_id) d.req, rt.vendor_trunk_id AS trunk_id, ${toPlatformSql("l.rate")} AS conv
         FROM unnest($1::text[], $2::text[], $3::int[]) AS d(req, code, pref)
         JOIN rate_lines l ON l.mccmnc = d.code AND l.sender_id IS NULL AND NOT l.is_blocked
              AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
         JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
         JOIN currency_latest cl ON cl.iso = l.currency
        ORDER BY d.req, rt.vendor_trunk_id, d.pref`,
      [req, code, pref],
    );
    const fresh = new Map(missing.map((r) => [r, [] as { trunkId: number; conv: number }[]]));
    for (const r of rows) fresh.get(r.req)!.push({ trunkId: Number(r.trunk_id), conv: Number(r.conv) });
    for (const [r, costs] of fresh) costCache.set(r, { at: now, costs });
  }
  return reqs.flatMap((r) => (costCache.get(r)?.costs ?? []).map((c) => ({ req: r, ...c })));
}

/**
 * What routing sees for each destination: every live, active vendor trunk with its buy rate
 * now (null without a rate), whatever the lookup's vendor filters, in one query for all
 * destinations.
 */
async function routingOptions(
  db: Db,
  clients: ClientLine[],
  vendorsNow?: VendorLine[],
): Promise<Map<string, Map<number, VendorOption>>> {
  const reqs = [...new Set(clients.map((c) => c.req))];
  const [quality, { rows: trunks }, lines] = await Promise.all([
    vendorQuality(),
    db.query("SELECT id, name, product_category_id FROM vendor_trunks WHERE deleted_at IS NULL AND status = 'active'"),
    vendorsNow ? vendorsNow.map((l) => ({ req: l.req, trunkId: l.trunkId, conv: l.conv })) : routingCosts(db, reqs),
  ]);
  const base = (): Map<number, VendorOption> =>
    new Map(
      trunks.map((t) => [
        Number(t.id),
        {
          vendorTrunkId: Number(t.id),
          name: t.name as string,
          cost: null,
          dlr: quality.get(Number(t.id)) ?? null,
          categoryId: t.product_category_id === null ? null : Number(t.product_category_id),
        },
      ]),
    );
  const out = new Map(reqs.map((r) => [r, base()]));
  for (const l of lines) {
    const o = out.get(l.req)?.get(l.trunkId);
    if (o) o.cost = l.conv;
  }
  // QBR orders vendors by the destination's effective DLR (QBR stats, §6.3) where known.
  const codes = [...new Set(reqs.flatMap((r) => [r, r.slice(0, 3)]))];
  const [qbr, lcrQ, tiers] = await Promise.all([qbrDlrByCode(db, codes), qbrQuality(db, codes), vendorTiers(db)]);
  const tps = tpsNow();
  for (const [req, options] of out) {
    const dlr = qbr.get(req) ?? qbr.get(req.slice(0, 3));
    if (dlr) for (const [id, o] of options) if (dlr.has(id)) o.dlr = dlr.get(id)!;
    // LCR profiles also filter on ASR, delay, tier and the TPS limit (§13.23).
    const q = qualityFor(lcrQ, req);
    for (const [id, o] of options) {
      o.asr = q.get(id)?.asr ?? null;
      o.delayS = q.get(id)?.delayS ?? null;
      o.tier = tiers.get(id)?.tier ?? null;
      o.atLimit = atLimit(tps.get(id), tiers.get(id)?.limit);
    }
  }
  return out;
}

export interface RouteOutcome {
  outcome: "route" | "block" | "no_vendor" | "no_rule";
  ruleId: number | null;
}

interface Routed {
  vendorTrunkId: number;
  name: string;
  cost: number | null;
  decidedBy: string;
  ruleId: number;
}

/**
 * The vendor today's rules pick for each client line (trunk × destination). Warm-up is left
 * out (it only applies to a rule's first messages) and no receiver is known, so number
 * whitelists don't apply: this is the steady-state route.
 */
export async function routedVendors(
  db: Db,
  clients: ClientLine[],
  vendorsNow?: VendorLine[],
  /** Filled with each line's outcome and deciding rule, also when no vendor is routed (Route map, §6.3). */
  outcomes?: Map<string, RouteOutcome>,
): Promise<Map<string, Routed | null>> {
  const out = new Map<string, Routed | null>();
  if (!clients.length) return out;
  const rules = await rulesNow(db);
  const byDest = new Map<string, ClientLine[]>();
  for (const c of clients) byDest.set(c.req, [...(byDest.get(c.req) ?? []), c]);
  const now = Date.now();
  const optionsByDest = await routingOptions(db, clients, vendorsNow);
  for (const [mccmnc, lines] of byDest) {
    const candidates = rulesForDestination(rules, mccmnc, now);
    const options = optionsByDest.get(mccmnc) ?? new Map<number, VendorOption>();
    // A trunk's ID only matters to rules that list trunks; otherwise trunks with the same
    // category, sender and sell rate route alike, so each such case is routed once.
    const listed = new Set(candidates.filter((r) => r.customerTrunkMode !== "all").flatMap((r) => r.customerTrunkIds));
    const memo = new Map<string, Routed | null>();
    const memoOutcome = new Map<string, RouteOutcome>();
    for (const c of lines) {
      const key = `${c.trunkCategoryId}|${listed.has(c.trunkId) ? c.trunkId : "-"}|${c.conv}|${c.senderId ?? ""}`;
      if (memo.has(key)) {
        out.set(`${c.req}|${c.trunkId}`, memo.get(key)!);
        outcomes?.set(`${c.req}|${c.trunkId}`, memoOutcome.get(key)!);
        continue;
      }
      const { decision } = routeThrough(
        candidates,
        {
          now,
          customerTrunkId: c.trunkId,
          categoryId: c.trunkCategoryId,
          receiver: "",
          sender: c.senderId ?? "",
          content: "",
          mccmnc,
          destination: null,
          tps: null,
          sellRate: c.conv,
          accumulatedRevenue: null,
          hlrPorted: null,
          warmupSent: Number.MAX_SAFE_INTEGER,
          listHas: () => false,
        },
        options,
        0,
      );
      const v = decision?.outcome === "route" ? decision.vendor : null;
      const routed = v
        ? {
            vendorTrunkId: v.vendorTrunkId,
            name: v.name,
            cost: options.get(v.vendorTrunkId)?.cost ?? null,
            decidedBy: v.decidedBy,
            ruleId: decision!.ruleId,
          }
        : null;
      memo.set(key, routed);
      out.set(`${c.req}|${c.trunkId}`, routed);
      // routeThrough returns only a matching rule's decision; no decision means no rule matched.
      const outcome: RouteOutcome =
        decision && decision.outcome !== "not_matched"
          ? { outcome: decision.outcome, ruleId: decision.ruleId }
          : { outcome: "no_rule", ruleId: null };
      memoOutcome.set(key, outcome);
      outcomes?.set(`${c.req}|${c.trunkId}`, outcome);
    }
  }
  return out;
}

interface Figures {
  n: number;
  asr: number | null;
  dlr: number | null;
}

/** Traffic per trunk for the destinations, over the last `hours` (ending at the latest EDR). */
async function trafficByTrunk(dests: Dest[], side: "c" | "v", hours: number): Promise<Map<string, Figures> | null> {
  if (!dests.length) return new Map();
  const end = await windowEnd();
  if (!end) return null;
  const nets = dests.filter((d) => !d.allNetworks).map((d) => d.mccmnc);
  const ccs = dests.filter((d) => d.allNetworks).map((d) => d.mcc);
  const list = (xs: string[]) => xs.map((x) => `'${x.replace(/\D/g, "")}'`).join(",") || "''";
  const rows = await chRows<{
    code: string;
    mcc: string;
    id: number;
    n: string;
    asr: number | null;
    dlr: number | null;
  }>(
    `SELECT c_mccmnc AS code, substring(c_mccmnc, 1, 3) AS mcc, ${side}_trunk_id AS id, count() AS n,
            round(countIf(is_submit_success = 1) / count() * 100, 1) AS asr,
            round(countIf(msg_status = 'DELIVRD') / greatest(countIf(is_submit_success = 1), 1) * 100, 1) AS dlr
       FROM edr
      WHERE submit_time > toDateTime64('${end}', 3) - INTERVAL ${hours} HOUR AND submit_time <= toDateTime64('${end}', 3)
        AND (c_mccmnc IN (${list(nets)}) OR substring(c_mccmnc, 1, 3) IN (${list(ccs)}))
      GROUP BY code, mcc, id`,
  );
  if (!rows) return null;
  const out = new Map<string, { n: number; ok: number; dl: number }>();
  const add = (key: string, r: (typeof rows)[number]) => {
    const n = Number(r.n);
    const ok = ((r.asr ?? 0) / 100) * n;
    const cur = out.get(key) ?? { n: 0, ok: 0, dl: 0 };
    out.set(key, { n: cur.n + n, ok: cur.ok + ok, dl: cur.dl + ((r.dlr ?? 0) / 100) * ok });
  };
  const ccSet = new Set(ccs);
  const netSet = new Set(nets);
  for (const r of rows) {
    if (netSet.has(r.code)) add(`${r.code}|${r.id}`, r);
    if (ccSet.has(r.mcc)) add(`${r.mcc}|${r.id}`, r);
  }
  return new Map(
    [...out].map(([k, v]) => [
      k,
      {
        n: v.n,
        asr: v.n ? Math.round((v.ok / v.n) * 1000) / 10 : null,
        dlr: v.ok ? Math.round((v.dl / v.ok) * 1000) / 10 : null,
      },
    ]),
  );
}

// ---------------------------------------------------------------- easy mode

const rateFields = (l: Line, showScheduled: boolean) => ({
  rateTableId: l.tableId,
  rate: l.rate,
  currency: l.currency,
  rateConverted: l.conv,
  effectiveFrom: l.from,
  validTo: l.to,
  matchedCode: l.code,
  senderId: l.senderId,
  scheduled:
    showScheduled && l.next ? { rate: l.next.rate, rateConverted: l.next.conv, effectiveFrom: l.next.from } : null,
});

export function lookupRates(request: FastifyRequest, reply: FastifyReply) {
  const input = request.body as RateLookupRequest;
  return withDb(reply, async (pool): Promise<RateLookupResult | FastifyReply> => {
    const { rows } = await pool.query(`${DEST_SELECT} WHERE m.mccmnc = $1`, [input.mccmnc]);
    if (!rows[0])
      return sendProblem(reply, 400, "Unknown destination", {
        errors: [{ path: "/mccmnc", message: "no such MCCMNC" }],
      });
    const [dest] = await withCodes(pool, [toDest(rows[0])]);
    const me = await getCurrentUser();
    const f: Filters = {
      at: input.asOf ? new Date(input.asOf) : new Date(),
      senderId: input.senderId?.trim() || null,
      includeInactive: !!input.includeInactive,
      ...(input.myClientsOnly ? { accountManagerIds: [me.id] } : {}),
    };
    const [vLines, cLines, vTraffic, cTraffic] = await Promise.all([
      vendorLines(pool, [dest!], f),
      clientLines(pool, [dest!], f),
      trafficByTrunk([dest!], "v", 24),
      trafficByTrunk([dest!], "c", 24 * 7),
    ]);
    const routed = await routedVendors(pool, cLines, vendorsAsRoutingSees(f, vLines));
    const routedIds = new Set([...routed.values()].filter((r): r is Routed => !!r).map((r) => r.vendorTrunkId));
    const active = vLines.filter((v) => v.status === "active");
    const bestCost = active.length ? Math.min(...active.map((v) => v.conv)) : null;
    const show = !!input.showScheduled;
    const vendors: LookupVendorCost[] = vLines
      .sort((a, b) => a.conv - b.conv || a.trunkName.localeCompare(b.trunkName))
      .map((v) => {
        const t = vTraffic?.get(`${dest!.mccmnc}|${v.trunkId}`);
        return {
          ...rateFields(v, show),
          vendorTrunkId: v.trunkId,
          vendorTrunkName: v.trunkName,
          enterpriseId: v.enterpriseId,
          enterpriseName: v.enterpriseName,
          tier: v.tier,
          category: v.category,
          status: v.status,
          routed: routedIds.has(v.trunkId),
          messages24h: vTraffic ? (t?.n ?? 0) : null,
          asr24h: t?.asr ?? null,
          dlr24h: t?.dlr ?? null,
        };
      });
    const clients: LookupClientRate[] = cLines
      .map((c) => {
        const r = routed.get(`${c.req}|${c.trunkId}`) ?? null;
        const marginBest = bestCost === null ? null : round6(c.conv - bestCost);
        const marginRouted = r?.cost === null || r?.cost === undefined ? null : round6(c.conv - r.cost);
        return {
          ...rateFields(c, show),
          customerTrunkId: c.trunkId,
          customerTrunkName: c.trunkName,
          enterpriseId: c.enterpriseId,
          enterpriseName: c.enterpriseName,
          rateTableName: c.tableName,
          category: c.category,
          status: c.status,
          accountManager: c.am,
          messages7d: cTraffic ? (cTraffic.get(`${dest!.mccmnc}|${c.trunkId}`)?.n ?? 0) : null,
          routedVendor: r,
          marginBest,
          marginBestPct: pct(marginBest, c.conv),
          marginRouted,
          marginRoutedPct: pct(marginRouted, c.conv),
        };
      })
      // Busiest clients first, then by name.
      .sort(
        (a, b) =>
          (b.messages7d ?? 0) - (a.messages7d ?? 0) ||
          a.enterpriseName.localeCompare(b.enterpriseName) ||
          a.customerTrunkName.localeCompare(b.customerTrunkName),
      );
    const { codes: _codes, ...destination } = dest!;
    return { destination, asOf: f.at.toISOString(), lookupCurrency: LOOKUP_CURRENCY, bestCost, vendors, clients };
  });
}

// ---------------------------------------------------------------- advanced mode

/** The destinations of an advanced lookup, in country and code order, and what didn't resolve. */
async function queryDestinations(
  db: Db,
  q: RateLookupQuery,
): Promise<{ dests: LookupDestination[]; unresolved: string[] }> {
  const found = new Map<string, Record<string, unknown>>();
  const unresolved: string[] = [];
  if (q.countryIds?.length) {
    const { rows } = await db.query(`${DEST_SELECT} WHERE m.country_id = ANY($1)`, [q.countryIds]);
    for (const r of rows) found.set(r.mccmnc, r);
  }
  if (q.mccmncs?.length) {
    const codes = [...new Set(q.mccmncs)];
    const { rows } = await db.query(`${DEST_SELECT} WHERE m.mccmnc = ANY($1)`, [codes]);
    for (const r of rows) found.set(r.mccmnc, r);
    const known = new Set(rows.map((r) => r.mccmnc));
    unresolved.push(...codes.filter((c) => !known.has(c)));
  }
  if (q.numbers?.length) {
    const numbers = [...new Set(q.numbers.map(normaliseNumber))];
    const { rows } = await db.query(
      `SELECT DISTINCT ON (x.n) x.n, m.mccmnc, m.mcc, m.network, m.is_all_networks, co.name AS country, co.iso AS country_iso
         FROM (SELECT n, left(n, k) AS p FROM unnest($1::text[]) n, generate_series(1, 15) k WHERE k <= length(n)) x
         JOIN dial_codes d ON d.prefix = x.p AND d.profile = 'All' AND d.deleted_at IS NULL
         JOIN mccmnc m ON m.id = d.mccmnc_id JOIN countries co ON co.id = m.country_id
        ORDER BY x.n, length(d.prefix) DESC`,
      [numbers],
    );
    for (const r of rows) found.set(r.mccmnc, r);
    const known = new Set(rows.map((r) => r.n));
    unresolved.push(...numbers.filter((n) => !known.has(n)));
  }
  const dests = [...found.values()]
    .map(toDest)
    .sort(
      (a, b) =>
        a.country.localeCompare(b.country) ||
        Number(b.allNetworks) - Number(a.allNetworks) ||
        a.mccmnc.localeCompare(b.mccmnc),
    );
  return { dests, unresolved: unresolved.slice(0, 50) };
}

const filtersOf = (q: RateLookupQuery): Filters => ({
  at: q.asOf ? new Date(q.asOf) : new Date(),
  senderId: q.senderId?.trim() || null,
  includeInactive: !!q.includeInactive,
  vendorTrunkIds: q.vendorTrunkIds,
  vendorEnterpriseIds: q.vendorEnterpriseIds,
  tiers: q.tiers,
  categoryIds: q.categoryIds,
  businessCompanyIds: q.businessCompanyIds,
  currencies: q.currencies,
  accountManagerIds: q.accountManagerIds,
  customerEnterpriseIds: q.customerEnterpriseIds,
  customerTrunkIds: q.customerTrunkIds,
  rateTableIds: q.rateTableIds,
});

/** A rate that ends by `soon` with no version after it: the destination stops being sold or bought. */
const expiresBy = (l: Line, soon: number) => l.to !== null && Date.parse(l.to) <= soon && l.next === null;

interface RowData {
  dest: Dest;
  vendors: VendorLine[];
  clients: ClientLine[];
  routed: Map<string, Routed | null>;
  bestCost: number | null;
  bestVendor: string | null;
  highlights: MatrixHighlight[];
}

/** The vendor lines routing sees (now, active, no sender ID, unfiltered) are these when the lookup doesn't narrow vendors. */
const vendorsAsRoutingSees = (f: Filters, lines: VendorLine[]) =>
  Math.abs(f.at.getTime() - Date.now()) < 60_000 &&
  !f.senderId &&
  !f.includeInactive &&
  !f.vendorTrunkIds?.length &&
  !f.vendorEnterpriseIds?.length &&
  !f.tiers?.length &&
  !f.categoryIds?.length &&
  !f.businessCompanyIds?.length &&
  !f.currencies?.length
    ? lines
    : undefined;

/** Lines, routing and highlights for a set of destinations. */
async function rowData(db: Db, dests: Dest[], f: Filters, needRouting: boolean): Promise<RowData[]> {
  const [vLines, cLines] = await Promise.all([vendorLines(db, dests, f), clientLines(db, dests, f)]);
  const routed = needRouting
    ? await routedVendors(db, cLines, vendorsAsRoutingSees(f, vLines))
    : new Map<string, Routed | null>();
  const vBy = new Map<string, VendorLine[]>();
  const cBy = new Map<string, ClientLine[]>();
  for (const v of vLines) vBy.set(v.req, [...(vBy.get(v.req) ?? []), v]);
  for (const c of cLines) cBy.set(c.req, [...(cBy.get(c.req) ?? []), c]);
  const soon = f.at.getTime() + EXPIRING_MS;
  return dests.map((dest) => {
    const vendors = (vBy.get(dest.mccmnc) ?? []).sort((a, b) => a.conv - b.conv);
    const clients = cBy.get(dest.mccmnc) ?? [];
    const active = vendors.filter((v) => v.status === "active");
    const best = active[0] ?? null;
    const highlights: MatrixHighlight[] = [];
    if (best && clients.some((c) => c.conv < best.conv)) highlights.push("below_cost");
    if (
      best &&
      needRouting &&
      clients.some((c) => {
        const r = routed.get(`${dest.mccmnc}|${c.trunkId}`);
        return !!r && r.cost !== null && best.conv < r.cost - 1e-9;
      })
    )
      highlights.push("cheaper_than_routed");
    if ([...vendors, ...clients].some((l) => expiresBy(l, soon))) highlights.push("expiring_soon");
    if (active.length === 1) highlights.push("single_vendor");
    return {
      dest,
      vendors,
      clients,
      routed,
      bestCost: best?.conv ?? null,
      bestVendor: best?.trunkName ?? null,
      highlights,
    };
  });
}

/** Columns: the trunks covering most destinations (vendor or customer side), at most 60. */
export async function topColumns(
  db: Db,
  dests: Dest[],
  f: Filters,
  side: "vendor" | "customer",
): Promise<{ columns: MatrixColumn[]; truncated: boolean }> {
  const p = pairs(dests);
  const values: unknown[] = [p.req, p.code, p.pref, f.at, f.senderId];
  const extra = tableFilters(f, values, side);
  const sql =
    side === "vendor"
      ? `SELECT vt.id, vt.name, e.name AS detail, count(DISTINCT d.req) AS n
           FROM unnest($1::text[], $2::text[], $3::int[]) AS d(req, code, pref)
           JOIN rate_lines l ON l.mccmnc = d.code AND ${valid("l", "$4")} AND NOT l.is_blocked AND (l.sender_id IS NULL OR l.sender_id = $5)
           JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
           JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id AND vt.deleted_at IS NULL
           JOIN enterprises e ON e.id = vt.enterprise_id
          WHERE true ${extra} GROUP BY vt.id, vt.name, e.name ORDER BY n DESC, vt.name LIMIT ${MAX_COLUMNS + 1}`
      : `SELECT ct.id, ct.name, e.name AS detail, count(DISTINCT d.req) AS n
           FROM unnest($1::text[], $2::text[], $3::int[]) AS d(req, code, pref)
           JOIN rate_lines l ON l.mccmnc = d.code AND ${valid("l", "$4")} AND NOT l.is_blocked AND (l.sender_id IS NULL OR l.sender_id = $5)
           JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'customer' AND rt.deleted_at IS NULL
           JOIN customer_trunk_rate_tables ctr ON ctr.rate_table_id = rt.id
           JOIN customer_trunks ct ON ct.id = ctr.customer_trunk_id AND ct.deleted_at IS NULL
           JOIN enterprises e ON e.id = ct.enterprise_id
          WHERE true ${extra} GROUP BY ct.id, ct.name, e.name ORDER BY n DESC, ct.name LIMIT ${MAX_COLUMNS + 1}`;
  const { rows } = await db.query(sql, values);
  return {
    columns: rows.slice(0, MAX_COLUMNS).map((r) => ({
      key: `${side === "vendor" ? "v" : "c"}${r.id}`,
      kind: side === "vendor" ? "vendor" : "client",
      id: Number(r.id),
      name: r.name,
      detail: r.detail,
    })),
    truncated: rows.length > MAX_COLUMNS,
  };
}

const decodeCursor = (c: string | null | undefined) => (c && /^\d+$/.test(c) ? Number(c) : 0);
const MAX_HIGHLIGHT_SCAN = 1000;

function badQuery(reply: FastifyReply, path: string, message: string) {
  return sendProblem(reply, 400, "Check the lookup", { errors: [{ path, message }] });
}

/** The whole matrix computation, shared by the paged view and the CSV export. */
async function buildMatrix(
  db: Db,
  q: RateMatrixRequest,
  page: { offset: number; limit: number },
): Promise<{ matrix: RateMatrix; data: RowData[] } | { error: [string, string] }> {
  if (!q.countryIds?.length && !q.mccmncs?.length && !q.numbers?.length)
    return { error: ["/countryIds", "choose countries, MCCMNCs or numbers to look up"] };
  const f = filtersOf(q);
  const { dests: found, unresolved } = await queryDestinations(db, q);
  let dests = await withCodes(db, found);
  const view = q.view;
  const needRouting = view === "margin" || view === "vendor_costs" || !!q.highlights?.includes("cheaper_than_routed");
  if (q.highlights?.length) {
    if (dests.length > MAX_HIGHLIGHT_SCAN)
      return {
        error: ["/highlights", `highlights scan at most ${MAX_HIGHLIGHT_SCAN} destinations; narrow the lookup`],
      };
    const all = await rowData(db, dests, f, !!q.highlights.includes("cheaper_than_routed"));
    const keep = new Set(
      all.filter((r) => r.highlights.some((h) => q.highlights!.includes(h))).map((r) => r.dest.mccmnc),
    );
    dests = dests.filter((d) => keep.has(d.mccmnc));
  }
  const slice = dests.slice(page.offset, page.offset + page.limit);
  const colsPromise =
    view === "cheapest"
      ? Promise.resolve({
          columns: Array.from({ length: q.cheapestN ?? 3 }, (_, i) => ({
            key: `r${i + 1}`,
            kind: "rank" as const,
            id: null,
            name: `#${i + 1}`,
            detail: `Cheapest ${i + 1}`,
          })),
          truncated: false,
        })
      : dests.length
        ? topColumns(db, dests, f, view === "vendor_costs" ? "vendor" : "customer")
        : Promise.resolve({ columns: [] as MatrixColumn[], truncated: false });
  const [cols, data, quality] = await Promise.all([
    colsPromise,
    rowData(db, slice, f, needRouting),
    view === "cheapest" ? trafficByTrunk(slice, "v", 24) : null,
  ]);
  const soon = f.at.getTime() + EXPIRING_MS;
  const rows: MatrixRow[] = data.map((d) => {
    const routedIds = new Set(
      [...d.routed.entries()]
        .filter(([k, r]) => k.startsWith(`${d.dest.mccmnc}|`) && r)
        .map(([, r]) => r!.vendorTrunkId),
    );
    const base = (l: Line) => ({
      rate: l.rate,
      currency: l.currency,
      rateConverted: l.conv,
      rateTableId: l.tableId,
      expiring: expiresBy(l, soon),
      scheduled: l.next ? { rate: l.next.rate, effectiveFrom: l.next.from } : null,
    });
    let cells: (MatrixCell | null)[];
    if (view === "vendor_costs") {
      const by = new Map(d.vendors.map((v) => [v.trunkId, v]));
      cells = cols.columns.map((c) => {
        const v = by.get(c.id!);
        return v
          ? { ...base(v), best: v.status === "active" && v.conv === d.bestCost, routed: routedIds.has(v.trunkId) }
          : null;
      });
    } else if (view === "cheapest") {
      const active = d.vendors.filter((v) => v.status === "active");
      cells = cols.columns.map((_, i) => {
        const v = active[i];
        if (!v) return null;
        const t = quality?.get(`${d.dest.mccmnc}|${v.trunkId}`);
        return {
          ...base(v),
          vendorTrunkId: v.trunkId,
          vendorName: v.trunkName,
          asr: t?.asr ?? null,
          dlr: t?.dlr ?? null,
          best: i === 0,
        };
      });
    } else {
      const by = new Map(d.clients.map((c) => [c.trunkId, c]));
      cells = cols.columns.map((col) => {
        const c = by.get(col.id!);
        if (!c) return null;
        const r = d.routed.get(`${d.dest.mccmnc}|${c.trunkId}`) ?? null;
        return {
          ...base(c),
          marginBest: d.bestCost === null ? null : round6(c.conv - d.bestCost),
          ...(view === "margin"
            ? {
                marginRouted: r?.cost === null || r?.cost === undefined ? null : round6(c.conv - r.cost),
                routedVendor: r?.name ?? null,
              }
            : {}),
        };
      });
    }
    const { codes: _codes, ...destination } = d.dest;
    return {
      destination,
      bestCost: d.bestCost,
      bestVendor: d.bestVendor,
      vendorCount: d.vendors.filter((v) => v.status === "active").length,
      highlights: d.highlights,
      cells,
    };
  });
  const next = page.offset + page.limit;
  return {
    data,
    matrix: {
      view,
      asOf: f.at.toISOString(),
      lookupCurrency: LOOKUP_CURRENCY,
      columns: cols.columns,
      columnsTruncated: cols.truncated,
      rows,
      total: dests.length,
      nextCursor: next < dests.length ? String(next) : null,
      unresolved,
    },
  };
}

export function rateLookupMatrix(request: FastifyRequest, reply: FastifyReply) {
  const q = request.body as RateMatrixRequest;
  return withDb(reply, async (pool) => {
    const out = await buildMatrix(pool, q, { offset: decodeCursor(q.cursor), limit: q.limit ?? 50 });
    if ("error" in out) return badQuery(reply, ...out.error);
    return out.matrix;
  });
}

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportRateLookupMatrix(request: FastifyRequest, reply: FastifyReply) {
  const q = request.body as RateMatrixRequest;
  return withDb(reply, async (pool) => {
    const out = await buildMatrix(pool, q, { offset: 0, limit: 20_000 });
    if ("error" in out) return badQuery(reply, ...out.error);
    const m = out.matrix;
    const converted = q.currency === "converted";
    const cellText = (c: MatrixCell | null) => {
      if (!c) return "";
      const rate = converted ? c.rateConverted : c.rate;
      if (m.view === "cheapest") return `${c.vendorName} ${rate}`;
      if (m.view === "margin") return `${rate} (margin ${c.marginBest ?? ""} / routed ${c.marginRouted ?? ""})`;
      return String(rate);
    };
    const head = [
      "MCCMNC",
      "Country",
      "Network",
      `Best cost (${LOOKUP_CURRENCY})`,
      "Best vendor",
      "Vendors",
      "Highlights",
      ...m.columns.map((c) => (c.kind === "rank" ? c.detail : `${c.name} (${c.detail})`)),
    ];
    const lines = m.rows.map((r) =>
      [
        r.destination.mccmnc,
        r.destination.country,
        r.destination.network,
        r.bestCost,
        r.bestVendor,
        r.vendorCount,
        r.highlights.join(" "),
        ...r.cells.map(cellText),
      ]
        .map(csv)
        .join(","),
    );
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="rate-lookup-${m.view}.csv"`);
    return [head.map(csv).join(","), ...lines].join("\r\n") + "\r\n";
  });
}

// ---------------------------------------------------------------- saved lookups

const LIST = "rate_lookup";
const SELECT = `SELECT v.id, v.name, v.owner_id, o.first_name || ' ' || o.last_name AS owner_name, v.state, v.updated_at,
    COALESCE((SELECT array_agg(s.user_id ORDER BY s.user_id) FROM saved_view_shares s WHERE s.saved_view_id = v.id), '{}') AS shared
  FROM saved_views v JOIN users o ON o.id = v.owner_id`;

const toLookup = (r: Record<string, unknown>): SavedLookup => ({
  id: r.id as number,
  name: r.name as string,
  owner: { id: r.owner_id as number, displayName: r.owner_name as string },
  sharedWithUserIds: (r.shared as number[]).map(Number),
  readOnly: r.owner_id !== currentUserId(),
  query: r.state as RateLookupQuery,
  updatedAt: (r.updated_at as Date).toISOString(),
});

export function listSavedLookups(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `${SELECT} WHERE v.list = $1 AND (v.owner_id = $2
         OR EXISTS (SELECT 1 FROM saved_view_shares s WHERE s.saved_view_id = v.id AND s.user_id = $2))
       ORDER BY (v.owner_id = $2) DESC, v.name`,
      [LIST, currentUserId()],
    );
    return rows.map(toLookup);
  });
}

export function createSavedLookup(request: FastifyRequest, reply: FastifyReply) {
  const input = request.body as SavedLookupInput;
  return withDb(reply, async (pool) => {
    try {
      const id = await inTransaction(pool, async (c) => {
        const { rows } = await c.query(
          "INSERT INTO saved_views (list, name, owner_id, state) VALUES ($1, $2, $3, $4) RETURNING id",
          [LIST, input.name.trim(), currentUserId(), JSON.stringify(input.query)],
        );
        await writeShares(c, rows[0].id, input.sharedWithUserIds ?? []);
        return rows[0].id as number;
      });
      const { rows } = await pool.query(`${SELECT} WHERE v.id = $1`, [id]);
      return reply.code(201).send(toLookup(rows[0]));
    } catch (err) {
      return inputProblem(reply, err);
    }
  });
}

async function ownLookup(pool: pg.Pool, reply: FastifyReply, id: number) {
  const { rows } = await pool.query("SELECT owner_id FROM saved_views WHERE id = $1 AND list = $2", [id, LIST]);
  if (!rows[0]) return sendProblem(reply, 404, `Saved lookup ${id} not found`);
  if (rows[0].owner_id !== currentUserId())
    return sendProblem(reply, 403, "Only the owner can change a saved lookup; it was shared with you read-only");
  return null;
}

export function updateSavedLookup(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const input = request.body as SavedLookupInput;
  return withDb(reply, async (pool) => {
    const denied = await ownLookup(pool, reply, id);
    if (denied) return denied;
    try {
      await inTransaction(pool, async (c) => {
        await c.query("UPDATE saved_views SET name = $2, state = $3, updated_at = now() WHERE id = $1", [
          id,
          input.name.trim(),
          JSON.stringify(input.query),
        ]);
        await writeShares(c, id, input.sharedWithUserIds ?? []);
      });
    } catch (err) {
      return inputProblem(reply, err);
    }
    const { rows } = await pool.query(`${SELECT} WHERE v.id = $1`, [id]);
    return toLookup(rows[0]);
  });
}

export function deleteSavedLookup(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const denied = await ownLookup(pool, reply, id);
    if (denied) return denied;
    await pool.query("DELETE FROM saved_views WHERE id = $1", [id]);
    return reply.code(204).send();
  });
}
