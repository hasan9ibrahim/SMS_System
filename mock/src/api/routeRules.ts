// Route rules (§6.3, §13.8–13.11, §13.24, §13.27, §15.4): record with every field, clone,
// safe delete, bulk operations, traffic per customer and vendor, rule Test and the Route
// Simulator. Every save is one change with a field-level diff that undo puts back (§13.10).
import { atLimit, loadLcrProfiles, qbrQuality, qualityFor, tpsNow, vendorTiers, type Quality } from "../lcr/data.js";
import type { LcrProfileCore } from "../lcr/rank.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  TranslationTestResult,
  RouteVendorCost,
  RouteVendorCostRequest,
  ArchiveRequest,
  ListQuery,
  RouteBulkRequest,
  RouteDecision,
  RouteRuleDetail,
  RouteRuleInput,
  RouteTestRequest,
  RouteVendor,
  RouteWhitelist,
  TrafficWindow,
  ValueMatch,
} from "@sms/contract";
import { toPlatformSql } from "../currency.js";
import { withDb } from "../db.js";
import { chRows } from "../edr.js";
import { listFields } from "../lists/fields.js";
import { routeRuleList } from "../lists/defs.js";
import { exportRows, runList } from "../lists/engine.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { decide, quickMatch, ROUTABLE_VENDOR_SQL, type MessageContext, type VendorOption } from "../routing/evaluate.js";
import { archiveGate } from "./enterprises.js";
import {
  archivedInfo,
  dependencies,
  diffPaths,
  isAdmin,
  iso,
  recordChange,
  same,
  updateColumns,
  type DiffEntry,
  type FieldError,
  type FieldSpec,
} from "./records.js";
import { qbrDlrByCode } from "./qbr.js";
import { ruleTraffic } from "./routeTraffic.js";
import { skipEgressBlocked } from "./egress.js";
import { customerPrice, priced } from "./linePrice.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";
import { csvText } from "../csvSafe.js";
import { runTrunkTranslation } from "./translationRules.js";
import { withTonNpiMode, type TonNpiMode } from "../routing/tonNpi.js";
import type { CapabilityInput } from "./egress.js";
import { compilePattern } from "../routing/pattern.js";
import { natural, textCoding, type MessageForm } from "../routing/coding.js";

type Db = pg.Pool | pg.PoolClient;
const notFound = (reply: FastifyReply, id: number) => sendProblem(reply, 404, `Route rule ${id} not found`);
const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

// ---------------------------------------------------------------- field map

const SCALARS: FieldSpec[] = [
  { api: "name", col: "name" },
  { api: "priority", col: "priority" },
  { api: "status", col: "status" },
  { api: "startsAt", col: "starts_at" },
  { api: "stopsAt", col: "stops_at" },
  { api: "continueRouting", col: "continue_routing" },
  { api: "matchMode", col: "match_mode" },
  { api: "comment", col: "comment" },
  { api: "categoryMode", col: "category_mode" },
  { api: "categoryIds", col: "category_ids", cast: "::bigint[]" },
  { api: "customerTrunkMode", col: "customer_trunk_mode" },
  { api: "customerTrunkIds", col: "customer_trunk_ids", cast: "::bigint[]" },
  { api: "mccmncMode", col: "mccmnc_mode" },
  { api: "mccmncs", col: "mccmncs", cast: "::text[]" },
  { api: "mccmncPattern", col: "mccmnc_pattern" },
  { api: "senderPattern", col: "sender_pattern" },
  { api: "senderPatternNegate", col: "sender_pattern_negate" },
  { api: "senderMatchCase", col: "sender_match_case" },
  { api: "receiverPattern", col: "receiver_pattern" },
  { api: "receiverPatternNegate", col: "receiver_pattern_negate" },
  { api: "contentPattern", col: "content_pattern" },
  { api: "contentPatternNegate", col: "content_pattern_negate" },
  { api: "senderListId", col: "sender_list_id" },
  { api: "senderListNegate", col: "sender_list_negate" },
  { api: "receiverListId", col: "receiver_list_id" },
  { api: "receiverListNegate", col: "receiver_list_negate" },
  { api: "hlrPorted", col: "hlr_ported" },
  { api: "routeType", col: "route_type" },
  { api: "huntPolicy", col: "hunt_policy" },
  { api: "enableBackupRoutes", col: "enable_backup_routes" },
  { api: "percentagePerCustomerTrunk", col: "percentage_per_customer_trunk" },
  { api: "vendorCategoryMode", col: "vendor_category_mode" },
  { api: "vendorCategoryIds", col: "vendor_category_ids", cast: "::bigint[]" },
  { api: "vendorTrunkMode", col: "vendor_trunk_mode" },
  { api: "vendorTrunkIds", col: "vendor_trunk_ids", cast: "::bigint[]" },
  { api: "maxRouteLevel", col: "max_route_level" },
  { api: "margin", col: "margin" },
  { api: "marginType", col: "margin_type" },
  { api: "qbrFormula", col: "qbr_formula" },
  { api: "skipVendorAtTpsPct", col: "skip_vendor_at_tps_pct" },
  { api: "lcrProfileId", col: "lcr_profile_id" },
  { api: "dlrTargetPct", col: "dlr_target_pct" },
  { api: "denyMultipart", col: "deny_multipart" },
  { api: "threshold", col: "threshold" },
  { api: "thresholdInterval", col: "threshold_interval" },
];
/** jsonb conditions: API keys are camelCase, stored keys snake_case (§13.8, §13.9, §13.24). */
const JSONS: FieldSpec[] = [
  { api: "tps", col: "tps_condition", cast: "::jsonb" },
  { api: "revenue", col: "revenue_condition", cast: "::jsonb" },
  { api: "hlrAction", col: "hlr_action", cast: "::jsonb" },
  { api: "qbrWeights", col: "qbr_weights", cast: "::jsonb" },
  // Value rows keep their camelCase keys (arrays are stored as given, team trial round 8).
  { api: "senderValues", col: "sender_values", cast: "::jsonb" },
  { api: "receiverValues", col: "receiver_values", cast: "::jsonb" },
];
const ARRAY_FIELDS = new Set(["categoryIds", "customerTrunkIds", "vendorCategoryIds", "vendorTrunkIds"]);
const FIELD_PATHS = [...SCALARS, ...JSONS].map((s) => s.api).concat(["vendors", "whitelists"]);

const keysTo = (o: unknown, f: (k: string) => string): unknown =>
  o && typeof o === "object" && !Array.isArray(o)
    ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [f(k), v]))
    : o;
