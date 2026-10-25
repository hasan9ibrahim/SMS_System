// Team activity and performance (§13.18): the Team report per member (business results from the EDR
// store, attributed to the account manager at send time §13.30; rates, billing and NOC work from the
// change history, Audit Trail and records; system activity from sessions and pages opened), a member's
// detail and timeline, monthly targets, online users and the page-view feed. The viewer's scope:
// administrators everyone, a department manager their department, a team lead their team, others
// themselves. Account manager visibility (§13.17) applies to the money shown.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ListQuery,
  MaskedCell,
  OnlineUser,
  OnlineUsers,
  PageViewInput,
  TeamActivity,
  TeamBilling,
  TeamBusiness,
  TeamMemberDetail,
  TeamMemberRow,
  TeamNoc,
  TeamRates,
  TeamReport,
  TeamReportQuery,
  TeamRole,
  TeamTarget,
  TeamTargetsUpdate,
  TeamTimelineRow,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { chRows } from "../edr.js";
import { PLATFORM_CURRENCY, sysToPlatformFactor } from "../currency.js";
import { sendProblem } from "../problem.js";
import { resolvePeriod, previousWindow, type Window } from "../reports/period.js";
import type { ListDef } from "../lists/engine.js";
import { runList } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { customerTrunkList, enterpriseList, vendorTrunkList } from "../lists/defs.js";
import { checkListQuery } from "../lists/validate.js";
import { currentViewer } from "../visibility/context.js";
import { restricts, type Viewer } from "../visibility/policy.js";
import { PAGES_BY_DEPARTMENT } from "../generator/teamExtras.js";
import { currentUserId } from "./session.js";

const DAY = 86_400_000;
const ACTIVE_MS = 5 * 60_000;
/** Money to 6 decimals (team trial round 3). */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;
const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const badInput = (reply: FastifyReply, path: string, message: string) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors: [{ path, message }] });

// ---------------------------------------------------------------- scope

export interface Scope {
  kind: TeamReport["scope"];
  label: string;
  /** Users the viewer may see; null = everyone. */
  userIds: number[] | null;
}

/** What the viewer may see (§13.18). Background jobs (no viewer) see everyone. */
export async function scopeOf(pool: pg.Pool | pg.PoolClient, viewer: Viewer | null): Promise<Scope> {
  if (!viewer) return { kind: "all", label: "Everyone", userIds: null };
  const { rows: u } = await pool.query("SELECT is_admin, is_team_lead FROM users WHERE id = $1", [viewer.userId]);
  if (u[0]?.is_admin) return { kind: "all", label: "Everyone", userIds: null };
  const { rows: d } = await pool.query(
    `SELECT d.name, array_agg(u.id) AS ids FROM departments d JOIN users u ON u.department_id = d.id AND u.deleted_at IS NULL
      WHERE d.manager_id = $1 AND d.deleted_at IS NULL GROUP BY d.id, d.name`,
    [viewer.userId],
  );
  if (d.length)
    return {
      kind: "department",
      label: d.map((x) => x.name).join(", "),
      userIds: [...new Set([viewer.userId, ...d.flatMap((x) => (x.ids as string[]).map(Number))])],
    };
  if (u[0]?.is_team_lead) {
    const { rows: t } = await pool.query(
      `WITH RECURSIVE team AS (SELECT id FROM users WHERE manager_id = $1 AND deleted_at IS NULL
         UNION SELECT u.id FROM users u JOIN team t ON u.manager_id = t.id WHERE u.deleted_at IS NULL)
       SELECT id FROM team`,
      [viewer.userId],
    );
    return { kind: "team", label: "My team", userIds: [viewer.userId, ...t.map((x) => Number(x.id))] };
  }
  return { kind: "self", label: "Only me", userIds: [viewer.userId] };
}

// ---------------------------------------------------------------- members

interface Member {
  id: number;
  name: string;
  username: string;
  initials: string;
  department: string | null;
  departmentId: number | null;
  roles: TeamRole[];
  isAm: boolean;
}

