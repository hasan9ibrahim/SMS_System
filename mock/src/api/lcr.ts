// Advanced LCR module (§13.23): the live LCR table per destination (every vendor trunk ranked by cost
// in the platform currency or by a quality-weighted score, at any point in time, with QBR quality,
// TPS and whether routing uses it now), what-if (remove a vendor, change a rate, add an offer: new
// ranking, routes that change, margin effect on last 7 days' traffic), the client view (sell rates
// against the LCR positions), LCR profiles reused by Least cost route rules, and change alerts.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  LcrAlertSettings,
  LcrClientQuery,
  LcrClientRow,
  LcrImpact,
  LcrProfileInput,
  LcrProfileRow,
  LcrQuery,
  LcrRow,
  ListQuery,
  LookupDestination,
} from "@sms/contract";
import { PLATFORM_CURRENCY, toPlatformSql } from "../currency.js";
import { db, withDb } from "../db.js";
import { chRows } from "../edr.js";
import { atLimit, loadLcrProfiles, mapProfile, qbrQuality, qualityFor, tpsNow, vendorTiers } from "../lcr/data.js";
import { rankLcr, type LcrCandidate } from "../lcr/rank.js";
import type { ListDef } from "../lists/engine.js";
import { runList } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { records } from "./admin.js";
import { clientLines, routedVendors, switchLines, vendorLines, withCodes, type ClientLine } from "./rateLookup.js";
import { dependencies, iso, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";

type Db = pg.Pool | pg.PoolClient;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;
const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

// ---------------------------------------------------------------- profiles

/** Names of the vendor trunks a profile lists, for its scope cell and hover list (team trial round 1). */
const SCOPE_NAMES = `ARRAY(SELECT vt.name FROM unnest(p.vendor_trunk_ids) x(id) JOIN vendor_trunks vt ON vt.id = x.id
    ORDER BY vt.name LIMIT 100)`;
const PROFILE_SELECT = `p.*, u.username AS updated_by,
  (SELECT count(*)::int FROM route_rules r WHERE r.lcr_profile_id = p.id AND r.deleted_at IS NULL) AS rule_count,
  ARRAY(SELECT r.name FROM route_rules r WHERE r.lcr_profile_id = p.id AND r.deleted_at IS NULL
         ORDER BY r.priority DESC, r.name LIMIT 100) AS rule_names,
  ${SCOPE_NAMES} AS scope_names`;
const PROFILE_FROM = "lcr_profiles p LEFT JOIN users u ON u.id = p.updated_by_id";

const scopeLabel = (mode: string, n: number) =>
  mode === "all" ? "All vendors" : mode === "exclusive" ? `All but ${n}` : `${n} vendor${n === 1 ? "" : "s"}`;

function mapProfileRow(r: Record<string, unknown>): LcrProfileRow {
  return {
    ...mapProfile(r),
    id: Number(r.id),
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    status: r.status as LcrProfileRow["status"],
    ruleCount: Number(r.rule_count ?? 0),
    ruleNames: (r.rule_names as string[] | null) ?? [],
    vendorScope: scopeLabel(r.vendor_trunk_mode as string, ((r.vendor_trunk_ids as unknown[] | null) ?? []).length),
    vendorScopeNames: r.vendor_trunk_mode === "all" ? [] : ((r.scope_names as string[] | null) ?? []),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export const lcrProfileList: ListDef<LcrProfileRow> = {
  fields: listFields.lcr_profiles,
  from: PROFILE_FROM,
  baseWhere: "p.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "p.id" },
    name: { sql: "p.name" },
    status: { sql: "p.status" },
    vendorCount: { sql: "p.vendor_count" },
    split: { sql: "p.split" },
    minDlr: { sql: "p.min_dlr" },
    minAsr: { sql: "p.min_asr" },
    maxRate: { sql: "p.max_rate" },
    qualityWeighted: { sql: "p.quality_weighted" },
    ruleCount: {
      sql: "(SELECT count(*)::int FROM route_rules r WHERE r.lcr_profile_id = p.id AND r.deleted_at IS NULL)",
    },
    // Filters on the vendor names ("All vendors" matches profiles without a list).
    vendorScope: {
      sql: `(CASE WHEN p.vendor_trunk_mode = 'all' THEN 'All vendors' ELSE array_to_string(${SCOPE_NAMES}, ', ') END)`,
    },
    description: { sql: "p.description" },
    updatedBy: { sql: "u.username" },
    updatedAt: { sql: "p.updated_at" },
    archived: { sql: "(p.deleted_at IS NOT NULL)" },
  },
  search: ["name", "description"],
  idSql: "p.id",
  select: PROFILE_SELECT,
  mapRow: mapProfileRow,
};

export function queryLcrProfiles(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.lcr_profiles);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, lcrProfileList, query));
}