const toSnake = (o: unknown) => keysTo(o, (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
const toCamel = (o: unknown) => keysTo(o, (k) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()));

/** API value -> parameter for its column. */
function dbValue(api: string, v: unknown): unknown {
  if (JSONS.some((s) => s.api === api)) return v === null || v === undefined ? null : JSON.stringify(toSnake(v));
  return v;
}

// ---------------------------------------------------------------- loading

const ruleSelect = `SELECT r.*, du.username AS deleted_by, cb.username AS created_by, ub.username AS updated_by
  FROM route_rules r
  LEFT JOIN users du ON du.id = r.deleted_by_id
  LEFT JOIN users cb ON cb.id = r.created_by_id
  LEFT JOIN users ub ON ub.id = r.updated_by_id`;

export type RuleCore = Omit<
  RouteRuleDetail,
  "labels" | "archived" | "createdBy" | "createdAt" | "updatedBy" | "updatedAt"
> & {
  id: number;
  /** Loaded for evaluation only (§13.23); not part of the record. */
  lcrProfile?: LcrProfileCore | null;
};

function rowToRule(r: Record<string, unknown>, vendors: RouteVendor[], whitelists: RouteWhitelist[]): RuleCore {
  const out: Record<string, unknown> = { id: r.id };
  for (const s of SCALARS) {
    const v = r[s.col];
    out[s.api] =
      v instanceof Date
        ? v.toISOString()
        : ARRAY_FIELDS.has(s.api)
          ? ((v as unknown[]) ?? []).map(Number)
          : (v ?? null);
  }
  out.mccmncs = (r.mccmncs as string[]) ?? [];
  for (const s of JSONS) {
    const v = r[s.col] as Record<string, unknown> | null;
    out[s.api] = v ? toCamel(v) : null;
  }
  const hlr = out.hlrAction as { customerTrunkIds?: unknown[] } | null;
  if (hlr) hlr.customerTrunkIds = (hlr.customerTrunkIds ?? []).map(Number);
  out.margin = Number(r.margin);
  out.dlrTargetPct = r.dlr_target_pct == null ? null : Number(r.dlr_target_pct);
  out.vendors = vendors;
  out.whitelists = whitelists;
  return out as RuleCore;
}

async function vendorsOf(db: Db, ids: number[]) {
  const [v, w] = await Promise.all([
    db.query(
      `SELECT route_rule_id, level, vendor_trunk_id, share_pct, is_backup, warmup_count, warmup_reset, warmup_per,
              warmup_reset_hours, backup_for_vendor_trunk_id
         FROM route_rule_vendors WHERE route_rule_id = ANY($1) ORDER BY route_rule_id, level, is_backup, share_pct DESC NULLS LAST, id`,
      [ids],
    ),
    db.query(
      "SELECT route_rule_id, vendor_trunk_id, number_list_id, numbers FROM route_rule_whitelists WHERE route_rule_id = ANY($1) ORDER BY id",
      [ids],
    ),
  ]);
  const vendors = new Map<number, RouteVendor[]>();
  const whitelists = new Map<number, RouteWhitelist[]>();
  for (const r of v.rows) {
    const list = vendors.get(r.route_rule_id) ?? [];
    list.push({
      level: r.level,
      vendorTrunkId: r.vendor_trunk_id,
      sharePct: r.share_pct ?? null,
      isBackup: r.is_backup,
      // Only when set, so rules without one compare equal to inputs that leave it out.
      ...(r.backup_for_vendor_trunk_id === null
        ? {}
        : { backupForVendorTrunkId: Number(r.backup_for_vendor_trunk_id) }),
      warmupCount: r.warmup_count ?? null,
      warmupReset: r.warmup_reset ?? null,
      // Custom reset period in hours (team trial round 2), only with warmupReset custom.
      ...(r.warmup_reset === "custom" ? { warmupResetHours: r.warmup_reset_hours ?? null } : {}),
      warmupPer: r.warmup_per ?? null,
    });
    vendors.set(r.route_rule_id, list);
  }
  for (const r of w.rows) {
    const list = whitelists.get(r.route_rule_id) ?? [];
    list.push({ vendorTrunkId: r.vendor_trunk_id, numberListId: r.number_list_id ?? null, numbers: r.numbers ?? [] });
    whitelists.set(r.route_rule_id, list);
  }
  return { vendors, whitelists };
}

async function labels(db: Db, rule: RuleCore): Promise<RouteRuleDetail["labels"]> {
  const vendorIds = [
    ...rule.vendors.map((v) => v.vendorTrunkId),
    ...rule.whitelists.map((w) => w.vendorTrunkId),
    ...rule.vendorTrunkIds,
  ];
  const trunkIds = [...rule.customerTrunkIds, ...(rule.hlrAction?.customerTrunkIds ?? [])];
  const listIds = [rule.senderListId, rule.receiverListId, ...rule.whitelists.map((w) => w.numberListId)].filter(
    (x): x is number => typeof x === "number",
  );
  const q = (sql: string, ids: number[]) =>
    ids.length
      ? db.query(sql, [ids]).then((r) => r.rows.map((x) => ({ id: Number(x.id), name: x.name as string })))
      : [];
  const policyIds = rule.hlrAction ? [rule.hlrAction.policyId] : [];
  const [customerTrunks, categories, vendorTrunks, numberLists, hlrPolicies] = await Promise.all([
    q("SELECT id, name FROM customer_trunks WHERE id = ANY($1)", trunkIds),
    q("SELECT id, name FROM product_categories WHERE id = ANY($1)", [...rule.categoryIds, ...rule.vendorCategoryIds]),
    q("SELECT id, name FROM vendor_trunks WHERE id = ANY($1)", vendorIds),
    q("SELECT id, name FROM number_lists WHERE id = ANY($1)", listIds),
    q("SELECT id, name FROM hlr_policies WHERE id = ANY($1)", policyIds),
  ]);
  return { customerTrunks, categories, vendorTrunks, numberLists, hlrPolicies };
}

/** `resets: false` leaves out the warm-up Reset times, for comparing with an input (they are never a change). */
export async function loadRule(db: Db, id: number, { resets = true } = {}): Promise<RouteRuleDetail | null> {
  const { rows } = await db.query(`${ruleSelect} WHERE r.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  const { vendors, whitelists } = await vendorsOf(db, [id]);
  const core = rowToRule(r, vendors.get(id) ?? [], whitelists.get(id) ?? []);
  // When Reset last restarted each vendor's warm-up count (team trial round 6); not part of the rule's own fields,
  // so it never shows as a change.
  const resetAt = new Map<number, string>(
    !resets
      ? []
      : (
          await db.query(
            "SELECT vendor_trunk_id, warmup_reset_at FROM route_rule_vendors WHERE route_rule_id = $1 AND warmup_reset_at IS NOT NULL",
            [id],
          )
        ).rows.map((x) => [Number(x.vendor_trunk_id), iso(x.warmup_reset_at)!]),
  );
  return {
    ...core,
    vendors: !resets
      ? core.vendors
      : core.vendors.map((v) => (v.warmupCount ? { ...v, warmupResetAt: resetAt.get(v.vendorTrunkId) ?? null } : v)),
    labels: await labels(db, core),
    archived: archivedInfo(r.deleted_at, r.deleted_by),
    createdBy: r.created_by ?? null,
    createdAt: iso(r.inserted_at),
    updatedBy: r.updated_by ?? "system",
    updatedAt: iso(r.updated_at)!,
  };
}

// ---------------------------------------------------------------- input

/** New rules start at 97; priorities 98–100 are kept for administrators (team trial round 1). */
const DEFAULT_PRIORITY = 97;
const ADMIN_PRIORITY = 98;
const adminOnly = (priority: number): FieldError => ({
  path: "/priority",
  message: `Priorities ${ADMIN_PRIORITY}–100 can only be set by an administrator (got ${priority})`,
});

/** A full record from a (possibly partial) input: defaults for a new rule, the old values on edit. */
function complete(input: RouteRuleInput, base: RuleCore | null): RuleCore {
  const now = Date.now();
  const defaults: Omit<RuleCore, "id"> = {
    name: "",
    priority: DEFAULT_PRIORITY,
    status: "active",
    startsAt: new Date(now).toISOString(),
    stopsAt: new Date(now + 10 * 365 * 86_400_000).toISOString(),
    continueRouting: "stop",
    matchMode: "all",
    comment: null,
    categoryMode: "all",
    categoryIds: [],
    customerTrunkMode: "all",
    customerTrunkIds: [],
    mccmncMode: "all",
    mccmncs: [],
    mccmncPattern: null,
    senderPattern: null,
    senderPatternNegate: false,
    senderMatchCase: true,
    receiverPattern: null,
    receiverPatternNegate: false,
    senderValues: [],
    receiverValues: [],
    contentPattern: null,
    contentPatternNegate: false,
    senderListId: null,
    senderListNegate: false,
    receiverListId: null,
    receiverListNegate: false,
    tps: null,
    revenue: null,
    hlrPorted: null,
    routeType: "static",
    huntPolicy: "top_down",
    enableBackupRoutes: false,
    percentagePerCustomerTrunk: true,
    marginType: "amount",
    vendorCategoryMode: "all",
    vendorCategoryIds: [],
    vendorTrunkMode: "all",
    vendorTrunkIds: [],
    maxRouteLevel: 1,
    margin: 0,
    dlrTargetPct: null,
    qbrFormula: null,
    skipVendorAtTpsPct: null,
    lcrProfileId: null,
    hlrAction: null,
    denyMultipart: false,
    threshold: null,
    thresholdInterval: null,
    vendors: [],
    whitelists: [],
  };
  const out = { ...defaults, ...(base ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(input))
    if (v !== undefined) out[k] = typeof v === "string" && k !== "name" && v.trim() === "" ? null : v;
  out.name = String(out.name).trim();
  out.mccmncs = [...new Set(out.mccmncs as string[])];
  // Value rows (team trial round 8): trimmed, blank rows dropped.
  for (const k of ["senderValues", "receiverValues"])
    out[k] = ((out[k] as ValueMatch[]) ?? [])
      .map((r) => ({ value: r.value.trim(), match: r.match, matchCase: r.matchCase }))
      .filter((r) => r.value !== "");
  // Vendors keep a stable order so an unchanged list never shows as a change.
  out.vendors = [...(out.vendors as RouteVendor[])]
    .map((v) => ({
      level: v.level,
      vendorTrunkId: v.vendorTrunkId,
      sharePct: v.sharePct ?? null,
      isBackup: v.isBackup ?? false,
      // The vendor a backup stands in for (team trial round 1); it was lost on save until team trial round 6.
      ...(v.isBackup && v.backupForVendorTrunkId ? { backupForVendorTrunkId: v.backupForVendorTrunkId } : {}),
      warmupCount: v.warmupCount ?? null,
      warmupReset: v.warmupCount ? (v.warmupReset ?? "day") : null,
      ...(v.warmupCount && v.warmupReset === "custom" ? { warmupResetHours: v.warmupResetHours ?? null } : {}),
      warmupPer: v.warmupCount ? (v.warmupPer ?? "customer_trunk") : null,
    }))
    .sort(
      (a, b) => a.level - b.level || Number(a.isBackup) - Number(b.isBackup) || (b.sharePct ?? 0) - (a.sharePct ?? 0),
    );
  // A percentage split: the vendor alone on its level takes 100 % (team trial round 12; its share is not asked).
  if (out.huntPolicy === "percentage") {
    const vs = out.vendors as RouteVendor[];
    out.vendors = vs.map((v) =>
      !v.isBackup && vs.filter((x) => !x.isBackup && x.level === v.level).length === 1 ? { ...v, sharePct: 100 } : v,
    );
  }
  out.whitelists = (out.whitelists as RouteWhitelist[]).map((w) => ({
    vendorTrunkId: w.vendorTrunkId,
    numberListId: w.numberListId ?? null,
    numbers: [...new Set(w.numbers)],
  }));
  return out as RuleCore;
}

/** Valid for the switch too (PCRE; routing/pattern.ts). */
const regexOk = (p: string | null) => !p || compilePattern(p) !== null;

async function checkRule(db: Db, r: RuleCore): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  if (!r.name) errors.push({ path: "/name", message: "required" });
  if (Date.parse(r.stopsAt) <= Date.parse(r.startsAt))
    errors.push({ path: "/stopsAt", message: "must be after the start time" });
  const w = r.qbrWeights;
  if (w && w.asr + w.dlr + w.delay + w.cost !== 100)
    errors.push({ path: "/qbrWeights", message: "the four weights must add up to 100 %" });
  for (const [path, p] of [
    ["mccmncPattern", r.mccmncPattern],
    ["senderPattern", r.senderPattern],
    ["receiverPattern", r.receiverPattern],
    ["contentPattern", r.contentPattern],
  ] as const)
    if (!regexOk(p)) errors.push({ path: `/${path}`, message: "invalid regular expression" });
  const exists = async (table: string, ids: number[], path: string, label: string) => {
    if (!ids.length) return;
    const { rows } = await db.query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [ids]);
    const ok = new Set(rows.map((x) => Number(x.id)));
    const missing = ids.filter((x) => !ok.has(x));
    if (missing.length) errors.push({ path, message: `unknown ${label}: ${missing.join(", ")}` });
  };
  await Promise.all([
    exists("customer_trunks", r.customerTrunkIds, "/customerTrunkIds", "customer trunk"),
    exists("product_categories", [...r.categoryIds, ...r.vendorCategoryIds], "/categoryIds", "category"),
    exists(
      "vendor_trunks",
      [...new Set([...r.vendors.map((v) => v.vendorTrunkId), ...r.vendorTrunkIds])],
      "/vendors",
      "vendor trunk",
    ),
    exists(
      "number_lists",
      [r.senderListId, r.receiverListId, ...r.whitelists.map((w) => w.numberListId)].filter((x): x is number => !!x),
      "/senderListId",
      "number list",
    ),
  ]);
  // HLR action (§13.24): a live policy, and trunks that are among the rule's customer trunks.
  if (r.hlrAction) {
    const { rows } = await db.query("SELECT status FROM hlr_policies WHERE id = $1 AND deleted_at IS NULL", [
      r.hlrAction.policyId,
    ]);
    if (!rows[0]) errors.push({ path: "/hlrAction/policyId", message: "unknown or deleted HLR policy" });
    await exists("customer_trunks", r.hlrAction.customerTrunkIds, "/hlrAction/customerTrunkIds", "customer trunk");
  }
  if (r.mccmncs.length) {
    const { rows } = await db.query("SELECT mccmnc FROM mccmnc WHERE mccmnc = ANY($1) AND deleted_at IS NULL", [
      r.mccmncs,
    ]);
    const ok = new Set(rows.map((x) => x.mccmnc));
    const missing = r.mccmncs.filter((c) => !ok.has(c));
    if (missing.length) errors.push({ path: "/mccmncs", message: `not in the MCCMNC master: ${missing.join(", ")}` });
  }
  if (r.mccmncMode !== "all" && !r.mccmncs.length && !r.mccmncPattern)
    errors.push({ path: "/mccmncs", message: "pick destinations or set the mode to all" });
  if (r.customerTrunkMode !== "all" && !r.customerTrunkIds.length)
    errors.push({ path: "/customerTrunkIds", message: "pick trunks or set the mode to all" });
  if (r.categoryMode !== "all" && !r.categoryIds.length)
    errors.push({ path: "/categoryIds", message: "pick categories or set the mode to all" });
  if (r.tps?.op === "between" && !(r.tps.value2 !== null && r.tps.value2 !== undefined && r.tps.value2 > r.tps.value))
    errors.push({ path: "/tps/value2", message: "between needs an upper value above the lower one" });
  if (r.revenue?.op === "between" && !(r.revenue.value2 != null && r.revenue.value2 > r.revenue.value))
    errors.push({ path: "/revenue/value2", message: "between needs an upper value above the lower one" });
  if (r.revenue?.type === "accumulated" && (!r.revenue.scope || !r.revenue.period))
    errors.push({ path: "/revenue", message: "accumulated revenue needs a scope and a period" });
  if ((r.threshold === null) !== (r.thresholdInterval === null))
    errors.push({ path: "/thresholdInterval", message: "set both the threshold and its interval, or neither" });
  // A draft may be saved without vendors; it cannot be on without them.
  if (r.routeType === "static" && r.status === "active" && !r.vendors.some((v) => !v.isBackup))
    errors.push({ path: "/vendors", message: "an active static route needs at least one vendor" });
  r.vendors.forEach((v, i) => {
    if (v.level > r.maxRouteLevel)
      errors.push({ path: `/vendors/${i}/level`, message: `above the max route level ${r.maxRouteLevel}` });
    if (v.warmupCount && v.warmupReset === "custom" && !v.warmupResetHours)
      errors.push({ path: `/vendors/${i}/warmupResetHours`, message: "give the reset period in hours" });
  });
  if (r.huntPolicy === "percentage" && r.routeType !== "dynamic") {
    const levels = new Map<number, number>();
    for (const v of r.vendors) if (!v.isBackup) levels.set(v.level, (levels.get(v.level) ?? 0) + (v.sharePct ?? 0));
    for (const [level, total] of levels)
      if (total !== 100)
        errors.push({ path: "/vendors", message: `shares on level ${level} add up to ${total}%, not 100%` });
  }
  if (r.lcrProfileId !== null && r.lcrProfileId !== undefined) {
    if (r.routeType !== "dynamic")
      errors.push({ path: "/lcrProfileId", message: "an LCR profile is for Least cost rules only" });
    const { rows } = await db.query("SELECT 1 FROM lcr_profiles WHERE id = $1 AND deleted_at IS NULL", [
      r.lcrProfileId,
    ]);
    if (!rows[0]) errors.push({ path: "/lcrProfileId", message: "unknown or deleted LCR profile" });
  }
  const vendorIds = new Set(r.vendors.map((v) => v.vendorTrunkId));
  r.whitelists.forEach((w, i) => {
    if (!vendorIds.has(w.vendorTrunkId) && r.routeType !== "dynamic")
      errors.push({ path: `/whitelists/${i}/vendorTrunkId`, message: "pin the numbers to one of the rule's vendors" });
    if (!w.numbers.length && !w.numberListId)
      errors.push({ path: `/whitelists/${i}/numbers`, message: "add numbers or a number list" });
  });
  return errors;
}

// ---------------------------------------------------------------- writing (and undo)

async function writeVendors(c: pg.PoolClient, id: number, vendors: RouteVendor[]) {
  // A save or undo never restarts a warm-up count (team trial round 6): each vendor keeps its last Reset time.
  const resets = new Map<number, Date>(
    (
      await c.query(
        "SELECT vendor_trunk_id, max(warmup_reset_at) AS at FROM route_rule_vendors WHERE route_rule_id = $1 GROUP BY 1",
        [id],
      )
    ).rows.map((x) => [Number(x.vendor_trunk_id), x.at]),
  );
  await c.query("DELETE FROM route_rule_vendors WHERE route_rule_id = $1", [id]);
  // The rule's own row changes too, so every screen that caches the rules by their last change sees it (an undo of
  // a vendor change showed the old vendors on Rate lookup and Route map; team trial round 12).
  await c.query("UPDATE route_rules SET updated_at = now() WHERE id = $1", [id]);
  for (const v of vendors)
    await c.query(
      `INSERT INTO route_rule_vendors (route_rule_id, level, vendor_trunk_id, share_pct, is_backup, warmup_count, warmup_reset, warmup_per,
                                       backup_for_vendor_trunk_id, warmup_reset_hours, warmup_reset_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        v.level,
        v.vendorTrunkId,
        v.sharePct ?? null,
        v.isBackup ?? false,
        v.warmupCount ?? null,
        v.warmupReset ?? null,
        v.warmupPer ?? null,
        v.isBackup ? (v.backupForVendorTrunkId ?? null) : null,
        v.warmupReset === "custom" ? (v.warmupResetHours ?? null) : null,
        resets.get(v.vendorTrunkId) ?? null,
      ],
    );
}

async function writeWhitelists(c: pg.PoolClient, id: number, lists: RouteWhitelist[]) {
  await c.query("DELETE FROM route_rule_whitelists WHERE route_rule_id = $1", [id]);
  await c.query("UPDATE route_rules SET updated_at = now() WHERE id = $1", [id]);
  for (const w of lists)
    await c.query(
      "INSERT INTO route_rule_whitelists (route_rule_id, vendor_trunk_id, number_list_id, numbers) VALUES ($1, $2, $3, $4)",
      [id, w.vendorTrunkId, w.numberListId ?? null, w.numbers],
    );
}

/** Sets one recorded field (save and undo, §13.10). Older history-only fields are skipped. */
export async function applyRouteRuleField(c: pg.PoolClient, id: number, field: string, value: unknown, userId: number) {
  const spec = [...SCALARS, ...JSONS].find((s) => s.api === field);
  if (spec) return updateColumns(c, "route_rules", id, [spec], { [field]: dbValue(field, value) }, userId);
  if (field === "vendors") return writeVendors(c, id, (value as RouteVendor[]) ?? []);
  if (field === "whitelists") return writeWhitelists(c, id, (value as RouteWhitelist[]) ?? []);
  if (field === "archived")
    await c.query(
      `UPDATE route_rules SET deleted_at = ${value ? "now()" : "NULL"}, deleted_by_id = ${value ? "$2" : "NULL"} WHERE id = $1`,
      value ? [id, userId] : [id],
    );
}

async function insertRule(c: pg.PoolClient, r: RuleCore, userId: number): Promise<number> {
  const specs = [...SCALARS, ...JSONS];
  const cols = specs.map((s) => s.col);
  const values = specs.map((s) => dbValue(s.api, (r as unknown as Record<string, unknown>)[s.api]));
  const ph = specs.map((s, i) => `$${i + 1}${s.cast ?? ""}`);
  const { rows } = await c.query(
    `INSERT INTO route_rules (${cols.join(", ")}, created_by_id, updated_by_id)
     VALUES (${ph.join(", ")}, $${specs.length + 1}, $${specs.length + 1}) RETURNING id`,
    [...values, userId],
  );
  const id = rows[0].id as number;
  await writeVendors(c, id, r.vendors);
  await writeWhitelists(c, id, r.whitelists);
  return id;
}

// ---------------------------------------------------------------- handlers: list and record

export function queryRouteRules(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.route_rules);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, async (pool) => {
    try {
      return await runList(pool, routeRuleList, query);
    } catch (err) {
      if ((err as { code?: string }).code === "2201B")
        return sendProblem(reply, 400, "Invalid list query", {
          errors: [{ path: "/filter", message: "invalid regular expression" }],
        });
      throw err;
    }
  });
}

