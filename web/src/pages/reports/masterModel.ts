// Pure helpers for the Master Report and department reports (§10, §13.15): group-by and metric
// columns, settings in the tab URL, drill-down filters, the EDRs behind a row, deltas and time zones.
import type {
  FilterCondition,
  MasterReportRow,
  MasterReportSettings,
  ReportDimension,
  ReportMetric,
  ReportPeriod,
} from "@sms/contract";
import { emptyState, encodeState, type GridState } from "../../grid/filterModel";

export const DIMENSIONS: ReportDimension[] = [
  "second",
  "minute",
  "quarterHour",
  "date",
  "hour",
  "week",
  "month",
  "customer",
  "customerTrunk",
  "customerIp",
  "vendor",
  "vendorTrunk",
  "vendorIp",
  "country",
  "destination",
  "vendorCountry",
  "vendorDestination",
  "productCategory",
  "senderId",
  "routeRule",
  "routeType",
  "rateTable",
  "accountManager",
  "vendorAccountManager",
  "businessCompany",
  "currency",
  "msgType",
  "hlrProvider",
  "errorCode",
  "deliveryStatus",
];
const DIM_SET = new Set<string>(DIMENSIONS);
export const isDimension = (f: string): f is ReportDimension => DIM_SET.has(f);

/** Group-by fields and metrics from the grid's visible columns (dimensions first, in order). */
export function splitVisible(visible: string[]): { groupBy: ReportDimension[]; metrics: ReportMetric[] } {
  return {
    groupBy: visible.filter(isDimension).slice(0, 5),
    metrics: visible.filter((f) => !isDimension(f)) as ReportMetric[],
  };
}
export const visibleOf = (s: Pick<MasterReportSettings, "groupBy" | "metrics">) => [...s.groupBy, ...s.metrics];

export type Settings = Pick<
  MasterReportSettings,
  "period" | "from" | "to" | "timezone" | "msgType" | "compare" | "hourFrom" | "hourTo"
>;
export const defaultSettings = (s?: Partial<MasterReportSettings>): Settings => ({
  period: s?.period ?? "yesterday",
  from: s?.from ?? null,
  to: s?.to ?? null,
  timezone: s?.timezone ?? "UTC",
  msgType: s?.msgType ?? null,
  compare: s?.compare ?? "none",
  hourFrom: s?.hourFrom ?? null,
  hourTo: s?.hourTo ?? null,
});
export const encodeSettings = (s: Settings) => btoa(JSON.stringify(s)).replace(/=+$/, "");
export function decodeSettings(raw: string | null, fallback: Settings): Settings {
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(atob(raw)) as Partial<Settings>) };
  } catch {
    return fallback;
  }
}

/** A grid row: an id from the group key, dimension labels and metric values side by side. */
export type FlatRow = { id: number; key: string; row: MasterReportRow } & Record<string, unknown>;
export function rowId(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) * 1024 + (key.length % 1024);
}
export function flatten(r: MasterReportRow): FlatRow {
  const out: FlatRow = { id: rowId(r.key), key: r.key, row: r };
  for (const [d, v] of Object.entries(r.dims)) out[d] = v.label;
  for (const [m, v] of Object.entries(r.metrics)) out[m] = v;
  return out;
}

/** Change against the previous period in %, null when there is no base. */
export const deltaPct = (cur: number | null | undefined, prev: number | null | undefined) =>
  cur === null || cur === undefined || !prev ? null : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;

/** Group-by fields filtered by name (their filter matches names); the rest by their ID. */
const BY_NAME = new Set<ReportDimension>([
  "customer",
  "customerTrunk",
  "vendor",
  "vendorTrunk",
  "productCategory",
  "routeRule",
  "rateTable",
  "accountManager",
  "vendorAccountManager",
  "businessCompany",
  "hlrProvider",
]);
const ENUMS = new Set<ReportDimension>(["msgType", "errorCode", "deliveryStatus"]);