async function membersOf(pool: pg.Pool, scope: Scope, q: TeamReportQuery): Promise<Member[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.username, u.department_id, d.name AS department, u.is_admin,
            u.is_account_manager, u.is_team_lead,
            EXISTS (SELECT 1 FROM departments m WHERE m.manager_id = u.id AND m.deleted_at IS NULL) AS dept_manager
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.deleted_at IS NULL
        AND ($1::bigint[] IS NULL OR u.id = ANY($1)) AND ($2::bigint IS NULL OR u.department_id = $2)
        AND ($3::bigint IS NULL OR u.id = $3)
        AND ($4::text IS NULL OR (u.first_name || ' ' || u.last_name || ' ' || u.username) ILIKE '%' || $4 || '%')
      ORDER BY u.first_name, u.last_name`,
    [scope.userIds, q.departmentId ?? null, q.userId ?? null, q.search?.trim() || null],
  );
  const out = rows.map((r): Member => {
    const roles: TeamRole[] = [];
    if (r.is_account_manager) roles.push("account_manager");
    if (r.is_team_lead) roles.push("team_lead");
    if (r.dept_manager) roles.push("department_manager");
    if (r.is_admin) roles.push("admin");
    return {
      id: Number(r.id),
      name: `${r.first_name} ${r.last_name}`,
      username: r.username,
      initials: `${r.first_name[0] ?? ""}${r.last_name[0] ?? ""}`.toUpperCase(),
      department: r.department ?? null,
      departmentId: r.department_id == null ? null : Number(r.department_id),
      roles,
      isAm: !!r.is_account_manager,
    };
  });
  return q.role ? out.filter((m) => m.roles.includes(q.role!)) : out;
}

// ---------------------------------------------------------------- sections (PostgreSQL)

type ByUser<T> = Map<number, T>;
const byUser = <T>(rows: Record<string, unknown>[], f: (r: Record<string, unknown>) => T): ByUser<T> =>
  new Map(rows.map((r) => [Number(r.user_id), f(r)]));

async function ratesWork(pool: pg.Pool, ids: number[], w: Window): Promise<ByUser<TeamRates>> {
  const { rows } = await pool.query(
    `WITH c AS (SELECT * FROM changes WHERE user_id = ANY($1) AND inserted_at >= $2 AND inserted_at < $3)
     SELECT u.id AS user_id,
       (SELECT count(DISTINCT t) FROM c, unnest(c.entity_ids) t WHERE c.user_id = u.id AND c.entity_type = 'rate_table' AND c.change_type <> 'undo') AS tables,
       (SELECT coalesce(sum(jsonb_array_length(c.diff)), 0) FROM c WHERE c.user_id = u.id AND c.entity_type = 'rate_table' AND c.change_type <> 'undo' AND jsonb_typeof(c.diff) = 'array') AS lines,
       (SELECT count(DISTINCT t) FROM c, unnest(c.entity_ids) t WHERE c.user_id = u.id AND c.entity_type = 'route_rule' AND c.change_type <> 'undo') AS rules,
       (SELECT count(*) FROM c WHERE c.user_id = u.id AND c.change_type = 'bulk') AS bulk,
       (SELECT count(*) FROM changes o JOIN changes x ON x.undo_of_id = o.id AND x.user_id <> o.user_id
         WHERE o.user_id = u.id AND x.inserted_at >= $2 AND x.inserted_at < $3) AS undone,
       (SELECT count(*) FROM rate_notifications r WHERE r.decided_by_id = u.id AND r.decided_at >= $2 AND r.decided_at < $3 AND r.status IN ('accepted','partly_accepted')) AS rn_ok,
       (SELECT count(*) FROM rate_notifications r WHERE r.decided_by_id = u.id AND r.decided_at >= $2 AND r.decided_at < $3 AND r.status = 'rejected') AS rn_no,
       (SELECT count(*) FROM market_moves m WHERE m.handled_by_id = u.id AND m.handled_at >= $2 AND m.handled_at < $3) AS moves,
       (SELECT avg(extract(epoch FROM m.handled_at - m.detected_at) / 3600) FROM market_moves m WHERE m.handled_by_id = u.id AND m.handled_at >= $2 AND m.handled_at < $3) AS move_h
     FROM unnest($1::bigint[]) AS u(id)`,
    [ids, w.from, w.to],
  );
  return byUser(rows, (r) => ({
    rateTablesChanged: n(r.tables),
    rateLineChanges: n(r.lines),
    rnAccepted: n(r.rn_ok),
    rnRejected: n(r.rn_no),
    marketMovesHandled: n(r.moves),
    avgMoveHandleHours: r.move_h == null ? null : r1(Number(r.move_h)),
    routeRulesChanged: n(r.rules),
    bulkJobs: n(r.bulk),
    undoneByOthers: n(r.undone),
  }));
}

async function billingWork(pool: pg.Pool, ids: number[], w: Window): Promise<ByUser<TeamBilling>> {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id,
       (SELECT count(*) FROM invoice_requests r WHERE r.created_by_id = u.id AND r.inserted_at >= $2 AND r.inserted_at < $3 AND r.status <> 'failed') AS inv,
       (SELECT count(*) FROM invoice_requests r JOIN invoices i ON i.id = r.invoice_id
         WHERE r.created_by_id = u.id AND i.email_sent_at >= $2 AND i.email_sent_at < $3) AS inv_sent,
       (SELECT count(*) FROM soa_reports s WHERE s.created_by_id = u.id AND s.inserted_at >= $2 AND s.inserted_at < $3) AS soa,
       (SELECT count(*) FROM soa_reports s WHERE s.created_by_id = u.id AND s.emailed_at >= $2 AND s.emailed_at < $3) AS soa_sent,
       (SELECT count(*) FROM transactions t WHERE t.created_by_id = u.id AND t.inserted_at >= $2 AND t.inserted_at < $3 AND t.deleted_at IS NULL) AS pay,
       (SELECT count(*) FROM vendor_invoices v WHERE coalesce(v.updated_by_id, v.created_by_id) = u.id AND v.updated_at >= $2 AND v.updated_at < $3 AND v.recon_status = 'disputed') AS d_open,
       (SELECT count(*) FROM vendor_invoices v WHERE coalesce(v.updated_by_id, v.created_by_id) = u.id AND v.updated_at >= $2 AND v.updated_at < $3 AND v.recon_status IN ('accepted','rejected') AND v.comparison IS NOT NULL AND v.comparison <> 'match') AS d_closed
     FROM unnest($1::bigint[]) AS u(id)`,
    [ids, w.from, w.to],
  );
  return byUser(rows, (r) => ({
    invoicesGenerated: n(r.inv),
    invoicesSent: n(r.inv_sent),
    soasGenerated: n(r.soa),
    soasSent: n(r.soa_sent),
    paymentsRecorded: n(r.pay),
    disputesOpened: n(r.d_open),
    disputesClosed: n(r.d_closed),
    avgVendorSoaConfirmHours: null,
  }));
}