const loadProfile = async (c: Db, id: number) => {
  const { rows } = await c.query(`SELECT ${PROFILE_SELECT} FROM ${PROFILE_FROM} WHERE p.id = $1`, [id]);
  return rows[0] ? mapProfileRow(rows[0]) : null;
};

const profiles = records<LcrProfileInput, LcrProfileRow>({
  table: "lcr_profiles",
  entityType: "lcr_profile",
  label: "LCR profile",
  fields: [
    ["name", "name"],
    ["description", "description"],
    ["status", "status"],
    ["vendorTrunkMode", "vendor_trunk_mode"],
    ["vendorTrunkIds", "vendor_trunk_ids"],
    ["tiers", "tiers"],
    ["minAsr", "min_asr"],
    ["minDlr", "min_dlr"],
    ["maxDelayS", "max_delay_s"],
    ["maxRate", "max_rate"],
    ["vendorCount", "vendor_count"],
    ["split", "split"],
    ["shares", "shares"],
    ["tieBreaker", "tie_breaker"],
    ["excludeAtTpsLimit", "exclude_at_tps_limit"],
    ["qualityWeighted", "quality_weighted"],
    ["weights", "weights"],
  ],
  load: loadProfile,
  values: (b) => ({
    ...b,
    name: b.name.trim(),
    description: b.description?.trim() || null,
    shares: b.split === "percentage" ? b.shares.slice(0, b.vendorCount) : [],
  }),
  check: async (c, b, id) => {
    const errors: FieldError[] = [];
    if (b.split === "percentage") {
      const sum = b.shares.reduce((a, x) => a + x, 0);
      if (b.shares.length !== b.vendorCount)
        errors.push({ path: "/shares", message: `give one share per vendor (${b.vendorCount})` });
      else if (sum !== 100) errors.push({ path: "/shares", message: `shares add up to ${sum} %, not 100 %` });
    }
    if (b.vendorTrunkMode !== "all" && !b.vendorTrunkIds.length)
      errors.push({ path: "/vendorTrunkIds", message: "choose the vendor trunks" });
    if (b.vendorTrunkIds.length) {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM vendor_trunks WHERE id = ANY($1)", [
        b.vendorTrunkIds,
      ]);
      if (rows[0].n !== b.vendorTrunkIds.length)
        errors.push({ path: "/vendorTrunkIds", message: "unknown vendor trunk" });
    }
    if (b.weights.cost + b.weights.asr + b.weights.dlr + b.weights.delay <= 0)
      errors.push({ path: "/weights", message: "at least one weight above 0" });
    const { rows } = await c.query(
      "SELECT deleted_at FROM lcr_profiles WHERE lower(name) = lower($1) AND id <> coalesce($2, 0)",
      [b.name, id],
    );
    if (rows[0])
      errors.push({
        path: "/name",
        message: rows[0].deleted_at ? "a deleted profile has this name" : "another profile has this name",
      });
    return errors;
  },
  nameOf: (b) => b.name,
  deps: async (c, id) => {
    const { rows } = await c.query(
      "SELECT id, name FROM route_rules WHERE lcr_profile_id = $1 AND deleted_at IS NULL ORDER BY priority DESC, id LIMIT 50",
      [id],
    );
    return dependencies([
      {
        key: "route_rules",
        label: "Least cost route rules using it",
        count: rows.length,
        blocking: true,
        detail: rows.length ? rows.map((r) => r.name).join(", ") : null,
      },
    ]);
  },
});
export const getLcrProfile = profiles.get;
export const getLcrProfileDependencies = profiles.dependencies;
export const createLcrProfile = profiles.create;
export const updateLcrProfile = profiles.update;
export const archiveLcrProfile = profiles.archive;
export const restoreLcrProfile = profiles.restore;

// ---------------------------------------------------------------- LCR table

async function destination(c: Db, code: string): Promise<LookupDestination | null> {
  const { rows } = await c.query(
    `SELECT m.mccmnc, m.mcc, m.network, m.is_all_networks, co.name AS country, co.iso
       FROM mccmnc m JOIN countries co ON co.id = m.country_id WHERE m.mccmnc = $1 AND m.deleted_at IS NULL`,
    [code],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    mccmnc: r.mccmnc,
    mcc: String(r.mcc).trim(),
    country: r.country,
    countryIso: String(r.iso).trim(),
    network: r.is_all_networks ? "All networks" : r.network,
    allNetworks: !!r.is_all_networks,
  };
}

