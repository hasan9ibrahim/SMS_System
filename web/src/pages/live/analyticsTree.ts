// Live analytics as a drill-down table (§13.4, redesigned in the team trial 2026-10-18): a total row,
// then rows by the first level (e.g. Customer); each row opens into the next level (e.g. Customer trunk,
// Destination, 15 minutes …). Every level is a Master Report query on the server (CLAUDE.md rule 3)
// filtered on the row's parents, over a calendar period and, each day, an hour range.
import type { FilterCondition, MasterReportQuery, MasterReportRow, ReportDimension, ReportMetric } from "@sms/contract";
import { drillConditions } from "../reports/masterModel";

export const LEVELS: { value: ReportDimension; label: string; time?: boolean }[] = [
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
  { value: "senderId", label: "Sender ID" },
  { value: "productCategory", label: "Product category" },
  { value: "quarterHour", label: "15 minutes", time: true },
  { value: "hour", label: "Hour", time: true },
  { value: "date", label: "Day", time: true },
  { value: "week", label: "Week", time: true },
  { value: "month", label: "Month", time: true },
];
const TIME = new Set<ReportDimension>(["quarterHour", "hour", "date", "week", "month"]);
export const levelLabel = (d: ReportDimension) => LEVELS.find((l) => l.value === d)?.label ?? d;

export type Fmt = "int" | "pct" | "money" | "rate" | "sec";
export interface Column {
  metric: ReportMetric;
  label: string;
  /** Second header line (side or unit), so every header is two even lines (team trial round 1). */
  sub?: string;
  title: string;
  fmt: Fmt;
}
/**
 * The old platform's Analytics Report columns, plus Attempts and the two DLRs. Success (the same as
 * Submitted) and Reported were dropped at the team's request (trial round 1).
 */
export const COLUMNS: Column[] = [
  { metric: "attempts", label: "Attempts", title: "Messages received from customers", fmt: "int" },
  { metric: "submitted", label: "Submitted", sub: "to vendor", title: "Sent to a vendor", fmt: "int" },
  { metric: "billableCustomer", label: "Billable", sub: "(C)", title: "Billable to the customer", fmt: "int" },
  { metric: "billableVendor", label: "Billable", sub: "(V)", title: "Billable by the vendor", fmt: "int" },
  { metric: "asr", label: "ASR", sub: "%", title: "Accepted / attempts", fmt: "pct" },
  {
    metric: "dlrCustomer",
    label: "DLR (c)",
    sub: "%",
    title: "Delivered as reported to the customer (the receipts we send)",
    fmt: "pct",
  },
  { metric: "dlrVendor", label: "DLR (v)", sub: "%", title: "Delivered as reported by the vendor", fmt: "pct" },
  { metric: "margin", label: "Margin", title: "Revenue − cost (platform currency)", fmt: "money" },
  { metric: "revenue", label: "Revenue", title: "Customer charges (platform currency)", fmt: "money" },
  { metric: "cost", label: "Cost", title: "Vendor charges (platform currency)", fmt: "money" },
  { metric: "delivered", label: "Delivered", title: "Delivery receipts DELIVRD from vendors", fmt: "int" },
  { metric: "avgRateCustomer", label: "Rate", sub: "(C)", title: "Average customer rate per message", fmt: "rate" },
  { metric: "avgRateVendor", label: "Rate", sub: "(V)", title: "Average vendor rate per message", fmt: "rate" },
  { metric: "deliveryDelayS", label: "Delay", sub: "sec", title: "Average delivery delay in seconds", fmt: "sec" },
  { metric: "hlrTotal", label: "HLR", title: "HLR lookups", fmt: "int" },
  { metric: "hlrPorted", label: "HLR", sub: "ported", title: "Lookups that found the number ported", fmt: "int" },
  { metric: "hlrCost", label: "HLR", sub: "cost", title: "HLR cost (platform currency)", fmt: "money" },
];
export const METRICS = COLUMNS.map((c) => c.metric);

export function fmt(v: number | null | undefined, kind: Fmt): string {
  if (v === null || v === undefined) return "—";
  switch (kind) {
    case "int":
      return Math.round(v).toLocaleString("en-US");
    case "pct":
      return v.toFixed(2);
    case "money": {
      // Whole units from 1,000 up, so every column fits without scrolling (team trial round 1).
      const d = Math.abs(v) >= 1000 ? 0 : 2;
      return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    case "rate":
      return v.toFixed(5);
    case "sec":
      return v.toFixed(2);
  }
}

/** Cell highlight: DLR and ASR amber or red below their thresholds, a negative margin red. */
export function cellTone(metric: ReportMetric, v: number | null | undefined): "" | "warn" | "bad" {
  if (v === null || v === undefined) return "";
  if (metric === "dlrCustomer" || metric === "dlrVendor") return v < 60 ? "bad" : v < 80 ? "warn" : "";
  if (metric === "asr") return v < 75 ? "bad" : v < 90 ? "warn" : "";
  if (metric === "margin") return v < 0 ? "bad" : "";
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
  levels: ReportDimension[];
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
  if (!s.levels.length) return "Pick at least one level";
  return null;
}

// ---------------------------------------------------------------- queries

/** One level's query: its rows filtered on the parents' groups. */
export function levelQuery(s: Settings, depth: number, parents: FilterCondition[], limit = 100): MasterReportQuery {
  const to = s.at ? s.at.to : new Date(Date.parse(`${s.toDate}T00:00:00Z`) + 86_400_000).toISOString();
  const allHours = !!s.at || (s.hourFrom === 0 && s.hourTo === 23);
  return {
    groupBy: [s.levels[depth]!],
    metrics: METRICS,
    timezone: "UTC",
    period: "custom",
    from: s.at ? s.at.from : `${s.fromDate}T00:00:00.000Z`,
    to,
    compare: "none",
    ...(allHours ? {} : { hourFrom: s.hourFrom, hourTo: s.hourTo }),
    ...(parents.length ? { filter: { logic: "and", conditions: parents } } : {}),
    // Time levels read in time order; the others busiest first.
    sort: [
      {
        field: TIME.has(s.levels[depth]!) ? s.levels[depth]! : "attempts",
        dir: TIME.has(s.levels[depth]!) ? "asc" : "desc",
      },
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
): MasterReportQuery {
  const q = levelQuery({ ...s, levels: [by] }, 0, conditions, limit);
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
