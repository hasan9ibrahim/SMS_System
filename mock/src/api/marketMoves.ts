// Market rate movements (§13.14). A scan looks at vendor rate changes of the last weeks (imports,
// incoming RNs §13.13, manual edits), keeps the top vendors of each destination (Tier 1 plus the
// cheapest N), and records a move when enough of them change in the same direction within the window
// (market/detect.ts). Each move lists the affected client tables with a suggested sell rate; account
// managers update them through Bulk rating, reroute, snooze or dismiss, and every action is logged.
// Optional auto-apply rules re-price a client's table to keep a margin, with the contractual notice.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ListQuery,
  MarketAutoRule,
  MarketAutoRuleInput,
  MarketMoveAction,
  MarketMoveClient,
  MarketMoveDetail,
  MarketMoveRow,
  MarketMoveSettings,
  MarketMoveVendor,
  RateLineEdit,
} from "@sms/contract";
import { PLATFORM_CURRENCY } from "../currency.js";
import { db, withDb } from "../db.js";
import { chRows } from "../edr.js";
import type { ListDef } from "../lists/engine.js";
import { runList } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { findMoves, suggestRate, type VendorChange } from "../market/detect.js";
import { sendProblem } from "../problem.js";
import { logEmail } from "./emailLog.js";
import { applyLineEdits, checkLineEdits, noticePeriods, type EditTable } from "./rates.js";
import { iso, recordChange, type DiffEntry } from "./records.js";
import { CURRENT_USER_ID, getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
const DAY_MS = 86_400_000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const notFound = (reply: FastifyReply, id: number) => sendProblem(reply, 404, `Market move ${id} not found`);

// ---------------------------------------------------------------- settings

async function loadSettings(c: Db) {
  const { rows } = await c.query(
    `SELECT s.*, u.username AS updated_by FROM market_move_settings s LEFT JOIN users u ON u.id = s.updated_by_id WHERE s.id = 1`,
  );
  return rows[0];
}
const toSettings = (r: Record<string, unknown>): MarketMoveSettings => ({
  cheapestN: Number(r.cheapest_n),
  includeTier1: r.include_tier1 as boolean,
  windowDays: Number(r.window_days),
  minVendors: Number(r.min_vendors),
  minChangePct: Number(r.min_change_pct),
  lookbackDays: Number(r.lookback_days),
  urgentChangePct: Number(r.urgent_change_pct),
  urgentDays: Number(r.urgent_days),
  targetMarginPct: r.target_margin_pct === null ? null : Number(r.target_margin_pct),
  digestHour: Number(r.digest_hour),
  updatedBy: (r.updated_by as string | null) ?? null,
  updatedAt: iso(r.updated_at),
});

export function getMarketMoveSettings(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => toSettings(await loadSettings(pool)));
}

export function updateMarketMoveSettings(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as MarketMoveSettings;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    await pool.query(
      `UPDATE market_move_settings SET cheapest_n = $1, include_tier1 = $2, window_days = $3, min_vendors = $4,
         min_change_pct = $5, lookback_days = $6, urgent_change_pct = $7, urgent_days = $8, target_margin_pct = $9,
         digest_hour = $10, updated_by_id = $11, updated_at = now() WHERE id = 1`,
      [
        b.cheapestN,
        b.includeTier1,
        b.windowDays,
        b.minVendors,
        b.minChangePct,
        b.lookbackDays,
        b.urgentChangePct,
        b.urgentDays,
        b.targetMarginPct,
        b.digestHour,
        me.id,
      ],
    );
    return toSettings(await loadSettings(pool));
  });
}

// ---------------------------------------------------------------- list

const DEST_JOIN = "JOIN mccmnc m ON m.id = mm.mccmnc_id JOIN countries co ON co.id = m.country_id";
const PLATFORM = `(SELECT rate_per_usd FROM currency_latest WHERE iso = '${PLATFORM_CURRENCY}')`;
const MOVE_FROM = `market_moves mm ${DEST_JOIN} LEFT JOIN users hb ON hb.id = mm.handled_by_id`;
const MOVE_SELECT = `mm.*, m.mccmnc, m.network, co.name AS country, co.iso, hb.username AS handled_by,
  mm.old_cost_usd * ${PLATFORM} AS old_cost, mm.new_cost_usd * ${PLATFORM} AS new_cost`;