/** Messages in the last 7 days per customer trunk for one destination. */
async function clientTraffic(code: string, trunkIds: number[]): Promise<Map<number, number>> {
  if (!trunkIds.length) return new Map();
  const rows = await chRows<{ t: number; n: string }>(
    `SELECT c_trunk_id AS t, count() AS n FROM edr WHERE start_time >= now() - INTERVAL 7 DAY
        AND c_mccmnc = '${code.replace(/\D/g, "")}' AND c_trunk_id IN (${trunkIds.join(",")}) GROUP BY t`,
    6000,
  );
  return new Map((rows ?? []).map((r) => [Number(r.t), Number(r.n)]));
}

export function lcrTable(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as LcrQuery;
  return withDb(reply, async (pool) => {
    const dest = await destination(pool, body.mccmnc);
    if (!dest) return badInput(reply, [{ path: "/mccmnc", message: `${body.mccmnc} is not in the MCCMNC master` }]);
    const at = body.at ? new Date(body.at) : new Date();
    const profileMap = body.profileId ? await loadLcrProfiles(pool) : null;
    let profileName: string | null = null;
    if (body.profileId) {
      const p = await loadProfile(pool, body.profileId);
      if (!p || p.archivedAt) return badInput(reply, [{ path: "/profileId", message: "unknown or deleted profile" }]);
      profileName = p.name;
    }
    const profile = body.profileId
      ? (profileMap?.get(body.profileId) ?? mapProfile(await rawProfile(pool, body.profileId)))
      : null;
    const dests = await withCodes(pool, [dest]);
    const [lines, quality, tiers] = await Promise.all([
      vendorLines(pool, dests, { at, senderId: null, includeInactive: true }),
      qbrQuality(pool, [dest.mccmnc, dest.mcc]),
      vendorTiers(pool),
    ]);
    const q = qualityFor(quality, dest.mccmnc);
    const tps = tpsNow();
    // Generic lines only (sender-ID rates are not LCR), one per vendor trunk; a trunk whose line in force is blocked
    // is not offered (blocked means blocked, decided 2026-10-30).
    const blockedTrunks = new Set(
      switchLines(lines)
        .filter((x) => x.blocked)
        .map((x) => x.trunkId),
    );
    const byTrunk = new Map<number, (typeof lines)[number]>();
    for (const l of lines)
      if (l.senderId === null && !l.blocked && !blockedTrunks.has(l.trunkId) && !byTrunk.has(l.trunkId))
        byTrunk.set(l.trunkId, l);
    type Cand = LcrCandidate & { line: (typeof lines)[number] | null; whatIf: LcrRow["whatIf"] };
    const base: Cand[] = [...byTrunk.values()].map((l) => ({
      vendorTrunkId: l.trunkId,
      cost: l.conv,
      asr: q.get(l.trunkId)?.asr ?? null,
      dlr: q.get(l.trunkId)?.dlr ?? null,
      delayS: q.get(l.trunkId)?.delayS ?? null,
      tier: l.tier,
      atLimit: atLimit(tps.get(l.trunkId), tiers.get(l.trunkId)?.limit),
      line: l,
      whatIf: null,
    }));
    const opts = {
      ...(body.qualityWeighted !== undefined ? { qualityWeighted: body.qualityWeighted } : {}),
      ...(body.weights ? { weights: body.weights } : {}),
    };
    const inactive = (c: Cand) => c.line?.status === "inactive";
    const rank = (cands: Cand[]) => {
      const live = cands.filter((c) => !inactive(c));
      const ranked = rankLcr(live, profile, opts);
      return [
        ...ranked,
        ...cands
          .filter(inactive)
          .map((c) => ({ c, rank: null, score: null, excluded: "trunk inactive", pick: false, share: null })),
      ];
    };
    const baseline = rank(base);

    // What-if: remove vendors, change rates, add offers.
    const w = body.whatIf;
    let after = baseline;
    if (w && ((w.remove?.length ?? 0) > 0 || (w.rates?.length ?? 0) > 0)) {
      const removed = new Set(w.remove ?? []);
      const rates = new Map((w.rates ?? []).map((x) => [x.vendorTrunkId, x.rate]));
      const changed: Cand[] = base.map((c) =>
        removed.has(c.vendorTrunkId)
          ? { ...c, whatIf: "removed" as const }
          : rates.has(c.vendorTrunkId)
            ? { ...c, cost: rates.get(c.vendorTrunkId)!, whatIf: "changed" as const }
            : c,
      );
      const missing = [...rates.keys()].filter((id) => !byTrunk.has(id));
      if (missing.length) {
        const { rows } = await pool.query(
          "SELECT vt.id, vt.status FROM vendor_trunks vt WHERE vt.id = ANY($1) AND vt.deleted_at IS NULL",
          [missing],
        );
        for (const r of rows)
          changed.push({
            vendorTrunkId: Number(r.id),
            cost: rates.get(Number(r.id))!,
            asr: q.get(Number(r.id))?.asr ?? null,
            dlr: q.get(Number(r.id))?.dlr ?? null,
            delayS: q.get(Number(r.id))?.delayS ?? null,
            tier: tiers.get(Number(r.id))?.tier ?? null,
            atLimit: atLimit(tps.get(Number(r.id)), tiers.get(Number(r.id))?.limit),
            line: null,
            whatIf: "added",
          });
      }
      after = rank(changed.filter((c) => c.whatIf !== "removed"));
      for (const c of changed.filter((x) => x.whatIf === "removed"))
        after.push({ c, rank: null, score: null, excluded: "removed (what-if)", pick: false, share: null });
    }

    // Routing now, for "used now" and the what-if impact.
    const clients = (await clientLines(pool, dests, { at: new Date(), senderId: null, includeInactive: false })).filter(
      (c) => c.senderId === null,
    );
    const nowLines = [...byTrunk.values()].filter((l) => !inactive({ line: l } as Cand));
    const routedNow = await routedVendors(pool, clients, nowLines as never);
    const usedBy = new Map<number, number>();
    for (const v of routedNow.values()) if (v) usedBy.set(v.vendorTrunkId, (usedBy.get(v.vendorTrunkId) ?? 0) + 1);
    let impact: LcrImpact | null = null;
    if (after !== baseline) impact = await whatIfImpact(pool, dest.mccmnc, clients, routedNow, after);

    const names = await trunkNames(
      pool,
      after.map((r) => r.c.vendorTrunkId),
    );
    const baseRank = new Map(baseline.map((r) => [r.c.vendorTrunkId, r.rank]));
    const rows: LcrRow[] = after.map((r) => {
      const l = r.c.line;
      const n = names.get(r.c.vendorTrunkId);
      return {
        rank: r.rank,
        vendorTrunkId: r.c.vendorTrunkId,
        vendorTrunk: n?.trunk ?? `#${r.c.vendorTrunkId}`,
        vendor: n?.vendor ?? "",
        tier: r.c.tier ?? "",
        status: l?.status ?? n?.status ?? "active",
        rate: l ? l.rate : r.c.cost,
        currency: l ? l.currency : PLATFORM_CURRENCY,
        cost: r6(r.c.cost),
        effectiveFrom: l ? l.from : at.toISOString(),
        nextRate: l?.next?.rate ?? null,
        nextFrom: l?.next?.from ?? null,
        asr: r.c.asr,
        dlr: r.c.dlr,
        delayS: r.c.delayS,
        attempts: q.get(r.c.vendorTrunkId)?.attempts ?? 0,
        tpsNow: tps.get(r.c.vendorTrunkId) ?? null,
        tpsLimit: tiers.get(r.c.vendorTrunkId)?.limit ?? null,
        atLimit: r.c.atLimit,
        routedNow: usedBy.get(r.c.vendorTrunkId) ?? 0,
        score: r.score,
        excluded: r.excluded,
        pick: r.pick,
        share: r.share,
        whatIf: (r.c as Cand).whatIf,
        baselineRank: baseRank.get(r.c.vendorTrunkId) ?? null,
      };
    });
    return {
      mccmnc: dest.mccmnc,
      country: dest.country,
      network: dest.network,
      at: at.toISOString(),
      currency: PLATFORM_CURRENCY,
      profile: profileName,
      rows,
      impact,
    };
  });
}

