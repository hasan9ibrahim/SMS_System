// Cleanup Center (§13.19, §13.20): a scan finds rules that are unassigned, unused, expired, identical,
// near-duplicate, shadowed, conflicting or broken; unattached or identical rate tables; idle trunks;
// dormant or duplicate enterprises; unused number lists; idle users. Each finding is reviewed before
// anything changes: route-rule cleanups replay the last 24 hours of traffic first, and everything applied
// is one undoable change in History (entity type "cleanup", each entry naming its record type).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  CleanupAction,
  CleanupApplyResult,
  CleanupArea,
  CleanupEntity,
  CleanupFinding,
  CleanupFindingDetail,
  CleanupIgnore,
  CleanupScanResult,
  CleanupSelection,
  CleanupSettings,
  CleanupSimulation,
  CleanupSummary,
  DuplicateCheck,
  DuplicateCheckResult,
  ListQuery,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { chRows } from "../edr.js";
import { sendProblem } from "../problem.js";
import type { ListDef } from "../lists/engine.js";
import { runList } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { currentViewer } from "../visibility/context.js";
import { inTransaction } from "./views.js";
import { logEmail } from "./emailLog.js";
import type { DiffEntry } from "./records.js";
import { iso, recordChange } from "./records.js";
import { getCurrentUser } from "./session.js";
import { KIND_LABELS } from "./cleanupLabels.js";
import {
  listIdsOf,
  loadRulesInOrder,
  messageContext,
  routeThrough,
  vendorOptions,
  type RuleCore,
} from "./routeRules.js";

type Db = pg.Pool | pg.PoolClient;
const DAY = 86_400_000;
const int = (v: unknown) => Number(v ?? 0);
const fmt = (n: number) => n.toLocaleString("en-US");

interface Draft {
  fingerprint: string;
  area: CleanupArea;
  kind: string;
  entityType: string;
  entityIds: number[];
  title: string;
  why: string;
  suggestion: CleanupAction;
  actions: CleanupAction[];
  impact: string;
  messages30d: number | null;
}
const fp = (kind: string, ids: number[]) => `${kind}:${[...ids].sort((a, b) => a - b).join(",")}`;

// ---------------------------------------------------------------- settings

const mapSettings = (r: Record<string, unknown>): CleanupSettings => ({
  unusedDays: int(r.unused_days),
  dormantDays: int(r.dormant_days),
  userIdleDays: int(r.user_idle_days),
  expiredDays: int(r.expired_days),
  requireApproval: !!r.require_approval,
  summaryEmails: (r.summary_emails as string[]) ?? [],
});
async function loadSettings(c: Db): Promise<CleanupSettings> {
  const { rows } = await c.query("SELECT * FROM cleanup_settings WHERE id = 1");
  return mapSettings(rows[0]);
}
export function getCleanupSettings(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, (pool) => loadSettings(pool));
}
export function updateCleanupSettings(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as CleanupSettings;
  return withDb(reply, async (pool) => {
    await pool.query(
      `UPDATE cleanup_settings SET unused_days = $1, dormant_days = $2, user_idle_days = $3, expired_days = $4,
              require_approval = $5, summary_emails = $6 WHERE id = 1`,
      [b.unusedDays, b.dormantDays, b.userIdleDays, b.expiredDays, b.requireApproval, b.summaryEmails],
    );
    return loadSettings(pool);
  });
}

// ---------------------------------------------------------------- detectors

/** Route rule conditions and routing, as text to compare (name, priority, comment and audit left out). */
const COND_SQL = (withTrunks: boolean) => `concat_ws('|', r.status, r.match_mode, r.category_mode,
  (SELECT array_agg(x ORDER BY x) FROM unnest(r.category_ids) x)::text, r.customer_trunk_mode,
  ${withTrunks ? "(SELECT array_agg(x ORDER BY x) FROM unnest(r.customer_trunk_ids) x)::text" : "''"},
  r.mccmnc_mode, (SELECT array_agg(x ORDER BY x) FROM unnest(r.mccmncs) x)::text, r.mccmnc_pattern,
  r.sender_pattern, r.sender_pattern_negate, r.sender_match_case, r.receiver_pattern, r.receiver_pattern_negate, r.sender_values::text, r.receiver_values::text, r.content_pattern,
  r.content_pattern_negate, r.sender_list_id, r.sender_list_negate, r.receiver_list_id, r.receiver_list_negate, r.tps_condition::text, r.revenue_condition::text,
  r.starts_at, r.stops_at, r.hlr_action, r.hlr_ported, r.deny_multipart)`;
const ROUTE_SQL = `concat_ws('|', r.route_type, r.hunt_policy, r.enable_backup_routes, r.vendor_category_mode,
  r.vendor_category_ids::text, r.vendor_trunk_mode, (SELECT array_agg(x ORDER BY x) FROM unnest(r.vendor_trunk_ids) x)::text,
  r.max_route_level, r.margin, r.qbr_formula, r.lcr_profile_id, r.continue_routing,
  (SELECT string_agg(concat_ws(':', v.level, v.vendor_trunk_id, v.share_pct, v.is_backup), ',' ORDER BY v.level, v.vendor_trunk_id)
     FROM route_rule_vendors v WHERE v.route_rule_id = r.id))`;

interface RuleRow {
  id: number;
  name: string;
  priority: number;
  cond: string;
  condNoTrunks: string;
  route: string;
  trunkMode: string;
  trunks: number[];
  cont: boolean;
  m30: number;
  m7: number;
}