function mapMove(r: Record<string, unknown>): MarketMoveRow {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: Number(r.id),
    mccmnc: r.mccmnc as string,
    country: (r.country as string) ?? null,
    countryIso: ((r.iso as string) ?? "").trim() || null,
    network: (r.network as string) ?? null,
    direction: r.direction as MarketMoveRow["direction"],
    avgChangePct: Number(r.avg_change_pct),
    movedCount: Number(r.moved_count),
    topCount: Number(r.top_count),
    firstEffective: iso(r.first_effective)!,
    lastEffective: iso(r.last_effective)!,
    detectedAt: iso(r.detected_at)!,
    oldCost: num(r.old_cost) === null ? null : r6(Number(r.old_cost)),
    newCost: num(r.new_cost) === null ? null : r6(Number(r.new_cost)),
    currency: PLATFORM_CURRENCY,
    state: r.state as MarketMoveRow["state"],
    urgent: r.urgent as boolean,
    snoozedUntil: iso(r.snoozed_until),
    affectedClients: Number(r.affected_clients),
    affectedTables: Number(r.affected_tables),
    volume7d: Number(r.volume_7d),
    autoApplied: Number(r.auto_applied),
    handledBy: (r.handled_by as string | null) ?? null,
    handledAt: iso(r.handled_at),
    note: (r.note as string | null) ?? null,
  };
}

export const marketMoveList: ListDef<MarketMoveRow> = {
  fields: listFields.market_moves,
  from: MOVE_FROM,
  columns: {
    id: { sql: "mm.id" },
    country: { sql: "co.name" },
    network: { sql: "m.network" },
    mccmnc: { sql: "m.mccmnc" },
    direction: { sql: "mm.direction" },
    avgChangePct: { sql: "mm.avg_change_pct" },
    movedCount: { sql: "mm.moved_count" },
    topCount: { sql: "mm.top_count" },
    firstEffective: { sql: "mm.first_effective" },
    lastEffective: { sql: "mm.last_effective" },
    newCost: { sql: `(mm.new_cost_usd * ${PLATFORM})` },
    affectedClients: { sql: "mm.affected_clients" },
    volume7d: { sql: "mm.volume_7d" },
    urgent: { sql: "mm.urgent" },
    state: { sql: "mm.state" },
    detectedAt: { sql: "mm.detected_at" },
    handledBy: { sql: "hb.username" },
    autoApplied: { sql: "mm.auto_applied" },
    // Account managers see moves for their own clients (§13.14).
    amUserId: {
      sql: "NULL",
      where: (op, c, p) => {
        const ids = op === "in" ? (c.values ?? []).map(Number) : [Number(c.value)];
        return `(mm.affected_am_ids && ${p(ids)}::bigint[])`;
      },
    },
  },
  search: ["country", "network", "mccmnc"],
  idSql: "mm.id",
  select: MOVE_SELECT,
  mapRow: mapMove,
};

export function queryMarketMoves(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.market_moves);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, marketMoveList, query));
}