async function nocWork(pool: pg.Pool, ids: number[], w: Window): Promise<ByUser<TeamNoc>> {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, i.acked, i.ack_min, i.resolve_min, i.handled,
       (SELECT count(*) FROM email_logs e WHERE e.user_id = u.id AND e.email_type = 'trouble_ticket' AND e.inserted_at >= $2 AND e.inserted_at < $3) AS tickets,
       (SELECT count(*) FROM audit_log a WHERE a.user_id = u.id AND a.at >= $2 AND a.at < $3
          AND a.action IN ('startBind','stopBind','startTrunkBind','stopTrunkBind')) AS binds
     FROM unnest($1::bigint[]) AS u(id)
     LEFT JOIN LATERAL (SELECT count(*) AS acked,
          avg(extract(epoch FROM acknowledged_at - started_at) / 60) AS ack_min,
          avg(extract(epoch FROM ended_at - started_at) / 60) FILTER (WHERE ended_at IS NOT NULL) AS resolve_min,
          count(*) FILTER (WHERE ended_at IS NOT NULL) AS handled
        FROM incidents WHERE acknowledged_by_id = u.id AND acknowledged_at >= $2 AND acknowledged_at < $3) i ON true`,
    [ids, w.from, w.to],
  );
  return byUser(rows, (r) => ({
    alertsAcknowledged: n(r.acked),
    avgAckMinutes: r.ack_min == null ? null : r1(Number(r.ack_min)),
    avgResolveMinutes: r.resolve_min == null ? null : r1(Number(r.resolve_min)),
    incidentsHandled: n(r.handled),
    ticketsRaised: n(r.tickets),
    bindActions: n(r.binds),
  }));
}

/** Session time inside the window, in seconds. */
// A session left open for days (an idle tab) counts 12 hours at most.
const SESSION_SPAN = `least(43200, greatest(0, extract(epoch FROM least(coalesce(s.ended_at, s.last_seen_at), $3) - greatest(s.logged_in_at, $2))))`;

async function systemActivity(pool: pg.Pool, ids: number[], w: Window): Promise<ByUser<TeamActivity>> {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, se.days, se.secs, se.last_login, se.new_devices,
       (SELECT count(*) FROM audit_log a WHERE a.user_id = u.id AND a.at >= $2 AND a.at < $3) AS saves,
       (SELECT json_agg(json_build_object('path', p.path, 'views', p.views) ORDER BY p.views DESC)
          FROM (SELECT path, count(*)::int AS views FROM page_views v WHERE v.user_id = u.id AND v.at >= $2 AND v.at < $3
                 GROUP BY path ORDER BY 2 DESC LIMIT 3) p) AS pages
     FROM unnest($1::bigint[]) AS u(id)
     LEFT JOIN LATERAL (SELECT count(DISTINCT s.logged_in_at::date) AS days, sum(${SESSION_SPAN}) AS secs,
          max(s.logged_in_at) AS last_login,
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM user_sessions o WHERE o.user_id = s.user_id
                 AND o.logged_in_at < s.logged_in_at AND o.ip = s.ip AND o.device IS NOT DISTINCT FROM s.device
                 AND o.browser IS NOT DISTINCT FROM s.browser)
             AND EXISTS (SELECT 1 FROM user_sessions o WHERE o.user_id = s.user_id AND o.logged_in_at < s.logged_in_at)) AS new_devices
        FROM user_sessions s WHERE s.user_kind = 'staff' AND s.user_id = u.id AND s.logged_in_at < $3
          AND coalesce(s.ended_at, s.last_seen_at) >= $2) se ON true`,
    [ids, w.from, w.to],
  );
  return byUser(rows, (r) => ({
    daysActive: n(r.days),
    hoursOnline: r1(n(r.secs) / 3600),
    lastLoginAt: iso(r.last_login),
    saves: n(r.saves),
    topPages: (r.pages as { path: string; views: number }[] | null) ?? [],
    newDevices: n(r.new_devices),
  }));
}

async function onlineIds(pool: pg.Pool): Promise<Set<number>> {
  const { rows } = await pool.query(
    "SELECT DISTINCT user_id FROM user_sessions WHERE user_kind = 'staff' AND ended_at IS NULL AND last_seen_at > now() - interval '30 minutes'",
  );
  return new Set(rows.map((r) => Number(r.user_id)));
}

// ---------------------------------------------------------------- business results (ClickHouse)

interface Biz {
  messages: number;
  revenue: number;
  cost: number;
  clients: number;
}
const chTime = (d: Date) => `toDateTime('${d.toISOString().slice(0, 19).replace("T", " ")}', 'UTC')`;

async function bizByAm(ids: number[], w: Window, factor: string): Promise<Map<number, Biz>> {
  if (!ids.length) return new Map();
  const rows = await chRows<{ am: number; m: number; r: number; c: number; k: number }>(
    `SELECT c_am_user_id AS am, toUInt64(sum(messages)) AS m, toFloat64(sum(revenue_sys * ${factor})) AS r,
            toFloat64(sum(cost_sys * ${factor})) AS c, uniqExactIf(c_enterprise_id, messages > 0) AS k
       FROM edr_hourly WHERE hour >= ${chTime(w.from)} AND hour < ${chTime(w.to)} AND c_am_user_id IN (${ids.join(",")})
      GROUP BY am`,
    20_000,
  );
  return new Map(
    (rows ?? []).map((x) => [Number(x.am), { messages: n(x.m), revenue: n(x.r), cost: n(x.c), clients: n(x.k) }]),
  );
}

/** First traffic of each client (inside the EDR store) in the window, by the AM at that time. */
async function newClients(ids: number[], w: Window): Promise<{ am: number; id: number; at: string }[]> {
  if (!ids.length) return [];
  const rows = await chRows<{ am: number; id: number; at: string }>(
    `SELECT argMin(c_am_user_id, hour) AS am, c_enterprise_id AS id, toString(min(hour)) AS at
       FROM edr_hourly WHERE messages > 0 GROUP BY id
     HAVING min(hour) >= greatest(${chTime(w.from)}, (SELECT min(hour) + INTERVAL 1 DAY FROM edr_hourly))
        AND min(hour) < ${chTime(w.to)} AND am IN (${ids.join(",")})`,
    20_000,
  );
  return (rows ?? []).map((r) => ({ am: n(r.am), id: n(r.id), at: `${r.at.replace(" ", "T")}Z` }));
}

/** Clients with traffic in the previous window and none in this one, by their AM then. */
async function stoppedClients(
  ids: number[],
  w: Window,
  prev: Window,
): Promise<{ am: number; id: number; at: string }[]> {
  if (!ids.length) return [];
  const rows = await chRows<{ am: number; id: number; at: string }>(
    `SELECT argMax(c_am_user_id, hour) AS am, c_enterprise_id AS id, toString(max(hour)) AS at
       FROM edr_hourly WHERE messages > 0 AND hour >= ${chTime(prev.from)} AND hour < ${chTime(w.to)} GROUP BY id
     HAVING max(hour) < ${chTime(w.from)} AND am IN (${ids.join(",")})`,
    20_000,
  );
  return (rows ?? []).map((r) => ({ am: n(r.am), id: n(r.id), at: `${r.at.replace(" ", "T")}Z` }));
}

