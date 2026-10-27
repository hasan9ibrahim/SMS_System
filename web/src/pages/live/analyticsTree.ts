// Live analytics as a drill-down table (§13.4, redesigned in the team trial 2026-10-18): a total row whose
// "+" breaks it down by any level (e.g. Customer), and every row's "+" breaks that row down further by any
// level not already used above it (team trial round 1: no levels to set up front). Every breakdown is a
// Master Report query on the server (CLAUDE.md rule 3) filtered on the row's parents, over a calendar
// period and, each day, an hour range.
import type { FilterCondition, MasterReportQuery, MasterReportRow, ReportDimension, ReportMetric } from "@sms/contract";
import { drillConditions } from "../reports/masterModel";

export const LEVELS: {
  value: ReportDimension;
  label: string;
  time?: boolean;
  /** Offered only under a Numeric row of this level (team trial round 2: each numeric Sender ID). */
  numericOf?: ReportDimension;
}[] = [
  { value: "customer", label: "Customer" },
  { value: "customerTrunk", label: "Customer trunk" },
  { value: "country", label: "Customer country" },
  { value: "destination", label: "Customer network (MCCMNC)" },
  { value: "vendor", label: "Vendor" },
  { value: "vendorTrunk", label: "Vendor trunk" },
  { value: "vendorCountry", label: "Vendor country" },
  { value: "vendorDestination", label: "Vendor network (MCCMNC)" },
  { value: "accountManager", label: "Customer account manager" },
  { value: "vendorAccountManager", label: "Vendor account manager" },
  // Customer Sender ID = what the customer sent us; Vendor Sender ID = what we sent the vendor after translation
  // rules. Numeric ones are one "Numeric" row; only that row's + lists them one by one (team trial round 2).
  { value: "senderGroup", label: "Customer Sender ID" },
  { value: "senderId", label: "Customer Sender ID (each numeric)", numericOf: "senderGroup" },
  { value: "vendorSenderGroup", label: "Vendor Sender ID" },
  { value: "vendorSenderId", label: "Vendor Sender ID (each numeric)", numericOf: "vendorSenderGroup" },
  { value: "productCategory", label: "Product category" },
  { value: "quarterHour", label: "15 minutes", time: true },
  { value: "hour", label: "Hour", time: true },
  { value: "date", label: "Day", time: true },
  { value: "week", label: "Week", time: true },
  { value: "month", label: "Month", time: true },
];
const TIME = new Set<ReportDimension>(["quarterHour", "hour", "date", "week", "month"]);
export const levelLabel = (d: ReportDimension) => LEVELS.find((l) => l.value === d)?.label ?? d;

/**
 * What a row's "+" offers: every level not already used by the row or the rows above it. "Each numeric" Sender ID
 * levels only under a Numeric row of their group (`conds`: the row's and its parents' conditions).
 */
export const levelOptions = (used: readonly ReportDimension[], conds: readonly FilterCondition[] = []) =>
  LEVELS.filter(
    (l) =>
      !used.includes(l.value) &&
      (!l.numericOf || conds.some((c) => c.field === l.numericOf && c.op === "eq" && c.value === "Numeric")),
  );

export type Fmt = "int" | "pct" | "money" | "rate" | "sec" | "tps";
export interface Column {
  metric: ReportMetric;
  /** The whole header on one line, side and unit included ("Billable (C)", "ASR %"; team trial round 1). */
  label: string;
  title: string;
  fmt: Fmt;
}
/**
 * The old platform's Analytics Report columns, plus Attempts and the two DLRs. Success (the same as
 * Submitted) and Reported were dropped at the team's request (trial round 1). Team trial round 3: Ported added,
 * HLR renamed HLR/MNP (back to HLR in team trial round 6), and more columns the user can add (hidden by default), like dashboard panels.
 */