export function getMarketMoveSummary(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS open, count(*) FILTER (WHERE urgent)::int AS urgent,
              count(*) FILTER (WHERE direction = 'up')::int AS up, count(*) FILTER (WHERE direction = 'down')::int AS down,
              count(*) FILTER (WHERE $1 = ANY(affected_am_ids))::int AS mine
         FROM market_moves WHERE state = 'open'`,
      [me.id],
    );
    return rows[0];
  });
}

// ---------------------------------------------------------------- detail

async function perUsd(c: Db): Promise<Map<string, number>> {
  const { rows } = await c.query("SELECT iso, rate_per_usd FROM currency_latest");
  return new Map(rows.map((r) => [String(r.iso), Number(r.rate_per_usd)]));
}

/** Customer tables (used by a live trunk) with a current generic line for the destination. */
async function affectedTables(c: Db, mccmncId: number) {
  const { rows } = await c.query(
    `SELECT rt.id, rt.name, rt.currency, rt.product_category_id, l.id AS line_id, l.rate,
            string_agg(DISTINCT e.name, ', ') AS clients, array_agg(DISTINCT e.id) AS enterprise_ids,
            max(e.rate_notice_days) AS notice_days,
            (array_agg(DISTINCT am.username) FILTER (WHERE am.username IS NOT NULL))[1] AS am
       FROM rate_lines l
       JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'customer' AND rt.deleted_at IS NULL
       JOIN customer_trunk_rate_tables x ON x.rate_table_id = rt.id
       JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
       JOIN enterprises e ON e.id = t.enterprise_id
       LEFT JOIN users am ON am.id = e.account_manager_id
      WHERE l.mccmnc_id = $1 AND l.sender_id IS NULL AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
      GROUP BY rt.id, l.id
      ORDER BY rt.name`,
    [mccmncId],
  );
  return rows;
}

async function autoRules(c: Db) {
  const { rows } = await c.query(
    `SELECT r.*, e.name AS enterprise, pc.name AS category FROM market_auto_rules r
       LEFT JOIN enterprises e ON e.id = r.enterprise_id LEFT JOIN product_categories pc ON pc.id = r.category_id
      WHERE r.deleted_at IS NULL AND r.status = 'active'`,
  );
  return rows;
}
const ruleLabel = (r: Record<string, unknown>) =>
  `${r.enterprise ?? `Category ${r.category}`}: keep margin ≥ ${Number(r.min_margin_pct)} %${r.direction === "both" ? " (up and down)" : " (increases)"}`;

/** The client's rule: its own enterprise first, then the table's category. */
function ruleFor(rules: Record<string, unknown>[], table: Record<string, unknown>) {
  const ents = ((table.enterprise_ids as string[]) ?? []).map(Number);
  return (
    rules.find((r) => r.enterprise_id !== null && ents.includes(Number(r.enterprise_id))) ??
    rules.find((r) => r.category_id !== null && Number(r.category_id) === Number(table.product_category_id)) ??
    null
  );
}

async function loadMove(c: Db, id: number): Promise<MarketMoveDetail | null> {
  const { rows } = await c.query(`SELECT ${MOVE_SELECT} FROM ${MOVE_FROM} WHERE mm.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  const row = mapMove(r);
  const fx = await perUsd(c);
  const platform = fx.get(PLATFORM_CURRENCY) ?? 1;
  const settings = await loadSettings(c);
  const { rows: vs } = await c.query(
    `SELECT v.*, vt.name AS trunk, e.name AS vendor, e.tier,
            (SELECT rt.id FROM rate_tables rt WHERE rt.vendor_trunk_id = vt.id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
              ORDER BY rt.id LIMIT 1) AS table_id
       FROM market_move_vendors v JOIN vendor_trunks vt ON vt.id = v.vendor_trunk_id JOIN enterprises e ON e.id = vt.enterprise_id
      WHERE v.move_id = $1 ORDER BY v.moved DESC, v.new_rate_usd NULLS LAST`,
    [id],
  );
  const tableIds = vs.map((v) => v.table_id).filter((x) => x !== null);
  const { rows: pts } = tableIds.length
    ? await c.query(
        `SELECT l.rate_table_id, l.valid_from, l.rate / cl.rate_per_usd AS usd FROM rate_lines l
           JOIN currency_latest cl ON cl.iso = l.currency
          WHERE l.rate_table_id = ANY($1) AND l.mccmnc_id = $2 AND l.sender_id IS NULL
            AND (l.valid_to IS NULL OR l.valid_to >= now() - interval '90 days')
          ORDER BY l.valid_from`,
        [tableIds, r.mccmnc_id],
      )
    : { rows: [] };
  const since = Date.now() - 90 * DAY_MS;
  const vendors: MarketMoveVendor[] = vs.map((v) => {
    const old = v.old_rate_usd === null ? null : Number(v.old_rate_usd) * platform;
    const next = v.new_rate_usd === null ? null : Number(v.new_rate_usd) * platform;
    return {
      vendorTrunkId: Number(v.vendor_trunk_id),
      vendorTrunk: v.trunk,
      vendor: v.vendor,
      tier: v.tier,
      moved: v.moved,
      oldRate: old === null ? null : r6(old),
      newRate: next === null ? null : r6(next),
      changePct: old && next !== null && v.moved ? r2((next / old - 1) * 100) : null,
      effectiveFrom: iso(v.effective_from),
      series: pts
        .filter((p) => Number(p.rate_table_id) === Number(v.table_id))
        .map((p) => ({
          at: new Date(Math.max((p.valid_from as Date).getTime(), since)).toISOString(),
          rate: r6(Number(p.usd) * platform),
        })),
    };
  });
  const tables = await affectedTables(c, Number(r.mccmnc_id));
  const traffic =
    tables.length > 0
      ? await chRows<{ t: number; n: string }>(
          `SELECT c_rate_table_id AS t, count() AS n FROM edr
            WHERE start_time >= now() - INTERVAL 7 DAY AND c_mccmnc = '${String(r.mccmnc).replace(/\D/g, "")}'
              AND c_rate_table_id IN (${tables.map((t) => Number(t.id)).join(",")})
            GROUP BY t`,
          6000,
        )
      : [];
  const volume = new Map((traffic ?? []).map((x) => [Number(x.t), Number(x.n)]));
  const rules = await autoRules(c);
  const target = settings.target_margin_pct === null ? null : Number(settings.target_margin_pct);
  const lastMs = (r.last_effective as Date).getTime();
  const clients: MarketMoveClient[] = tables.map((t) => {
    const k = fx.get(t.currency) ?? 1;
    const sell = Number(t.rate);
    const oldCost = r.old_cost_usd === null ? null : Number(r.old_cost_usd) * k;
    const newCost = r.new_cost_usd === null ? null : Number(r.new_cost_usd) * k;
    const margin = (cost: number | null) => (cost === null || sell <= 0 ? null : r2(((sell - cost) / sell) * 100));
    const notice = Number(t.notice_days ?? 0);
    const rule = ruleFor(rules, t);
    return {
      rateTableId: Number(t.id),
      table: t.name,
      clients: t.clients,
      accountManager: t.am ?? null,
      currency: t.currency,
      lineId: Number(t.line_id),
      sellRate: sell,
      marginNowPct: margin(oldCost),
      marginNewPct: margin(newCost),
      messages7d: volume.get(Number(t.id)) ?? 0,
      noticeDays: notice,
      suggestedRate: suggestRate(sell, oldCost, newCost, target),
      suggestedFrom: new Date(Math.max(lastMs, Date.now() + notice * DAY_MS)).toISOString(),
      belowNewCost: newCost !== null && sell < newCost,
      autoRule: rule ? ruleLabel(rule) : null,
    };
  });
  const { rows: log } = await c.query(
    `SELECT g.at, g.text, u.username FROM market_move_log g LEFT JOIN users u ON u.id = g.user_id
      WHERE g.move_id = $1 ORDER BY g.id`,
    [id],
  );
  return {
    ...row,
    vendors,
    clients: clients.sort((a, b) => b.messages7d - a.messages7d || a.table.localeCompare(b.table)),
    log: log.map((g) => ({ at: iso(g.at)!, user: g.username ?? null, text: g.text })),
  };
}

