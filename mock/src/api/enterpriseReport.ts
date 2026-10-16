// Enterprise report (§10 /report/2, §13.31): the billing team's traffic report per customer or
// vendor enterprise, from the EDR store. Day, week and month totals are cut at midnight in the
// chosen time zone: each partner's billing time zone (a trunk's own when set, else its
// enterprise's), UTC, or the platform time zone. Trunks are grouped by time zone and each group
// is aggregated in its own zone; the groups are then combined, filtered, sorted and paged with
// the list grammar (§13.25) on the `enterprise_report` field catalogue.
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  EnterpriseReportExport,
  EnterpriseReportPage,
  EnterpriseReportParams,
  EnterpriseReportQuery,
  EnterpriseReportRow,
  FieldDescriptor,
  FilterCondition,
  FilterGroup,
  ListQuery,
  ReportMetrics,
} from "@sms/contract";
import { PLATFORM_CURRENCY, sysToPlatformFactor } from "../currency.js";
import { db } from "../db.js";
import { chRows } from "../edr.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { PLATFORM_TIMEZONE } from "../platform.js";
import { sendProblem } from "../problem.js";

const FIELDS = listFields.enterprise_report;
const byName = new Map(FIELDS.fields.map((f) => [f.field, f]));
const MAX_DAYS = 400;

/** A ClickHouse string literal. */
const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const ids = (xs: number[]) => xs.map((x) => String(Math.trunc(Number(x)))).join(",");

// ---------------------------------------------------------------- metrics

/** Sums per row, added up when time-zone groups are combined (and for the totals). */
const BASE = [
  "attempts",
  "successful",
  "submitted",
  "billable_c",
  "billable_v",
  "delivered_c",
  "delivered_v",
  "reported_c",
  "reported_v",
  "revenue_p",
  "cost_p",
  "revenue_b",
  "cost_b",
  "delay_sum",
  "delay_n",
  "hlr_cached",
  "hlr_live",
  "hlr_acc",
  "hlr_ported",
  "hlr_cost_b",
  "hlr_cost_p",
] as const;
type Base = Record<(typeof BASE)[number], number>;

/** Per-EDR sums. Money "_p" is in the partner currency, "_b" in the platform currency (§13.9 decision). */
function baseAggregates(side: "customer" | "vendor", factor: string): string {
  const c = side === "customer";
  const ex = c ? "c_ex_rate" : "v_ex_rate";
  return [
    "count() AS attempts",
    "countIf(is_submit_success = 1) AS successful",
    "countIf(v_trunk_id > 0) AS submitted",
    "countIf(is_customer_billable = 1) AS billable_c",
    "countIf(is_vendor_billable = 1) AS billable_v",
    "countIf(c_msg_status = 'DELIVRD') AS delivered_c",
    "countIf(msg_status = 'DELIVRD') AS delivered_v",
    "countIf(c_msg_status NOT IN ('', 'ENROUTE')) AS reported_c",
    "countIf(msg_status NOT IN ('', 'ENROUTE')) AS reported_v",
    // The partner's side is in its own currency; the other side is converted into it via the base.
    `toFloat64(${c ? "sum(revenue)" : `sum(revenue_sys * ${ex})`}) AS revenue_p`,
    `toFloat64(${c ? `sum(cost_sys * ${ex})` : "sum(cost)"}) AS cost_p`,
    `toFloat64(sum(revenue_sys * ${factor})) AS revenue_b`,
    `toFloat64(sum(cost_sys * ${factor})) AS cost_b`,
    "toFloat64(sumIf(delivery_delay_ms, msg_status = 'DELIVRD')) AS delay_sum",
    "countIf(msg_status = 'DELIVRD') AS delay_n",
    "countIf(hlr_fetch_type = 'cached') AS hlr_cached",
    "countIf(hlr_fetch_type = 'live') AS hlr_live",
    "countIf(hlr_is_accomplished = 1) AS hlr_acc",
    "countIf(hlr_is_ported = 1) AS hlr_ported",
    `toFloat64(sum(hlr_cost_sys * ${factor})) AS hlr_cost_b`,
    `toFloat64(sum(hlr_cost_sys * ${ex})) AS hlr_cost_p`,
  ].join(",\n         ");
}