const csvCell = (v: unknown) => {
  const s = csvText(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function exportRouteRules(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.route_rules);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, async (pool) => {
    // As the viewer sees the list: masked trunk and vendor names, withheld margins (§13.17, security audit).
    const rows = (await exportRows(pool, routeRuleList, {
      ...query,
      limit: 100_000,
      cursor: null,
    } as ListQuery)) as unknown as Record<string, unknown>[];
    const cols: [string, string][] = [
      ["ID", "id"],
      ["Rule", "name"],
      ["Priority", "priority"],
      ["Type", "routeType"],
      ["Category", "categoryLabel"],
      ["Customer trunks", "customerTrunksLabel"],
      ["Destination", "destinationLabel"],
      ["Vendors", "vendorsLabel"],
      ["Messages", "messages"],
      ["ASR %", "asr"],
      ["DLR %", "dlr"],
      ["Margin", "margin"],
      ["Status", "status"],
      ["Start (UTC)", "startsAt"],
      ["Stop (UTC)", "stopsAt"],
    ];
    const lines = rows.map((row) => cols.map(([, k]) => csvCell(row[k])).join(","));
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="route_rules.csv"')
      .send([cols.map(([h]) => h).join(","), ...lines].join("\r\n") + "\r\n");
  });
}

export function getRouteRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => (await loadRule(pool, id)) ?? notFound(reply, id));
}