export const ALL_COLUMNS: (Column & { shown: boolean; group: string })[] = [
  {
    metric: "attempts",
    label: "Attempts",
    title: "Messages received from customers",
    fmt: "int",
    shown: true,
    group: "Traffic",
  },
  { metric: "submitted", label: "Submitted", title: "Sent to a vendor", fmt: "int", shown: true, group: "Traffic" },
  {
    metric: "billableCustomer",
    label: "Billable (C)",
    title: "Billable to the customer",
    fmt: "int",
    shown: true,
    group: "Traffic",
  },
  {
    metric: "billableVendor",
    label: "Billable (V)",
    title: "Billable by the vendor",
    fmt: "int",
    shown: true,
    group: "Traffic",
  },
  { metric: "asr", label: "ASR %", title: "Accepted / attempts", fmt: "pct", shown: true, group: "Quality" },
  {
    metric: "dlrCustomer",
    label: "DLR (c)",
    title: "Delivered as reported to the customer (the receipts we send)",
    fmt: "pct",
    shown: true,
    group: "Quality",
  },
  {
    metric: "dlrVendor",
    label: "DLR (v)",
    title: "Delivered as reported by the vendor",
    fmt: "pct",
    shown: true,
    group: "Quality",
  },
  {
    metric: "margin",
    label: "Margin",
    title: "Revenue − cost (platform currency)",
    fmt: "money",
    shown: true,
    group: "Billing",
  },
  {
    metric: "revenue",
    label: "Revenue",
    title: "Customer charges (platform currency)",
    fmt: "money",
    shown: true,
    group: "Billing",
  },
  {
    metric: "cost",
    label: "Cost",
    title: "Vendor charges (platform currency)",
    fmt: "money",
    shown: true,
    group: "Billing",
  },
  {
    metric: "delivered",
    label: "Delivered",
    title: "Delivery receipts DELIVRD from vendors",
    fmt: "int",
    shown: true,
    group: "Traffic",
  },
  {
    metric: "avgRateCustomer",
    label: "Rate (C)",
    title: "Average customer rate per message",
    fmt: "rate",
    shown: true,
    group: "Billing",
  },
  {
    metric: "avgRateVendor",
    label: "Rate (V)",
    title: "Average vendor rate per message",
    fmt: "rate",
    shown: true,
    group: "Billing",
  },
  {
    metric: "deliveryDelayS",
    label: "Delay s",
    title: "Average delivery delay in seconds",
    fmt: "sec",
    shown: true,
    // Under Network, with the HLR and TPS figures (team trial round 6).
    group: "Network",
  },
  { metric: "hlrTotal", label: "HLR", title: "HLR lookups", fmt: "int", shown: true, group: "HLR/MNP" },
  {
    metric: "hlrPorted",
    label: "Ported",
    title: "Numbers the HLR / MNP lookup found ported to another network",
    fmt: "int",
    shown: true,
    group: "HLR/MNP",
  },
  // Live TPS replaced HLR ported (team trial round 1): messages per second over the last minute up to now.
  {
    metric: "tpsNow",
    label: "TPS",
    title: "Live TPS: messages per second over the last minute",
    fmt: "tps",
    shown: true,
    group: "Traffic",
  },
  {
    metric: "hlrCost",
    label: "HLR cost",
    title: "HLR / MNP cost (platform currency)",
    fmt: "money",
    shown: true,
    group: "HLR/MNP",
  },
  // Hidden by default (team trial round 3).
  {
    metric: "hlrCached",
    label: "Cached HLR",
    title:
      "Of all HLR / MNP lookups, numbers already looked up in the last 24 hours: answered from the cache, not looked up again",
    fmt: "int",
    shown: false,
    group: "HLR/MNP",
  },
  {
    metric: "hlrLive",
    label: "Live HLR",
    title: "HLR / MNP lookups sent to a provider (not from the cache)",
    fmt: "int",
    shown: false,
    group: "HLR/MNP",
  },
  {
    metric: "hlrAccomplished",
    label: "HLR answered",
    title: "HLR / MNP lookups that returned a result",
    fmt: "int",
    shown: false,
    group: "HLR/MNP",
  },
  { metric: "marginPct", label: "Margin %", title: "Margin / revenue", fmt: "pct", shown: false, group: "Billing" },
  {
    metric: "costAvg",
    label: "Avg cost",
    title: "Average cost per billable message (platform currency)",
    fmt: "rate",
    shown: false,
    group: "Billing",
  },
  {
    metric: "successful",
    label: "Success",
    title: "Accepted by the platform",
    fmt: "int",
    shown: false,
    group: "Traffic",
  },
  {
    metric: "failedSubmits",
    label: "Failed submits",
    title: "Messages no vendor accepted",
    fmt: "int",
    shown: false,
    group: "Traffic",
  },
  {
    metric: "reroutes",
    label: "Reroutes",
    title: "Messages sent again to another vendor",
    fmt: "int",
    shown: false,
    group: "Traffic",
  },
  {
    metric: "reportedCustomer",
    label: "Reported (C)",
    title: "Delivery receipts sent to the customer",
    fmt: "int",
    shown: false,
    group: "Quality",
  },
  {
    metric: "reportedVendor",
    label: "Reported (V)",
    title: "Delivery receipts received from vendors",
    fmt: "int",
    shown: false,
    group: "Quality",
  },
  {
    metric: "tpsAvg",
    label: "Avg TPS",
    title: "Average messages per second over the period",
    fmt: "tps",
    shown: false,
    group: "Traffic",
  },
  {
    metric: "tpsPeak",
    label: "Peak TPS",
    title: "Busiest second of the period",
    fmt: "tps",
    shown: false,
    group: "Traffic",
  },
  { metric: "moCount", label: "MO", title: "Mobile originated messages", fmt: "int", shown: false, group: "Traffic" },
];
/** The default columns, in order. */
/**
 * Header bands over the columns (team trial round 5): Traffic, Quality, Billing (Money until round 6), Network. A
 * band's columns sit together, in the catalogue's order within the band; the column chooser groups by band too.
 */