/** Monthly targets prorated to the window (days of each month inside it). */
async function targetsFor(
  pool: pg.Pool,
  ids: number[],
  w: Window,
): Promise<Map<number, { revenue: number; margin: number }>> {
  const { rows } = await pool.query(
    `SELECT user_id, month, revenue_target, margin_target FROM user_targets
      WHERE user_id = ANY($1) AND month < $3 AND month + interval '1 month' > $2`,
    [ids, w.from, w.to],
  );
  const out = new Map<number, { revenue: number; margin: number }>();
  for (const r of rows) {
    const start = new Date(r.month).getTime();
    const end = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1);
    const overlap = Math.max(0, Math.min(end, w.to.getTime()) - Math.max(start, w.from.getTime()));
    const share = overlap / (end - start);
    const t = out.get(Number(r.user_id)) ?? { revenue: 0, margin: 0 };
    t.revenue += n(r.revenue_target) * share;
    t.margin += n(r.margin_target) * share;
    out.set(Number(r.user_id), t);
  }
  return out;
}

// ---------------------------------------------------------------- the report

function windows(q: TeamReportQuery): { w: Window; prev: Window } | string {
  if (q.period === "custom") {
    if (!q.from || !q.to) return "a custom period needs from and to";
    if (Date.parse(q.to) <= Date.parse(q.from)) return "to must be after from";
    if (Date.parse(q.to) - Date.parse(q.from) > 400 * DAY) return "at most 400 days";
  }
  const w = resolvePeriod(q.period, "UTC", Date.now(), { from: q.from ?? null, to: q.to ?? null });
  return { w, prev: previousWindow(w, "previous_period") };
}

/** Money of other members' clients as the viewer's policy allows (§13.17). */
function withhold(rows: TeamMemberRow[], viewer: Viewer | null, own: Set<number>): MaskedCell[] {
  if (!restricts(viewer)) return [];
  const masked: MaskedCell[] = [];
  const { items, thresholds } = viewer.policy;
  for (const r of rows) {
    const b = r.business;
    if (!b) continue;
    const side = own.has(r.id) ? "own" : "others";
    const rev = items.revenue[side];
    if (rev === "hide") {
      for (const f of ["revenue", "prevRevenue", "revenueTarget", "growthPct", "achievedPct"] as const) b[f] = null;
      masked.push({ id: r.id, field: "revenue", text: "Hidden" });
    } else if (thresholds.revenueHideAbove !== null && (b.revenue ?? 0) > thresholds.revenueHideAbove) {
      b.revenue = null;
      b.prevRevenue = null;
      masked.push({ id: r.id, field: "revenue", text: "Above limit" });
    }
    const mar = items.margin[side];
    if (mar !== "show") {
      const pct = b.marginPct;
      const text =
        mar === "hide" || pct === null
          ? "Hidden"
          : pct < thresholds.marginLowPct
            ? "Low"
            : pct > thresholds.marginHighPct
              ? "High"
              : "Normal";
      b.margin = null;
      b.marginPct = null;
      b.prevMargin = null;
      b.marginTarget = null;
      masked.push({ id: r.id, field: "margin", text }, { id: r.id, field: "marginPct", text });
    }
  }
  return masked;
}

/** Members whose money counts as the viewer's own: themselves, and their team with "team counts as own". */
async function ownMembers(pool: pg.Pool, viewer: Viewer | null): Promise<Set<number>> {
  if (!viewer) return new Set();
  const own = new Set([viewer.userId]);
  if (viewer.policy?.includeTeam) {
    const { rows } = await pool.query(
      `WITH RECURSIVE team AS (SELECT id FROM users WHERE manager_id = $1 UNION SELECT u.id FROM users u JOIN team t ON u.manager_id = t.id)
       SELECT id FROM team`,
      [viewer.userId],
    );
    for (const r of rows) own.add(Number(r.id));
  }
  return own;
}