export function getMarketMove(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => (await loadMove(pool, id)) ?? notFound(reply, id));
}

const log = (c: Db, moveId: number, userId: number | null, text: string) =>
  c.query("INSERT INTO market_move_log (move_id, user_id, text) VALUES ($1, $2, $3)", [moveId, userId, text]);

export function actOnMarketMove(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const b = request.body as MarketMoveAction;
  const note = b.note?.trim() || null;
  if (b.action === "dismiss" && !note)
    return sendProblem(reply, 400, "Check the highlighted fields", {
      errors: [{ path: "/note", message: "a note is required to dismiss" }],
    });
  if (b.action === "note" && !note)
    return sendProblem(reply, 400, "Check the highlighted fields", {
      errors: [{ path: "/note", message: "required" }],
    });
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query("SELECT id FROM market_moves WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    const days = b.days ?? 7;
    await inTransaction(pool, async (c) => {
      if (b.action === "snooze")
        await c.query(
          "UPDATE market_moves SET state = 'snoozed', snoozed_until = now() + make_interval(days => $2), updated_at = now() WHERE id = $1",
          [id, days],
        );
      else if (b.action === "dismiss" || b.action === "handled")
        await c.query(
          `UPDATE market_moves SET state = $2, note = $3, handled_by_id = $4, handled_at = now(), snoozed_until = NULL,
             updated_at = now() WHERE id = $1`,
          [id, b.action === "dismiss" ? "dismissed" : "handled", note, me.id],
        );
      else if (b.action === "reopen")
        await c.query(
          "UPDATE market_moves SET state = 'open', snoozed_until = NULL, updated_at = now() WHERE id = $1",
          [id],
        );
      const text = {
        snooze: `Snoozed for ${days} day${days === 1 ? "" : "s"}`,
        dismiss: "Dismissed",
        handled: "Marked handled",
        reopen: "Reopened",
        note: "Note",
      }[b.action];
      await log(c, id, me.id, note ? `${text}: ${note}` : text);
    });
    return loadMove(pool, id);
  });
}

// ---------------------------------------------------------------- scan

interface Candidate {
  mccmncId: number;
  mccmnc: string;
  topCount: number;
  current: Map<number, number>; // top vendor trunk -> current usd
  changes: VendorChange[];
}

/** Top vendors per destination and their recent changes (one SQL pass over the rate lines). */
async function loadCandidates(c: Db, s: MarketMoveSettings): Promise<Map<number, Candidate>> {
  const { rows: top } = await c.query(
    `WITH cur AS (
       SELECT l.mccmnc_id AS m, l.mccmnc, rt.vendor_trunk_id AS vt, e.tier, l.rate / cl.rate_per_usd AS usd
         FROM rate_lines l
         JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
         JOIN vendor_trunks v ON v.id = rt.vendor_trunk_id AND v.deleted_at IS NULL AND v.status = 'active'
         JOIN enterprises e ON e.id = v.enterprise_id
         JOIN currency_latest cl ON cl.iso = l.currency
        WHERE l.sender_id IS NULL AND NOT l.is_blocked AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now()))
     SELECT m, mccmnc, vt, usd FROM (
       SELECT cur.*, row_number() OVER (PARTITION BY m, vt ORDER BY usd) AS dup,
              dense_rank() OVER (PARTITION BY m ORDER BY usd, vt) AS rn FROM cur) x
      WHERE dup = 1 AND (rn <= $1 OR ($2 AND tier = 'tier1'))`,
    [s.cheapestN, s.includeTier1],
  );
  const out = new Map<number, Candidate>();
  for (const t of top) {
    const m = Number(t.m);
    const cand = out.get(m) ?? { mccmncId: m, mccmnc: t.mccmnc, topCount: 0, current: new Map(), changes: [] };
    if (!cand.current.has(Number(t.vt))) {
      cand.current.set(Number(t.vt), Number(t.usd));
      cand.topCount++;
    }
    out.set(m, cand);
  }
  const { rows: ch } = await c.query(
    `SELECT l.mccmnc_id AS m, rt.vendor_trunk_id AS vt, l.valid_from, l.rate / cl.rate_per_usd AS new_usd,
            p.rate / cp.rate_per_usd AS old_usd
       FROM rate_lines l
       JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
       JOIN rate_lines p ON p.rate_table_id = l.rate_table_id AND p.mccmnc_id = l.mccmnc_id AND p.sender_id IS NULL
                        AND p.valid_to = l.valid_from
       JOIN currency_latest cl ON cl.iso = l.currency
       JOIN currency_latest cp ON cp.iso = p.currency
      WHERE l.sender_id IS NULL AND l.valid_from >= now() - make_interval(days => $1)
        AND abs(l.rate / nullif(p.rate, 0) - 1) * 100 >= $2`,
    [s.lookbackDays, s.minChangePct],
  );
  for (const x of ch) {
    const cand = out.get(Number(x.m));
    if (!cand || !cand.current.has(Number(x.vt))) continue;
    cand.changes.push({
      vendorTrunkId: Number(x.vt),
      at: (x.valid_from as Date).getTime(),
      oldUsd: Number(x.old_usd),
      newUsd: Number(x.new_usd),
    });
  }
  return out;
}