export function createRouteRule(request: FastifyRequest, reply: FastifyReply) {
  const { draft, ...input } = request.body as RouteRuleInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const rule = complete(input, null);
    const errors = await checkRule(pool, rule);
    if (rule.priority >= ADMIN_PRIORITY && !isAdmin(me)) errors.push(adminOnly(rule.priority));
    if (errors.length) return badInput(reply, errors);
    const { id, change } = await inTransaction(pool, async (c) => {
      const id = await insertRule(c, rule, me.id);
      // The New rule window's rule: a draft until its Save (§6.3, §13.10; jobs/routeRuleDrafts.ts sweeps those left).
      if (draft) await c.query("UPDATE route_rules SET draft = true WHERE id = $1", [id]);
      const change = await recordChange(c, {
        entityType: "route_rule",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: rule.name }],
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadRule(pool, id), change });
  });
}

export function updateRouteRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const { draft, ...input } = request.body as RouteRuleInput;
  // The New rule window's Save keeps its draft (§6.3, §13.10), also when no field changed; a kept rule stays kept.
  const keep = (c: Db) =>
    draft === false ? c.query("UPDATE route_rules SET draft = false WHERE id = $1 AND draft", [id]) : null;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const before = await loadRule(pool, id, { resets: false });
    if (!before) return notFound(reply, id);
    if (before.archived) return sendProblem(reply, 400, "This rule is archived; restore it before editing");
    const after = complete(input, before);
    const errors = await checkRule(pool, after);
    if (after.priority !== before.priority && after.priority >= ADMIN_PRIORITY && !isAdmin(me))
      errors.push(adminOnly(after.priority));
    if (errors.length) return badInput(reply, errors);
    const diff = diffPaths(id, before, after, FIELD_PATHS);
    if (diff.length === 0) {
      await keep(pool);
      return { record: before, change: null };
    }
    const change = await inTransaction(pool, async (c) => {
      await keep(c);
      for (const d of diff) await applyRouteRuleField(c, id, d.field, d.after, me.id);
      await c.query("UPDATE route_rules SET updated_by_id = $2, updated_at = now() WHERE id = $1", [id, me.id]);
      const onlyStatus = diff.length === 1 && diff[0]!.field === "status";
      return recordChange(c, {
        entityType: "route_rule",
        entityIds: [id],
        changeType: onlyStatus ? (diff[0]!.after === "active" ? "enable" : "disable") : "edit",
        diff,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadRule(pool, id), change };
  });
}