async function ruleRows(c: Db): Promise<RuleRow[]> {
  const { rows } = await c.query(
    `SELECT r.id, r.name, r.priority, md5(${COND_SQL(true)}) AS cond, md5(${COND_SQL(false)}) AS cond_nt,
            md5(${ROUTE_SQL}) AS route, r.customer_trunk_mode, r.customer_trunk_ids, r.continue_routing,
            coalesce(t30.messages, 0) AS m30, coalesce(t7.messages, 0) AS m7
       FROM route_rules r
       LEFT JOIN route_rule_traffic t30 ON t30.route_rule_id = r.id AND t30.time_window = '30d'
       LEFT JOIN route_rule_traffic t7 ON t7.route_rule_id = r.id AND t7.time_window = '7d'
      WHERE r.deleted_at IS NULL AND r.status = 'active'
      ORDER BY r.priority DESC, r.id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    priority: Number(r.priority),
    cond: r.cond,
    condNoTrunks: r.cond_nt,
    route: r.route,
    trunkMode: r.customer_trunk_mode,
    trunks: ((r.customer_trunk_ids as string[]) ?? []).map(Number),
    // "stop" ends routing at the rule; "yes" continues when it finds no vendor (R3).
    cont: r.continue_routing !== "stop",
    m30: int(r.m30),
    m7: int(r.m7),
  }));
}

const msgs = (n: number) => (n ? `${fmt(n)} messages in the last 30 days` : "0 messages in the last 30 days");
const group = <T, K>(xs: T[], key: (x: T) => K) => {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

async function routeRuleFindings(c: Db, s: CleanupSettings): Promise<Draft[]> {
  const out: Draft[] = [];
  const rules = await ruleRows(c);
  const names = (rs: RuleRow[]) => rs.map((r) => `"${r.name}"`).join(", ");
  const sum = (rs: RuleRow[]) => rs.reduce((a, r) => a + r.m30, 0);

  // Identical: same conditions and routing, whatever the name and priority.
  const identical = new Set<number>();
  for (const g of group(rules, (r) => `${r.cond}|${r.route}`).values()) {
    if (g.length < 2) continue;
    const [keep, ...rest] = g;
    for (const r of g) identical.add(r.id);
    out.push({
      fingerprint: fp(
        "route_rule_identical",
        g.map((r) => r.id),
      ),
      area: "rules",
      kind: "route_rule_identical",
      entityType: "route_rule",
      entityIds: g.map((r) => r.id),
      title: `${g.length} route rules with the same conditions and vendors`,
      why: `${names(g)} differ only in name or priority; only "${keep!.name}" ever decides, the others add noise.`,
      suggestion: "merge",
      actions: ["merge", "review"],
      impact: `Keeps "${keep!.name}", archives ${rest.length}; ${msgs(sum(g))} — routing result unchanged`,
      messages30d: sum(g),
    });
  }
  // Near-duplicates: differ only in their client trunk list.
  for (const g of group(
    rules.filter((r) => r.trunkMode === "inclusive" && !identical.has(r.id)),
    (r) => `${r.condNoTrunks}|${r.route}|${r.priority}`,
  ).values()) {
    if (g.length < 2) continue;
    const [keep] = g;
    const union = [...new Set(g.flatMap((r) => r.trunks))];
    out.push({
      fingerprint: fp(
        "route_rule_near_duplicate",
        g.map((r) => r.id),
      ),
      area: "rules",
      kind: "route_rule_near_duplicate",
      entityType: "route_rule",
      entityIds: g.map((r) => r.id),
      title: `${g.length} route rules that differ only in their client trunks`,
      why: `${names(g)} could be one rule listing all ${union.length} client trunks.`,
      suggestion: "merge",
      actions: ["merge", "review"],
      impact: `"${keep!.name}" takes all ${union.length} trunks, ${g.length - 1} archived; ${msgs(sum(g))}`,
      messages30d: sum(g),
    });
  }
  // Shadowed and conflicting: same conditions, other vendors.
  for (const g of group(
    rules.filter((r) => !identical.has(r.id)),
    (r) => r.cond,
  ).values()) {
    if (g.length < 2) continue;
    for (let i = 1; i < g.length; i++) {
      const b = g[i]!;
      // Same priority: whichever comes first decides. Lower priority (tried later): shadowed when the earlier rule stops.
      const a =
        g.slice(0, i).find((x) => x.priority === b.priority && x.route !== b.route) ??
        g.slice(0, i).find((x) => !x.cont && x.priority > b.priority && x.route !== b.route);
      if (!a) continue;
      if (a.priority === b.priority)
        out.push({
          fingerprint: fp("route_rule_conflict", [a.id, b.id]),
          area: "rules",
          kind: "route_rule_conflict",
          entityType: "route_rule",
          entityIds: [a.id, b.id],
          title: `Two rules at priority ${a.priority} for the same traffic with different vendors`,
          why: `"${a.name}" and "${b.name}" match the same messages; which one wins depends only on their IDs.`,
          suggestion: "reorder",
          actions: ["reorder", "review"],
          impact: `Moves "${b.name}" to priority ${b.priority - 1} — routing result unchanged, the order becomes explicit`,
          messages30d: a.m30 + b.m30,
        });
      else
        out.push({
          fingerprint: fp("route_rule_shadowed", [b.id]),
          area: "rules",
          kind: "route_rule_shadowed",
          entityType: "route_rule",
          entityIds: [b.id, a.id],
          title: `"${b.name}" can never match`,
          why: `"${a.name}" (priority ${a.priority}) has the same conditions, comes first and does not continue, so it takes all of this rule's traffic.`,
          suggestion: "archive",
          actions: ["archive", "deactivate", "review"],
          impact: `${msgs(b.m30)} on the shadowed rule — routing result unchanged`,
          messages30d: b.m30,
        });
    }
  }
  // Unused, expired, broken.
  const { rows: unused } = await c.query(
    `SELECT r.id, r.name, coalesce(t.messages, 0) AS m FROM route_rules r
       LEFT JOIN route_rule_traffic t ON t.route_rule_id = r.id AND t.time_window = '30d'
      WHERE r.deleted_at IS NULL AND r.status = 'active' AND r.inserted_at < now() - make_interval(days => $1)
        AND coalesce(t.messages, 0) = 0 AND (r.stops_at IS NULL OR r.stops_at > now())`,
    [s.unusedDays],
  );
  for (const r of unused)
    out.push({
      fingerprint: fp("route_rule_unused", [Number(r.id)]),
      area: "rules",
      kind: "route_rule_unused",
      entityType: "route_rule",
      entityIds: [Number(r.id)],
      title: `"${r.name}" matched no message in ${s.unusedDays} days`,
      why: "A rule that never matches is dead weight in the list and hides the rules that do work.",
      suggestion: "deactivate",
      actions: ["deactivate", "archive"],
      impact: `0 messages in the last ${s.unusedDays} days`,
      messages30d: 0,
    });
  const { rows: expired } = await c.query(
    `SELECT id, name, stops_at FROM route_rules WHERE deleted_at IS NULL AND stops_at < now() - make_interval(days => $1)`,
    [s.expiredDays],
  );
  for (const r of expired)
    out.push({
      fingerprint: fp("route_rule_expired", [Number(r.id)]),
      area: "rules",
      kind: "route_rule_expired",
      entityType: "route_rule",
      entityIds: [Number(r.id)],
      title: `"${r.name}" stopped on ${iso(r.stops_at)!.slice(0, 10)}`,
      why: "Its stop time has passed, so it no longer routes anything.",
      suggestion: "archive",
      actions: ["archive"],
      impact: "No traffic since it stopped",
      messages30d: 0,
    });
  const { rows: broken } = await c.query(
    `SELECT r.id, r.name, array_agg(DISTINCT vt.name) AS bad,
            count(*) FILTER (WHERE vt.deleted_at IS NULL AND vt.status = 'active') AS good,
            coalesce(t.messages, 0) AS m
       FROM route_rules r JOIN route_rule_vendors v ON v.route_rule_id = r.id JOIN vendor_trunks vt ON vt.id = v.vendor_trunk_id
       LEFT JOIN route_rule_traffic t ON t.route_rule_id = r.id AND t.time_window = '30d'
      WHERE r.deleted_at IS NULL
      GROUP BY r.id, r.name, t.messages
     HAVING bool_or(vt.deleted_at IS NOT NULL OR vt.status <> 'active')`,
  );
  for (const r of broken) {
    const bad = (r.bad as string[]).filter(Boolean);
    out.push({
      fingerprint: fp("route_rule_broken", [Number(r.id)]),
      area: "rules",
      kind: "route_rule_broken",
      entityType: "route_rule",
      entityIds: [Number(r.id)],
      title: `"${r.name}" points to a deleted or inactive vendor trunk`,
      why: `Its vendor list includes trunks that cannot take traffic${bad.length ? ` (${bad.slice(0, 3).join(", ")}${bad.length > 3 ? "…" : ""})` : ""}.`,
      suggestion: int(r.good) > 0 ? "reassign" : "deactivate",
      actions: int(r.good) > 0 ? ["reassign", "deactivate", "review"] : ["deactivate", "review"],
      impact:
        int(r.good) > 0
          ? `Removes the dead vendors and keeps ${r.good} working ones; ${msgs(int(r.m))}`
          : `No working vendor left; ${msgs(int(r.m))}`,
      messages30d: int(r.m),
    });
  }
  return out;
}