/** Drill-down: conditions that keep only this row's group (on its group-by fields). */
export function drillConditions(row: MasterReportRow, groupBy: ReportDimension[]): FilterCondition[] {
  return groupBy.map((d) => {
    const cell = row.dims[d]!;
    if (BY_NAME.has(d))
      return cell.id === 0 || cell.id === null ? { field: d, op: "empty" } : { field: d, op: "eq", value: cell.label };
    if (ENUMS.has(d)) return { field: d, op: "in", values: [String(cell.id ?? "")] };
    return cell.id === "" || cell.id === null
      ? { field: d, op: "empty" }
      : { field: d, op: "eq", value: String(cell.id) };
  });
}

/** EDR Search fields that hold each group-by field's ID (date parts narrow the time instead). */
const EDR_FIELD: Partial<Record<ReportDimension, string>> = {
  customer: "customerEnterpriseId",
  customerTrunk: "customerTrunkId",
  customerIp: "customerIp",
  vendor: "vendorEnterpriseId",
  vendorTrunk: "vendorTrunkId",
  vendorIp: "vendorIp",
  country: "country",
  destination: "customerMccmnc",
  vendorDestination: "vendorMccmnc",
  productCategory: "productCategoryId",
  senderId: "senderId",
  routeRule: "routeRuleId",
  rateTable: "customerRateTableId",
  businessCompany: "businessCompanyId",
  currency: "customerCurrency",
  msgType: "type",
  hlrProvider: "hlrProviderId",
  errorCode: "causeCode",
  deliveryStatus: "msgStatus",
};
const INTEGER_EDR = new Set([
  "customerEnterpriseId",
  "customerTrunkId",
  "vendorEnterpriseId",
  "vendorTrunkId",
  "productCategoryId",
  "routeRuleId",
  "customerRateTableId",
  "businessCompanyId",
  "hlrProviderId",
]);

/**
 * EDR Search filters for the messages behind a row, in the report window (UTC hours for an hour or
 * 15-minute row). A drill-down row passes its whole chain (parents first).
 */
export function edrGridState(
  chain: { row: MasterReportRow; dims: ReportDimension[] }[],
  from: string,
  to: string,
): GridState {
  const columns: Record<string, FilterCondition> = {};
  let start = from;
  let end = to;
  for (const { row, dims } of chain)
    for (const d of dims) {
      const id = row.dims[d]!.id;
      const timeSpan = { hour: 3_600_000, quarterHour: 900_000, minute: 60_000, second: 1000 }[d as string] ?? 0;
      if (timeSpan && typeof id === "string" && id.length >= 13 && from.endsWith("Z")) {
        // time ids are in the report's time zone; only exact in UTC ("YYYY-MM-DD HH:MM[:SS]")
        const hms = id.slice(11);
        start = `${id.slice(0, 10)}T${hms.length >= 8 ? hms.slice(0, 8) : `${hms.slice(0, 5)}:00`}.000Z`;
        end = new Date(Date.parse(start) + timeSpan).toISOString();
        continue;
      }
      if (d === "date" && typeof id === "string") {
        start = `${id}T00:00:00.000Z`;
        end = new Date(Date.parse(start) + 86_400_000).toISOString();
        continue;
      }
      const field = EDR_FIELD[d];
      if (!field || id === null) continue;
      if (field === "causeCode" || field === "msgStatus" || field === "type")
        columns[field] = { field, op: "in", values: [String(id)] };
      else columns[field] = { field, op: "eq", value: INTEGER_EDR.has(field) ? Number(id) : String(id) };
    }
  columns.startTime = { field: "startTime", op: "between", values: [start, end] };
  return { ...emptyState(), columns };
}

/** EDR Search for the messages behind a row, in the report window (UTC hours for an hour row). */
export function edrSearchPath(row: MasterReportRow, groupBy: ReportDimension[], from: string, to: string): string {
  return `/monitoring/edr?g=${encodeState(edrGridState([{ row, dims: groupBy }], from, to))}`;
}

export const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_24_hours", label: "Last 24 hours" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "this_week", label: "This week" },
  { value: "last_week", label: "Last week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom" },
];