export function cloneRouteRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const src = await loadRule(pool, id);
    if (!src) return notFound(reply, id);
    const copy: RuleCore = {
      ...src,
      name: `${src.name} (copy)`.slice(0, 120),
      status: "inactive",
      // A copy made by someone who is not an administrator stays below the reserved priorities.
      priority: isAdmin(me) ? src.priority : Math.min(src.priority, DEFAULT_PRIORITY),
    };
    const { newId, change } = await inTransaction(pool, async (c) => {
      const newId = await insertRule(c, copy, me.id);
      const change = await recordChange(c, {
        entityType: "route_rule",
        entityIds: [newId],
        changeType: "clone",
        diff: [{ entity_id: newId, field: "*", before: null, after: copy.name }],
        note: `Copy of #${id}`,
        userId: me.id,
        ip: request.ip,
      });
      return { newId, change };
    });
    return reply.code(201).send({ record: await loadRule(pool, newId), change });
  });
}

// ---------------------------------------------------------------- safe delete (§13.29)

export async function ruleDependencies(db: Db, id: number) {
  const traffic = await chRows<{ n: string }>(
    `SELECT count() AS n FROM edr WHERE route_rule_id = ${Number(id)} AND submit_time > now() - INTERVAL 30 DAY`,
  );
  return dependencies([
    {
      key: "traffic_30d",
      label: "Traffic in the last 30 days",
      count: traffic ? Number(traffic[0]?.n ?? 0) : null,
      blocking: false,
      detail: "Stays in reports with the rule's name",
    },
    {
      key: "history",
      label: "Change history",
      count: null,
      blocking: false,
      detail: "Kept; undo brings the rule back",
    },
  ]);
}

export function getRouteRuleDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM route_rules WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    return ruleDependencies(pool, id);
  });
}

export function archiveRouteRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const body = (request.body ?? {}) as ArchiveRequest;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const before = await loadRule(pool, id, { resets: false });
    if (!before) return notFound(reply, id);
    if (before.archived) return { record: before, change: null };
    const gate = await archiveGate(reply, body, await ruleDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const change = await inTransaction(pool, async (c) => {
      await applyRouteRuleField(c, id, "archived", true, me.id);
      return recordChange(c, {
        entityType: "route_rule",
        entityIds: [id],
        changeType: "delete",
        diff: [{ entity_id: id, field: "archived", before: false, after: true }],
        note: gate.note,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadRule(pool, id), change };
  });
}

/**
 * Whether rule `id` (a qualified SQL expression, e.g. `r.id`: inside, a bare `id` would be the change's) was ever
 * turned on: an enable, or the status set to active, in its change history. Such a rule is never discarded, by its
 * author or by the draft sweep (jobs/routeRuleDrafts.ts).
 */
export const everTurnedOnSql = (id: string) =>
  `EXISTS (SELECT 1 FROM changes WHERE entity_type = 'route_rule' AND entity_ids && ARRAY[${id}]::bigint[]
             AND (change_type = 'enable' OR diff @> '[{"field": "status", "after": "active"}]'::jsonb))`;

/**
 * Attempts the rules ever carried, by rule id: the long-term totals outlive the detailed EDRs (docs/BACKEND_PLAN.md
 * §3.7). Null when the EDR store does not answer.
 */
export async function ruleAttempts(ids: number[]): Promise<Map<number, number> | null> {
  if (!ids.length) return new Map();
  const rows = await chRows<{ id: string; n: string }>(
    `SELECT route_rule_id AS id, sum(rows) AS n FROM edr_totals
      WHERE route_rule_id IN (${ids.map(Number).join(",")}) AND kind = 'attempt' GROUP BY route_rule_id`,
  );
  return rows && new Map(rows.map((r) => [Number(r.id), Number(r.n)]));
}

/**
 * Removes a rule as if it was never added (§6.3, §13.10): its vendors, whitelists, traffic rows and change history,
 * then the rule. A discarded draft leaves no history (discard, the draft sweep).
 */
export async function removeNeverAdded(c: pg.PoolClient, id: number) {
  for (const t of ["route_rule_vendors", "route_rule_whitelists", "route_rule_traffic"])
    await c.query(`DELETE FROM ${t} WHERE route_rule_id = $1`, [id]);
  await c.query("DELETE FROM changes WHERE entity_type = 'route_rule' AND entity_ids = ARRAY[$1]::bigint[]", [id]);
  await c.query("DELETE FROM route_rules WHERE id = $1", [id]);
}

/**
 * Discards a draft from New rule (team trial round 3): the rule, its vendors, whitelists, traffic rows and change
 * history go, as if it was never added. Only its author, within 24 hours, never turned on, no traffic.
 */
export function discardRouteRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `SELECT r.created_by_id, r.status, r.inserted_at > now() - interval '24 hours' AS recent,
              ${everTurnedOnSql("r.id")} AS on
         FROM route_rules r WHERE r.id = $1`,
      [id],
    );
    if (!rows[0]) return notFound(reply, id);
    const traffic = await ruleAttempts([Number(id)]);
    if (
      Number(rows[0].created_by_id) !== me.id ||
      !rows[0].recent ||
      rows[0].on ||
      rows[0].status === "active" ||
      (traffic?.get(Number(id)) ?? 0) > 0
    )
      return sendProblem(
        reply,
        409,
        "Only a new rule you added today that was never turned on can be discarded; use Delete",
      );
    await inTransaction(pool, (c) => removeNeverAdded(c, id));
    return reply.code(204).send();
  });
}

export function restoreRouteRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!isAdmin(me)) return sendProblem(reply, 403, "Only administrators can restore archived records");
    const { rows } = await pool.query("SELECT deleted_at FROM route_rules WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    if (!rows[0].deleted_at) return sendProblem(reply, 400, "This rule is not archived");
    const change = await inTransaction(pool, async (c) => {
      await applyRouteRuleField(c, id, "archived", false, me.id);
      return recordChange(c, {
        entityType: "route_rule",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "archived", before: true, after: false }],
        note: "Restored",
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadRule(pool, id), change };
  });
}

/**
 * Reset (team trial round 6, §13.27): one vendor's warm-up count starts again from 0 now. The switch keys each count
 * by its period and this time (`Sms.Switch.Pipeline.Warmup`), so only this or the period restarts it, never a save.
 * Not a change of the rule, so nothing to undo; the audit trail logs the call.
 */
export function resetRouteRuleWarmup(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const { vendorTrunkId } = request.body as { vendorTrunkId: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT deleted_at FROM route_rules WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    if (rows[0].deleted_at) return sendProblem(reply, 400, "Restore the rule first");
    const { rowCount } = await pool.query(
      `UPDATE route_rule_vendors SET warmup_reset_at = now()
        WHERE route_rule_id = $1 AND vendor_trunk_id = $2 AND warmup_count > 0`,
      [id, vendorTrunkId],
    );
    if (!rowCount)
      return sendProblem(reply, 400, "Invalid warm-up reset", {
        errors: [{ path: "/vendorTrunkId", message: "this vendor of the rule has no warm-up threshold" }],
      });
    return { record: await loadRule(pool, id), change: null };
  });
}

// ---------------------------------------------------------------- bulk (§6.3, §13.11)