async function otherRuleFindings(c: Db): Promise<Draft[]> {
  const out: Draft[] = [];
  const { rows: tr } = await c.query(
    `SELECT r.id, r.name FROM translation_rules r WHERE r.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM translation_rule_targets t WHERE t.translation_rule_id = r.id)`,
  );
  for (const r of tr)
    out.push({
      fingerprint: fp("translation_rule_unassigned", [Number(r.id)]),
      area: "rules",
      kind: "translation_rule_unassigned",
      entityType: "translation_rule",
      entityIds: [Number(r.id)],
      title: `Translation rule "${r.name}" is on no trunk`,
      why: "It is not attached to any customer or vendor trunk, enterprise, category or all trunks, so it never runs.",
      suggestion: "archive",
      actions: ["archive"],
      impact: "Never runs — no message affected",
      messages30d: 0,
    });
  const { rows: hr } = await c.query(
    `SELECT r.id, r.name FROM hlr_rules r WHERE r.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hlr_rule_targets t WHERE t.hlr_rule_id = r.id)`,
  );
  for (const r of hr)
    out.push({
      fingerprint: fp("hlr_rule_unassigned", [Number(r.id)]),
      area: "rules",
      kind: "hlr_rule_unassigned",
      entityType: "hlr_rule",
      entityIds: [Number(r.id)],
      title: `HLR rule "${r.name}" is on no trunk`,
      why: "No trunk uses it, so no lookup is made with it.",
      suggestion: "archive",
      actions: ["archive"],
      impact: "Never runs — no message affected",
      messages30d: 0,
    });
  const { rows: nl } = await c.query(
    `SELECT n.id, n.name, (SELECT count(*) FROM number_list_entries e WHERE e.number_list_id = n.id) AS entries
       FROM number_lists n WHERE n.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM route_rules r WHERE r.deleted_at IS NULL AND n.id IN (r.sender_list_id, r.receiver_list_id))
        AND NOT EXISTS (SELECT 1 FROM translation_rules r WHERE r.deleted_at IS NULL
                          AND n.id IN (r.sender_list_id, r.receiver_list_id, r.sender_conversion_list_id))`,
  );
  for (const r of nl)
    out.push({
      fingerprint: fp("number_list_unused", [Number(r.id)]),
      area: "lists",
      kind: "number_list_unused",
      entityType: "number_list",
      entityIds: [Number(r.id)],
      title: `Number list "${r.name}" is not used anywhere`,
      why: `No route or translation rule refers to it (${fmt(int(r.entries))} entries).`,
      suggestion: "archive",
      actions: ["archive"],
      impact: "Not used — no message affected",
      messages30d: 0,
    });
  return out;
}

async function rateFindings(c: Db): Promise<Draft[]> {
  const out: Draft[] = [];
  const { rows: same } = await c.query(
    `WITH cur AS (
       SELECT rt.id, rt.name,
              md5(string_agg(concat_ws(':', l.mccmnc, l.sender_id, l.rate, l.currency, l.is_blocked), ',' ORDER BY l.mccmnc, l.sender_id)) AS h,
              count(*) AS lines,
              (SELECT count(*) FROM customer_trunk_rate_tables x JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
                WHERE x.rate_table_id = rt.id) AS trunks
         FROM rate_tables rt JOIN rate_lines l ON l.rate_table_id = rt.id
        WHERE rt.kind = 'customer' AND rt.deleted_at IS NULL AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
        GROUP BY rt.id, rt.name)
     SELECT h, json_agg(json_build_object('id', id, 'name', name, 'trunks', trunks, 'lines', lines) ORDER BY trunks DESC, id) AS t
       FROM cur GROUP BY h HAVING count(*) > 1`,
  );
  const inIdentical = new Set<number>();
  for (const g of same) {
    const t = g.t as { id: number; name: string; trunks: number; lines: number }[];
    const [keep, ...copies] = t;
    for (const x of t) inIdentical.add(Number(x.id));
    const free = copies.every((x) => int(x.trunks) === 0);
    out.push({
      fingerprint: fp(
        "rate_table_identical",
        t.map((x) => Number(x.id)),
      ),
      area: "rates",
      kind: "rate_table_identical",
      entityType: "rate_table",
      entityIds: t.map((x) => Number(x.id)),
      title: `${t.length} rate tables with identical current rates`,
      why: `${t.map((x) => `"${x.name}"`).join(", ")} sell the same ${fmt(int(keep!.lines))} lines; every rate change has to be made ${t.length} times.`,
      suggestion: free ? "archive" : "review",
      actions: free ? ["archive", "review"] : ["review"],
      impact: free
        ? `Archives ${copies.length} cop${copies.length === 1 ? "y" : "ies"} on no trunk; "${keep!.name}" stays`
        : "The copies are on trunks: move the trunks to one table first",
      messages30d: null,
    });
  }
  const { rows: free } = await c.query(
    `SELECT rt.id, rt.name, (SELECT count(*) FROM rate_lines l WHERE l.rate_table_id = rt.id) AS lines
       FROM rate_tables rt WHERE rt.kind = 'customer' AND rt.deleted_at IS NULL AND rt.inserted_at < now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM customer_trunk_rate_tables x JOIN customer_trunks t ON t.id = x.customer_trunk_id
                         AND t.deleted_at IS NULL WHERE x.rate_table_id = rt.id)`,
  );
  for (const r of free)
    if (!inIdentical.has(Number(r.id)))
      out.push({
        fingerprint: fp("rate_table_unattached", [Number(r.id)]),
        area: "rates",
        kind: "rate_table_unattached",
        entityType: "rate_table",
        entityIds: [Number(r.id)],
        title: `Rate table "${r.name}" is on no trunk`,
        why: `No customer trunk sells from it (${fmt(int(r.lines))} lines kept for nothing).`,
        suggestion: "archive",
        actions: ["archive"],
        impact: "Not on any trunk — no message affected",
        messages30d: 0,
      });
  return out;
}

async function trunkFindings(c: Db, s: CleanupSettings): Promise<Draft[]> {
  const out: Draft[] = [];
  const traffic = await chRows<{ side: string; id: number; m: number }>(
    `SELECT 'c' AS side, c_trunk_id AS id, toUInt64(sum(messages)) AS m FROM edr_hourly
      WHERE hour >= now() - INTERVAL ${Math.floor(s.unusedDays)} DAY GROUP BY id
     UNION ALL
     SELECT 'v', v_trunk_id, toUInt64(sum(messages)) FROM edr_hourly
      WHERE hour >= now() - INTERVAL ${Math.floor(s.unusedDays)} DAY GROUP BY v_trunk_id`,
    20_000,
  );
  if (!traffic) return out; // no EDR store: no traffic findings
  const busy = new Set(traffic.filter((t) => int(t.m) > 0).map((t) => `${t.side}${t.id}`));
  for (const kind of ["customer", "vendor"] as const) {
    const { rows } = await c.query(
      `SELECT t.id, t.name, t.status, e.name AS enterprise FROM ${kind}_trunks t JOIN enterprises e ON e.id = t.enterprise_id
        WHERE t.deleted_at IS NULL AND t.inserted_at < now() - make_interval(days => $1)`,
      [s.unusedDays],
    );
    for (const t of rows) {
      if (busy.has(`${kind[0]}${t.id}`)) continue;
      const inactive = t.status !== "active";
      const k = inactive ? "trunk_inactive" : "trunk_idle";
      out.push({
        fingerprint: fp(`${k}_${kind}`, [Number(t.id)]),
        area: "trunks",
        kind: k,
        entityType: `${kind}_trunk`,
        entityIds: [Number(t.id)],
        title: `${kind === "customer" ? "Customer" : "Vendor"} trunk "${t.name}" (${t.enterprise}) carried nothing in ${s.unusedDays} days`,
        why: inactive
          ? "It is inactive and has no traffic: it only clutters pickers and lists."
          : "It is active but no message went through it.",
        suggestion: inactive ? "archive" : "deactivate",
        actions: inactive ? ["archive"] : ["deactivate", "archive"],
        impact: `0 messages in the last ${s.unusedDays} days`,
        messages30d: 0,
      });
    }
  }
  return out;
}