export type Band = "traffic" | "quality" | "money" | "network";
export const BANDS: { key: Band; label: string }[] = [
  { key: "traffic", label: "Traffic" },
  { key: "quality", label: "Quality" },
  { key: "money", label: "Billing" },
  { key: "network", label: "Network" },
];
const NETWORK = new Set<string>([
  "deliveryDelayS",
  "hlrTotal",
  "hlrPorted",
  "hlrCached",
  "hlrLive",
  "hlrAccomplished",
  "tpsNow",
  "tpsAvg",
  "tpsPeak",
]);
export function bandOf(c: Pick<Column, "metric" | "fmt">): Band {
  if (NETWORK.has(c.metric)) return "network";
  const g = ALL_COLUMNS.find((x) => x.metric === c.metric)?.group;
  return g === "Quality" ? "quality" : g === "Billing" || g === "HLR/MNP" ? "money" : "traffic";
}
const bandIndex = (c: Column) => BANDS.findIndex((b) => b.key === bandOf(c));
/** Consecutive columns of one band, for the band row of the header. */
export function bandSpans(cols: Column[]): { band: Band; label: string; span: number }[] {
  const out: { band: Band; label: string; span: number }[] = [];
  for (const c of cols) {
    const b = bandOf(c);
    const last = out.at(-1);
    if (last?.band === b) last.span++;
    else out.push({ band: b, label: BANDS.find((x) => x.key === b)!.label, span: 1 });
  }
  return out;
}

export const DEFAULT_COLUMNS: ReportMetric[] = ALL_COLUMNS.filter((c) => c.shown).map((c) => c.metric);
/** The user's saved columns (unknown ones dropped), else the default set. Grouped by band, catalogue order within. */
export function columnsFor(saved: readonly string[] | undefined): Column[] {
  const pick = saved?.length ? new Set(saved) : new Set<string>(DEFAULT_COLUMNS);
  const out = ALL_COLUMNS.filter((c) => pick.has(c.metric));
  const list = out.length ? out : ALL_COLUMNS.filter((c) => c.shown);
  return [...list].sort((a, b) => bandIndex(a) - bandIndex(b));
}
/** The default columns (tests and the detail panel before preferences load). */
export const COLUMNS: Column[] = columnsFor(undefined);
export const METRICS = DEFAULT_COLUMNS;

export function fmt(v: number | null | undefined, kind: Fmt): string {
  if (v === null || v === undefined) return "—";
  switch (kind) {
    case "int":
      return Math.round(v).toLocaleString("en-US");
    case "pct":
      return v.toFixed(2);
    // Money and rates are never rounded: 6 decimals on every row, the total included (team trial round 3).
    case "money":
    case "rate":
      return v.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
    case "sec":
    case "tps":
      return v.toFixed(2);
  }
}

/** The columns shown bold and coloured; the rest stay plain (team trial round 1). */
export const TONED = new Set<ReportMetric>(["asr", "dlrCustomer", "dlrVendor", "margin"]);

/**
 * Cell colour (team trial round 1): ASR and both DLRs green from 80 %, black on orange from 60 % to
 * 80 %, black on red below 60 %; margin green when positive, black on red when negative.
 */
export function cellTone(metric: ReportMetric, v: number | null | undefined): "" | "good" | "pos" | "warn" | "bad" {
  if (v === null || v === undefined) return "";
  if (metric === "asr" || metric === "dlrCustomer" || metric === "dlrVendor")
    return v >= 80 ? "good" : v >= 60 ? "warn" : "bad";
  // Margin: green when positive, red when negative; ASR and DLRs green from 80 % (team trial round 5).
  if (metric === "margin") return v > 0 ? "pos" : v < 0 ? "bad" : "";
  return "";
}

// ---------------------------------------------------------------- period

export interface Settings {
  /** Calendar days, inclusive (YYYY-MM-DD, UTC). */
  fromDate: string;
  toDate: string;
  /** Each day, these hours only (inclusive). */
  hourFrom: number;
  hourTo: number;
  /** One time bucket picked in the detail panel: the top table shows only that moment. */
  at?: { from: string; to: string; label: string } | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
export function presetRange(key: "today" | "yesterday" | "last7" | "thisMonth" | "lastMonth", now = new Date()) {
  const today = day(now);
  const shift = (days: number) => day(new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000));
  const firstOfMonth = `${today.slice(0, 8)}01`;
  switch (key) {
    case "today":
      return { fromDate: today, toDate: today };
    case "yesterday":
      return { fromDate: shift(-1), toDate: shift(-1) };
    case "last7":
      return { fromDate: shift(-6), toDate: today };
    case "thisMonth":
      return { fromDate: firstOfMonth, toDate: today };
    case "lastMonth": {
      const end = day(new Date(Date.parse(`${firstOfMonth}T00:00:00Z`) - 86_400_000));
      return { fromDate: `${end.slice(0, 8)}01`, toDate: end };
    }
  }
}