let scanning: Promise<unknown> | null = null;

/** One detection pass; concurrent calls share the running pass. */
export function runMarketScan(): Promise<{
  created: number;
  updated: number;
  expired: number;
  autoApplied: number;
  tookMs: number;
}> {
  if (scanning) return scanning as never;
  const p = scan().finally(() => (scanning = null));
  scanning = p;
  return p;
}

async function scan() {
  const t0 = Date.now();
  const c = db();
  const s = toSettings(await loadSettings(c));
  const candidates = await loadCandidates(c, s);
  const found: { cand: Candidate; move: ReturnType<typeof findMoves>[number] }[] = [];
  for (const cand of candidates.values())
    if (cand.changes.length >= s.minVendors) for (const move of findMoves(cand.changes, s)) found.push({ cand, move });

  // Affected clients per destination (customer tables used by a live trunk).
  const ids = [...new Set(found.map((f) => f.cand.mccmncId))];
  const { rows: aff } = ids.length
    ? await c.query(
        `SELECT l.mccmnc_id AS m, count(DISTINCT l.rate_table_id)::int AS tables, count(DISTINCT t.enterprise_id)::int AS clients,
                coalesce(array_agg(DISTINCT e.account_manager_id) FILTER (WHERE e.account_manager_id IS NOT NULL), '{}') AS ams
           FROM rate_lines l
           JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'customer' AND rt.deleted_at IS NULL
           JOIN customer_trunk_rate_tables x ON x.rate_table_id = rt.id
           JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
           JOIN enterprises e ON e.id = t.enterprise_id
          WHERE l.mccmnc_id = ANY($1) AND l.sender_id IS NULL AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
          GROUP BY 1`,
        [ids],
      )
    : { rows: [] };
  const affected = new Map(aff.map((a) => [Number(a.m), a]));
  const codes = [...new Set(found.map((f) => f.cand.mccmnc.replace(/\D/g, "")))];
  const vol = codes.length
    ? await chRows<{ m: string; n: string }>(
        `SELECT c_mccmnc AS m, sum(attempts) AS n FROM edr_hourly WHERE hour >= now() - INTERVAL 7 DAY
          AND c_mccmnc IN (${codes.map((x) => `'${x}'`).join(",")}) GROUP BY m`,
        8000,
      )
    : [];
  const volume = new Map((vol ?? []).map((v) => [v.m, Number(v.n)]));

  // One batch upsert of the moves, then their vendors and the "Detected" log lines.
  const now = Date.now();
  const rows: { cand: Candidate; move: (typeof found)[number]["move"]; a: Record<string, unknown> }[] = [];
  for (const f of found) {
    const a = affected.get(f.cand.mccmncId);
    if (a) rows.push({ ...f, a }); // nobody sells the other destinations
  }
  const cols = {
    m: [] as number[],
    dir: [] as string[],
    first: [] as Date[],
    last: [] as Date[],
    avg: [] as number[],
    moved: [] as number[],
    top: [] as number[],
    oldc: [] as number[],
    newc: [] as number[],
    urgent: [] as boolean[],
    tables: [] as number[],
    clients: [] as number[],
    ams: [] as string[],
    vol: [] as number[],
  };
  for (const { cand, move, a } of rows) {
    const after = (vt: number, usd: number, k: "oldUsd" | "newUsd") =>
      move.changes.find((x) => x.vendorTrunkId === vt)?.[k] ?? usd;
    cols.m.push(cand.mccmncId);
    cols.dir.push(move.direction);
    cols.first.push(new Date(move.first));
    cols.last.push(new Date(move.last));
    cols.avg.push(move.avgChangePct);
    cols.moved.push(move.changes.length);
    cols.top.push(cand.topCount);
    cols.oldc.push(Math.min(...[...cand.current].map(([vt, usd]) => after(vt, usd, "oldUsd"))));
    cols.newc.push(Math.min(...[...cand.current].map(([vt, usd]) => after(vt, usd, "newUsd"))));
    cols.urgent.push(
      move.direction === "up" &&
        move.avgChangePct >= s.urgentChangePct &&
        move.first <= now + s.urgentDays * DAY_MS &&
        move.last >= now - DAY_MS,
    );
    cols.tables.push(Number(a.tables));
    cols.clients.push(Number(a.clients));
    cols.ams.push(`{${((a.ams as number[]) ?? []).join(",")}}`);
    cols.vol.push(volume.get(cand.mccmnc.replace(/\D/g, "")) ?? 0);
  }
  const { rows: saved } = rows.length
    ? await c.query(
        `INSERT INTO market_moves (mccmnc_id, direction, first_effective, last_effective, avg_change_pct, moved_count,
            top_count, old_cost_usd, new_cost_usd, urgent, affected_tables, affected_clients, affected_am_ids, volume_7d)
         SELECT m, dir, f, l, avg, mv, tp, oc, nc, ur, tb, cl, am::bigint[], vo
           FROM unnest($1::bigint[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::numeric[], $6::int[], $7::int[],
                       $8::numeric[], $9::numeric[], $10::boolean[], $11::int[], $12::int[], $13::text[], $14::int[])
                AS x(m, dir, f, l, avg, mv, tp, oc, nc, ur, tb, cl, am, vo)
         ON CONFLICT (mccmnc_id, direction, first_effective) DO UPDATE SET last_effective = EXCLUDED.last_effective,
            avg_change_pct = EXCLUDED.avg_change_pct, moved_count = EXCLUDED.moved_count, top_count = EXCLUDED.top_count,
            old_cost_usd = EXCLUDED.old_cost_usd, new_cost_usd = EXCLUDED.new_cost_usd, urgent = EXCLUDED.urgent,
            affected_tables = EXCLUDED.affected_tables, affected_clients = EXCLUDED.affected_clients,
            affected_am_ids = EXCLUDED.affected_am_ids, volume_7d = EXCLUDED.volume_7d, updated_at = now()
         RETURNING id, mccmnc_id, direction, first_effective, (xmax = 0) AS inserted`,
        [
          cols.m,
          cols.dir,
          cols.first,
          cols.last,
          cols.avg,
          cols.moved,
          cols.top,
          cols.oldc,
          cols.newc,
          cols.urgent,
          cols.tables,
          cols.clients,
          cols.ams,
          cols.vol,
        ],
      )
    : { rows: [] };
  const key = (m: number, d: string, f: number) => `${m}:${d}:${f}`;
  const idOf = new Map(
    saved.map((r) => [key(Number(r.mccmnc_id), r.direction, (r.first_effective as Date).getTime()), r]),
  );
  const v = {
    move: [] as number[],
    vt: [] as number[],
    moved: [] as boolean[],
    o: [] as number[],
    n: [] as number[],
    at: [] as (Date | null)[],
  };
  const logs = { move: [] as number[], text: [] as string[] };
  const inserted: number[] = [];
  for (const { cand, move } of rows) {
    const r = idOf.get(key(cand.mccmncId, move.direction, move.first));
    if (!r) continue;
    const id = Number(r.id);
    for (const [vt, usd] of cand.current) {
      const x = move.changes.find((y) => y.vendorTrunkId === vt);
      v.move.push(id);
      v.vt.push(vt);
      v.moved.push(!!x);
      v.o.push(x ? x.oldUsd : usd);
      v.n.push(x ? x.newUsd : usd);
      v.at.push(x ? new Date(x.at) : null);
    }
    if (r.inserted) {
      inserted.push(id);
      logs.move.push(id);
      logs.text.push(
        `Detected: ${move.changes.length} of ${cand.topCount} top vendors moved ${move.direction} ` +
          `${move.avgChangePct > 0 ? "+" : ""}${move.avgChangePct} % on average`,
      );
    }
  }
  if (saved.length) {
    await c.query("DELETE FROM market_move_vendors WHERE move_id = ANY($1)", [saved.map((r) => Number(r.id))]);
    await c.query(
      `INSERT INTO market_move_vendors (move_id, vendor_trunk_id, moved, old_rate_usd, new_rate_usd, effective_from)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::boolean[], $4::numeric[], $5::numeric[], $6::timestamptz[])`,
      [v.move, v.vt, v.moved, v.o, v.n, v.at],
    );
  }
  if (logs.move.length)
    await c.query("INSERT INTO market_move_log (move_id, text) SELECT * FROM unnest($1::bigint[], $2::text[])", [
      logs.move,
      logs.text,
    ]);
  let autoApplied = 0;
  if ((await autoRules(c)).length) for (const id of inserted) autoApplied += await autoApply(id);
  const created = inserted.length;
  const updated = saved.length - created;

  // Snoozes end; old moves nobody acted on expire.
  await c.query(
    "UPDATE market_moves SET state = 'open', snoozed_until = NULL WHERE state = 'snoozed' AND snoozed_until <= now()",
  );
  const { rowCount: expired } = await c.query(
    `UPDATE market_moves SET state = 'expired', updated_at = now()
      WHERE state IN ('open', 'snoozed') AND last_effective < now() - make_interval(days => $1)`,
    [s.lookbackDays],
  );
  return { created, updated, expired: expired ?? 0, autoApplied, tookMs: Date.now() - t0 };
}

