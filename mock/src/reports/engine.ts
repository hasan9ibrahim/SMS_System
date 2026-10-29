// Master Report engine (§10, §13.15) on the EDR store. Group by up to 5 fields, any metrics, filters
// with the §13.25 grammar: conditions on group-by fields run before grouping (names resolved to IDs,
// chEngine.ts), metric thresholds after. Each page is grouped base sums -> metrics -> threshold
// filter -> sort and page; totals and the count use the same filtered groups. Raw EDRs are used while the period is
// within the detailed months; older periods read the long-term totals (masterSource, docs/BACKEND_PLAN.md §3.7).
import { production } from "../mode.js";
import type pg from "pg";
import type {
  FieldDescriptor,
  FilterCondition,
  FilterGroup,
  MasterReportQuery,
  MasterReportRow,
  ReportDimension,
  ReportMetric,
} from "@sms/contract";
import { PLATFORM_CURRENCY, sysToPlatformFactor } from "../currency.js";
import { chQuery } from "../edr.js";
import { chWhere, lit, namesOf, type ChColumn, type ChListDef, type NameSource } from "../lists/chEngine.js";
import { EDR_COLUMNS } from "../lists/edrDefs.js";
import { decodeCursor, encodeCursor } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { causeName } from "../smpp.js";
import { MAX_DAYS, previousWindow, resolvePeriod, type Window } from "./period.js";
import {
  beforeDetail,
  checkQuarterBounds,
  counter,
  decFactor,
  DETAIL_MONTHS,
  PastDetailError,
  pastDetail,
  type EdrSource,
} from "./source.js";

const ENTERPRISES: NameSource = { table: "enterprises e", name: "e.name", id: "e.id" };
/** The live screens label enterprises by alias (team trial round 1); the name stands in for an empty alias. */
const ENTERPRISE_ALIASES: NameSource = {
  table: "enterprises e",
  name: "COALESCE(NULLIF(e.alias, ''), e.name)",
  id: "e.id",
};
const named = (src: NameSource, idSql: string): ChColumn => ({ sql: idSql, names: { ...src, idSql } });

interface Dim {
  /** ID expression (grouped on); labels come from `names`, `label` or the ID itself. */
  id: (tz: string) => string;
  names?: NameSource;
  /** PostgreSQL lookup for text keys (country, MCCMNC). */
  lookup?: "country" | "mccmnc" | "mcc";
  label?: (id: string) => string;
  /** Filter column on the EDR store. */
  filter: (tz: string) => ChColumn;
}