const LEGAL = /\b(ltd|llc|limited|inc|fze|fz llc|dmcc|ab|sa|srl|gmbh|bv|plc|co|company|group)\b/g;
export const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(LEGAL, " ")
    .replace(/\s+/g, " ")
    .trim();

async function enterpriseFindings(c: Db, s: CleanupSettings): Promise<Draft[]> {
  const out: Draft[] = [];
  const { rows } = await c.query(
    `SELECT e.id, e.name, e.vat_number, e.status, e.inserted_at,
            (SELECT count(*) FROM customer_trunks t WHERE t.enterprise_id = e.id AND t.deleted_at IS NULL AND t.status = 'active')
          + (SELECT count(*) FROM vendor_trunks t WHERE t.enterprise_id = e.id AND t.deleted_at IS NULL AND t.status = 'active') AS live
       FROM enterprises e WHERE e.deleted_at IS NULL ORDER BY e.id`,
  );
  // Same company twice: the same name (punctuation and legal form aside) or VAT number.
  const seen = new Set<string>();
  for (const key of ["name", "vat"] as const) {
    for (const g of group(
      rows.filter((r) => (key === "name" ? normName(r.name) : r.vat_number)),
      (r) => (key === "name" ? normName(r.name) : String(r.vat_number).toUpperCase()),
    ).values()) {
      if (g.length < 2) continue;
      const ids = g.map((r) => Number(r.id));
      const f = fp("enterprise_duplicate", ids);
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({
        fingerprint: f,
        area: "enterprises",
        kind: "enterprise_duplicate",
        entityType: "enterprise",
        entityIds: ids,
        title: `${g.map((r) => `"${r.name}"`).join(" and ")} look like the same company`,
        why:
          key === "name" ? "Same name apart from punctuation and legal form." : `Same VAT number ${g[0]!.vat_number}.`,
        suggestion: "review",
        actions: ["review"],
        impact: "Merge by hand: trunks, documents, invoices and history must be kept",
        messages30d: null,
      });
    }
  }
  // Dormant: no active trunk and no traffic in the EDR store for the period.
  const traffic = await chRows<{ id: number }>(
    `SELECT DISTINCT c_enterprise_id AS id FROM edr_hourly WHERE hour >= now() - INTERVAL ${Math.floor(s.dormantDays)} DAY
     UNION DISTINCT SELECT DISTINCT v_enterprise_id FROM edr_hourly WHERE hour >= now() - INTERVAL ${Math.floor(s.dormantDays)} DAY`,
    20_000,
  );
  if (traffic) {
    const busy = new Set(traffic.map((t) => int(t.id)));
    for (const r of rows)
      if (
        r.status === "active" &&
        int(r.live) === 0 &&
        !busy.has(Number(r.id)) &&
        Date.now() - new Date(r.inserted_at).getTime() > s.dormantDays * DAY
      )
        out.push({
          fingerprint: fp("enterprise_dormant", [Number(r.id)]),
          area: "enterprises",
          kind: "enterprise_dormant",
          entityType: "enterprise",
          entityIds: [Number(r.id)],
          title: `"${r.name}" has no active trunk and no traffic in ${s.dormantDays} days`,
          why: "A dormant partner still shows in pickers, reports and billing runs.",
          suggestion: "deactivate",
          actions: ["deactivate", "review"],
          impact: "Marked inactive; records and history stay",
          messages30d: 0,
        });
  }
  return out;
}

async function userFindings(c: Db, s: CleanupSettings): Promise<Draft[]> {
  const { rows } = await c.query(
    `SELECT id, first_name || ' ' || last_name AS name, last_login_at FROM users
      WHERE deleted_at IS NULL AND status = 'active' AND NOT is_admin AND inserted_at < now() - make_interval(days => $1)
        AND (last_login_at IS NULL OR last_login_at < now() - make_interval(days => $1))`,
    [s.userIdleDays],
  );
  return rows.map((r) => ({
    fingerprint: fp("user_idle", [Number(r.id)]),
    area: "users" as const,
    kind: "user_idle",
    entityType: "user",
    entityIds: [Number(r.id)],
    title: `${r.name} has not signed in for ${s.userIdleDays} days`,
    why: r.last_login_at ? `Last sign-in ${iso(r.last_login_at)!.slice(0, 10)}.` : "Never signed in.",
    suggestion: "deactivate" as const,
    actions: ["deactivate" as const],
    impact: "Disabled; they can be enabled again",
    messages30d: null,
  }));
}

// ---------------------------------------------------------------- scan

let scanning: Promise<CleanupScanResult> | null = null;

export function runScan(pool: pg.Pool = db()): Promise<CleanupScanResult> {
  scanning ??= (async () => {
    const started = Date.now();
    const s = await loadSettings(pool);
    const drafts = (
      await Promise.all([
        routeRuleFindings(pool, s),
        otherRuleFindings(pool),
        rateFindings(pool),
        trunkFindings(pool, s),
        enterpriseFindings(pool, s),
        userFindings(pool, s),
      ])
    ).flat();
    const r = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `WITH d AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(fingerprint text, area text, kind text, "entityType" text,
              "entityIds" bigint[], title text, why text, suggestion text, actions text[], impact text, "messages30d" bigint))
         INSERT INTO cleanup_findings (fingerprint, area, kind, entity_type, entity_ids, title, why, suggestion, actions, impact, messages_30d)
         SELECT fingerprint, area, kind, "entityType", "entityIds", title, why, suggestion, actions, impact, "messages30d" FROM d
         ON CONFLICT (fingerprint) DO UPDATE SET title = EXCLUDED.title, why = EXCLUDED.why, suggestion = EXCLUDED.suggestion,
           actions = EXCLUDED.actions, impact = EXCLUDED.impact, messages_30d = EXCLUDED.messages_30d, last_seen_at = now(),
           entity_ids = EXCLUDED.entity_ids,
           state = CASE WHEN cleanup_findings.state IN ('resolved', 'applied') THEN 'open' ELSE cleanup_findings.state END,
           detected_at = CASE WHEN cleanup_findings.state IN ('resolved', 'applied') THEN now() ELSE cleanup_findings.detected_at END
         RETURNING (xmax = 0) AS created`,
        [JSON.stringify(drafts)],
      );
      // Open findings the scan no longer sees are resolved (fixed by hand, or the records changed).
      const { rowCount } = await c.query(
        `UPDATE cleanup_findings SET state = 'resolved' WHERE state IN ('open', 'awaiting_approval') AND NOT (fingerprint = ANY($1))`,
        [drafts.map((d) => d.fingerprint)],
      );
      await c.query("UPDATE cleanup_settings SET last_scan_at = now() WHERE id = 1");
      const { rows: open } = await c.query("SELECT count(*)::int AS n FROM cleanup_findings WHERE state = 'open'");
      const created = rows.filter((x) => x.created).length;
      return {
        created,
        updated: rows.length - created,
        resolved: rowCount ?? 0,
        open: open[0].n,
        durationMs: Date.now() - started,
      };
    });
    return r;
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