/**
 * Auto-apply rules (§13.14): for a new move, re-price each covered client table whose margin at the
 * new cost falls below the rule's minimum, from the move's date or the client's notice, whichever is
 * later. One undoable change per table.
 */
async function autoApply(moveId: number): Promise<number> {
  const c = db();
  const rules = await autoRules(c);
  if (!rules.length) return 0;
  const move = await loadMove(c, moveId);
  if (!move) return 0;
  const fx = await perUsd(c);
  const { rows: mm } = await c.query("SELECT new_cost_usd, mccmnc_id FROM market_moves WHERE id = $1", [moveId]);
  const newUsd = Number(mm[0].new_cost_usd);
  const tables = await affectedTables(c, Number(mm[0].mccmnc_id));
  let applied = 0;
  for (const t of tables) {
    const rule = ruleFor(rules, t);
    if (!rule || (move.direction === "down" && rule.direction !== "both")) continue;
    const sell = Number(t.rate);
    const cost = newUsd * (fx.get(t.currency) ?? 1);
    const min = Number(rule.min_margin_pct);
    const margin = sell > 0 ? ((sell - cost) / sell) * 100 : -100;
    const rate = r6(cost / (1 - min / 100));
    if (move.direction === "up" ? margin >= min : rate >= sell) continue;
    const notice = (await noticePeriods(c, [Number(t.id)])).get(Number(t.id));
    const from = new Date(
      Math.max(Date.parse(move.lastEffective), Date.now() + (notice?.days ?? 0) * DAY_MS, Date.now()),
    );
    const edits: RateLineEdit[] = [
      { action: "set", mccmnc: move.mccmnc, senderId: null, rate, effectiveFrom: from.toISOString() },
    ];
    const ids = new Map<string, number>();
    if (
      (
        await checkLineEdits(
          c,
          Number(t.id),
          edits.map((it) => ({ it, at: "/" })),
          ids,
          Date.now(),
        )
      ).length
    )
      continue;
    const table: EditTable = { id: Number(t.id), name: t.name, kind: "customer", currency: t.currency, notice: null };
    await inTransaction(c as pg.Pool, async (tx) => {
      const diff: DiffEntry[] = [];
      await applyLineEdits(tx, table, edits, ids, CURRENT_USER_ID, new Date(), diff, []);
      if (!diff.length) return;
      await tx.query("SELECT refresh_rate_table_stats($1::bigint[])", [[table.id]]);
      await recordChange(tx, {
        entityType: "rate_table",
        entityIds: [table.id],
        changeType: "edit",
        diff,
        note: `Auto-apply after market move #${moveId} (${ruleLabel(rule)})`,
        userId: CURRENT_USER_ID,
      });
      await log(
        tx,
        moveId,
        null,
        `Auto-applied ${rate} ${t.currency} on ${t.name} from ${from.toISOString().slice(0, 10)}`,
      );
      applied++;
    });
  }
  if (applied)
    await c.query("UPDATE market_moves SET auto_applied = auto_applied + $2 WHERE id = $1", [moveId, applied]);
  return applied;
}