/**
 * The window a period stands for, in UTC, to show in the From / To boxes (team trial round 1). A custom
 * period is its own from / to; the server works the presets out in the report's time zone.
 */
export function periodWindow(
  s: Pick<Settings, "period" | "from" | "to">,
  now = new Date(),
): { from: string | null; to: string | null } {
  if (s.period === "custom") return { from: s.from ?? null, to: s.to ?? null };
  const DAY = 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  const month = (offset: number) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1);
  const iso = (ms: number) => new Date(ms).toISOString();
  switch (s.period) {
    case "today":
      return { from: iso(today), to: iso(today + DAY) };
    case "yesterday":
      return { from: iso(today - DAY), to: iso(today) };
    case "last_24_hours":
      return { from: iso(now.getTime() - DAY), to: iso(now.getTime()) };
    case "last_7_days":
      return { from: iso(today - 6 * DAY), to: iso(today + DAY) };
    case "this_week":
      return { from: iso(monday), to: iso(monday + 7 * DAY) };
    case "last_week":
      return { from: iso(monday - 7 * DAY), to: iso(monday) };
    case "this_month":
      return { from: iso(month(0)), to: iso(month(1)) };
    case "last_month":
      return { from: iso(month(-1)), to: iso(month(0)) };
    default:
      return { from: null, to: null };
  }
}

/** The 31 zones of the §10 Timezone picker: whole hours as Etc/GMT (sign reversed), plus the half-hour zones. */
export const TIMEZONES: { value: string; label: string }[] = [
  { value: "UTC", label: "UTC (GMT+00:00)" },
  ...Array.from({ length: 25 }, (_, i) => i - 12)
    .filter((h) => h !== 0)
    .map((h) => ({
      value: `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`,
      label: `GMT${h > 0 ? "+" : "−"}${String(Math.abs(h)).padStart(2, "0")}:00`,
    })),
  { value: "America/St_Johns", label: "GMT−03:30 (St John's)" },
  { value: "Asia/Tehran", label: "GMT+03:30 (Tehran)" },
  { value: "Asia/Kabul", label: "GMT+04:30 (Kabul)" },
  { value: "Asia/Kolkata", label: "GMT+05:30 (India)" },
  { value: "Asia/Kathmandu", label: "GMT+05:45 (Kathmandu)" },
  { value: "Australia/Darwin", label: "GMT+09:30 (Darwin)" },
].sort((a, b) => offsetOf(a.value) - offsetOf(b.value));
function offsetOf(tz: string): number {
  const m = /^Etc\/GMT([+-])(\d+)$/.exec(tz);
  if (m) return (m[1] === "-" ? 1 : -1) * Number(m[2]) * 60;
  return (
    {
      UTC: 0,
      "America/St_Johns": -210,
      "Asia/Tehran": 210,
      "Asia/Kabul": 270,
      "Asia/Kolkata": 330,
      "Asia/Kathmandu": 345,
      "Australia/Darwin": 570,
    }[tz] ?? 0
  );
}

/** Metric display: money and rates with fixed decimals, percentages with one. */
export function fmtMetric(m: string, v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (m === "avgRateCustomer" || m === "avgRateVendor" || m === "costAvg") return v.toFixed(5);
  if (["revenue", "cost", "margin", "revenueBase", "costBase", "hlrCost"].includes(m))
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (["asr", "dlrCustomer", "dlrVendor", "marginPct"].includes(m)) return `${v.toFixed(1)} %`;
  if (m === "tpsAvg" || m === "tpsPeak" || m === "tpsNow" || m === "deliveryDelayS") return v.toFixed(m === "deliveryDelayS" ? 1 : 2);
  return v.toLocaleString("en-US");
}
/** Higher is worse for these (the delta arrow turns red when they go up). */
export const LOWER_IS_BETTER = new Set([
  "failedSubmits",
  "deliveryDelayS",
  "cost",
  "costBase",
  "costAvg",
  "reroutes",
  "hlrCost",
]);