export function scanCleanup(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, (pool) => runScan(pool));
}

// ---------------------------------------------------------------- list, detail, summary

const FINDING_SELECT = `f.*, ab.username AS applied_by`;
const FINDING_FROM = "cleanup_findings f LEFT JOIN users ab ON ab.id = f.applied_by_id";
const KIND_LABEL_SQL = `CASE f.kind ${Object.entries(KIND_LABELS)
  .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
  .join(" ")} ELSE f.kind END`;

export function mapFinding(r: Record<string, unknown>): CleanupFinding {
  return {
    id: Number(r.id),
    area: r.area as CleanupArea,
    kind: r.kind as string,
    kindLabel: KIND_LABELS[r.kind as string] ?? (r.kind as string),
    entityType: r.entity_type as string,
    entityIds: ((r.entity_ids as string[]) ?? []).map(Number),
    title: r.title as string,
    why: r.why as string,
    suggestion: r.suggestion as CleanupAction,
    actions: (r.actions as CleanupAction[]) ?? [],
    impact: r.impact as string,
    messages30d: r.messages_30d == null ? null : Number(r.messages_30d),
    state: r.state as CleanupFinding["state"],
    ignoreReason: (r.ignore_reason as string | null) ?? null,
    detectedAt: iso(r.detected_at)!,
    lastSeenAt: iso(r.last_seen_at)!,
    appliedAt: iso(r.applied_at),
    appliedBy: (r.applied_by as string | null) ?? null,
    changeId: r.change_id == null ? null : Number(r.change_id),
  };
}

export const cleanupFindingList: ListDef<CleanupFinding> = {
  fields: listFields.cleanup_findings,
  from: FINDING_FROM,
  columns: {
    id: { sql: "f.id" },
    area: { sql: "f.area" },
    kind: { sql: "f.kind" },
    kindLabel: { sql: KIND_LABEL_SQL },
    title: { sql: "f.title" },
    suggestion: { sql: "f.suggestion" },
    impact: { sql: "f.impact" },
    messages30d: { sql: "f.messages_30d" },
    state: { sql: "f.state" },
    entityType: { sql: "f.entity_type" },
    entityId: { sql: "NULL", where: (_op, c, p) => `${p(Number(c.value))}::bigint = ANY(f.entity_ids)` },
    detectedAt: { sql: "f.detected_at" },
    appliedAt: { sql: "f.applied_at" },
    appliedBy: { sql: "ab.username" },
    ignoreReason: { sql: "f.ignore_reason" },
  },
  search: ["title", "kindLabel", "impact"],
  idSql: "f.id",
  select: FINDING_SELECT,
  mapRow: mapFinding,
};

export function queryCleanupFindings(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.cleanup_findings);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, cleanupFindingList, query));
}

async function loadFinding(c: Db, id: number): Promise<CleanupFinding | null> {
  const { rows } = await c.query(`SELECT ${FINDING_SELECT} FROM ${FINDING_FROM} WHERE f.id = $1`, [id]);
  return rows[0] ? mapFinding(rows[0]) : null;
}

const ENTITY_TABLE: Record<string, { table: string; name: string; path: (id: number) => string | null }> = {
  route_rule: { table: "route_rules", name: "name", path: (id) => `/routing/rules?rule=${id}` },
  translation_rule: { table: "translation_rules", name: "name", path: () => "/switch/translation-rules" },
  hlr_rule: { table: "hlr_rules", name: "name", path: () => "/switch/hlr?view=rules" },
  number_list: { table: "number_lists", name: "name", path: () => "/switch/number-lists" },
  rate_table: { table: "rate_tables", name: "name", path: (id) => `/rates/manager?table=${id}` },
  customer_trunk: { table: "customer_trunks", name: "name", path: (id) => `/enterprises/customer-trunks/${id}` },
  vendor_trunk: { table: "vendor_trunks", name: "name", path: (id) => `/enterprises/vendor-trunks/${id}` },
  enterprise: { table: "enterprises", name: "name", path: (id) => `/enterprises/${id}` },
  user: { table: "users", name: "first_name || ' ' || last_name", path: () => "/admin/users" },
};

async function entitiesOf(c: Db, f: CleanupFinding): Promise<CleanupEntity[]> {
  const t = ENTITY_TABLE[f.entityType];
  if (!t) return [];
  const extra =
    f.entityType === "route_rule"
      ? `'priority ' || x.priority || ' · ' || x.route_type || ' · ' || coalesce((SELECT messages FROM route_rule_traffic WHERE route_rule_id = x.id AND time_window = '7d'), 0) || ' msgs / 7 days' || ' · ' ||
         CASE WHEN x.customer_trunk_mode = 'all' THEN 'all trunks' ELSE cardinality(x.customer_trunk_ids) || ' trunks' END`
      : f.entityType === "rate_table"
        ? `(SELECT count(*) FROM customer_trunk_rate_tables y WHERE y.rate_table_id = x.id) || ' trunks · ' || x.currency`
        : f.entityType.endsWith("_trunk")
          ? `(SELECT name FROM enterprises WHERE id = x.enterprise_id)`
          : "''";
  const status = [
    "route_rule",
    "customer_trunk",
    "vendor_trunk",
    "enterprise",
    "user",
    "translation_rule",
    "hlr_rule",
  ].includes(f.entityType)
    ? "x.status"
    : "NULL";
  const { rows } = await c.query(
    `SELECT x.id, ${t.name} AS name, ${status} AS status, x.deleted_at, ${extra} AS info FROM ${t.table} x WHERE x.id = ANY($1)`,
    [f.entityIds],
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return f.entityIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => ({
      id: Number(r.id),
      type: f.entityType,
      name: r.name,
      status: r.deleted_at ? "archived" : (r.status ?? null),
      info: String(r.info ?? ""),
      path: t.path(Number(r.id)),
    }));
}

function previewOf(f: CleanupFinding, ents: CleanupEntity[], action: CleanupAction): string[] {
  const name = (id: number) => ents.find((e) => e.id === id)?.name ?? `#${id}`;
  const [first, ...rest] = f.entityIds;
  switch (action) {
    case "merge":
      return f.kind === "route_rule_near_duplicate"
        ? [
            `Keep "${name(first!)}" and give it the client trunks of all ${f.entityIds.length} rules`,
            ...rest.map((id) => `Archive "${name(id)}"`),
          ]
        : [`Keep "${name(first!)}"`, ...rest.map((id) => `Archive "${name(id)}" (same conditions and vendors)`)];
    case "archive":
      return f.kind === "rate_table_identical"
        ? rest.map((id) => `Archive "${name(id)}"`)
        : [`Archive "${name(first!)}" (restorable for 90 days)`];
    case "deactivate":
      return [`Set "${name(first!)}" to inactive`];
    case "reorder":
      return [`Move "${name(f.entityIds[1]!)}" one priority lower`];
    case "reassign":
      return [`Remove the deleted or inactive vendor trunks from "${name(first!)}"`];
    case "review":
      return ["Nothing changes automatically: open the records and fix them by hand"];
  }
}

export function getCleanupFinding(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const f = await loadFinding(pool, id);
    if (!f) return sendProblem(reply, 404, `Finding ${id} not found`);
    const entities = await entitiesOf(pool, f);
    const out: CleanupFindingDetail = { ...f, entities, preview: previewOf(f, entities, f.suggestion) };
    return out;
  });
}