const ratio = (num: string, den: string, scale: number, digits: number) =>
  `if(${den} = 0, NULL, round(${num} / ${den} * ${scale}, ${digits}))`;

/** The §10 metric columns from the sums (ClickHouse, so they can be filtered and sorted). */
const DERIVED: Record<keyof ReportMetrics, string> = {
  attempts: "attempts",
  successful: "successful",
  billableCustomer: "billable_c",
  billableVendor: "billable_v",
  submitted: "submitted",
  asr: ratio("successful", "attempts", 100, 1),
  dlrCustomer: ratio("delivered_c", "successful", 100, 1),
  dlrVendor: ratio("delivered_v", "successful", 100, 1),
  revenue: "round(revenue_p, 4)",
  revenuePlatform: "round(revenue_b, 4)",
  cost: "round(cost_p, 4)",
  costPlatform: "round(cost_b, 4)",
  margin: "round(revenue_b - cost_b, 4)",
  marginPct: ratio("revenue_b - cost_b", "revenue_b", 100, 1),
  avgRateCustomer: ratio("revenue_p", "billable_c", 1, 6),
  avgRateVendor: ratio("cost_p", "billable_v", 1, 6),
  costAvg: ratio("cost_b", "billable_v", 1, 6),
  reportedCustomer: "reported_c",
  reportedVendor: "reported_v",
  deliveryDelayS: ratio("delay_sum", "delay_n", 0.001, 1),
  hlrCached: "hlr_cached",
  hlrLive: "hlr_live",
  hlrTotal: "hlr_cached + hlr_live",
  hlrAccomplished: "hlr_acc",
  hlrPorted: "hlr_ported",
  hlrCost: "round(hlr_cost_p, 4)",
  hlrCostPlatform: "round(hlr_cost_b, 4)",
};

/** The same metrics in JavaScript, for the totals row. */
export function metricsFrom(b: Base): ReportMetrics {
  const r = (num: number, den: number, scale: number, digits: number) =>
    den === 0 ? null : Math.round((num / den) * scale * 10 ** digits) / 10 ** digits;
  const m4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    attempts: b.attempts,
    successful: b.successful,
    billableCustomer: b.billable_c,
    billableVendor: b.billable_v,
    submitted: b.submitted,
    asr: r(b.successful, b.attempts, 100, 1),
    dlrCustomer: r(b.delivered_c, b.successful, 100, 1),
    dlrVendor: r(b.delivered_v, b.successful, 100, 1),
    revenue: m4(b.revenue_p),
    revenuePlatform: m4(b.revenue_b),
    cost: m4(b.cost_p),
    costPlatform: m4(b.cost_b),
    margin: m4(b.revenue_b - b.cost_b),
    marginPct: r(b.revenue_b - b.cost_b, b.revenue_b, 100, 1),
    avgRateCustomer: r(b.revenue_p, b.billable_c, 1, 6),
    avgRateVendor: r(b.cost_p, b.billable_v, 1, 6),
    costAvg: r(b.cost_b, b.billable_v, 1, 6),
    reportedCustomer: b.reported_c,
    reportedVendor: b.reported_v,
    deliveryDelayS: r(b.delay_sum, b.delay_n, 0.001, 1),
    hlrCached: b.hlr_cached,
    hlrLive: b.hlr_live,
    hlrTotal: b.hlr_cached + b.hlr_live,
    hlrAccomplished: b.hlr_acc,
    hlrPorted: b.hlr_ported,
    hlrCost: m4(b.hlr_cost_p),
    hlrCostPlatform: m4(b.hlr_cost_b),
  };
}