async function rawProfile(c: Db, id: number) {
  const { rows } = await c.query("SELECT * FROM lcr_profiles WHERE id = $1", [id]);
  return rows[0];
}

async function trunkNames(c: Db, ids: number[]) {
  const { rows } = await c.query(
    "SELECT vt.id, vt.name, vt.status, e.name AS vendor FROM vendor_trunks vt JOIN enterprises e ON e.id = vt.enterprise_id WHERE vt.id = ANY($1)",
    [ids],
  );
  return new Map(
    rows.map((r) => [
      Number(r.id),
      { trunk: r.name as string, vendor: r.vendor as string, status: r.status as string },
    ]),
  );
}

/** Routes that change with the what-if costs, and the effect on last 7 days' traffic. */
async function whatIfImpact(
  c: Db,
  code: string,
  clients: ClientLine[],
  before: Awaited<ReturnType<typeof routedVendors>>,
  after: ReturnType<typeof rankLcr<LcrCandidate>>,
): Promise<LcrImpact> {
  const costs = after
    .filter((r) => r.excluded !== "removed (what-if)" && r.excluded !== "trunk inactive")
    .map((r) => ({ req: code, trunkId: r.c.vendorTrunkId, conv: r.c.cost }));
  const routed = await routedVendors(c, clients, costs as never);
  const traffic = await clientTraffic(
    code,
    clients.map((x) => x.trunkId),
  );
  let changed = 0;
  let msgs = 0;
  let costChange = 0;
  const changes: LcrImpact["changes"] = [];
  for (const cl of clients) {
    const key = `${cl.req}|${cl.trunkId}`;
    const a = before.get(key) ?? null;
    const b = routed.get(key) ?? null;
    const n = traffic.get(cl.trunkId) ?? 0;
    msgs += n;
    if ((a?.vendorTrunkId ?? null) === (b?.vendorTrunkId ?? null) && (a?.cost ?? null) === (b?.cost ?? null)) continue;
    if ((a?.vendorTrunkId ?? null) !== (b?.vendorTrunkId ?? null)) {
      changed++;
      if (changes.length < 50)
        changes.push({ customerTrunk: cl.trunkName, from: a?.name ?? null, to: b?.name ?? null, messages7d: n });
    }
    if (a?.cost !== null && a?.cost !== undefined && b?.cost !== null && b?.cost !== undefined)
      costChange += n * (b.cost - a.cost);
  }
  return {
    clientLines: clients.length,
    routesChanged: changed,
    messages7d: msgs,
    costChange7d: r6(costChange),
    marginChange7d: r6(-costChange),
    changes: changes.sort((x, y) => y.messages7d - x.messages7d),
  };
}