export function ignoreCleanupFinding(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const { reason } = request.body as CleanupIgnore;
  return withDb(reply, async (pool) => {
    const { rowCount } = await pool.query(
      "UPDATE cleanup_findings SET state = 'ignored', ignore_reason = $2 WHERE id = $1",
      [id, reason.trim()],
    );
    return rowCount ? loadFinding(pool, id) : sendProblem(reply, 404, `Finding ${id} not found`);
  });
}

export function reopenCleanupFinding(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const f = await loadFinding(pool, id);
    if (!f) return sendProblem(reply, 404, `Finding ${id} not found`);
    if (f.state !== "ignored")
      return sendProblem(reply, 409, `Only ignored findings can be reopened (this one is ${f.state})`);
    await pool.query("UPDATE cleanup_findings SET state = 'open', ignore_reason = NULL WHERE id = $1", [id]);
    return loadFinding(pool, id);
  });
}

export function getCleanupSummary(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool): Promise<CleanupSummary> => {
    const { rows } = await pool.query(
      `SELECT area, kind, count(*) FILTER (WHERE state = 'open')::int AS open FROM cleanup_findings GROUP BY area, kind`,
    );
    const { rows: t } = await pool.query(
      `SELECT count(*) FILTER (WHERE state = 'open')::int AS open, count(*) FILTER (WHERE state = 'awaiting_approval')::int AS waiting,
              count(*) FILTER (WHERE state = 'applied' AND applied_at > now() - interval '30 days')::int AS applied,
              count(*) FILTER (WHERE state = 'ignored')::int AS ignored,
              (SELECT last_scan_at FROM cleanup_settings WHERE id = 1) AS last_scan
         FROM cleanup_findings`,
    );
    const byArea = { rules: 0, rates: 0, trunks: 0, enterprises: 0, lists: 0, users: 0 };
    for (const r of rows) byArea[r.area as CleanupArea] += r.open;
    const last = t[0].last_scan ? new Date(t[0].last_scan) : null;
    return {
      open: t[0].open,
      awaitingApproval: t[0].waiting,
      applied30d: t[0].applied,
      ignored: t[0].ignored,
      byArea,
      byKind: rows
        .filter((r) => r.open > 0)
        .map((r) => ({ area: r.area, kind: r.kind, kindLabel: KIND_LABELS[r.kind] ?? r.kind, open: r.open }))
        .sort((a, b) => b.open - a.open),
      lastScanAt: iso(last),
      nextScanAt: last ? new Date(last.getTime() + DAY).toISOString() : null,
    };
  });
}

// ---------------------------------------------------------------- plan: what applying does

interface Step {
  entityType: string;
  id: number;
  field: string;
  before: unknown;
  after: unknown;
}

const actionOf = (f: CleanupFinding, wanted: CleanupAction | null | undefined) =>
  wanted && f.actions.includes(wanted) ? wanted : f.suggestion;

/** The record edits for one finding and action (archive, status, trunks, priority, vendors). */
async function planOf(c: Db, f: CleanupFinding, action: CleanupAction): Promise<Step[] | string> {
  if (action === "review") return "needs a person: open the records and fix them by hand";
  const [first, ...rest] = f.entityIds;
  const live = async (type: string, ids: number[]) => {
    const t = ENTITY_TABLE[type]!.table;
    const { rows } = await c.query(`SELECT id FROM ${t} WHERE id = ANY($1) AND deleted_at IS NULL`, [ids]);
    return new Set(rows.map((r) => Number(r.id)));
  };
  const archive = (type: string, id: number): Step =>
    type === "route_rule"
      ? { entityType: type, id, field: "archived", before: false, after: true }
      : { entityType: type, id, field: "*", before: { archived: false }, after: null };
  switch (action) {
    case "archive": {
      const ids = f.kind === "rate_table_identical" ? rest : f.kind === "route_rule_shadowed" ? [first!] : [first!];
      const alive = await live(f.entityType, ids);
      if (!ids.every((id) => alive.has(id))) return "a record was already archived";
      return ids.map((id) => archive(f.entityType, id));
    }
    case "deactivate": {
      const t = ENTITY_TABLE[f.entityType]!.table;
      const { rows } = await c.query(`SELECT status, deleted_at FROM ${t} WHERE id = $1`, [first]);
      if (!rows[0] || rows[0].deleted_at) return "the record no longer exists";
      if (rows[0].status === "inactive") return "already inactive";
      return [{ entityType: f.entityType, id: first!, field: "status", before: rows[0].status, after: "inactive" }];
    }
    case "merge": {
      const alive = await live("route_rule", f.entityIds);
      if (!f.entityIds.every((id) => alive.has(id))) return "a rule of the group was already archived";
      const steps: Step[] = [];
      if (f.kind === "route_rule_near_duplicate") {
        const { rows } = await c.query("SELECT id, customer_trunk_ids FROM route_rules WHERE id = ANY($1)", [
          f.entityIds,
        ]);
        const before = ((rows.find((r) => Number(r.id) === first)?.customer_trunk_ids as string[]) ?? []).map(Number);
        const union = [...new Set(rows.flatMap((r) => ((r.customer_trunk_ids as string[]) ?? []).map(Number)))];
        steps.push({ entityType: "route_rule", id: first!, field: "customerTrunkIds", before, after: union });
      }
      return [...steps, ...rest.map((id) => archive("route_rule", id))];
    }
    case "reorder": {
      const b = f.entityIds[1]!;
      const { rows } = await c.query("SELECT priority FROM route_rules WHERE id = $1 AND deleted_at IS NULL", [b]);
      if (!rows[0]) return "the rule no longer exists";
      return [
        {
          entityType: "route_rule",
          id: b,
          field: "priority",
          before: Number(rows[0].priority),
          after: Number(rows[0].priority) - 1,
        },
      ];
    }
    case "reassign": {
      const { rows } = await c.query(
        `SELECT v.level, v.vendor_trunk_id, v.share_pct, v.is_backup, v.warmup_count, v.warmup_reset, v.warmup_per,
                (vt.deleted_at IS NULL AND vt.status = 'active') AS ok
           FROM route_rule_vendors v JOIN vendor_trunks vt ON vt.id = v.vendor_trunk_id WHERE v.route_rule_id = $1 ORDER BY v.id`,
        [first],
      );
      const vendor = (r: Record<string, unknown>) => ({
        level: Number(r.level),
        vendorTrunkId: Number(r.vendor_trunk_id),
        sharePct: r.share_pct == null ? null : Number(r.share_pct),
        isBackup: !!r.is_backup,
        warmupCount: r.warmup_count == null ? null : Number(r.warmup_count),
        warmupReset: (r.warmup_reset as string | null) ?? null,
        warmupPer: (r.warmup_per as string | null) ?? null,
      });
      const after = rows.filter((r) => r.ok).map(vendor);
      if (!after.length) return "no working vendor would be left; deactivate it instead";
      if (after.length === rows.length) return "every vendor works now";
      return [{ entityType: "route_rule", id: first!, field: "vendors", before: rows.map(vendor), after }];
    }
  }
}