const tzl = (tz: string) => lit(tz);
/** The Sender ID, with every numeric one (digits, optional leading +) as "Numeric". */
const numericGroup = (col: string) => `if(match(${col}, '^[+]?[0-9]+$'), 'Numeric', ${col})`;
export const NUMERIC_GROUP_SQL = numericGroup("src_addr");
/** The same on the Sender ID sent to the vendor, after translation rules (team trial round 2). */
export const VENDOR_NUMERIC_GROUP_SQL = numericGroup("v_src_addr");
export const DIMS: Record<ReportDimension, Dim> = {
  // Second, minute and 15-minute buckets (Live analytics detail, team trial 2026-10-18).
  second: {
    id: (tz) => `formatDateTime(start_time, '%Y-%m-%d %H:%i:%S', ${tzl(tz)})`,
    filter: (tz) => ({ sql: `formatDateTime(start_time, '%Y-%m-%d %H:%i:%S', ${tzl(tz)})` }),
  },
  minute: {
    id: (tz) => `formatDateTime(start_time, '%Y-%m-%d %H:%i', ${tzl(tz)})`,
    filter: (tz) => ({ sql: `formatDateTime(start_time, '%Y-%m-%d %H:%i', ${tzl(tz)})` }),
  },
  quarterHour: {
    id: (tz) => `formatDateTime(toStartOfFifteenMinutes(start_time), '%Y-%m-%d %H:%i', ${tzl(tz)})`,
    filter: (tz) => ({ sql: `formatDateTime(toStartOfFifteenMinutes(start_time), '%Y-%m-%d %H:%i', ${tzl(tz)})` }),
  },
  date: {
    id: (tz) => `toString(toDate(start_time, ${tzl(tz)}))`,
    filter: (tz) => ({ sql: `toString(toDate(start_time, ${tzl(tz)}))` }),
  },
  hour: {
    id: (tz) => `formatDateTime(start_time, '%Y-%m-%d %H:00', ${tzl(tz)})`,
    filter: (tz) => ({ sql: `formatDateTime(start_time, '%Y-%m-%d %H:00', ${tzl(tz)})` }),
  },
  week: {
    id: (tz) => `toString(toMonday(start_time, ${tzl(tz)}))`,
    label: (id) => `Week of ${id}`,
    filter: (tz) => ({ sql: `toString(toMonday(start_time, ${tzl(tz)}))` }),
  },
  month: {
    id: (tz) => `formatDateTime(start_time, '%Y-%m', ${tzl(tz)})`,
    filter: (tz) => ({ sql: `formatDateTime(start_time, '%Y-%m', ${tzl(tz)})` }),
  },
  customer: { id: () => "c_enterprise_id", names: ENTERPRISES, filter: () => named(ENTERPRISES, "c_enterprise_id") },
  customerTrunk: {
    id: () => "c_trunk_id",
    names: { table: "customer_trunks t", name: "t.name", id: "t.id" },
    filter: () => EDR_COLUMNS.customerTrunk!,
  },
  customerIp: { id: () => "IPv4NumToString(c_ip)", filter: () => EDR_COLUMNS.customerIp! },
  vendor: { id: () => "v_enterprise_id", names: ENTERPRISES, filter: () => named(ENTERPRISES, "v_enterprise_id") },
  vendorTrunk: {
    id: () => "v_trunk_id",
    names: { table: "vendor_trunks t", name: "t.name", id: "t.id" },
    filter: () => EDR_COLUMNS.vendorTrunk!,
  },
  vendorIp: { id: () => "if(v_trunk_id = 0, '', IPv4NumToString(v_ip))", filter: () => EDR_COLUMNS.vendorIp! },
  country: { id: () => "c_country_iso", lookup: "country", filter: () => EDR_COLUMNS.country! },
  destination: { id: () => "c_mccmnc", lookup: "mccmnc", filter: () => EDR_COLUMNS.customerMccmnc! },
  // The country of the MCCMNC sent to the vendor (its MCC).
  vendorCountry: {
    id: () => "if(v_trunk_id = 0, '', substring(v_mccmnc, 1, 3))",
    lookup: "mcc",
    filter: () => ({ sql: "if(v_trunk_id = 0, '', substring(v_mccmnc, 1, 3))" }),
  },
  vendorDestination: {
    id: () => "if(v_trunk_id = 0, '', v_mccmnc)",
    lookup: "mccmnc",
    filter: () => EDR_COLUMNS.vendorMccmnc!,
  },
  productCategory: {
    id: () => "product_category_id",
    names: { table: "product_categories c", name: "c.name", id: "c.id" },
    filter: () => EDR_COLUMNS.productCategory!,
  },
  senderId: { id: () => "src_addr", filter: () => EDR_COLUMNS.senderId! },
  // Numeric Sender IDs (digits, optional +) count as one "Numeric" row; its + lists them (team trial round 2).
  senderGroup: {
    id: () => NUMERIC_GROUP_SQL,
    filter: () => ({ sql: NUMERIC_GROUP_SQL }),
  },
  // Customer Sender ID is what the customer sent us; Vendor Sender ID what we sent the vendor (team trial round 2).
  vendorSenderId: { id: () => "v_src_addr", filter: () => EDR_COLUMNS.vendorSenderId! },
  vendorSenderGroup: {
    id: () => VENDOR_NUMERIC_GROUP_SQL,
    filter: () => ({ sql: VENDOR_NUMERIC_GROUP_SQL }),
  },
  routeRule: {
    id: () => "route_rule_id",
    names: { table: "route_rules r", name: "r.name", id: "r.id" },
    filter: () => named({ table: "route_rules r", name: "r.name", id: "r.id" }, "route_rule_id"),
  },
  routeType: { id: () => "route_type", filter: () => ({ sql: "route_type" }) },
  rateTable: {
    id: () => "c_rate_table_id",
    names: { table: "rate_tables rt", name: "rt.name", id: "rt.id" },
    filter: () => named({ table: "rate_tables rt", name: "rt.name", id: "rt.id" }, "c_rate_table_id"),
  },
  accountManager: {
    id: () => "c_am_user_id",
    names: { table: "users u", name: "u.first_name || ' ' || u.last_name", id: "u.id" },
    filter: () => named({ table: "users u", name: "u.first_name || ' ' || u.last_name", id: "u.id" }, "c_am_user_id"),
  },
  vendorAccountManager: {
    id: () => "v_am_user_id",
    names: { table: "users u", name: "u.first_name || ' ' || u.last_name", id: "u.id" },
    filter: () => named({ table: "users u", name: "u.first_name || ' ' || u.last_name", id: "u.id" }, "v_am_user_id"),
  },
  businessCompany: {
    id: () => "business_company_id",
    names: { table: "business_companies b", name: "b.name", id: "b.id" },
    filter: () => named({ table: "business_companies b", name: "b.name", id: "b.id" }, "business_company_id"),
  },
  currency: { id: () => "c_currency", filter: () => EDR_COLUMNS.customerCurrency! },
  msgType: { id: () => "toString(msg_type)", filter: () => EDR_COLUMNS.type! },
  hlrProvider: {
    id: () => "hlr_provider_id",
    names: { table: "hlr_providers p", name: "p.name", id: "p.id" },
    filter: () => EDR_COLUMNS.hlrProvider!,
  },
  errorCode: {
    id: () => "command_status",
    label: (id) => `${id} ${causeName(Number(id))}`,
    filter: () => EDR_COLUMNS.causeCode!,
  },
  // The grouped query reads edr_all, where outcome rows carry the status themselves: no outcome overlay here.
  deliveryStatus: { id: () => "msg_status", label: (id) => id || "no receipt", filter: () => ({ sql: "msg_status" }) },
};

/** Base sums per group over `edr_all` (backend step 11b: attempts and the switch's receipt outcomes); counts of
 * attempts only on attempt rows, statuses, delays, billable counts and money on both. Money "_b" in the platform
 * currency, "_base" in the base currency: exact decimal sums, so the long-term totals give the same figures (they
 * count their `rows`, source.ts). */