// ---------------------------------------------------------------- client view

const clientCache = new Map<string, { at: number; rows: LcrClientRow[] }>();

export function lcrClientView(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as LcrClientQuery;
  if (!b.enterpriseId && !b.accountManagerId)
    return badInput(reply, [{ path: "/enterpriseId", message: "choose a client or an account manager" }]);
  return withDb(reply, async (pool) => {
    const at = b.at ? new Date(b.at) : new Date();
    const key = JSON.stringify([b.enterpriseId, b.accountManagerId, b.profileId, b.at ?? null]);
    let rows = clientCache.get(key);
    if (!rows || Date.now() - rows.at > 60_000) {
      rows = { at: Date.now(), rows: await computeClientView(pool, b, at) };
      clientCache.set(key, rows);
    }
    let list = rows.rows;
    if (b.onlyBelowCost) list = list.filter((r) => r.belowCost);
    const q = b.search?.trim().toLowerCase();
    if (q)
      list = list.filter((r) =>
        [r.customerTrunk, r.enterprise, r.country, r.network, r.mccmnc].some((v) => v?.toLowerCase().includes(q)),
      );
    const sort = b.sort ?? "margin";
    list = [...list].sort((x, y) =>
      sort === "messages"
        ? y.messages7d - x.messages7d
        : sort === "destination"
          ? (x.country ?? "").localeCompare(y.country ?? "") || x.mccmnc.localeCompare(y.mccmnc)
          : (x.margin1Pct ?? Infinity) - (y.margin1Pct ?? Infinity),
    );
    const margins = rows.rows.flatMap((r) => (r.margin1Pct === null ? [] : [r.margin1Pct]));
    const offset = b.offset ?? 0;
    return {
      rows: list.slice(offset, offset + (b.limit ?? 100)),
      total: list.length,
      currency: PLATFORM_CURRENCY,
      summary: {
        lines: rows.rows.length,
        belowCost: rows.rows.filter((r) => r.belowCost).length,
        avgMargin1Pct: margins.length ? r2(margins.reduce((s, v) => s + v, 0) / margins.length) : null,
      },
    };
  });
}