/** Partner-currency totals only add up when every row is in the same currency. */
function partnerMoneyIfOneCurrency(m: ReportMetrics, currencies: number): ReportMetrics {
  if (currencies <= 1) return m;
  return { ...m, revenue: null, cost: null, hlrCost: null, avgRateCustomer: null, avgRateVendor: null };
}

// ---------------------------------------------------------------- keys, names, time zones

const BUCKET: Record<string, (tz: string) => string> = {
  hourly: (tz) => `formatDateTime(toStartOfHour(submit_time, ${lit(tz)}), '%Y-%m-%d %H:00', ${lit(tz)})`,
  daily: (tz) => `toString(toDate(submit_time, ${lit(tz)}))`,
  weekly: (tz) => `toString(toMonday(submit_time, ${lit(tz)}))`,
  monthly: (tz) => `toString(toStartOfMonth(submit_time, ${lit(tz)}))`,
};

interface Names {
  enterprises: Map<number, string>;
  trunks: Map<number, string>;
  users: Map<number, string>;
  /** MCCMNC → [country, network]; a 3-digit MCC → [country, ""]. */
  codes: Map<string, [string, string]>;
}

let namesCache: { at: number; side: string; names: Names } | null = null;

async function loadNames(side: "customer" | "vendor"): Promise<Names> {
  if (namesCache && namesCache.side === side && Date.now() - namesCache.at < 60_000) return namesCache.names;
  const trunkTable = side === "customer" ? "customer_trunks" : "vendor_trunks";
  const [e, t, u, m] = await Promise.all([
    db().query("SELECT id, name FROM enterprises"),
    db().query(`SELECT id, name FROM ${trunkTable}`),
    db().query("SELECT id, first_name || ' ' || last_name AS name FROM users"),
    db().query(
      "SELECT m.mccmnc, m.mcc, m.network, m.is_all_networks, co.name AS country FROM mccmnc m JOIN countries co ON co.id = m.country_id",
    ),
  ]);
  const codes = new Map<string, [string, string]>();
  for (const r of m.rows) codes.set(r.mccmnc, [r.country, r.is_all_networks ? "" : r.network]);
  const names: Names = {
    enterprises: new Map(e.rows.map((r) => [Number(r.id), r.name as string])),
    trunks: new Map(t.rows.map((r) => [Number(r.id), r.name as string])),
    users: new Map(u.rows.map((r) => [Number(r.id), r.name as string])),
    codes,
  };
  namesCache = { at: Date.now(), side, names };
  return names;
}

/** ClickHouse: id → name with a literal lookup table. */
function nameOf(expr: string, map: Map<number | string, string>, numeric = true): string {
  if (map.size === 0) return "''";
  const keys = [...map.keys()];
  const k = numeric
    ? `[${keys.map((x) => `toUInt32(${Number(x)})`).join(",")}]`
    : `[${keys.map((x) => lit(String(x))).join(",")}]`;
  const v = `[${[...map.values()].map(lit).join(",")}]`;
  return `transform(${expr}, ${k}, ${v}, '')`;
}

interface TzGroup {
  timezone: string;
  trunkIds: number[];
  enterprises: number;
}

/**
 * Trunks of the report, grouped by the time zone their traffic is cut in: per partner, the
 * trunk's billing time zone when set, else its enterprise's (§13.31).
 */