const baseSums = (factor: string, src: EdrSource = "edr_all") => {
  const n = counter(src);
  // The factor depends on the row's business company; in decimals the sum is exact whatever the rows' grouping.
  const fx = decFactor(factor);
  return [
    `${n("kind = 'attempt'")} AS attempts`,
    `${n("kind = 'attempt' AND is_submit_success = 1")} AS successful`,
    `${n("kind = 'attempt' AND v_trunk_id > 0")} AS submitted`,
    `${n("kind = 'attempt' AND v_trunk_id > 0 AND is_submit_success = 0")} AS failed_submits`,
    `${n("msg_status = 'DELIVRD'")} AS delivered_v`,
    `${n("c_msg_status = 'DELIVRD'")} AS delivered_c`,
    `${n("is_customer_billable = 1")} AS billable_c`,
    `${n("is_vendor_billable = 1")} AS billable_v`,
    `${n("c_msg_status NOT IN ('', 'ENROUTE')")} AS reported_c`,
    `${n("msg_status NOT IN ('', 'ENROUTE')")} AS reported_v`,
    `toFloat64(sum(toDecimal128(revenue_sys, 6) * ${fx})) AS revenue_b`,
    `toFloat64(sum(toDecimal128(cost_sys, 6) * ${fx})) AS cost_b`,
    "toFloat64(sum(revenue_sys)) AS revenue_base",
    "toFloat64(sum(cost_sys)) AS cost_base",
    "uniqExact(business_company_id) AS companies",
    "toFloat64(sumIf(delivery_delay_ms, msg_status = 'DELIVRD')) AS delay_sum",
    `${n("hlr_fetch_type = 'cached'")} AS hlr_cached`,
    `${n("hlr_fetch_type = 'live'")} AS hlr_live`,
    `${n("hlr_is_accomplished = 1")} AS hlr_acc`,
    `${n("hlr_is_ported = 1")} AS hlr_ported`,
    `toFloat64(sum(toDecimal128(hlr_cost_sys, 6) * ${fx})) AS hlr_cost_b`,
    `${n("kind = 'attempt' AND (dlr_reroute = 1 OR attempt_no > 1)")} AS reroutes`,
    `${n("msg_type = 'MO'")} AS mo`,
  ].join(", ");
};
export const BASE_COLUMNS = [
  "attempts",
  "successful",
  "submitted",
  "failed_submits",
  "delivered_v",
  "delivered_c",
  "billable_c",
  "billable_v",
  "reported_c",
  "reported_v",
  "revenue_b",
  "cost_b",
  "revenue_base",
  "cost_base",
  "companies",
  "delay_sum",
  "hlr_cached",
  "hlr_live",
  "hlr_acc",
  "hlr_ported",
  "hlr_cost_b",
  "reroutes",
  "mo",
] as const;
export type Base = Record<(typeof BASE_COLUMNS)[number], number>;

const ratio = (num: string, den: string, scale: number, digits: number) =>
  `if((${den}) = 0, NULL, round((${num}) / (${den}) * ${scale}, ${digits}))`;

/** Metrics from the base sums (ClickHouse, so they can be filtered and sorted). tpsPeak and tpsNow are added per page. */
export const METRIC_SQL = (seconds: number): Record<Exclude<ReportMetric, "tpsPeak" | "tpsNow">, string> => ({
  attempts: "attempts",
  successful: "successful",
  submitted: "submitted",
  delivered: "delivered_v",
  failedSubmits: "failed_submits",
  billableCustomer: "billable_c",
  billableVendor: "billable_v",
  reportedCustomer: "reported_c",
  reportedVendor: "reported_v",
  asr: ratio("successful", "attempts", 100, 1),
  dlrCustomer: ratio("delivered_c", "successful", 100, 1),
  dlrVendor: ratio("delivered_v", "successful", 100, 1),
  deliveryDelayS: ratio("delay_sum", "delivered_v", 0.001, 1),
  revenue: "round(revenue_b, 6)",
  cost: "round(cost_b, 6)",
  margin: "round(revenue_b - cost_b, 6)",
  marginPct: ratio("revenue_b - cost_b", "revenue_b", 100, 1),
  avgRateCustomer: ratio("revenue_b", "billable_c", 1, 6),
  avgRateVendor: ratio("cost_b", "billable_v", 1, 6),
  costAvg: ratio("cost_b", "billable_v", 1, 6),
  revenueBase: "if(companies > 1, NULL, round(revenue_base, 6))",
  costBase: "if(companies > 1, NULL, round(cost_base, 6))",
  hlrCached: "hlr_cached",
  hlrLive: "hlr_live",
  hlrTotal: "hlr_cached + hlr_live",
  hlrAccomplished: "hlr_acc",
  hlrPorted: "hlr_ported",
  hlrCost: "round(hlr_cost_b, 6)",
  reroutes: "reroutes",
  moCount: "mo",
  tpsAvg: `round(attempts / ${Math.max(1, seconds)}, 2)`,
});