async function computeClientView(c: Db, b: LcrClientQuery, at: Date): Promise<LcrClientRow[]> {
  const profile = b.profileId ? mapProfile(await rawProfile(c, b.profileId)) : null;
  // Each client trunk's sell rate per destination (its first rate table with a line, §5.4).
  const { rows: sells } = await c.query(
    `SELECT DISTINCT ON (ct.id, l.mccmnc_id) ct.id AS trunk_id, ct.name AS trunk, e.name AS enterprise,
            l.mccmnc_id, l.mccmnc, ${toPlatformSql("l.rate")} AS conv
       FROM customer_trunks ct
       JOIN enterprises e ON e.id = ct.enterprise_id
       JOIN customer_trunk_rate_tables x ON x.customer_trunk_id = ct.id
       JOIN rate_tables rt ON rt.id = x.rate_table_id AND rt.kind = 'customer' AND rt.deleted_at IS NULL
       JOIN rate_lines l ON l.rate_table_id = rt.id AND l.sender_id IS NULL AND NOT l.is_blocked
            AND l.valid_from <= $3 AND (l.valid_to IS NULL OR l.valid_to > $3)
       JOIN currency_latest cl ON cl.iso = l.currency
      WHERE ct.deleted_at IS NULL AND ct.status = 'active'
        AND ($1::bigint IS NULL OR e.id = $1) AND ($2::bigint IS NULL OR e.account_manager_id = $2)
      ORDER BY ct.id, l.mccmnc_id, x.position`,
    [b.enterpriseId ?? null, b.accountManagerId ?? null, at],
  );
  if (!sells.length) return [];
  const destIds = [...new Set(sells.map((s) => Number(s.mccmnc_id)))];
  // The vendors for those destinations at the point in time, with QBR quality.
  const { rows: vend } = await c.query(
    `SELECT DISTINCT ON (l.mccmnc_id, vt.id) l.mccmnc_id, vt.id AS trunk_id, vt.name, e.tier, vt.tps,
            ${toPlatformSql("l.rate")} AS conv, q.asr, q.dlr, q.add_s
       FROM rate_lines l
       JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
       JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id AND vt.deleted_at IS NULL AND vt.status = 'active'
       JOIN enterprises e ON e.id = vt.enterprise_id
       JOIN currency_latest cl ON cl.iso = l.currency
       LEFT JOIN qbr_stats q ON q.side = 'vendor' AND q.trunk_id = vt.id AND q.mccmnc_id = l.mccmnc_id
      WHERE l.mccmnc_id = ANY($1) AND l.sender_id IS NULL AND NOT l.is_blocked
        AND l.valid_from <= $2 AND (l.valid_to IS NULL OR l.valid_to > $2)
      ORDER BY l.mccmnc_id, vt.id, l.rate / cl.rate_per_eur`,
    [destIds, at],
  );
  const tps = tpsNow();
  const byDest = new Map<number, (LcrCandidate & { name: string })[]>();
  for (const v of vend) {
    const list = byDest.get(Number(v.mccmnc_id)) ?? [];
    list.push({
      vendorTrunkId: Number(v.trunk_id),
      name: v.name,
      cost: Number(v.conv),
      asr: v.asr === null ? null : Number(v.asr),
      dlr: v.dlr === null ? null : Number(v.dlr),
      delayS: v.add_s === null ? null : Number(v.add_s),
      tier: v.tier,
      atLimit: atLimit(tps.get(Number(v.trunk_id)), Number(v.tps)),
    });
    byDest.set(Number(v.mccmnc_id), list);
  }
  const top = new Map<number, (LcrCandidate & { name: string })[]>();
  for (const [m, list] of byDest)
    top.set(
      m,
      rankLcr(list, profile)
        .filter((r) => r.rank !== null)
        .slice(0, 3)
        .map((r) => r.c),
    );
  const { rows: names } = await c.query(
    "SELECT m.id, m.network, m.is_all_networks, co.name AS country FROM mccmnc m JOIN countries co ON co.id = m.country_id WHERE m.id = ANY($1)",
    [destIds],
  );
  const dn = new Map(names.map((n) => [Number(n.id), n]));
  const trunkIds = [...new Set(sells.map((s) => Number(s.trunk_id)))];
  const traffic = await chRows<{ t: number; m: string; n: string }>(
    `SELECT c_trunk_id AS t, c_mccmnc AS m, count() AS n FROM edr WHERE start_time >= now() - INTERVAL 7 DAY
        AND c_trunk_id IN (${trunkIds.join(",")}) GROUP BY t, m`,
    8000,
  );
  const vol = new Map((traffic ?? []).map((r) => [`${r.t}:${r.m}`, Number(r.n)]));
  return sells.map((s) => {
    const sell = Number(s.conv);
    const t = top.get(Number(s.mccmnc_id)) ?? [];
    const margin = (cost: number | undefined) =>
      cost === undefined || sell <= 0 ? null : r2(((sell - cost) / sell) * 100);
    const d = dn.get(Number(s.mccmnc_id));
    return {
      customerTrunkId: Number(s.trunk_id),
      customerTrunk: s.trunk,
      enterprise: s.enterprise,
      mccmnc: s.mccmnc,
      country: d?.country ?? null,
      network: d ? (d.is_all_networks ? "All networks" : d.network) : null,
      sellRate: r6(sell),
      cost1: t[0] ? r6(t[0].cost) : null,
      vendor1: t[0]?.name ?? null,
      cost2: t[1] ? r6(t[1].cost) : null,
      vendor2: t[1]?.name ?? null,
      cost3: t[2] ? r6(t[2].cost) : null,
      vendor3: t[2]?.name ?? null,
      margin1Pct: margin(t[0]?.cost),
      margin2Pct: margin(t[1]?.cost),
      margin3Pct: margin(t[2]?.cost),
      belowCost: t[0] !== undefined && sell < t[0].cost,
      messages7d: vol.get(`${s.trunk_id}:${s.mccmnc}`) ?? 0,
    };
  });
}