export function bulkRouteRules(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as RouteBulkRequest;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const errors: FieldError[] = [];
    if (body.action === "set_priority" && body.priority === undefined)
      errors.push({ path: "/priority", message: "required" });
    if (body.action === "shift_priority" && !body.shift) errors.push({ path: "/shift", message: "required" });
    if (body.action === "set_priority" && (body.priority ?? 0) >= ADMIN_PRIORITY && !isAdmin(me))
      errors.push(adminOnly(body.priority!));
    if (body.action === "replace_vendor") {
      if (!body.fromVendorTrunkId) errors.push({ path: "/fromVendorTrunkId", message: "required" });
      if (!body.toVendorTrunkId) errors.push({ path: "/toVendorTrunkId", message: "required" });
      else {
        const { rows } = await pool.query("SELECT 1 FROM vendor_trunks WHERE id = $1 AND deleted_at IS NULL", [
          body.toVendorTrunkId,
        ]);
        if (!rows[0]) errors.push({ path: "/toVendorTrunkId", message: "unknown or archived vendor trunk" });
      }
    }
    if (body.action === "set_lcr_profile") {
      if (!body.lcrProfileId) errors.push({ path: "/lcrProfileId", message: "required" });
      else {
        const { rows } = await pool.query("SELECT 1 FROM lcr_profiles WHERE id = $1 AND deleted_at IS NULL", [
          body.lcrProfileId,
        ]);
        if (!rows[0]) errors.push({ path: "/lcrProfileId", message: "unknown or deleted LCR profile" });
      }
    }
    if (errors.length) return badInput(reply, errors);
    const ids = [...new Set(body.ruleIds)];
    const { rows } = await pool.query(
      "SELECT id, status, priority, route_type, lcr_profile_id, deleted_at FROM route_rules WHERE id = ANY($1) AND deleted_at IS NULL",
      [ids],
    );
    const { vendors, whitelists } = await vendorsOf(pool, ids);
    if (body.action === "enable") {
      const empty = rows
        .filter((r) => r.route_type === "static" && !(vendors.get(r.id) ?? []).some((v) => !v.isBackup))
        .map((r) => r.id as number);
      if (empty.length)
        return badInput(reply, [
          { path: "/ruleIds", message: `static rules without vendors cannot be turned on: #${empty.join(", #")}` },
        ]);
    }
    const diff: DiffEntry[] = [];
    for (const r of rows) {
      const id = r.id as number;
      if (body.action === "enable" && r.status !== "active")
        diff.push({ entity_id: id, field: "status", before: r.status, after: "active" });
      if (body.action === "disable" && r.status !== "inactive")
        diff.push({ entity_id: id, field: "status", before: r.status, after: "inactive" });
      if (body.action === "set_priority" && r.priority !== body.priority)
        diff.push({ entity_id: id, field: "priority", before: r.priority, after: body.priority });
      if (body.action === "shift_priority") {
        // Not an administrator: a shift never raises a rule into the reserved priorities.
        const top = isAdmin(me) ? 100 : Math.max(DEFAULT_PRIORITY, r.priority);
        const next = Math.min(top, Math.max(1, r.priority + body.shift!));
        if (next !== r.priority) diff.push({ entity_id: id, field: "priority", before: r.priority, after: next });
      }
      if (body.action === "archive") diff.push({ entity_id: id, field: "archived", before: false, after: true });
      // Apply LCR (§13.23): the rule becomes Least cost with the profile.
      if (body.action === "set_lcr_profile") {
        if (r.route_type !== "dynamic")
          diff.push({ entity_id: id, field: "routeType", before: r.route_type, after: "dynamic" });
        const before = r.lcr_profile_id === null ? null : Number(r.lcr_profile_id);
        if (before !== body.lcrProfileId)
          diff.push({ entity_id: id, field: "lcrProfileId", before, after: body.lcrProfileId });
      }
      if (body.action === "replace_vendor") {
        const swap = <T extends { vendorTrunkId: number }>(list: T[]) =>
          list.map((v) =>
            v.vendorTrunkId === body.fromVendorTrunkId ? { ...v, vendorTrunkId: body.toVendorTrunkId! } : v,
          );
        const v0 = vendors.get(id) ?? [];
        const w0 = whitelists.get(id) ?? [];
        const v1 = swap(v0);
        const w1 = swap(w0);
        if (!same(v0, v1)) diff.push({ entity_id: id, field: "vendors", before: v0, after: v1 });
        if (!same(w0, w1)) diff.push({ entity_id: id, field: "whitelists", before: w0, after: w1 });
      }
    }
    if (diff.length === 0) return { change: null, affected: 0 };
    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) await applyRouteRuleField(c, d.entity_id, d.field, d.after, me.id);
      const touched = [...new Set(diff.map((d) => d.entity_id))];
      await c.query("UPDATE route_rules SET updated_by_id = $2, updated_at = now() WHERE id = ANY($1)", [
        touched,
        me.id,
      ]);
      return recordChange(c, {
        entityType: "route_rule",
        entityIds: touched,
        changeType: "bulk",
        diff,
        note: body.note?.trim() || `Bulk ${body.action.replace("_", " ")} on ${touched.length} rules`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { change, affected: new Set(diff.map((d) => d.entity_id)).size };
  });
}

// ---------------------------------------------------------------- traffic (§13.27)

export function getRouteRuleTraffic(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const { window = "24h" } = request.query as { window?: TrafficWindow };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM route_rules WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    return ruleTraffic(id, window);
  });
}

// ---------------------------------------------------------------- Test and Route Simulator

let qualityCache: { at: number; dlr: Map<number, number> } | null = null;

/** Delivered % per vendor trunk over 7 days, for QBR ordering (cached a minute). */
export async function vendorQuality(): Promise<Map<number, number>> {
  if (qualityCache && Date.now() - qualityCache.at < 60_000) return qualityCache.dlr;
  const rows = await chRows<{ id: number; dlr: number }>(
    `SELECT v_trunk_id AS id, round(countIf(msg_status = 'DELIVRD') / greatest(countIf(is_submit_success = 1), 1) * 100, 1) AS dlr
       FROM edr_all WHERE submit_time > now() - INTERVAL 7 DAY GROUP BY id`,
  );
  qualityCache = { at: Date.now(), dlr: new Map((rows ?? []).map((r) => [Number(r.id), Number(r.dlr)])) };
  return qualityCache.dlr;
}

/** `rateSender`: the sender as the customer sent it, when ingress translation changed it (the Route simulator). */
export async function messageContext(
  db: Db,
  input: RouteTestRequest,
  listIds: number[],
  rateSender?: string | null,
): Promise<MessageContext> {
  const prefixes = Array.from({ length: input.receiver.length }, (_, i) => input.receiver.slice(0, i + 1));
  const dest = input.mccmnc
    ? await db.query(
        "SELECT m.mccmnc, m.network, m.is_all_networks, co.name AS country FROM mccmnc m JOIN countries co ON co.id = m.country_id WHERE m.mccmnc = $1",
        [input.mccmnc],
      )
    : await db.query(
        `SELECT m.mccmnc, m.network, m.is_all_networks, co.name AS country FROM dial_codes d
           JOIN mccmnc m ON m.id = d.mccmnc_id JOIN countries co ON co.id = m.country_id
          WHERE d.prefix = ANY($1) AND d.profile = 'All' AND d.deleted_at IS NULL ORDER BY length(d.prefix) DESC LIMIT 1`,
        [prefixes],
      );
  const d = dest.rows[0];
  const mccmnc: string | null = d?.mccmnc ?? null;
  let categoryId: number | null = null;
  let sellRate: number | null = input.revenuePerMessage ?? null;
  if (input.customerTrunkId) {
    const { rows } = await db.query("SELECT product_category_id FROM customer_trunks WHERE id = $1", [
      input.customerTrunkId,
    ]);
    categoryId = rows[0]?.product_category_id ?? null;
    if (sellRate === null && mccmnc) {
      // The first of the trunk's rate tables with a line for the destination (§5.4), as the switch picks it: the
      // sender's own line first, a blocked line means none (linePrice.ts).
      sellRate = priced(await customerPrice(db, input.customerTrunkId, mccmnc, rateSender ?? input.sender ?? null))
        ?.platformRate ?? null;
    }
  }
  const values = [input.sender ?? "", input.receiver];
  // Lower-cased too, for sender lists with Match case off (team trial round 1).
  const { rows: entries } = listIds.length
    ? await db.query(
        "SELECT number_list_id, value FROM number_list_entries WHERE number_list_id = ANY($1) AND lower(value) = ANY($2)",
        [listIds, values.map((v) => v.toLowerCase())],
      )
    : { rows: [] as { number_list_id: number; value: string }[] };
  const hits = new Set(entries.map((e) => `${e.number_list_id}:${e.value}`));
  const lowerHits = new Set(entries.map((e) => `${e.number_list_id}:${e.value.toLowerCase()}`));
  return {
    now: Date.now(),
    customerTrunkId: input.customerTrunkId ?? null,
    categoryId,
    receiver: input.receiver,
    sender: input.sender ?? "",
    content: input.content ?? "",
    mccmnc,
    destination: d ? `${d.country} · ${d.is_all_networks ? "All networks" : d.network}` : null,
    tps: input.tps ?? null,
    sellRate,
    accumulatedRevenue: input.accumulatedRevenue ?? null,
    hlrPorted: input.hlrPorted ?? null,
    warmupSent: input.warmupSent ?? 0,
    listHas: (listId, value, ignoreCase) =>
      ignoreCase ? lowerHits.has(`${listId}:${value.toLowerCase()}`) : hits.has(`${listId}:${value}`),
  };
}