/** The same metrics in JavaScript, for totals. */
export function metricsFromBase(b: Base, seconds: number): Record<string, number | null> {
  const r = (num: number, den: number, scale: number, digits: number) =>
    den === 0 ? null : Math.round((num / den) * scale * 10 ** digits) / 10 ** digits;
  // Money keeps 6 decimals, never rounded further (team trial round 3).
  const m6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    attempts: b.attempts,
    successful: b.successful,
    submitted: b.submitted,
    delivered: b.delivered_v,
    failedSubmits: b.failed_submits,
    billableCustomer: b.billable_c,
    billableVendor: b.billable_v,
    reportedCustomer: b.reported_c,
    reportedVendor: b.reported_v,
    asr: r(b.successful, b.attempts, 100, 1),
    dlrCustomer: r(b.delivered_c, b.successful, 100, 1),
    dlrVendor: r(b.delivered_v, b.successful, 100, 1),
    deliveryDelayS: r(b.delay_sum, b.delivered_v, 0.001, 1),
    revenue: m6(b.revenue_b),
    cost: m6(b.cost_b),
    margin: m6(b.revenue_b - b.cost_b),
    marginPct: r(b.revenue_b - b.cost_b, b.revenue_b, 100, 1),
    avgRateCustomer: r(b.revenue_b, b.billable_c, 1, 6),
    avgRateVendor: r(b.cost_b, b.billable_v, 1, 6),
    costAvg: r(b.cost_b, b.billable_v, 1, 6),
    revenueBase: b.companies > 1 ? null : m6(b.revenue_base),
    costBase: b.companies > 1 ? null : m6(b.cost_base),
    hlrCached: b.hlr_cached,
    hlrLive: b.hlr_live,
    hlrTotal: b.hlr_cached + b.hlr_live,
    hlrAccomplished: b.hlr_acc,
    hlrPorted: b.hlr_ported,
    hlrCost: m6(b.hlr_cost_b),
    reroutes: b.reroutes,
    moCount: b.mo,
    tpsAvg: Math.round((b.attempts / Math.max(1, seconds)) * 100) / 100,
  };
}

// ---------------------------------------------------------------- filters

const fields = listFields.master_report.fields;
const byName = new Map(fields.map((f) => [f.field, f]));
const isMetric = (f: string) => byName.get(f)?.field !== undefined && !(f in DIMS);

function kindOf(node: FilterGroup | FilterCondition): "dim" | "metric" | "mixed" {
  if (!("logic" in node)) return isMetric(node.field) ? "metric" : "dim";
  const kinds = new Set(node.conditions.map(kindOf));
  return kinds.size === 1 ? [...kinds][0]! : "mixed";
}

/** Splits a filter into the part on group-by fields (before grouping) and metric thresholds (after). */
export function splitFilter(filter: FilterGroup | undefined): {
  dims: FilterGroup | null;
  metrics: FilterGroup | null;
  error: string | null;
} {
  if (!filter || !filter.conditions.length) return { dims: null, metrics: null, error: null };
  const k = kindOf(filter);
  if (k === "dim") return { dims: filter, metrics: null, error: null };
  if (k === "metric") return { dims: null, metrics: filter, error: null };
  if (filter.logic === "or")
    return { dims: null, metrics: null, error: "Metric thresholds cannot be OR-ed with field conditions" };
  const dims = filter.conditions.filter((n) => kindOf(n) === "dim");
  const metrics = filter.conditions.filter((n) => kindOf(n) === "metric");
  if (filter.conditions.some((n) => kindOf(n) === "mixed"))
    return { dims: null, metrics: null, error: "Metric thresholds cannot be OR-ed with field conditions" };
  return { dims: { logic: "and", conditions: dims }, metrics: { logic: "and", conditions: metrics }, error: null };
}

/** The group-by fields of a query: by alias, customer and vendor are labelled and filtered on enterprise aliases. */
export function dimsFor(q: Pick<MasterReportQuery, "enterpriseLabel">): Record<ReportDimension, Dim> {
  if (q.enterpriseLabel !== "alias") return DIMS;
  return {
    ...DIMS,
    customer: {
      ...DIMS.customer,
      names: ENTERPRISE_ALIASES,
      filter: () => named(ENTERPRISE_ALIASES, "c_enterprise_id"),
    },
    vendor: { ...DIMS.vendor, names: ENTERPRISE_ALIASES, filter: () => named(ENTERPRISE_ALIASES, "v_enterprise_id") },
  };
}

function dimDef(tz: string, dims: Record<ReportDimension, Dim> = DIMS): ChListDef<unknown> {
  return {
    fields: { list: "master_report", defaultSort: [], fields: fields.filter((f) => f.field in DIMS) },
    table: "edr",
    columns: Object.fromEntries(Object.entries(dims).map(([k, d]) => [k, d.filter(tz)])),
    search: [],
    idSql: "edr_id",
    mapRow: (r) => r,
  };
}
function metricDef(seconds: number): ChListDef<unknown> {
  const sql = METRIC_SQL(seconds);
  return {
    fields: { list: "master_report", defaultSort: [], fields: fields.filter((f) => !(f.field in DIMS)) },
    table: "m",
    columns: Object.fromEntries(Object.keys(sql).map((k) => [k, { sql: k }])),
    search: [],
    idSql: "1",
    mapRow: (r) => r,
  };
}