// ---------------------------------------------------------------- change alerts

const CHANGE_FROM = `lcr_changes ch JOIN mccmnc m ON m.id = ch.mccmnc_id JOIN countries co ON co.id = m.country_id
  LEFT JOIN vendor_trunks ov ON ov.id = ch.old_vendor_id LEFT JOIN vendor_trunks nv ON nv.id = ch.new_vendor_id`;
const PLATFORM = `(SELECT rate_per_eur FROM currency_latest WHERE iso = '${PLATFORM_CURRENCY}')`;
export const lcrChangeList: ListDef<import("@sms/contract").LcrChangeRow> = {
  fields: listFields.lcr_changes,
  from: CHANGE_FROM,
  columns: {
    id: { sql: "ch.id" },
    detectedAt: { sql: "ch.detected_at" },
    country: { sql: "co.name" },
    network: { sql: "m.network" },
    mccmnc: { sql: "m.mccmnc" },
    kind: { sql: "ch.kind" },
    oldVendor: { sql: "ov.name" },
    newVendor: { sql: "nv.name" },
    oldCost: { sql: `(ch.old_cost_eur * ${PLATFORM})` },
    newCost: { sql: `(ch.new_cost_eur * ${PLATFORM})` },
    changePct: { sql: "ch.change_pct" },
  },
  search: ["country", "network", "mccmnc", "oldVendor", "newVendor"],
  idSql: "ch.id",
  select: `ch.*, m.mccmnc, m.network, m.is_all_networks, co.name AS country, ov.name AS old_vendor, nv.name AS new_vendor,
    ch.old_cost_eur * ${PLATFORM} AS old_cost, ch.new_cost_eur * ${PLATFORM} AS new_cost,
    (SELECT mm.id FROM market_moves mm WHERE mm.mccmnc_id = ch.mccmnc_id
      AND ch.detected_at BETWEEN mm.first_effective - interval '7 days' AND mm.last_effective + interval '7 days'
      ORDER BY mm.detected_at DESC LIMIT 1) AS market_move_id`,
  mapRow: (r) => ({
    id: Number(r.id),
    mccmnc: r.mccmnc as string,
    country: (r.country as string) ?? null,
    network: r.is_all_networks ? "All networks" : ((r.network as string) ?? null),
    kind: r.kind as "top_changed" | "cost_moved",
    oldVendor: (r.old_vendor as string | null) ?? null,
    newVendor: (r.new_vendor as string | null) ?? null,
    oldCost: r.old_cost === null ? null : r6(Number(r.old_cost)),
    newCost: r.new_cost === null ? null : r6(Number(r.new_cost)),
    changePct: r.change_pct === null ? null : Number(r.change_pct),
    detectedAt: iso(r.detected_at)!,
    marketMoveId: r.market_move_id === null ? null : Number(r.market_move_id),
  }),
};

export function queryLcrChanges(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.lcr_changes);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, lcrChangeList, query));
}

const toAlertSettings = (r: Record<string, unknown>): LcrAlertSettings => ({
  enabled: r.enabled as boolean,
  costMovePct: Number(r.cost_move_pct),
  topChanged: r.top_changed as boolean,
});

export function getLcrAlertSettings(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT * FROM lcr_alert_settings WHERE id = 1");
    return toAlertSettings(rows[0]);
  });
}

export function updateLcrAlertSettings(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as LcrAlertSettings;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `UPDATE lcr_alert_settings SET enabled = $1, cost_move_pct = $2, top_changed = $3, updated_by_id = $4, updated_at = now()
        WHERE id = 1 RETURNING *`,
      [b.enabled, b.costMovePct, b.topChanged, me.id],
    );
    return toAlertSettings(rows[0]);
  });
}