/** Live vendor trunks with their buy rate (platform currency) for the destination. */
export async function vendorOptions(
  db: Db,
  mccmnc: string | null,
  onlyIds: number[] | null,
): Promise<Map<number, VendorOption>> {
  const [quality, qbr, lcrQ, tiers] = await Promise.all([
    vendorQuality(),
    qbrDlrByCode(db, mccmnc ? [mccmnc, mccmnc.slice(0, 3)] : []),
    qbrQuality(db, mccmnc ? [mccmnc, mccmnc.slice(0, 3)] : []),
    vendorTiers(db),
  ]);
  const destQ = mccmnc ? qualityFor(lcrQ, mccmnc) : new Map<number, Quality>();
  const tps = tpsNow();
  // QBR uses the destination's effective vendor DLR (QBR stats, §6.3), else the 7-day DLR.
  const destDlr = qbr.get(mccmnc ?? "") ?? qbr.get(mccmnc?.slice(0, 3) ?? "") ?? new Map<number, number>();
  // The generic line in force, network before country; a blocked one means the vendor takes no traffic there
  // (blocked means blocked, decided 2026-10-30), as the switch's vendor options.
  const { rows } = await db.query(
    `SELECT vt.id, vt.name, vt.product_category_id, c.conv, c.is_blocked FROM vendor_trunks vt
       LEFT JOIN LATERAL (
         SELECT ${toPlatformSql("l.rate")} AS conv, l.is_blocked FROM rate_tables rt
           JOIN rate_lines l ON l.rate_table_id = rt.id
           LEFT JOIN currency_latest cl ON cl.iso = l.currency
          WHERE rt.vendor_trunk_id = vt.id AND rt.deleted_at IS NULL AND l.mccmnc = ANY($1) AND l.sender_id IS NULL
            AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
            AND (l.is_blocked OR cl.iso IS NOT NULL)
          ORDER BY length(l.mccmnc) DESC, rt.id LIMIT 1) c ON true
      WHERE vt.deleted_at IS NULL AND ${ROUTABLE_VENDOR_SQL} AND ($2::bigint[] IS NULL OR vt.id = ANY($2))`,
    [mccmnc ? [mccmnc, mccmnc.slice(0, 3)] : [], onlyIds],
  );
  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        vendorTrunkId: Number(r.id),
        name: r.name as string,
        cost: r.conv === null || r.is_blocked ? null : Math.round(Number(r.conv) * 1e6) / 1e6,
        blocked: r.is_blocked === true,
        dlr: destDlr.get(Number(r.id)) ?? quality.get(Number(r.id)) ?? null,
        categoryId: r.product_category_id ?? null,
        asr: destQ.get(Number(r.id))?.asr ?? null,
        delayS: destQ.get(Number(r.id))?.delayS ?? null,
        tier: tiers.get(Number(r.id))?.tier ?? null,
        atLimit: atLimit(tps.get(Number(r.id)), tiers.get(Number(r.id))?.limit),
      },
    ]),
  );
}

export const listIdsOf = (rules: RuleCore[]) => [
  ...new Set(
    rules.flatMap((r) =>
      [r.senderListId, r.receiverListId, ...r.whitelists.map((w) => w.numberListId)].filter((x): x is number => !!x),
    ),
  ),
];

async function checkTestInput(db: Db, input: RouteTestRequest): Promise<FieldError[]> {
  if (!input.customerTrunkId) return [];
  const { rows } = await db.query("SELECT 1 FROM customer_trunks WHERE id = $1", [input.customerTrunkId]);
  return rows[0] ? [] : [{ path: "/customerTrunkId", message: "unknown customer trunk" }];
}

/**
 * The customer trunk's ingress translation, run first as the switch does (intake: translation, HLR, rate, route): the
 * route rules see the translated sender, receiver and content (team trial round 12: a content change by an ingress
 * rule did not show in the simulator). A trunk set to auto TON / NPI then fixes them (S-4.7): the Test form has none,
 * so with auto the vendors' capability filter checks the values auto sets (`tonNpi`).
 */
async function ingressOf(
  pool: pg.Pool,
  input: RouteTestRequest,
): Promise<{
  input: RouteTestRequest;
  ingress: TranslationTestResult | null;
  tonNpi: Omit<CapabilityInput, "form">;
}> {
  if (!input.customerTrunkId) return { input, ingress: null, tonNpi: {} };
  const [t, { rows }] = await Promise.all([
    runTrunkTranslation(pool, "customer", input.customerTrunkId, {
      sender: input.sender ?? "",
      receiver: input.receiver,
      text: input.content ?? "",
    }),
    pool.query("SELECT ton_npi_mode FROM customer_trunks WHERE id = $1", [input.customerTrunkId]),
  ]);
  const mode = (rows[0]?.ton_npi_mode ?? "as_sent") as TonNpiMode;
  if (!t || (!t.result.steps.length && mode !== "auto")) return { input, ingress: null, tonNpi: {} };
  const r = t.result;
  const ingress: TranslationTestResult | null = r.steps.length
    ? { before: r.before, after: r.after, blocked: r.blocked, steps: r.steps }
    : null;
  const sent = withTonNpiMode(mode, r.after, t.pinned);
  const receiver = /^[0-9]{5,15}$/.test(sent.receiver) ? sent.receiver : input.receiver;
  return {
    input: { ...input, sender: sent.sender, receiver, content: r.after.text },
    ingress,
    tonNpi: {
      senderTon: sent.senderTon,
      senderNpi: sent.senderNpi,
      destTon: sent.destTon,
      destNpi: sent.destNpi,
      pinned: t.pinned,
    },
  };
}

export function testRouteRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const raw = request.body as RouteTestRequest;
  return withDb(reply, async (pool): Promise<RouteDecision | FastifyReply> => {
    const rule = await loadRule(pool, id);
    if (!rule) return notFound(reply, id);
    const errors = await checkTestInput(pool, raw);
    if (errors.length) return badInput(reply, errors);
    const { input, ingress, tonNpi } = await ingressOf(pool, raw);
    const m = await messageContext(pool, input, listIdsOf([rule]));
    const dynamic = rule.routeType === "dynamic" || (rule.routeType === "qbr" && rule.vendors.length === 0);
    const ids = dynamic
      ? null
      : [...rule.vendors.map((v) => v.vendorTrunkId), ...rule.whitelists.map((w) => w.vendorTrunkId)];
    const profiles = rule.lcrProfileId ? await loadLcrProfiles(pool) : null;
    const options = await vendorOptions(pool, m.mccmnc, ids);
    const withProfile = { ...rule, lcrProfile: profiles?.get(rule.lcrProfileId!) ?? null };
    const form = testForm(raw);
    m.parts = natural(form)?.parts || 1;
    // A vendor whose own egress rules block the message, or that cannot take it, is skipped for the next one (decided
    // 2026-10-18; §5.5).
    const { result, skipped } = await skipEgressBlocked(
      pool,
      m,
      testMessage(input, tonNpi),
      (mm) => decide(withProfile, mm, options),
      (d) => d.vendor,
      { form, ...tonNpi },
    );
    return { ...result, egressSkipped: skipped, ingress };
  });
}

/** Every live rule in evaluation order (highest priority first, then ID; team trial round 1), with vendors and whitelists. */
export async function loadRulesInOrder(db: Db): Promise<RuleCore[]> {
  const { rows } = await db.query(`${ruleSelect} WHERE r.deleted_at IS NULL ORDER BY r.priority DESC, r.id`);
  const ids = rows.map((r) => r.id as number);
  const [{ vendors, whitelists }, profiles] = await Promise.all([vendorsOf(db, ids), loadLcrProfiles(db)]);
  // Least cost rules carry their LCR profile for the evaluator (§13.23).
  return rows.map((r) => ({
    ...rowToRule(r, vendors.get(r.id) ?? [], whitelists.get(r.id) ?? []),
    lcrProfile: r.lcr_profile_id ? (profiles.get(Number(r.lcr_profile_id)) ?? null) : null,
  }));
}

export interface TriedRule {
  ruleId: number;
  name: string;
  priority: number;
  matched: boolean;
  reason: string;
}

/**
 * Runs a message through the rules in order, as the switch will: the first matching rule
 * decides, unless it finds no vendor and says continue (YES, decided 2026-10-24, R3; groups and NEXT were removed,
 * R4). `keep` limits how many tried rules are listed.
 */