/** Writes one step (the same writes undo uses, in the other direction). */
async function applyStep(c: pg.PoolClient, s: Step, userId: number) {
  const t = ENTITY_TABLE[s.entityType]!.table;
  if (s.field === "archived") {
    await c.query("UPDATE route_rules SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1", [s.id, userId]);
  } else if (s.field === "*") {
    await c.query(`UPDATE ${t} SET deleted_at = now() WHERE id = $1`, [s.id]);
  } else if (s.field === "status") {
    await c.query(`UPDATE ${t} SET status = $2, updated_at = now() WHERE id = $1`, [s.id, s.after]);
  } else if (s.field === "customerTrunkIds") {
    await c.query(
      "UPDATE route_rules SET customer_trunk_ids = $2, updated_by_id = $3, updated_at = now() WHERE id = $1",
      [s.id, s.after, userId],
    );
  } else if (s.field === "priority") {
    await c.query("UPDATE route_rules SET priority = $2, updated_by_id = $3, updated_at = now() WHERE id = $1", [
      s.id,
      s.after,
      userId,
    ]);
  } else if (s.field === "vendors") {
    const keep = (s.after as { vendorTrunkId: number }[]).map((v) => v.vendorTrunkId);
    await c.query("DELETE FROM route_rule_vendors WHERE route_rule_id = $1 AND NOT (vendor_trunk_id = ANY($2))", [
      s.id,
      keep,
    ]);
  }
}

// ---------------------------------------------------------------- simulate

/** The route rules as they would be after these steps. */
function rulesAfter(rules: RuleCore[], steps: Step[]): RuleCore[] {
  const out: RuleCore[] = [];
  for (const r of rules) {
    const mine = steps.filter((s) => s.entityType === "route_rule" && s.id === r.id);
    if (mine.some((s) => s.field === "archived" || (s.field === "status" && s.after === "inactive"))) continue;
    let x = r;
    for (const s of mine) {
      if (s.field === "customerTrunkIds") x = { ...x, customerTrunkIds: s.after as number[] };
      if (s.field === "priority") x = { ...x, priority: s.after as number };
      if (s.field === "vendors") {
        const keep = new Set((s.after as { vendorTrunkId: number }[]).map((v) => v.vendorTrunkId));
        x = { ...x, vendors: x.vendors.filter((v) => keep.has(v.vendorTrunkId)) };
      }
    }
    out.push(x);
  }
  return out.sort((a, b) => b.priority - a.priority || a.id - b.id);
}

async function stepsFor(c: Db, sel: CleanupSelection) {
  const steps: Step[] = [];
  const findings: { f: CleanupFinding; steps: Step[] }[] = [];
  const skipped: { id: number; reason: string }[] = [];
  for (const id of sel.findingIds) {
    const f = await loadFinding(c, id);
    if (!f) {
      skipped.push({ id, reason: "not found" });
      continue;
    }
    if (f.state !== "open" && f.state !== "awaiting_approval") {
      skipped.push({ id, reason: `already ${f.state}` });
      continue;
    }
    const plan = await planOf(c, f, actionOf(f, sel.action));
    if (typeof plan === "string") skipped.push({ id, reason: plan });
    else {
      findings.push({ f, steps: plan });
      steps.push(...plan);
    }
  }
  return { steps, findings, skipped };
}

export async function simulate(pool: pg.Pool, steps: Step[]): Promise<CleanupSimulation> {
  if (!steps.some((s) => s.entityType === "route_rule"))
    return {
      samples: 0,
      messages24h: 0,
      changedSamples: 0,
      changedMessages: 0,
      unchanged: true,
      changes: [],
      note: "No route rule changes: routing is not affected.",
    };
  const before = await loadRulesInOrder(pool);
  const after = rulesAfter(before, steps);
  const touched = new Set(steps.map((s) => s.id));
  const sample = await chRows<{ t: number; mccmnc: string; m: number }>(
    `SELECT c_trunk_id AS t, c_mccmnc AS mccmnc, toUInt64(sum(messages)) AS m FROM edr_hourly
      WHERE hour >= (SELECT max(hour) FROM edr_hourly) - INTERVAL 24 HOUR AND c_mccmnc <> '' GROUP BY t, mccmnc
      ORDER BY m DESC LIMIT 300`,
    20_000,
  );
  const listIds = listIdsOf(before);
  const options = new Map<string, Awaited<ReturnType<typeof vendorOptions>>>();
  const names = new Map<number, string>();
  const { rows: tn } = await pool.query(
    "SELECT id, name FROM customer_trunks UNION ALL SELECT -id, name FROM vendor_trunks",
  );
  for (const r of tn) names.set(Number(r.id), r.name);
  // The busiest pairs, plus pairs routed by the rules being changed.
  let changedSamples = 0;
  let changedMessages = 0;
  let total = 0;
  const changes: CleanupSimulation["changes"] = [];
  for (const p of sample ?? []) {
    const m = await messageContext(pool, { customerTrunkId: Number(p.t), receiver: "", mccmnc: p.mccmnc }, listIds);
    if (!options.has(p.mccmnc)) options.set(p.mccmnc, await vendorOptions(pool, m.mccmnc, null));
    const opts = options.get(p.mccmnc)!;
    const a = routeThrough(before, m, opts, 0).decision;
    total += int(p.m);
    if (a && !touched.has(a.ruleId) && !steps.some((s) => s.field === "priority")) continue;
    const b = routeThrough(after, m, opts, 0).decision;
    const va = a?.vendor?.vendorTrunkId ?? null;
    const vb = b?.vendor?.vendorTrunkId ?? null;
    if (va === vb) continue;
    changedSamples++;
    changedMessages += int(p.m);
    if (changes.length < 50)
      changes.push({
        customerTrunk: names.get(Number(p.t)) ?? `#${p.t}`,
        mccmnc: p.mccmnc,
        before: va === null ? null : (names.get(-va) ?? `#${va}`),
        after: vb === null ? null : (names.get(-vb) ?? `#${vb}`),
        messages24h: int(p.m),
      });
  }
  return {
    samples: sample?.length ?? 0,
    messages24h: total,
    changedSamples,
    changedMessages,
    unchanged: changedSamples === 0,
    changes,
    note: sample
      ? `Replayed the ${fmt(sample.length)} busiest client trunk and destination pairs of the last 24 hours (${fmt(total)} messages).`
      : "The EDR store is not reachable: no replay.",
  };
}

export function simulateCleanup(request: FastifyRequest, reply: FastifyReply) {
  const sel = request.body as CleanupSelection;
  return withDb(reply, async (pool) => simulate(pool, (await stepsFor(pool, sel)).steps));
}

// ---------------------------------------------------------------- apply and approve

async function applyNow(
  pool: pg.Pool,
  request: FastifyRequest,
  sel: CleanupSelection,
  approving: boolean,
): Promise<CleanupApplyResult> {
  const me = await getCurrentUser();
  const { steps, findings, skipped } = await stepsFor(pool, sel);
  if (!steps.length) return { applied: 0, awaitingApproval: 0, skipped, change: null };
  const change = await inTransaction(pool, async (c) => {
    for (const s of steps) await applyStep(c, s, me.id);
    const kinds = [...new Set(findings.map((x) => KIND_LABELS[x.f.kind] ?? x.f.kind))];
    const ch = await recordChange(c, {
      entityType: "cleanup",
      entityIds: [...new Set(steps.map((s) => s.id))],
      changeType: "cleanup",
      diff: steps.map(
        (s) =>
          ({
            entity_id: s.id,
            field: s.field,
            before: s.before,
            after: s.after,
            entityType: s.entityType,
          }) as DiffEntry,
      ),
      note:
        sel.note?.trim() ||
        `Cleanup${approving ? " (approved)" : ""}: ${findings.length} finding${findings.length === 1 ? "" : "s"} — ${kinds.join(", ")}`,
      userId: me.id,
      ip: request.ip,
    });
    await c.query(
      `UPDATE cleanup_findings SET state = 'applied', applied_at = now(), applied_by_id = $2, change_id = $3 WHERE id = ANY($1)`,
      [findings.map((x) => x.f.id), me.id, ch?.id ?? null],
    );
    return ch;
  });
  return { applied: findings.length, awaitingApproval: 0, skipped, change };
}