/** Every day of the period, only hourFrom..hourTo (inclusive, report time zone; wraps past midnight). */
export function hourSql(q: Pick<MasterReportQuery, "hourFrom" | "hourTo">, tz: string): string {
  const from = q.hourFrom ?? null;
  const to = q.hourTo ?? null;
  if (from === null && to === null) return "1";
  const f = from ?? 0;
  const t = to ?? 23;
  const h = `toHour(start_time, ${tzl(tz)})`;
  return f <= t ? `${h} BETWEEN ${f} AND ${t}` : `(${h} >= ${f} OR ${h} <= ${t})`;
}

/** Fields whose codes users know by name: a text condition becomes the list of codes it names. */
const NAMED_TEXT: Partial<Record<string, "country" | "mccmnc" | "mcc">> = {
  country: "country",
  destination: "mccmnc",
  vendorDestination: "mccmnc",
  vendorCountry: "mcc",
};
const likeToRegex = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/%/g, ".*")
      .replace(/_/g, ".")}$`,
    "i",
  );

export async function namedToCodes(pool: pg.Pool, group: FilterGroup): Promise<FilterGroup> {
  const lk = await loadLookups(pool);
  const map = (node: FilterGroup | FilterCondition): FilterGroup | FilterCondition => {
    if ("logic" in node) return { ...node, conditions: node.conditions.map(map) };
    const kind = NAMED_TEXT[node.field];
    if (!kind || !["like", "not_like", "eq", "neq"].includes(node.op)) return node;
    const text = String(node.value ?? "");
    const re = node.op === "like" || node.op === "not_like" ? likeToRegex(text) : null;
    const labels = kind === "country" ? lk.country : kind === "mcc" ? lk.mcc : lk.mccmnc;
    const hit = (code: string, label: string) =>
      re
        ? re.test(code) || re.test(label) || re.test(`${label} (${code})`)
        : code.toLowerCase() === text.toLowerCase() || label.toLowerCase() === text.toLowerCase();
    const codes = [...labels.entries()].filter(([code, label]) => hit(code, label)).map(([code]) => code);
    const negated = node.op === "not_like" || node.op === "neq";
    return { field: node.field, op: negated ? "not_in" : "in", values: codes.length ? codes : ["\u0000none"] };
  };
  return map(group) as FilterGroup;
}

// ---------------------------------------------------------------- long-term totals

/** Only in the detailed EDRs (docs/BACKEND_PLAN.md §3.7). */
const DETAIL_ONLY: Partial<Record<ReportDimension, string>> = {
  second: "Grouping by second",
  minute: "Grouping by minute",
  customerIp: "The customer IP",
  vendorIp: "The vendor IP",
};
const SENDER_DIMS = new Set<string>(["senderId", "senderGroup", "vendorSenderId", "vendorSenderGroup"]);
/** What edr_sender_daily keeps beside the Sender IDs (ClickHouse 008). */
const SENDER_TABLE_DIMS = new Set<string>([
  ...SENDER_DIMS,
  "date",
  "week",
  "month",
  "customer",
  "customerTrunk",
  "vendor",
  "vendorTrunk",
  "country",
  "destination",
  "vendorCountry",
  "vendorDestination",
  "productCategory",
  "accountManager",
  "vendorAccountManager",
  "businessCompany",
  "msgType",
  "deliveryStatus",
]);
const UTC_ZONES = new Set(["UTC", "Etc/UTC", "GMT", "Etc/GMT"]);

function filterFields(node: FilterGroup | FilterCondition | null | undefined): string[] {
  if (!node) return [];
  return "logic" in node ? node.conditions.flatMap(filterFields) : [node.field];
}

/**
 * The table a report reads: edr_all while every window is within the detailed months, else the 15-minute totals, or
 * the daily Sender ID totals when a Sender ID is grouped or filtered on. Throws PastDetailError for what the totals
 * do not keep.
 */
export function masterSource(
  q: Pick<MasterReportQuery, "groupBy" | "metrics" | "sort" | "timezone" | "hourFrom" | "hourTo">,
  windows: Window[],
  dimFilter: FilterGroup | null,
  now: number,
): EdrSource {
  if (!windows.some((w) => beforeDetail(w.from))) return "edr_all";
  const used = new Set<string>([...q.groupBy, ...filterFields(dimFilter)]);
  for (const f of used) {
    const what = DETAIL_ONLY[f as ReportDimension];
    if (what) throw pastDetail(what);
  }
  const tps = (f: string) => f === "tpsPeak" || f === "tpsNow";
  if (q.metrics.some(tps) || q.sort?.some((x) => tps(x.field))) throw pastDetail("TPS peak and TPS now");
  if (![...used].some((f) => SENDER_DIMS.has(f))) {
    for (const w of windows) checkQuarterBounds(now, w.from, w.to);
    return "edr_totals";
  }
  const other = [...used].find((f) => !SENDER_TABLE_DIMS.has(f));
  if (other)
    throw new PastDetailError(
      `Sender IDs older than ${DETAIL_MONTHS} months are kept per day with partners, trunks, destinations, AMs and statuses; ${DIM_LABELS[other as ReportDimension] ?? other} is not among them`,
    );
  const days = windows.every((w) => w.from.getTime() % 86_400_000 === 0 && w.to.getTime() % 86_400_000 === 0);
  if (!days || !UTC_ZONES.has(q.timezone) || q.hourFrom != null || q.hourTo != null)
    throw new PastDetailError(
      `Sender IDs older than ${DETAIL_MONTHS} months are kept per UTC day: choose the UTC time zone and whole days`,
    );
  return "edr_sender_daily";
}

// ---------------------------------------------------------------- run

export interface ReportResult {
  window: Window;
  previous: Window | null;
  rows: MasterReportRow[];
  totals: { metrics: Record<string, number | null>; previous: Record<string, number | null> | null };
  total: number;
  nextCursor: string | null;
}

const toChTime = (d: Date) => lit(d.toISOString().replace("T", " ").replace("Z", ""));
const timeWhere = (w: Window) =>
  `start_time >= toDateTime64(${toChTime(w.from)}, 3, 'UTC') AND start_time < toDateTime64(${toChTime(w.to)}, 3, 'UTC')`;
const seconds = (w: Window) => Math.max(1, Math.round((w.to.getTime() - w.from.getTime()) / 1000));

/**
 * Latest EDR time: "now" for relative periods in this phase. Cached for a few seconds only: the live
 * simulator writes EDRs every second, so Live analytics must see them (team trial round 1).
 */
let latest: { at: number; t: number } | null = null;
export async function reportNow(): Promise<number> {
  // Production (backend step 11): the clock. The fake data's "now" is its latest EDR, which in production would pull
  // every window back to the last message during a quiet spell.
  if (production) return Date.now();
  if (latest && Date.now() - latest.at < 1_000) return latest.t;
  const r = await chQuery<{ t: string }>("SELECT toString(max(start_time)) AS t FROM edr");
  // The minute after the latest EDR, so the last messages fall inside "today".
  const t = r[0]?.t ? Math.ceil((Date.parse(`${r[0].t.replace(" ", "T")}Z`) + 1) / 60_000) * 60_000 : Date.now();
  latest = { at: Date.now(), t };
  return t;
}

export function windowOf(
  q: Pick<MasterReportQuery, "period" | "from" | "to" | "timezone">,
  now: number,
): Window | string {
  if (q.period === "custom") {
    if (!q.from || !q.to) return "a custom period needs from and to";
    const w = resolvePeriod("custom", q.timezone, now, q);
    if (w.to <= w.from) return "to must be after from";
    if (w.to.getTime() - w.from.getTime() > MAX_DAYS * 86_400_000) return `at most ${MAX_DAYS} days`;
    return w;
  }
  return resolvePeriod(q.period, q.timezone, now);
}

/** Country and MCCMNC labels from PostgreSQL. */
let lookups: {
  at: number;
  country: Map<string, string>;
  mccmnc: Map<string, string>;
  mcc: Map<string, string>;
} | null = null;
async function loadLookups(pool: pg.Pool) {
  if (lookups && Date.now() - lookups.at < 300_000) return lookups;
  const [c, m] = await Promise.all([
    pool.query("SELECT iso, name FROM countries"),
    pool.query(
      `SELECT m.mccmnc, co.name AS country, m.network, m.is_all_networks FROM mccmnc m JOIN countries co ON co.id = m.country_id`,
    ),
  ]);
  lookups = {
    at: Date.now(),
    country: new Map(c.rows.map((r) => [String(r.iso), String(r.name)])),
    mccmnc: new Map(
      m.rows.map((r) => [String(r.mccmnc), `${r.country} · ${r.is_all_networks ? "All networks" : r.network}`]),
    ),
    mcc: new Map(m.rows.map((r) => [String(r.mccmnc).slice(0, 3), String(r.country)])),
  };
  return lookups;
}

export async function runMasterReport(
  pool: pg.Pool,
  q: MasterReportQuery,
  window: Window,
  opts: { all?: boolean } = {},
): Promise<ReportResult> {
  const tz = q.timezone;
  const split = splitFilter(q.filter);
  // Country and destination filters accept names as well as codes ("Nigeria", "MTN", "621").
  if (split.dims) split.dims = await namedToCodes(pool, split.dims);
  const hours = hourSql(q, tz);
  const tw = (w: Window) => `${timeWhere(w)} AND ${hours}`;
  const factor = await sysToPlatformFactor();
  const secs = seconds(window);
  const msql = METRIC_SQL(secs);
  const dimIds = q.groupBy.map((d) => `${DIMS[d].id(tz)} AS d_${d}`);
  const D = dimsFor(q);
  const dimWhere = split.dims ? await chWhere(pool, dimDef(tz, D), { filter: split.dims }) : "1";
  const typeWhere = q.msgType ? `msg_type = ${lit(q.msgType)}` : "1";
  const prevWindow = q.compare && q.compare !== "none" ? previousWindow(window, q.compare) : null;
  const src = masterSource(q, prevWindow ? [window, prevWindow] : [window], split.dims, await reportNow());
  // Live TPS (team trial round 1): the last minute up to now, when the period includes now. "Now" is the
  // latest EDR in this phase (the fake data ends when it was generated); the backend uses its live counters.
  // Counted in the grouped query, so it can be sorted on like any metric.
  const nowMs =
    src === "edr_all" && (q.metrics.includes("tpsNow") || q.sort?.some((x) => x.field === "tpsNow"))
      ? await reportNow()
      : null;
  const nowWindow =
    nowMs !== null && window.from.getTime() <= nowMs && nowMs <= window.to.getTime()
      ? { from: new Date(nowMs - 60_000), to: new Date(nowMs + 1) }
      : null;
  const nowCol = nowWindow ? `countIf(kind = 'attempt' AND ${timeWhere(nowWindow)}) AS now_n` : "0 AS now_n";
  const grouped = (w: Window, extra = "1") =>
    `SELECT ${dimIds.join(", ")}, ${baseSums(factor, src)}, ${nowCol} FROM ${src} WHERE ${tw(w)} AND ${typeWhere} AND ${dimWhere} AND ${extra}
      GROUP BY ${q.groupBy.map((d) => `d_${d}`).join(", ")}`;
  const withMetrics = (w: Window, extra = "1") =>
    `SELECT *, ${Object.entries(msql)
      .map(([k, v]) => `${v} AS ${k}`)
      .join(", ")} FROM (${grouped(w, extra)})`;
  const metricWhere = split.metrics ? await chWhere(pool, metricDef(secs), { filter: split.metrics }) : "1";
  // Labels, also used to sort a group-by field by name (enterprises, trunks, countries, networks) rather
  // than by its internal ID (team trial round 1: sort any column of Live analytics).
  const names = new Map<ReportDimension, Map<number, string>>();
  for (const d of q.groupBy) if (D[d].names) names.set(d, await namesOf(pool, D[d].names!));
  const lk = q.groupBy.some((d) => DIMS[d].lookup) ? await loadLookups(pool) : null;
  const byName = (d: ReportDimension): string => {
    const dim = DIMS[d];
    const m: Map<string | number, string> | null | undefined = dim.names
      ? names.get(d)
      : dim.lookup === "country"
        ? lk?.country
        : dim.lookup === "mcc"
          ? lk?.mcc
          : dim.lookup === "mccmnc"
            ? lk?.mccmnc
            : null;
    if (!m || !m.size) return `d_${d}`;
    const keys = [...m.keys()];
    const numeric = typeof keys[0] === "number";
    const arr = (xs: (string | number)[]) =>
      `[${xs.map((x) => (numeric && typeof x === "number" ? String(x) : lit(String(x)))).join(", ")}]`;
    return `lower(transform(${numeric ? `toInt64(d_${d})` : `toString(d_${d})`}, ${arr(keys)}, ${arr([...m.values()])}, toString(d_${d})))`;
  };
  const sort = (
    q.sort?.length
      ? q.sort
      : [{ field: q.metrics.find((m) => m !== "tpsPeak" && m !== "tpsNow") ?? "attempts", dir: "desc" as const }]
  )
    .filter((s) => s.field !== "tpsPeak")
    .map((s) => {
      const expr = s.field === "tpsNow" ? "now_n" : s.field in DIMS ? byName(s.field as ReportDimension) : s.field;
      return `${expr} ${s.dir === "desc" ? "DESC" : "ASC"}`;
    });
  sort.push(...q.groupBy.map((d) => `d_${d} ASC`));
  const limit = opts.all ? 100_000 : (q.limit ?? 200);
  const offset = opts.all ? 0 : decodeCursor(q.cursor);
  // Totals get "t_" aliases: in ClickHouse a SELECT alias is visible in WHERE, so `sum(x) AS x` would
  // turn the threshold filter on x into an aggregate.
  const sumBase = [
    ...BASE_COLUMNS.map((c) => (c === "companies" ? "max(companies) AS t_companies" : `sum(${c}) AS t_${c}`)),
    "sum(now_n) AS t_now_n",
  ].join(", ");
  const [page, totals, count] = await Promise.all([
    chQuery<Record<string, unknown>>(
      `SELECT * FROM (${withMetrics(window)}) WHERE ${metricWhere} ORDER BY ${sort.join(", ")} LIMIT ${limit + 1} OFFSET ${offset}`,
    ),
    chQuery<Record<string, unknown>>(`SELECT ${sumBase} FROM (${withMetrics(window)}) WHERE ${metricWhere}`),
    chQuery<{ n: string }>(`SELECT count() AS n FROM (${withMetrics(window)}) WHERE ${metricWhere}`),
  ]);
  const more = page.length > limit;
  const rowsRaw = page.slice(0, limit);
  const keyOf = (r: Record<string, unknown>) => q.groupBy.map((d) => String(r[`d_${d}`])).join("|");
  // Tuple of the page's group IDs, for the previous period and the TPS peak.
  const tupleIn = (rs: Record<string, unknown>[]) =>
    rs.length
      ? `tuple(${q.groupBy.map((d) => DIMS[d].id(tz)).join(", ")}) IN (${rs
          .map(
            (r) =>
              `tuple(${q.groupBy.map((d) => (typeof r[`d_${d}`] === "number" ? String(r[`d_${d}`]) : lit(String(r[`d_${d}`])))).join(", ")})`,
          )
          .join(", ")})`
      : "0";
  const wantPeak = q.metrics.includes("tpsPeak");
  const peakSql = (w: Window, rs: Record<string, unknown>[] | null) =>
    `SELECT ${rs ? q.groupBy.map((d) => `d_${d}`).join(", ") + ", " : ""}max(n) AS peak FROM (
       SELECT ${dimIds.join(", ")}, toStartOfMinute(start_time) AS minute, count() AS n FROM edr
        WHERE ${tw(w)} AND ${typeWhere} AND ${dimWhere} AND ${rs ? tupleIn(rs) : "1"}
        GROUP BY ${q.groupBy.map((d) => `d_${d}`).join(", ")}, minute)${rs ? ` GROUP BY ${q.groupBy.map((d) => `d_${d}`).join(", ")}` : ""}`;
  const [prevRows, prevTotals, peaks, peakTotal] = await Promise.all([
    prevWindow && rowsRaw.length
      ? chQuery<Record<string, unknown>>(withMetrics(prevWindow, tupleIn(rowsRaw)))
      : Promise.resolve([]),
    prevWindow
      ? chQuery<Record<string, unknown>>(`SELECT ${sumBase} FROM (${withMetrics(prevWindow)}) WHERE ${metricWhere}`)
      : Promise.resolve(null),
    wantPeak && rowsRaw.length ? chQuery<Record<string, unknown>>(peakSql(window, rowsRaw)) : Promise.resolve([]),
    wantPeak ? chQuery<{ peak: string }>(peakSql(window, null)) : Promise.resolve(null),
  ]);
  const prevByKey = new Map(prevRows.map((r) => [keyOf(r), r]));
  const peakByKey = new Map(peaks.map((r) => [keyOf(r), Number(r.peak)]));
  const tps = (n: number) => Math.round((n / 60) * 100) / 100;
  // In the live minute a group with no messages runs at 0; outside the period's "now" there is no live TPS.
  const tpsNowOf = (n: unknown) => (nowWindow ? tps(Number(n ?? 0)) : null);

  // Labels (names and lookups loaded above)
  const label = (d: ReportDimension, id: unknown): string => {
    const dim = DIMS[d];
    const s = String(id ?? "");
    if (dim.names)
      return Number(id) ? (names.get(d)!.get(Number(id)) ?? `#${s}`) : d.startsWith("vendor") ? "not routed" : "—";
    // Country names alone (team trial round 6: "Brazil", not "Brazil (BR)").
    if (dim.lookup === "country") return s ? (lk!.country.get(s) ?? s) : "unknown";
    if (dim.lookup === "mcc") return s ? `${lk!.mcc.get(s) ?? "Unknown country"} (${s})` : "not routed";
    if (dim.lookup === "mccmnc")
      return s
        ? `${lk!.mccmnc.get(s) ?? "Unknown network"} (${s})`
        : d === "vendorDestination"
          ? "not routed"
          : "unknown";
    if (dim.label) return dim.label(s);
    return s || "—";
  };
  const pick = (r: Record<string, unknown>, extra: Record<string, number | null> = {}) => {
    const out: Record<string, number | null> = {};
    for (const m of q.metrics)
      out[m] =
        m === "tpsPeak" || m === "tpsNow"
          ? (extra[m] ?? null)
          : r[m] === null || r[m] === undefined
            ? null
            : Number(r[m]);
    return out;
  };
  const rows: MasterReportRow[] = rowsRaw.map((r) => {
    const key = keyOf(r);
    const prev = prevByKey.get(key);
    return {
      key,
      dims: Object.fromEntries(
        q.groupBy.map((d) => {
          const id = r[`d_${d}`];
          return [
            d,
            {
              id: typeof id === "number" ? id : id === null || id === undefined ? null : String(id),
              label: label(d, id),
            },
          ];
        }),
      ),
      metrics: pick(r, {
        tpsPeak: peakByKey.has(key) ? tps(peakByKey.get(key)!) : null,
        tpsNow: tpsNowOf(r.now_n),
      }),
      previous: prevWindow ? (prev ? pick(prev) : Object.fromEntries(q.metrics.map((m) => [m, null]))) : null,
    };
  });
  const toBase = (r: Record<string, unknown> | undefined) =>
    Object.fromEntries(BASE_COLUMNS.map((c) => [c, Number(r?.[`t_${c}`] ?? 0)])) as Base;
  const totalMetrics = metricsFromBase(toBase(totals[0]), secs);
  if (wantPeak) totalMetrics.tpsPeak = peakTotal?.[0] ? tps(Number(peakTotal[0].peak)) : null;
  if (q.metrics.includes("tpsNow")) totalMetrics.tpsNow = tpsNowOf(totals[0]?.t_now_n);
  const only = (m: Record<string, number | null>) => Object.fromEntries(q.metrics.map((k) => [k, m[k] ?? null]));
  return {
    window,
    previous: prevWindow,
    rows,
    totals: {
      metrics: only(totalMetrics),
      previous: prevTotals ? only(metricsFromBase(toBase(prevTotals[0]), seconds(prevWindow!))) : null,
    },
    total: Number(count[0]?.n ?? 0),
    nextCursor: more ? encodeCursor(offset + limit) : null,
  };
}

export const METRIC_LABELS: Record<ReportMetric, string> = Object.fromEntries(
  fields.filter((f) => !(f.field in DIMS)).map((f) => [f.field, f.label]),
) as Record<ReportMetric, string>;
export const DIM_LABELS: Record<ReportDimension, string> = Object.fromEntries(
  fields.filter((f) => f.field in DIMS).map((f) => [f.field, f.label]),
) as Record<ReportDimension, string>;
export type { FieldDescriptor };