export function routeThrough(
  rules: RuleCore[],
  m: MessageContext,
  options: Map<number, VendorOption>,
  keep = 100,
): { tried: TriedRule[]; decision: RouteDecision | null } {
  const tried: TriedRule[] = [];
  for (const rule of rules) {
    // Without a list to report, skip non-matching rules cheaply.
    if (keep === 0 && !quickMatch(rule, m)) continue;
    const decision = decide(rule, m, options);
    if (keep > 0) {
      const failed = decision.checks.find((c) => !c.ok);
      const reason = decision.matched
        ? decision.outcome === "route"
          ? `routes to ${decision.vendor!.name} (${decision.vendor!.decidedBy})`
          : decision.outcome === "block"
            ? "blocks the message"
            : "no vendor qualifies"
        : `${failed?.condition ?? "condition"}: ${failed?.detail ?? "no match"}`;
      // Only matching rules and the first non-matching ones are listed, to keep the answer small.
      if (decision.matched || tried.length < keep)
        tried.push({ ruleId: rule.id, name: rule.name, priority: rule.priority, matched: decision.matched, reason });
    }
    if (!decision.matched) continue;
    if (decision.outcome === "no_vendor" && rule.continueRouting === "yes") continue;
    // Rules further down that would also match are listed as shadowed (team trial round 6), so a new rule hiding
    // an older one shows it; they are never reached for this message.
    if (keep > 0) {
      let shadowed = 0;
      for (const later of rules.slice(rules.indexOf(rule) + 1)) {
        if (shadowed >= 20) break;
        if (!quickMatch(later, m)) continue;
        const d = decide(later, m, options);
        if (!d.matched) continue;
        shadowed++;
        tried.push({
          ruleId: later.id,
          name: later.name,
          priority: later.priority,
          matched: false,
          reason: `shadowed: would match too, but rule #${rule.id} decides first`,
        });
      }
      return { tried: tried.slice(-(keep + shadowed)), decision };
    }
    return { tried: tried.slice(-keep), decision };
  }
  return { tried: tried.slice(-keep), decision: null };
}

export function simulateRoute(request: FastifyRequest, reply: FastifyReply) {
  const raw = request.body as RouteTestRequest;
  return withDb(reply, async (pool) => {
    const errors = await checkTestInput(pool, raw);
    if (errors.length) return badInput(reply, errors);
    const { input, ingress, tonNpi } = await ingressOf(pool, raw);
    const rules = await loadRulesInOrder(pool);
    const m = await messageContext(pool, input, listIdsOf(rules));
    const options = await vendorOptions(pool, m.mccmnc, null);
    const form = testForm(raw);
    m.parts = natural(form)?.parts || 1;
    const { result, skipped } = await skipEgressBlocked(
      pool,
      m,
      testMessage(input, tonNpi),
      (mm) => routeThrough(rules, mm, options),
      (r) => r.decision?.vendor,
      { form, ...tonNpi },
    );
    return { ...result, egressSkipped: skipped, ingress };
  });
}

/**
 * The message as the customer sent it, for Deny Multipart and the vendors' capability filter (§6.3, §5.5): the Test
 * form has no coding or TON / NPI, so the text goes in the coding it needs (GSM, else UCS-2) and TON / NPI are checked
 * only as a translation rule or auto TON / NPI sets them (S-4.7).
 */
const testForm = (raw: RouteTestRequest): MessageForm => ({
  text: raw.content ?? "",
  dataCoding: textCoding(raw.content ?? ""),
});

/** The message a vendor's egress rules see in a Test or Simulate (no TON / NPI in that form, unless auto set them). */
const testMessage = (input: RouteTestRequest, tonNpi: Omit<CapabilityInput, "form"> = {}) => ({
  sender: input.sender ?? "",
  receiver: input.receiver ?? "",
  text: input.content ?? "",
  senderTon: tonNpi.senderTon ?? null,
  senderNpi: tonNpi.senderNpi ?? null,
});

/**
 * What each picked vendor charges for the rule's destinations (team trial round 4): current generic, unblocked
 * lines of the trunk's buy table over the destinations the rule matches; one figure when flat, else min and max,
 * in the table's currency and in EUR (the base) at the latest exchange rates.
 */
/**
 * The costs for a list of destinations as routing finds them (team trial round 12): each code's own line, else its
 * country's ("All networks") line, which the column used to leave out. A blocked line in force counts as no cost for
 * that destination, never its country's (blocked means blocked, decided 2026-10-30).
 */
async function listedCosts(pool: pg.Pool, vendorTrunkIds: number[], codes: string[]): Promise<RouteVendorCost[]> {
  const { rows } = await pool.query(
    `WITH picked AS (
       SELECT DISTINCT ON (rt.vendor_trunk_id, c.code) rt.vendor_trunk_id AS id, rt.currency, l.rate,
              l.rate / cl.rate_per_eur AS eur, c.code, l.is_blocked
         FROM unnest($2::text[]) AS c(code)
         JOIN rate_tables rt ON rt.kind = 'vendor' AND rt.deleted_at IS NULL AND rt.vendor_trunk_id = ANY($1::bigint[])
         JOIN rate_lines l ON l.rate_table_id = rt.id AND l.sender_id IS NULL
              AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
              AND l.mccmnc IN (c.code, left(c.code, 3))
         LEFT JOIN currency_latest cl ON cl.iso = l.currency
        ORDER BY rt.vendor_trunk_id, c.code, (l.mccmnc = c.code) DESC, rt.id)
     SELECT id, min(currency) AS currency, min(rate) AS min, max(rate) AS max, min(eur) AS min_eur, max(eur) AS max_eur,
            count(*)::int AS destinations
       FROM picked WHERE NOT is_blocked GROUP BY id`,
    [vendorTrunkIds, codes],
  );
  const { rows: tables } = await pool.query(
    "SELECT vendor_trunk_id AS id, min(currency) AS currency FROM rate_tables WHERE kind = 'vendor' AND deleted_at IS NULL AND vendor_trunk_id = ANY($1::bigint[]) GROUP BY 1",
    [vendorTrunkIds],
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const ccy = new Map(tables.map((r) => [Number(r.id), String(r.currency).trim()]));
  const num = (v: unknown, d: number) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));
  return vendorTrunkIds.map((id) => {
    const r = byId.get(id);
    return {
      vendorTrunkId: id,
      currency: r ? String(r.currency).trim() : (ccy.get(id) ?? null),
      min: num(r?.min, 6),
      max: num(r?.max, 6),
      minEur: num(r?.min_eur, 6),
      maxEur: num(r?.max_eur, 6),
      destinations: r ? Number(r.destinations) : 0,
    };
  });
}

export function routeVendorCosts(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as RouteVendorCostRequest;
  return withDb(reply, async (pool): Promise<RouteVendorCost[]> => {
    const params: unknown[] = [b.vendorTrunkIds];
    let where = "";
    // The list wins over the pattern when both are set, as in routing (R1, team trial round 12).
    const listed = b.mccmncMode !== "all" && (b.mccmncs ?? []).length > 0;
    if (listed && b.mccmncMode === "inclusive") return listedCosts(pool, b.vendorTrunkIds, b.mccmncs);
    if (listed) {
      params.push(b.mccmncs);
      where = `AND NOT (l.mccmnc = ANY($${params.length}::text[]))`;
    } else if (b.mccmncPattern) {
      params.push(b.mccmncPattern);
      where = `AND l.mccmnc ~* $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT rt.vendor_trunk_id AS id, rt.currency, min(l.rate) AS min, max(l.rate) AS max,
              min(l.rate / cl.rate_per_eur) AS min_eur, max(l.rate / cl.rate_per_eur) AS max_eur,
              count(l.id)::int AS destinations
         FROM rate_tables rt
         LEFT JOIN rate_lines l ON l.rate_table_id = rt.id AND l.sender_id IS NULL AND NOT l.is_blocked
              AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now()) ${where}
         LEFT JOIN currency_latest cl ON cl.iso = l.currency
        WHERE rt.kind = 'vendor' AND rt.deleted_at IS NULL AND rt.vendor_trunk_id = ANY($1::bigint[])
        GROUP BY rt.vendor_trunk_id, rt.currency`,
      params,
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const num = (v: unknown, d: number) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));
    return b.vendorTrunkIds.map((id) => {
      const r = byId.get(id);
      return {
        vendorTrunkId: id,
        currency: r ? String(r.currency).trim() : null,
        min: num(r?.min, 6),
        max: num(r?.max, 6),
        minEur: num(r?.min_eur, 6),
        maxEur: num(r?.max_eur, 6),
        destinations: r ? Number(r.destinations) : 0,
      };
    });
  });
}