export async function buildTeamReport(
  pool: pg.Pool,
  q: TeamReportQuery,
  viewer: Viewer | null,
): Promise<TeamReport | string> {
  const win = windows(q);
  if (typeof win === "string") return win;
  const { w, prev } = win;
  const scope = await scopeOf(pool, viewer);
  const members = await membersOf(pool, scope, q);
  const ids = members.map((m) => m.id);
  const ams = members.filter((m) => m.isAm).map((m) => m.id);
  const factor = await sysToPlatformFactor();
  const [rates, billing, noc, activity, online, cur, before, fresh, stopped, targets, hourly] = await Promise.all([
    ratesWork(pool, ids, w),
    billingWork(pool, ids, w),
    nocWork(pool, ids, w),
    systemActivity(pool, ids, w),
    onlineIds(pool),
    bizByAm(ams, w, factor),
    bizByAm(ams, prev, factor),
    newClients(ams, w),
    stoppedClients(ams, w, prev),
    targetsFor(pool, ams, w),
    pool.query(
      `SELECT extract(hour FROM at)::int AS h, count(*)::int AS c FROM audit_log
        WHERE user_id = ANY($1) AND at >= $2 AND at < $3 GROUP BY 1`,
      [ids, w.from, w.to],
    ),
  ]);
  const count = (list: { am: number }[], id: number) => list.filter((x) => x.am === id).length;
  const rows: TeamMemberRow[] = members.map((m) => {
    let business: TeamBusiness | null = null;
    if (m.isAm) {
      const c = cur.get(m.id) ?? { messages: 0, revenue: 0, cost: 0, clients: 0 };
      const p = before.get(m.id) ?? { messages: 0, revenue: 0, cost: 0, clients: 0 };
      const t = targets.get(m.id);
      const margin = c.revenue - c.cost;
      business = {
        activeClients: c.clients,
        newClients: count(fresh, m.id),
        stoppedClients: count(stopped, m.id),
        messages: c.messages,
        revenue: r6(c.revenue),
        margin: r6(margin),
        marginPct: c.revenue > 0 ? r1((margin / c.revenue) * 100) : null,
        growthPct: p.revenue > 0 ? r1(((c.revenue - p.revenue) / p.revenue) * 100) : null,
        prevMessages: p.messages,
        prevRevenue: r6(p.revenue),
        prevMargin: r6(p.revenue - p.cost),
        revenueTarget: t ? r6(t.revenue) : null,
        marginTarget: t ? r6(t.margin) : null,
        achievedPct: t && t.revenue > 0 ? r1((c.revenue / t.revenue) * 100) : null,
      };
    }
    return {
      id: m.id,
      name: m.name,
      username: m.username,
      initials: m.initials,
      department: m.department,
      departmentId: m.departmentId,
      roles: m.roles,
      online: online.has(m.id),
      business,
      rates: rates.get(m.id)!,
      billing: billing.get(m.id)!,
      noc: noc.get(m.id)!,
      activity: activity.get(m.id)!,
    };
  });
  // Totals before withholding, then only from what the viewer may see.
  const masked = withhold(rows, viewer, await ownMembers(pool, viewer));
  const sum = (f: (r: TeamMemberRow) => number | null | undefined) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const revHidden = rows.some((r) => r.business && r.business.revenue === null && r.business.messages > 0);
  const marHidden = rows.some((r) => r.business && r.business.margin === null && r.business.messages > 0);
  const revenue = sum((r) => r.business?.revenue);
  const margin = sum((r) => r.business?.margin);
  const hours = Array.from({ length: 24 }, () => 0);
  for (const h of hourly.rows) hours[Number(h.h)] = Number(h.c);
  return {
    period: { from: w.from.toISOString(), to: w.to.toISOString() },
    previous: q.compare ? { from: prev.from.toISOString(), to: prev.to.toISOString() } : null,
    scope: scope.kind,
    scopeLabel: scope.label,
    currency: PLATFORM_CURRENCY,
    rows,
    totals: {
      members: rows.length,
      activeMembers: rows.filter((r) => r.activity.daysActive > 0).length,
      messages: sum((r) => r.business?.messages),
      revenue: revHidden ? null : r6(revenue),
      margin: marHidden ? null : r6(margin),
      marginPct: revHidden || marHidden || revenue <= 0 ? null : r1((margin / revenue) * 100),
      saves: sum((r) => r.activity.saves),
      hoursOnline: r1(sum((r) => r.activity.hoursOnline)),
      alertsAcknowledged: sum((r) => r.noc.alertsAcknowledged),
    },
    hourly: hours,
    masked,
  };
}

export function runTeamReport(request: FastifyRequest, reply: FastifyReply) {
  const q = request.body as TeamReportQuery;
  return withDb(reply, async (pool) => {
    const r = await buildTeamReport(pool, q, await currentViewer());
    return typeof r === "string" ? badInput(reply, "/period", r) : r;
  });
}

// ---------------------------------------------------------------- CSV

const cell = (v: unknown) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const TEAM_COLUMNS: [string, (r: TeamMemberRow) => unknown][] = [
  ["Member", (r) => r.name],
  ["Department", (r) => r.department],
  ["Roles", (r) => r.roles.join(" ")],
  ["Active clients", (r) => r.business?.activeClients],
  ["New clients", (r) => r.business?.newClients],
  ["Stopped clients", (r) => r.business?.stoppedClients],
  ["Messages", (r) => r.business?.messages],
  ["Revenue", (r) => r.business?.revenue],
  ["Margin", (r) => r.business?.margin],
  ["Margin %", (r) => r.business?.marginPct],
  ["Growth %", (r) => r.business?.growthPct],
  ["Target", (r) => r.business?.revenueTarget],
  ["Achieved %", (r) => r.business?.achievedPct],
  ["Rate tables changed", (r) => r.rates.rateTablesChanged],
  ["RNs accepted", (r) => r.rates.rnAccepted],
  ["RNs rejected", (r) => r.rates.rnRejected],
  ["Market moves handled", (r) => r.rates.marketMovesHandled],
  ["Route rules changed", (r) => r.rates.routeRulesChanged],
  ["Bulk jobs", (r) => r.rates.bulkJobs],
  ["Undone by others", (r) => r.rates.undoneByOthers],
  ["Invoices generated", (r) => r.billing.invoicesGenerated],
  ["Invoices sent", (r) => r.billing.invoicesSent],
  ["SOAs sent", (r) => r.billing.soasSent],
  ["Payments recorded", (r) => r.billing.paymentsRecorded],
  ["Disputes opened", (r) => r.billing.disputesOpened],
  ["Alerts acknowledged", (r) => r.noc.alertsAcknowledged],
  ["Avg ack (min)", (r) => r.noc.avgAckMinutes],
  ["Days active", (r) => r.activity.daysActive],
  ["Hours online", (r) => r.activity.hoursOnline],
  ["Saves", (r) => r.activity.saves],
  ["New devices", (r) => r.activity.newDevices],
];
export function teamCsv(r: TeamReport): string {
  return (
    [
      TEAM_COLUMNS.map(([h]) => h).join(","),
      ...r.rows.map((row) => TEAM_COLUMNS.map(([, f]) => cell(f(row))).join(",")),
    ].join("\r\n") + "\r\n"
  );
}