/** The period includes today, so figures keep coming in (live refresh). */
export const includesToday = (s: Pick<Settings, "toDate">, now = new Date()) => s.toDate >= day(now);

export function rangeProblem(s: Settings): string | null {
  if (!s.fromDate || !s.toDate) return "Pick the From and To days";
  if (s.toDate < s.fromDate) return "To must be on or after From";
  if (Date.parse(s.toDate) - Date.parse(s.fromDate) > 400 * 86_400_000) return "At most 400 days";
  return null;
}

// ---------------------------------------------------------------- queries

/** One breakdown's query: rows by `dim`, filtered on the parents' groups. */
/** A column sort picked in the header: by the row names, or by a metric (team trial round 1). */
export interface ColumnSort {
  key: "name" | ReportMetric;
  dir: "asc" | "desc";
}

/** The next sort when a header is clicked: the same column flips, a new one starts busiest / A–Z first. */
export function nextSort(current: ColumnSort | null, key: ColumnSort["key"]): ColumnSort {
  if (current?.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "name" ? "asc" : "desc" };
}

export function levelQuery(
  s: Settings,
  dim: ReportDimension,
  parents: FilterCondition[],
  limit = 100,
  columnSort: ColumnSort | null = null,
  metrics: readonly ReportMetric[] = METRICS,
): MasterReportQuery {
  const to = s.at ? s.at.to : new Date(Date.parse(`${s.toDate}T00:00:00Z`) + 86_400_000).toISOString();
  const allHours = !!s.at || (s.hourFrom === 0 && s.hourTo === 23);
  return {
    groupBy: [dim],
    metrics: [...metrics],
    // Live screens show enterprises by alias (team trial round 1).
    enterpriseLabel: "alias",
    timezone: "UTC",
    period: "custom",
    from: s.at ? s.at.from : `${s.fromDate}T00:00:00.000Z`,
    to,
    compare: "none",
    ...(allHours ? {} : { hourFrom: s.hourFrom, hourTo: s.hourTo }),
    ...(parents.length ? { filter: { logic: "and", conditions: parents } } : {}),
    // A picked column sorts every breakdown (names by name, server-side); else time levels read in time
    // order and the others busiest first.
    sort: [
      columnSort
        ? { field: columnSort.key === "name" ? dim : columnSort.key, dir: columnSort.dir }
        : { field: TIME.has(dim) ? dim : "attempts", dir: TIME.has(dim) ? "asc" : "desc" },
    ],
    limit,
  };
}

/** The conditions that keep a row's group, added to its parents' (the next level's filter). */
export const childConditions = (parents: FilterCondition[], row: MasterReportRow, dim: ReportDimension) => [
  ...parents,
  ...drillConditions(row, [dim]),
];

// ---------------------------------------------------------------- detail panel

/** How the detail panel under the table splits a row's traffic over time. */
export const DETAIL: { value: ReportDimension; label: string; ms: number }[] = [
  { value: "second", label: "Second", ms: 1000 },
  { value: "minute", label: "Minute", ms: 60_000 },
  { value: "quarterHour", label: "15 minutes", ms: 900_000 },
  { value: "hour", label: "Hour", ms: 3_600_000 },
  { value: "date", label: "Day", ms: 86_400_000 },
];

/** A row's traffic over time, newest first (the detail panel). */
export function detailQuery(
  s: Settings,
  by: ReportDimension,
  conditions: FilterCondition[],
  limit = 500,
  metrics: readonly ReportMetric[] = METRICS,
): MasterReportQuery {
  const q = levelQuery(s, by, conditions, limit, null, metrics);
  return { ...q, sort: [{ field: by, dir: "desc" }] };
}

/** The time window of one detail row ("2026-10-18 02:35" by minute → 02:35:00–02:36:00 UTC). */
export function bucketWindow(by: ReportDimension, id: string): { from: string; to: string; label: string } | null {
  const step = DETAIL.find((d) => d.value === by)?.ms;
  if (!step || id.length < 10) return null;
  const hms = id.length > 10 ? id.slice(11) : "00:00:00";
  const time = hms.length >= 8 ? hms.slice(0, 8) : hms.length >= 5 ? `${hms.slice(0, 5)}:00` : "00:00:00";
  const from = `${id.slice(0, 10)}T${time}.000Z`;
  if (Number.isNaN(Date.parse(from))) return null;
  return { from, to: new Date(Date.parse(from) + step).toISOString(), label: `${id} UTC` };
}