export function applyCleanup(request: FastifyRequest, reply: FastifyReply) {
  const sel = request.body as CleanupSelection;
  return withDb(reply, async (pool) => {
    const settings = await loadSettings(pool);
    const viewer = await currentViewer();
    const admin = viewer?.exemptReason === "Administrator";
    if (settings.requireApproval && !admin) {
      // Waits for an administrator (§13.19 optional approval by a manager).
      const { steps, findings, skipped } = await stepsFor(pool, sel);
      void steps;
      await pool.query(
        `UPDATE cleanup_findings SET state = 'awaiting_approval', requested_action = $2, requested_by_id = $3 WHERE id = ANY($1)`,
        [findings.map((x) => x.f.id), sel.action ?? null, viewer?.userId ?? null],
      );
      return { applied: 0, awaitingApproval: findings.length, skipped, change: null } satisfies CleanupApplyResult;
    }
    return applyNow(pool, request, sel, false);
  });
}

export function approveCleanup(request: FastifyRequest, reply: FastifyReply) {
  const sel = request.body as CleanupSelection;
  return withDb(reply, async (pool) => {
    const viewer = await currentViewer();
    if (viewer?.exemptReason !== "Administrator")
      return sendProblem(reply, 403, "Only administrators approve cleanups");
    const { rows } = await pool.query(
      "SELECT id FROM cleanup_findings WHERE id = ANY($1) AND state = 'awaiting_approval'",
      [sel.findingIds],
    );
    if (!rows.length) return sendProblem(reply, 400, "None of these findings is waiting for approval");
    return applyNow(pool, request, { ...sel, findingIds: rows.map((r) => Number(r.id)) }, true);
  });
}

// ---------------------------------------------------------------- duplicate warning on save (§13.20)

export function checkDuplicate(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as DuplicateCheck;
  return withDb(reply, async (pool): Promise<DuplicateCheckResult | FastifyReply> => {
    const matches: DuplicateCheckResult["matches"] = [];
    if (b.kind === "enterprise") {
      const e = b.enterprise ?? { name: null, vatNumber: null, emails: [] };
      const domains = (e.emails ?? [])
        .map((m) => m.split("@")[1]?.toLowerCase())
        .filter((d): d is string => !!d && !/^(gmail|yahoo|hotmail|outlook|example)\./.test(d));
      const { rows } = await pool.query(
        `SELECT e.id, e.name, e.vat_number,
                (SELECT array_agg(DISTINCT lower(split_part(m, '@', 2))) FROM enterprise_contacts c, unnest(c.emails) m
                  WHERE c.enterprise_id = e.id) AS domains
           FROM enterprises e WHERE e.deleted_at IS NULL AND e.id <> coalesce($1, 0)`,
        [b.excludeId ?? null],
      );
      const name = e.name ? normName(e.name) : "";
      for (const r of rows) {
        const reasons: string[] = [];
        if (name && normName(r.name) === name) reasons.push("same name");
        if (e.vatNumber && r.vat_number && String(r.vat_number).toUpperCase() === e.vatNumber.toUpperCase())
          reasons.push("same VAT number");
        const shared = domains.filter((d) => ((r.domains as string[]) ?? []).includes(d));
        if (shared.length) reasons.push(`same e-mail domain ${shared[0]}`);
        if (reasons.length)
          matches.push({ id: Number(r.id), name: r.name, reason: reasons.join(", "), path: `/enterprises/${r.id}` });
      }
    } else {
      const r = b.routeRule;
      if (!r)
        return sendProblem(reply, 400, "Check the highlighted fields", {
          errors: [{ path: "/routeRule", message: "required" }],
        });
      const rules = await loadRulesInOrder(pool);
      const set = (xs: unknown[]) => JSON.stringify([...xs].map(String).sort());
      const vendors = (vs: { vendorTrunkId: number; level: number }[]) =>
        set(vs.map((v) => `${v.level}:${v.vendorTrunkId}`));
      for (const x of rules) {
        if (x.id === b.excludeId) continue;
        const same =
          x.customerTrunkMode === (r.customerTrunkMode ?? "all") &&
          set(x.customerTrunkIds) === set(r.customerTrunkIds ?? []) &&
          x.mccmncMode === (r.mccmncMode ?? "all") &&
          set(x.mccmncs) === set(r.mccmncs ?? []) &&
          x.categoryMode === (r.categoryMode ?? "all") &&
          set(x.categoryIds) === set(r.categoryIds ?? []) &&
          (x.senderPattern ?? null) === (r.senderPattern ?? null) &&
          (x.receiverPattern ?? null) === (r.receiverPattern ?? null) &&
          JSON.stringify(x.senderValues ?? []) === JSON.stringify(r.senderValues ?? []) &&
          JSON.stringify(x.receiverValues ?? []) === JSON.stringify(r.receiverValues ?? []);
        if (!same) continue;
        const sameVendors =
          x.routeType === (r.routeType ?? "static") && vendors(x.vendors) === vendors(r.vendors ?? []);
        matches.push({
          id: x.id,
          name: x.name,
          reason: sameVendors
            ? "same conditions and vendors"
            : `same conditions (priority ${x.priority}), other vendors`,
          path: `/routing/rules?rule=${x.id}`,
        });
      }
    }
    return { matches: matches.slice(0, 10) };
  });
}

// ---------------------------------------------------------------- nightly scan and weekly summary

export async function sendWeeklySummary(pool: pg.Pool = db(), force = false): Promise<boolean> {
  const s = await pool.query("SELECT last_summary_at, summary_emails FROM cleanup_settings WHERE id = 1");
  const last = s.rows[0]?.last_summary_at ? new Date(s.rows[0].last_summary_at).getTime() : 0;
  if (!force && Date.now() - last < 7 * DAY) return false;
  const { rows } = await pool.query(
    "SELECT kind, count(*)::int AS n FROM cleanup_findings WHERE state = 'open' GROUP BY kind ORDER BY 2 DESC",
  );
  if (!rows.length) return false;
  const lines = rows.map((r) => `${r.n} × ${KIND_LABELS[r.kind] ?? r.kind}`);
  const top = rows.slice(0, 3).map((r) => `${r.n} ${(KIND_LABELS[r.kind] ?? r.kind).toLowerCase()}`);
  await logEmail(pool, {
    type: "cleanup_summary",
    to: s.rows[0].summary_emails ?? [],
    subject: `Cleanup Center: ${top.join(", ")}`,
    body: `Open findings this week:\n${lines.join("\n")}\n\nReview them in Admin › Cleanup center; nothing changes until someone applies them.`,
  });
  await pool.query("UPDATE cleanup_settings SET last_summary_at = now() WHERE id = 1");
  return true;
}

/** The scan once at start (after the other jobs settle) and then nightly; the weekly summary when due. */
export function startCleanupJobs(pool: pg.Pool = db()): () => void {
  const run = () =>
    void runScan(pool)
      .then(() => sendWeeklySummary(pool))
      .catch(() => undefined);
  const first = setTimeout(run, 45_000);
  const timer = setInterval(run, DAY);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