export function exportTeamReport(request: FastifyRequest, reply: FastifyReply) {
  const q = request.body as TeamReportQuery;
  return withDb(reply, async (pool) => {
    const r = await buildTeamReport(pool, q, await currentViewer());
    if (typeof r === "string") return badInput(reply, "/period", r);
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="team_${r.period.from.slice(0, 10)}_${r.period.to.slice(0, 10)}.csv"`,
      )
      .send(teamCsv(r));
  });
}

// ---------------------------------------------------------------- one member

export function getTeamMember(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const q = request.body as TeamReportQuery;
  return withDb(reply, async (pool) => {
    const viewer = await currentViewer();
    const report = await buildTeamReport(
      pool,
      { ...q, userId: id, departmentId: null, role: null, search: null },
      viewer,
    );
    if (typeof report === "string") return badInput(reply, "/period", report);
    const row = report.rows[0];
    if (!row) {
      const { rows } = await pool.query("SELECT 1 FROM users WHERE id = $1", [id]);
      return rows[0]
        ? sendProblem(reply, 403, "This user is outside your team", {
            detail: "The Team report shows your scope only (§13.18).",
          })
        : sendProblem(reply, 404, `User ${id} not found`);
    }
    const w = { from: new Date(report.period.from), to: new Date(report.period.to) };
    const prev = previousWindow(w, "previous_period");
    const factor = await sysToPlatformFactor();
    const [trend, hourly, days, devices, fresh, stopped] = await Promise.all([
      row.business
        ? chRows<{ d: string; m: number; r: number; c: number }>(
            `SELECT toString(toDate(hour)) AS d, toUInt64(sum(messages)) AS m, toFloat64(sum(revenue_sys * ${factor})) AS r,
                    toFloat64(sum(cost_sys * ${factor})) AS c
               FROM edr_hourly WHERE c_am_user_id = ${id} AND hour >= ${chTime(w.from)} AND hour < ${chTime(w.to)}
              GROUP BY d ORDER BY d`,
            20_000,
          )
        : Promise.resolve([]),
      pool.query(
        `SELECT extract(hour FROM at)::int AS h, count(*)::int AS c FROM audit_log WHERE user_id = $1 AND at >= $2 AND at < $3 GROUP BY 1`,
        [id, w.from, w.to],
      ),
      pool.query(
        `SELECT d::text AS date, min(s.logged_in_at) AS first, max(coalesce(s.ended_at, s.last_seen_at)) AS last,
                sum(${SESSION_SPAN}) AS secs,
                (SELECT count(*)::int FROM audit_log a WHERE a.user_id = $1 AND a.at::date = d) AS saves
           FROM user_sessions s, LATERAL (SELECT s.logged_in_at::date AS d) x
          WHERE s.user_kind = 'staff' AND s.user_id = $1 AND s.logged_in_at < $3 AND coalesce(s.ended_at, s.last_seen_at) >= $2
          GROUP BY d ORDER BY d DESC`,
        [id, w.from, w.to],
      ),
      pool.query(
        `SELECT s.device, s.os, s.browser, host(s.ip) AS ip, s.location, min(s.logged_in_at) AS first_seen, count(*)::int AS sessions
           FROM user_sessions s WHERE s.user_kind = 'staff' AND s.user_id = $1
          GROUP BY 1, 2, 3, 4, 5 ORDER BY max(s.logged_in_at) DESC LIMIT 20`,
        [id],
      ),
      row.business ? newClients([id], w) : Promise.resolve([]),
      row.business ? stoppedClients([id], w, prev) : Promise.resolve([]),
    ]);
    const names = new Map<number, string>();
    const eids = [...fresh, ...stopped].map((x) => x.id);
    if (eids.length) {
      const { rows } = await pool.query("SELECT id, name FROM enterprises WHERE id = ANY($1)", [eids]);
      for (const e of rows) names.set(Number(e.id), e.name);
    }
    const client = (x: { id: number; at: string }) => ({
      enterpriseId: x.id,
      enterpriseName: names.get(x.id) ?? `Enterprise #${x.id}`,
      at: x.at,
    });
    const hours = Array.from({ length: 24 }, () => 0);
    for (const h of hourly.rows) hours[Number(h.h)] = Number(h.c);
    const hideMoney = report.masked.length > 0;
    const out: TeamMemberDetail = {
      row,
      period: report.period,
      trend: (trend ?? []).map((t) => ({
        date: t.d,
        messages: n(t.m),
        revenue: hideMoney && row.business?.revenue === null ? null : r6(n(t.r)),
        margin: hideMoney && row.business?.margin === null ? null : r6(n(t.r) - n(t.c)),
      })),
      hourly: hours,
      days: days.rows.map((d) => ({
        date: d.date,
        firstLogin: iso(d.first)!,
        lastSeen: iso(d.last)!,
        hours: r1(n(d.secs) / 3600),
        saves: n(d.saves),
      })),
      newClients: fresh.map(client),
      stoppedClients: stopped.map(client),
      devices: devices.rows.map((d) => ({
        device: d.device ?? null,
        os: d.os ?? null,
        browser: d.browser ?? null,
        ip: d.ip ?? null,
        location: d.location ?? null,
        firstSeen: iso(d.first_seen)!,
        sessions: n(d.sessions),
        isNew: new Date(d.first_seen) >= w.from,
      })),
      masked: report.masked,
    };
    return out;
  });
}

// ---------------------------------------------------------------- timeline