export function scanMarketMoves(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, () => runMarketScan());
}

let scanTimer: NodeJS.Timeout | null = null;
/** A scan soon after vendor rate changes; several in a row lead to one. */
export function scheduleMarketScan(delayMs = 60_000): void {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    void runMarketScan().catch(() => undefined);
  }, delayMs);
  scanTimer.unref();
}

// ---------------------------------------------------------------- digest

/** One e-mail per account manager with the moves for their clients not yet in a digest. */
export async function sendDigest(c: Db): Promise<number> {
  const { rows } = await c.query(
    `SELECT u.id, u.email, u.first_name, array_agg(mm.id ORDER BY mm.urgent DESC, mm.avg_change_pct DESC) AS ids
       FROM market_moves mm JOIN users u ON u.id = ANY(mm.affected_am_ids)
      WHERE mm.state = 'open' AND mm.digested_at IS NULL AND u.deleted_at IS NULL
      GROUP BY u.id`,
  );
  let sent = 0;
  for (const u of rows) {
    const { rows: mv } = await c.query(`SELECT ${MOVE_SELECT} FROM ${MOVE_FROM} WHERE mm.id = ANY($1)`, [u.ids]);
    const lines = mv
      .map(mapMove)
      .slice(0, 50)
      .map(
        (m) =>
          `${m.urgent ? "URGENT " : ""}${m.direction === "up" ? "↑" : "↓"} ${m.country} ${m.network} (${m.mccmnc}): ` +
          `${m.avgChangePct > 0 ? "+" : ""}${m.avgChangePct} %, ${m.movedCount} of ${m.topCount} top vendors, ` +
          `from ${m.firstEffective.slice(0, 10)}, ${m.affectedClients} client${m.affectedClients === 1 ? "" : "s"}`,
      );
    await logEmail(c, {
      type: "daily_report",
      to: u.email ? [u.email] : [],
      sender: null,
      subject: `Market moves: ${mv.length} new for your clients`,
      body: `Hello ${u.first_name ?? ""},\n\nNew market moves for your clients:\n\n${lines.join("\n")}${mv.length > 50 ? `\n… and ${mv.length - 50} more` : ""}\n\nOpen Rates › Market moves to update rates.`,
    });
    sent++;
  }
  await c.query("UPDATE market_moves SET digested_at = now() WHERE state = 'open' AND digested_at IS NULL");
  await c.query("UPDATE market_move_settings SET last_digest_at = now() WHERE id = 1");
  return sent;
}