/** Cheapest live vendor per destination at a time (vendor lines valid then, latest exchange rates). */
async function cheapestAt(c: Db, at: Date) {
  const { rows } = await c.query(
    `SELECT DISTINCT ON (l.mccmnc_id) l.mccmnc_id, rt.vendor_trunk_id, l.rate / cl.rate_per_eur AS usd
       FROM rate_lines l
       JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
       JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id AND vt.deleted_at IS NULL AND vt.status = 'active'
       JOIN currency_latest cl ON cl.iso = l.currency
      WHERE l.sender_id IS NULL AND NOT l.is_blocked AND l.valid_from <= $1 AND (l.valid_to IS NULL OR l.valid_to > $1)
      ORDER BY l.mccmnc_id, l.rate / cl.rate_per_eur, rt.vendor_trunk_id`,
    [at],
  );
  return new Map(rows.map((r) => [Number(r.mccmnc_id), { vt: Number(r.vendor_trunk_id), usd: Number(r.usd) }]));
}

/** Compares the cheapest vendor and cost with the last check and records the changes (§13.23). */
export async function checkLcrChanges(at = new Date(), c: Db = db()): Promise<number> {
  const { rows: s } = await c.query("SELECT * FROM lcr_alert_settings WHERE id = 1");
  const settings = toAlertSettings(s[0]);
  if (!settings.enabled) return 0;
  const { rows: snap } = await c.query("SELECT mccmnc_id, vendor_trunk_id, cost_eur FROM lcr_snapshot");
  const before = new Map(
    snap.map((r) => [Number(r.mccmnc_id), { vt: Number(r.vendor_trunk_id), usd: Number(r.cost_eur) }]),
  );
  const now = await cheapestAt(c, at);
  const ch = {
    m: [] as number[],
    kind: [] as string[],
    ov: [] as number[],
    nv: [] as number[],
    oc: [] as number[],
    nc: [] as number[],
    pct: [] as number[],
  };
  for (const [m, n] of now) {
    const b = before.get(m);
    if (!b) continue;
    const pct = b.usd > 0 ? r2((n.usd / b.usd - 1) * 100) : 0;
    const push = (kind: string) => {
      ch.m.push(m);
      ch.kind.push(kind);
      ch.ov.push(b.vt);
      ch.nv.push(n.vt);
      ch.oc.push(b.usd);
      ch.nc.push(n.usd);
      ch.pct.push(pct);
    };
    if (settings.topChanged && b.vt !== n.vt) push("top_changed");
    if (Math.abs(pct) >= settings.costMovePct) push("cost_moved");
  }
  if (ch.m.length)
    await c.query(
      `INSERT INTO lcr_changes (mccmnc_id, kind, old_vendor_id, new_vendor_id, old_cost_eur, new_cost_eur, change_pct, detected_at)
       SELECT *, $8 FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::bigint[], $5::numeric[], $6::numeric[], $7::numeric[])`,
      [ch.m, ch.kind, ch.ov, ch.nv, ch.oc, ch.nc, ch.pct, at],
    );
  const ids = [...now.keys()];
  await c.query(
    `INSERT INTO lcr_snapshot (mccmnc_id, vendor_trunk_id, cost_eur, checked_at)
     SELECT m, v, u, $4 FROM unnest($1::bigint[], $2::bigint[], $3::numeric[]) AS x(m, v, u)
     ON CONFLICT (mccmnc_id) DO UPDATE SET vendor_trunk_id = EXCLUDED.vendor_trunk_id, cost_eur = EXCLUDED.cost_eur,
       checked_at = EXCLUDED.checked_at`,
    [ids, ids.map((m) => now.get(m)!.vt), ids.map((m) => now.get(m)!.usd), at],
  );
  return ch.m.length;
}

/** At start: with no snapshot yet, replay the last 7 days day by day for a change history; then every 15 min. */
export function startLcrChecks(): void {
  setTimeout(async () => {
    try {
      const { rows } = await db().query("SELECT count(*)::int AS n FROM lcr_snapshot");
      if (rows[0].n === 0)
        for (let d = 7; d >= 1; d--)
          await checkLcrChanges(new Date(Math.floor(Date.now() / 86_400_000 - d) * 86_400_000 + 6 * 3600_000));
      await checkLcrChanges();
    } catch (e) {
      console.error("LCR check failed:", e);
    }
  }, 30_000).unref();
  setInterval(() => void checkLcrChanges().catch((e) => console.error("LCR check failed:", e)), 15 * 60_000).unref();
}