/** The user of a timeline query (`userId eq`, required). */
function timelineUser(query: ListQuery): number | null {
  const c = query.filter?.conditions.find((x) => "field" in x && x.field === "userId" && x.op === "eq") as
    { value?: unknown } | undefined;
  const id = Number(c?.value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const teamTimelineList: ListDef<TeamTimelineRow> = {
  fields: listFields.team_timeline,
  // One user's rows only, pushed into each branch so each uses its user index.
  from: (query) => {
    const u = timelineUser(query) ?? 0;
    return `(SELECT c.id * 4 AS id, c.user_id, c.inserted_at AS at, 'change' AS kind,
               c.entity_type || ' · ' || c.change_type AS type, coalesce(c.note, initcap(c.change_type) || ' ' || replace(c.entity_type, '_', ' ')) AS summary,
               c.entity_type, c.entity_ids[1] AS entity_id
          FROM changes c WHERE c.user_id = ${u}
        UNION ALL
        SELECT a.id * 4 + 1, a.user_id, a.at, 'action', a.module || ' · ' || a.action, a.method || ' ' || a.controller,
               a.table_name, CASE WHEN a.master_id ~ '^[0-9]{1,18}$' THEN a.master_id::bigint END
          FROM audit_log a WHERE a.user_id = ${u}
        UNION ALL
        SELECT s.id * 4 + 2, s.user_id, s.logged_in_at, 'login', 'sign-in',
               'Signed in · ' || concat_ws(' · ', s.device, s.browser, s.os, host(s.ip), s.location), NULL, NULL
          FROM user_sessions s WHERE s.user_kind = 'staff' AND s.user_id = ${u}) t`;
  },
  columns: {
    id: { sql: "t.id" },
    userId: { sql: "t.user_id" },
    at: { sql: "t.at" },
    kind: { sql: "t.kind" },
    type: { sql: "t.type" },
    summary: { sql: "t.summary" },
    entityType: { sql: "t.entity_type" },
    entityId: { sql: "t.entity_id" },
  },
  search: ["type", "summary"],
  idSql: "t.id",
  select: "t.*",
  mapRow: (r) => ({
    id: Number(r.id),
    userId: Number(r.user_id),
    at: iso(r.at)!,
    kind: r.kind as TeamTimelineRow["kind"],
    type: r.type as string,
    summary: r.summary as string,
    entityType: (r.entity_type as string | null) ?? null,
    entityId: nn(r.entity_id),
  }),
};

export function queryTeamTimeline(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.team_timeline);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  const user = timelineUser(query);
  if (!user) return badInput(reply, "/filter", "filter on one user (userId eq)");
  return withDb(reply, async (pool) => {
    const scope = await scopeOf(pool, await currentViewer());
    if (scope.userIds && !scope.userIds.includes(user))
      return sendProblem(reply, 400, "Invalid list query", {
        errors: [{ path: "/filter", message: "this user is outside your team" }],
      });
    return runList(pool, teamTimelineList, query);
  });
}

// ---------------------------------------------------------------- targets

const monthDate = (m: string) => `${m}-01`;

async function loadTargets(pool: pg.Pool, month: string, scope: Scope): Promise<TeamTarget[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name || ' ' || u.last_name AS name, d.name AS department, t.revenue_target, t.margin_target
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN user_targets t ON t.user_id = u.id AND t.month = $1::date
      WHERE u.deleted_at IS NULL AND u.is_account_manager AND ($2::bigint[] IS NULL OR u.id = ANY($2))
      ORDER BY u.first_name, u.last_name`,
    [monthDate(month), scope.userIds],
  );
  return rows.map((r) => ({
    userId: Number(r.id),
    userName: r.name,
    department: r.department ?? null,
    month,
    revenueTarget: nn(r.revenue_target),
    marginTarget: nn(r.margin_target),
  }));
}

export function getTeamTargets(request: FastifyRequest, reply: FastifyReply) {
  const { month } = request.query as { month: string };
  return withDb(reply, async (pool) => loadTargets(pool, month, await scopeOf(pool, await currentViewer())));
}

export function updateTeamTargets(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as TeamTargetsUpdate;
  return withDb(reply, async (pool) => {
    const viewer = await currentViewer();
    const scope = await scopeOf(pool, viewer);
    // Administrators and department managers set targets; team leads and members only read them.
    if (scope.kind === "team" || scope.kind === "self")
      return sendProblem(reply, 403, "Only administrators and department managers set targets");
    const outside = b.items.filter((i) => scope.userIds && !scope.userIds.includes(i.userId));
    if (outside.length) return badInput(reply, "/items", "a user is outside your department");
    await pool.query(
      `INSERT INTO user_targets (user_id, month, revenue_target, margin_target, updated_by_id)
       SELECT x.user_id, $1::date, x.revenue, x.margin, $5
         FROM unnest($2::bigint[], $3::numeric[], $4::numeric[]) AS x(user_id, revenue, margin)
       ON CONFLICT (user_id, month) DO UPDATE SET revenue_target = EXCLUDED.revenue_target,
         margin_target = EXCLUDED.margin_target, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`,
      [
        monthDate(b.month),
        b.items.map((i) => i.userId),
        b.items.map((i) => i.revenueTarget),
        b.items.map((i) => i.marginTarget),
        currentUserId(),
      ],
    );
    return loadTargets(pool, b.month, scope);
  });
}

/**
 * Fake targets when there are none yet: per account manager and month (three back, this one and the
 * next), their last 30 days' revenue give or take 25 %, margin target 30 % of it. Platform currency.
 */
export async function ensureTeamTargets(pool: pg.Pool = db()): Promise<number> {
  const { rows: any } = await pool.query("SELECT 1 FROM user_targets LIMIT 1");
  if (any[0]) return 0;
  const { rows: ams } = await pool.query("SELECT id FROM users WHERE is_account_manager AND deleted_at IS NULL");
  const ids = ams.map((r) => Number(r.id));
  if (!ids.length) return 0;
  const to = new Date();
  const factor = await sysToPlatformFactor();
  const actual = await bizByAm(ids, { from: new Date(to.getTime() - 30 * DAY), to }, factor);
  const noise = (a: number, b: number) => (((a * 7919 + b * 104729) % 1000) / 1000) * 0.5 + 0.75;
  const months: string[] = [];
  for (let k = -3; k <= 1; k++) {
    const d = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + k, 1));
    months.push(d.toISOString().slice(0, 10));
  }
  const u: number[] = [];
  const m: string[] = [];
  const rev: number[] = [];
  for (const id of ids)
    for (const [i, month] of months.entries()) {
      const base = Math.max(2000, actual.get(id)?.revenue ?? 0);
      u.push(id);
      m.push(month);
      rev.push(Math.round((base * noise(id, i)) / 100) * 100);
    }
  await pool.query(
    `INSERT INTO user_targets (user_id, month, revenue_target, margin_target)
     SELECT u, m::date, r, round(r * 0.3) FROM unnest($1::bigint[], $2::text[], $3::numeric[]) AS x(u, m, r)
     ON CONFLICT DO NOTHING`,
    [u, m, rev],
  );
  return u.length;
}

// ---------------------------------------------------------------- online now and page views

export async function onlineUsers(pool: pg.Pool, viewer: Viewer | null): Promise<OnlineUsers> {
  const scope = await scopeOf(pool, viewer);
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (s.user_id) s.user_id, u.first_name, u.last_name, d.name AS department, s.logged_in_at,
            s.last_seen_at, s.device, s.browser, s.os, s.location,
            (SELECT v.path FROM page_views v WHERE v.user_id = s.user_id ORDER BY v.at DESC LIMIT 1) AS page
       FROM user_sessions s JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE s.user_kind = 'staff' AND s.ended_at IS NULL AND s.last_seen_at > now() - interval '30 minutes'
        AND ($1::bigint[] IS NULL OR s.user_id = ANY($1))
      ORDER BY s.user_id, s.last_seen_at DESC`,
    [scope.userIds],
  );
  const users: OnlineUser[] = rows
    .map((r) => ({
      userId: Number(r.user_id),
      name: `${r.first_name} ${r.last_name}`,
      initials: `${r.first_name[0] ?? ""}${r.last_name[0] ?? ""}`.toUpperCase(),
      department: r.department ?? null,
      active: Date.now() - new Date(r.last_seen_at).getTime() < ACTIVE_MS,
      page: r.page ?? null,
      since: iso(r.logged_in_at)!,
      lastSeenAt: iso(r.last_seen_at)!,
      device: r.device ?? null,
      browser: r.browser ?? null,
      os: r.os ?? null,
      location: r.location ?? null,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return { users, total: users.length, active: users.filter((x) => x.active).length, scope: scope.kind };
}

export function getOnlineUsers(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => onlineUsers(pool, await currentViewer()));
}

/** The signed-in user opened a page (an administrator previewing someone still counts as themselves). */
/** Record paths whose names Home shows instead of an ID (team trial round 1). */
const RECORD_PATHS: { re: RegExp; def: () => ListDef<{ id: number; name: string }> }[] = [
  { re: /^\/enterprises\/(\d+)$/, def: () => enterpriseList as unknown as ListDef<{ id: number; name: string }> },
  {
    re: /^\/enterprises\/customer-trunks\/(\d+)$/,
    def: () => customerTrunkList as unknown as ListDef<{ id: number; name: string }>,
  },
  {
    re: /^\/enterprises\/vendor-trunks\/(\d+)$/,
    def: () => vendorTrunkList as unknown as ListDef<{ id: number; name: string }>,
  },
];

/** The signed-in user's pages of the last 30 days, last opened first, for Home (team trial round 1). */
export function getMyPages(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query<{ path: string; views: number; last_at: Date }>(
      `SELECT path, count(*)::int AS views, max(at) AS last_at FROM page_views
        WHERE user_id = $1 AND at > now() - interval '30 days'
        GROUP BY path ORDER BY last_at DESC LIMIT 50`,
      [currentUserId()],
    );
    // Record names through their lists, so a masked enterprise stays masked (§13.17).
    const titles = new Map<string, string>();
    for (const { re, def } of RECORD_PATHS) {
      const ids = rows
        .map((r) => re.exec(r.path)?.[1])
        .filter((x): x is string => !!x)
        .map(Number);
      if (!ids.length) continue;
      const page = await runList(pool, def(), {
        limit: ids.length,
        withTotal: false,
        filter: { logic: "and", conditions: [{ field: "id", op: "in", values: ids }] },
      });
      for (const r of rows) {
        const id = Number(re.exec(r.path)?.[1]);
        const hit = page.rows.find((x) => x.id === id);
        if (hit) titles.set(r.path, hit.name);
      }
    }
    return {
      pages: rows.map((r) => ({
        path: r.path,
        title: titles.get(r.path) ?? null,
        views: r.views,
        lastAt: r.last_at.toISOString(),
      })),
    };
  });
}