async function timezoneGroups(p: EnterpriseReportParams): Promise<TzGroup[]> {
  const table = p.side === "customer" ? "customer_trunks" : "vendor_trunks";
  const where: string[] = [];
  const values: unknown[] = [];
  if (p.enterpriseIds?.length) {
    values.push(p.enterpriseIds);
    where.push(`t.enterprise_id = ANY($${values.length})`);
  }
  if (p.trunkIds?.length) {
    values.push(p.trunkIds);
    where.push(`t.id = ANY($${values.length})`);
  }
  // Archived trunks still have traffic to bill (§13.29), so they count.
  const { rows } = await db().query(
    `SELECT t.id, t.enterprise_id, COALESCE(t.billing_timezone, e.billing_timezone, 'UTC') AS tz
       FROM ${table} t JOIN enterprises e ON e.id = t.enterprise_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    values,
  );
  const mode = p.timezone ?? "partner";
  const fixed = mode === "utc" ? "UTC" : mode === "platform" ? PLATFORM_TIMEZONE : null;
  const groups = new Map<string, { trunks: number[]; ents: Set<number> }>();
  for (const r of rows) {
    const tz = fixed ?? (r.tz as string);
    const g = groups.get(tz) ?? { trunks: [], ents: new Set<number>() };
    g.trunks.push(Number(r.id));
    g.ents.add(Number(r.enterprise_id));
    groups.set(tz, g);
  }
  return [...groups].map(([timezone, g]) => ({ timezone, trunkIds: g.trunks, enterprises: g.ents.size }));
}

// ---------------------------------------------------------------- filter grammar → ClickHouse

/** Column of each catalogue field in the combined result. */
const COLUMN: Record<string, string> = {
  period: "period",
  enterpriseName: "enterprise_name",
  enterpriseId: "enterprise_id_out",
  trunkName: "trunk_name",
  trunkId: "trunk_id",
  country: "country",
  mccmnc: "mccmnc",
  network: "network",
  accountManagerName: "am_name",
  currency: "currency",
  timezone: "timezone",
  ...Object.fromEntries(Object.keys(DERIVED).map((k) => [k, k])),
};

const NUMERIC = new Set(["integer", "decimal", "money", "percent"]);

function conditionSql(c: FilterCondition, f: FieldDescriptor): string {
  const x = COLUMN[c.field]!;
  const num = NUMERIC.has(f.type);
  const v = (val: unknown) => (num ? String(Number(val)) : lit(String(val).toLowerCase()));
  const subject = num ? x : `lower(toString(${x}))`;
  const values = c.values ?? [];
  switch (c.op) {
    case "eq":
      return `${subject} = ${v(c.value)}`;
    case "neq":
      return `(isNull(${x}) OR ${subject} != ${v(c.value)})`;
    case "like":
      return `ilike(toString(${x}), ${lit(String(c.value))})`;
    case "not_like":
      return `(isNull(${x}) OR NOT ilike(toString(${x}), ${lit(String(c.value))}))`;
    case "in":
      return `${subject} IN (${values.map(v).join(",")})`;
    case "not_in":
      return `(isNull(${x}) OR ${subject} NOT IN (${values.map(v).join(",")}))`;
    case "between":
      return `${x} BETWEEN ${v(values[0])} AND ${v(values[1])}`;
    case "gt":
      return `${x} > ${v(c.value)}`;
    case "gte":
      return `${x} >= ${v(c.value)}`;
    case "lt":
      return `${x} < ${v(c.value)}`;
    case "lte":
      return `${x} <= ${v(c.value)}`;
    case "empty":
      return `(isNull(${x}) OR toString(${x}) = '')`;
    case "not_empty":
      return `(isNotNull(${x}) AND toString(${x}) != '')`;
    case "regex":
      return `match(toString(${x}), ${lit(`(?i)${String(c.value)}`)})`;
    default:
      return "1";
  }
}

function groupSql(g: FilterGroup): string {
  const parts = g.conditions.map((n) =>
    "logic" in n ? groupSql(n) : conditionSql(n as FilterCondition, byName.get((n as FilterCondition).field)!),
  );
  return parts.length ? `(${parts.join(g.logic === "or" ? " OR " : " AND ")})` : "1";
}

// ---------------------------------------------------------------- the query

export interface ReportResult {
  page: EnterpriseReportPage;
  groups: TzGroup[];
}

function checkParams(p: EnterpriseReportParams): string | null {
  const from = Date.parse(`${p.from}:00Z`);
  const to = Date.parse(`${p.to}:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "/report/from: invalid date";
  if (to <= from) return "/report/to: the end must be after the start";
  if (to - from > MAX_DAYS * 86_400_000) return `/report/to: at most ${MAX_DAYS} days per report`;
  return null;
}

export async function runEnterpriseReport(
  q: EnterpriseReportQuery,
  opts: { all?: boolean } = {},
): Promise<ReportResult> {
  const p = q.report;
  const side = p.side;
  const s = side === "customer" ? "c" : "v";
  const groupBy = p.groupBy ?? ["enterprise", "trunk"];
  const reportBy = p.reportBy ?? "daily";
  const [groups, names, factor] = await Promise.all([timezoneGroups(p), loadNames(side), sysToPlatformFactor()]);
  const empty: EnterpriseReportPage = {
    rows: [],
    totals: metricsFrom(Object.fromEntries(BASE.map((k) => [k, 0])) as Base),
    timezones: groups.map((g) => ({ timezone: g.timezone, enterprises: g.enterprises })),
    platformCurrency: PLATFORM_CURRENCY,
    available: true,
    total: 0,
    totalIsEstimate: false,
    nextCursor: null,
  };
  if (!groups.length) return { page: empty, groups };

  // Keys of a row inside one time-zone group.
  const keys: string[] = [`${s === "c" ? "c_currency" : "v_currency"} AS currency`];
  if (reportBy !== "none") keys.push("PERIOD AS period");
  if (groupBy.includes("enterprise")) keys.push(`${s}_enterprise_id AS enterprise_id`);
  if (groupBy.includes("trunk")) keys.push(`${s}_trunk_id AS trunk_id`, `${s}_enterprise_id AS trunk_enterprise_id`);
  if (groupBy.includes("country") && !groupBy.includes("destination")) keys.push("c_mcc AS mcc");
  if (groupBy.includes("destination")) keys.push("c_mccmnc AS mccmnc_code");
  if (groupBy.includes("account_manager")) keys.push(`${s}_am_user_id AS am_id`);
  const keyNames = keys.map((k) => k.split(" AS ")[1]!);

  const where: string[] = [];
  if (p.msgType) where.push(`msg_type = ${lit(p.msgType)}`);
  if (p.accountManagerIds?.length) where.push(`${s}_am_user_id IN (${ids(p.accountManagerIds)})`);
  if (p.mccmncs?.length) {
    const nets = p.mccmncs.filter((c) => c.length > 3);
    const ccs = p.mccmncs.filter((c) => c.length === 3);
    where.push(
      `(${[
        nets.length ? `c_mccmnc IN (${nets.map(lit).join(",")})` : "",
        ccs.length ? `c_mcc IN (${ccs.map(lit).join(",")})` : "",
      ]
        .filter(Boolean)
        .join(" OR ")})`,
    );
  }
  const aggs = baseAggregates(side, factor);
  const parts = groups.map((g) => {
    const tz = lit(g.timezone);
    const k = keys.map((x) => x.replace("PERIOD", BUCKET[reportBy]?.(g.timezone) ?? "''"));
    return `SELECT ${k.join(", ")}, ${tz} AS timezone,
         ${aggs}
       FROM edr
      WHERE ${s}_trunk_id IN (${ids(g.trunkIds)})
        AND submit_time >= toDateTime64(${lit(`${p.from.replace("T", " ")}:00`)}, 3, ${tz})
        AND submit_time < toDateTime64(${lit(`${p.to.replace("T", " ")}:00`)}, 3, ${tz})
        ${where.map((w) => `AND ${w}`).join(" ")}
      GROUP BY ${keyNames.join(", ")}`;
  });
  // Combine the time-zone groups: rows of different zones only meet when no period is shown.
  const outerKeys = [...keyNames, ...(reportBy !== "none" ? ["timezone"] : [])];
  const code = groupBy.includes("destination") ? "mccmnc_code" : groupBy.includes("country") ? "mcc" : null;
  const countryMap = new Map<string, string>();
  const networkMap = new Map<string, string>();
  for (const [c, [country, network]] of names.codes) {
    countryMap.set(c, country);
    networkMap.set(c, network);
  }
  const combined = `SELECT ${outerKeys.join(", ")},
         ${reportBy !== "none" ? "" : "if(uniqExact(timezone) = 1, any(timezone), 'several') AS timezone,"}
         ${BASE.map((b) => `sum(${b}) AS ${b}`).join(", ")}
       FROM (${parts.join("\n UNION ALL \n")})
      GROUP BY ${outerKeys.join(", ")}`;
  const select = `SELECT *,
         ${reportBy !== "none" ? "" : "NULL AS period,"}
         ${groupBy.includes("trunk") ? "" : "NULL AS trunk_id,"}
         ${groupBy.includes("enterprise") ? nameOf("enterprise_id", names.enterprises) : groupBy.includes("trunk") ? nameOf("trunk_enterprise_id", names.enterprises) : "NULL"} AS enterprise_name,
         ${groupBy.includes("enterprise") ? "enterprise_id" : groupBy.includes("trunk") ? "trunk_enterprise_id" : "NULL"} AS enterprise_id_out,
         ${groupBy.includes("trunk") ? nameOf("trunk_id", names.trunks) : "NULL"} AS trunk_name,
         ${code ? nameOf(code, countryMap, false) : "NULL"} AS country,
         ${code === "mccmnc_code" ? "mccmnc_code" : code === "mcc" ? "mcc" : "NULL"} AS mccmnc,
         ${code === "mccmnc_code" ? nameOf(code, networkMap, false) : "NULL"} AS network,
         ${groupBy.includes("account_manager") ? `if(am_id = 0, 'No account manager', ${nameOf("am_id", names.users)})` : "NULL"} AS am_name,
         ${Object.entries(DERIVED)
           .map(([k, sql]) => `${sql} AS ${k}`)
           .join(",\n         ")}
       FROM (${combined})`;

  const filterSql = [q.filter ? groupSql(q.filter) : "1"];
  if (q.search?.trim()) {
    const term = lit(`%${q.search.trim()}%`);
    filterSql.push(
      `(${["enterprise_name", "trunk_name", "country", "network", "am_name", "mccmnc", "period"].map((c) => `ilike(toString(${c}), ${term})`).join(" OR ")})`,
    );
  }
  const sort = (q.sort?.length ? q.sort : FIELDS.defaultSort).filter((k) => COLUMN[k.field]);
  const order = [
    ...sort.map((k) => `${COLUMN[k.field]} ${k.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`),
    // Stable order for paging.
    "period ASC",
    "enterprise_name ASC",
    "trunk_name ASC",
    "mccmnc ASC",
    "am_name ASC",
    "currency ASC",
    "timezone ASC",
  ].join(", ");
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const limit = opts.all ? 100_000 : (q.limit ?? 200);
  const filtered = `(${select}) WHERE ${filterSql.join(" AND ")}`;
  const [rows, totals] = await Promise.all([
    chRows<Record<string, unknown>>(
      `SELECT * FROM ${filtered} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      15_000,
    ),
    chRows<Record<string, unknown>>(
      `SELECT count() AS n, uniqExact(currency) AS currencies, ${BASE.map((b) => `sum(${b}) AS ${b}`).join(", ")} FROM ${filtered}`,
      15_000,
    ),
  ]);
  if (!rows || !totals) return { page: { ...empty, available: false }, groups };
  const t = totals[0] ?? {};
  const total = Number(t.n ?? 0);
  const out: EnterpriseReportRow[] = rows.map((r, i) => {
    const metrics = Object.fromEntries(
      Object.keys(DERIVED).map((k) => [k, r[k] === null || r[k] === undefined ? null : Number(r[k])]),
    ) as unknown as ReportMetrics;
    const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
    const int = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      id: offset + i + 1,
      period: str(r.period),
      enterpriseId: int(r.enterprise_id_out),
      enterpriseName: str(r.enterprise_name),
      trunkId: groupBy.includes("trunk") ? int(r.trunk_id) : null,
      trunkName: str(r.trunk_name),
      country: str(r.country),
      mccmnc: str(r.mccmnc),
      network: str(r.network),
      accountManagerId: groupBy.includes("account_manager") && Number(r.am_id) > 0 ? Number(r.am_id) : null,
      accountManagerName: str(r.am_name),
      currency: String(r.currency || "—"),
      timezone: String(r.timezone),
      ...metrics,
    };
  });
  const next = offset + out.length;
  return {
    groups,
    page: {
      ...empty,
      rows: out,
      totals: partnerMoneyIfOneCurrency(
        metricsFrom(Object.fromEntries(BASE.map((k) => [k, Number(t[k] ?? 0)])) as Base),
        Number(t.currencies ?? 0),
      ),
      total,
      nextCursor: !opts.all && next < total ? String(next) : null,
    },
  };
}

function checkQuery(q: EnterpriseReportQuery) {
  const param = checkParams(q.report);
  if (param) {
    const [path, message] = param.split(": ");
    return [{ path: path!, message: message! }];
  }
  return checkListQuery(
    { ...(q.filter ? { filter: q.filter } : {}), ...(q.sort ? { sort: q.sort } : {}) } as ListQuery,
    FIELDS,
  );
}

export async function queryEnterpriseReport(request: FastifyRequest, reply: FastifyReply) {
  const q = request.body as EnterpriseReportQuery;
  const errors = checkQuery(q);
  if (errors.length) return sendProblem(reply, 400, "Check the report settings", { errors });
  return (await runEnterpriseReport(q)).page;
}

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const MODE_LABEL = { partner: "partner billing time zone", utc: "UTC", platform: "platform time zone" } as const;

export async function exportEnterpriseReport(request: FastifyRequest, reply: FastifyReply) {
  const q = request.body as EnterpriseReportQuery & Pick<EnterpriseReportExport, "columns">;
  const errors = checkQuery(q);
  if (errors.length) return sendProblem(reply, 400, "Check the report settings", { errors });
  const { page } = await runEnterpriseReport(q, { all: true });
  if (!page.available) return sendProblem(reply, 503, "The EDR store is not answering");
  const cols = (q.columns?.length ? q.columns : FIELDS.fields.filter((f) => !f.hidden).map((f) => f.field)).filter(
    (c) => byName.has(c),
  );
  const p = q.report;
  const zones = page.timezones.map((z) => `${z.timezone} (${z.enterprises})`).join("; ");
  // The time zone is printed on every export (§13.31).
  const head = [
    [`Enterprise report (${p.side} side)`],
    [`Period`, `${p.from.replace("T", " ")} to ${p.to.replace("T", " ")}`],
    [`Time zone`, `${MODE_LABEL[p.timezone ?? "partner"]}: ${zones}`],
    [`Platform currency`, page.platformCurrency],
    [],
  ];
  const rows = [
    cols.map((c) => byName.get(c)!.label),
    ...page.rows.map((r) => cols.map((c) => (r as unknown as Record<string, unknown>)[c])),
    ["Total", ...cols.slice(1).map((c) => (page.totals as unknown as Record<string, unknown>)[c] ?? "")],
  ];
  reply.header("content-type", "text/csv; charset=utf-8");
  reply.header("content-disposition", `attachment; filename="enterprise-report-${p.side}-${p.from.slice(0, 10)}.csv"`);
  return [...head, ...rows].map((r) => r.map(csv).join(",")).join("\r\n") + "\r\n";
}