export function sendMarketMoveDigest(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => ({ sent: await sendDigest(pool) }));
}

/** Scans at start and every 15 minutes; the digest once a day at the digest hour (UTC). */
export function startMarketMoves(): void {
  setTimeout(() => void runMarketScan().catch((e) => console.error("market scan failed:", e)), 20_000).unref();
  const tick = setInterval(async () => {
    try {
      await runMarketScan();
      const s = await loadSettings(db());
      const now = new Date();
      const last = s.last_digest_at ? (s.last_digest_at as Date).getTime() : 0;
      if (now.getUTCHours() === Number(s.digest_hour) && Date.now() - last > 20 * 3600_000) await sendDigest(db());
    } catch (e) {
      console.error("market scan failed:", e);
    }
  }, 15 * 60_000);
  tick.unref();
}

// ---------------------------------------------------------------- auto-apply rules

async function ruleRow(c: Db, id: number): Promise<MarketAutoRule | null> {
  const { rows } = await c.query(
    `SELECT r.*, e.name AS enterprise, pc.name AS category, u.username AS updated_by FROM market_auto_rules r
       LEFT JOIN enterprises e ON e.id = r.enterprise_id LEFT JOIN product_categories pc ON pc.id = r.category_id
       LEFT JOIN users u ON u.id = r.updated_by_id WHERE r.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    enterpriseId: r.enterprise_id === null ? null : Number(r.enterprise_id),
    categoryId: r.category_id === null ? null : Number(r.category_id),
    direction: r.direction,
    minMarginPct: Number(r.min_margin_pct),
    status: r.status,
    label: ruleLabel(r),
    updatedBy: r.updated_by ?? null,
    updatedAt: iso(r.updated_at)!,
  };
}

export function listMarketAutoRules(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT id FROM market_auto_rules WHERE deleted_at IS NULL ORDER BY id");
    const rules = [];
    for (const r of rows) rules.push((await ruleRow(pool, Number(r.id)))!);
    return { rules };
  });
}

function ruleInputErrors(b: MarketAutoRuleInput) {
  return (b.enterpriseId === null) === (b.categoryId === null)
    ? [{ path: "/enterpriseId", message: "choose a client or a product category (one of the two)" }]
    : [];
}

export function createMarketAutoRule(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as MarketAutoRuleInput;
  const errors = ruleInputErrors(b);
  if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `INSERT INTO market_auto_rules (enterprise_id, category_id, direction, min_margin_pct, status, updated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [b.enterpriseId, b.categoryId, b.direction, b.minMarginPct, b.status, me.id],
    );
    return reply.code(201).send(await ruleRow(pool, Number(rows[0].id)));
  });
}

export function updateMarketAutoRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const b = request.body as MarketAutoRuleInput;
  const errors = ruleInputErrors(b);
  if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rowCount } = await pool.query(
      `UPDATE market_auto_rules SET enterprise_id = $2, category_id = $3, direction = $4, min_margin_pct = $5, status = $6,
         updated_by_id = $7, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [id, b.enterpriseId, b.categoryId, b.direction, b.minMarginPct, b.status, me.id],
    );
    if (!rowCount) return sendProblem(reply, 404, `Rule ${id} not found`);
    return ruleRow(pool, id);
  });
}

export function archiveMarketAutoRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rowCount } = await pool.query(
      "UPDATE market_auto_rules SET deleted_at = now(), updated_by_id = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [id, me.id],
    );
    if (!rowCount) return sendProblem(reply, 404, `Rule ${id} not found`);
    return ruleRow(pool, id);
  });
}