export function recordPageView(request: FastifyRequest, reply: FastifyReply) {
  const { path } = request.body as PageViewInput;
  return withDb(reply, async (pool) => {
    await pool.query("INSERT INTO page_views (user_id, path) VALUES ($1, $2)", [currentUserId(), path.slice(0, 300)]);
    await pool.query(
      `UPDATE user_sessions SET last_seen_at = now()
        WHERE id = (SELECT id FROM user_sessions WHERE user_id = $1 AND ended_at IS NULL ORDER BY logged_in_at DESC LIMIT 1)`,
      [currentUserId()],
    );
    return reply.code(204).send();
  });
}

/**
 * Presence for the fake team (dev server only): every minute about half of the open staff sessions
 * show activity on a page of their department, and now and then someone signs in or out.
 */
export function startTeamPresence(pool: pg.Pool = db()): () => void {
  const tick = async () => {
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, d.name AS department FROM user_sessions s JOIN users u ON u.id = s.user_id
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE s.user_kind = 'staff' AND s.ended_at IS NULL AND s.user_id <> $1`,
      [currentUserId()],
    );
    const busy = rows.filter(() => Math.random() < 0.5);
    for (const r of busy) {
      const pages = PAGES_BY_DEPARTMENT[r.department as string] ?? ["/dashboard"];
      await pool.query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [r.id]);
      await pool.query("INSERT INTO page_views (user_id, path) VALUES ($1, $2)", [
        r.user_id,
        pages[Math.floor(Math.random() * pages.length)],
      ]);
    }
    if (Math.random() < 0.15 && rows.length > 5) {
      const out = rows[Math.floor(Math.random() * rows.length)]!;
      await pool.query("UPDATE user_sessions SET ended_at = now(), end_reason = 'logout' WHERE id = $1", [out.id]);
    }
    if (Math.random() < 0.2) {
      await pool.query(
        `INSERT INTO user_sessions (user_kind, user_id, ip, location, device, os, browser, logged_in_at, last_seen_at)
         SELECT 'staff', u.id, s.ip, s.location, s.device, s.os, s.browser, now(), now()
           FROM users u JOIN LATERAL (SELECT * FROM user_sessions o WHERE o.user_id = u.id ORDER BY o.logged_in_at DESC LIMIT 1) s ON true
          WHERE u.deleted_at IS NULL AND u.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM user_sessions x WHERE x.user_id = u.id AND x.ended_at IS NULL)
          ORDER BY random() LIMIT 1`,
      );
    }
  };
  const timer = setInterval(() => void tick().catch(() => undefined), 60_000);
  void tick().catch(() => undefined);
  return () => clearInterval(timer);
}
