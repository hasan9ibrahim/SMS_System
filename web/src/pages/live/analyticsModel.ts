// Live Analytics (§13.4) without React: Report By and its Master Report field, threshold colours,
// which cells changed between two snapshots (green up / red down highlight), and historical periods
// built from the Master Report (they stay standard queries).
import type { AnalyticsJoinParams, AnalyticsSnapshotEvent, MasterReportPage, MasterReportQuery } from "@sms/contract";

export type Row = AnalyticsSnapshotEvent["rows"][number];
export type GroupBy = AnalyticsJoinParams["groupBy"];
export type SortKey = NonNullable<AnalyticsJoinParams["sort"]>;
export type Period = "live" | "yesterday" | "this_week" | "this_month";

export const GROUPS: { value: GroupBy; label: string; dim: MasterReportQuery["groupBy"][number] }[] = [
  { value: "customer", label: "Customer", dim: "customer" },
  { value: "customer_trunk", label: "Customer trunk", dim: "customerTrunk" },
  { value: "vendor", label: "Vendor", dim: "vendor" },
  { value: "vendor_trunk", label: "Vendor trunk", dim: "vendorTrunk" },
  { value: "destination", label: "Destination", dim: "destination" },
  { value: "country", label: "Country", dim: "country" },
];
export const PERIODS: { value: Period; label: string }[] = [
  { value: "live", label: "Today (live)" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
];
export const isGroup = (v: string | null): v is GroupBy => GROUPS.some((g) => g.value === v);

/**
 * Columns that flash when they change (§13.4: only changed cells update, with a highlight). Today's
 * counters grow every update, so only the rates flash, and only on a visible change.
 */
export const FLASH_KEYS = ["asr", "dlr", "marginPct", "tps"] as const;
type FlashKey = (typeof FLASH_KEYS)[number];
const MIN_CHANGE: Record<FlashKey, (a: number, b: number) => boolean> = {
  asr: (a, b) => Math.abs(a - b) >= 0.1,
  dlr: (a, b) => Math.abs(a - b) >= 0.1,
  marginPct: (a, b) => Math.abs(a - b) >= 0.1,
  tps: (a, b) => Math.abs(a - b) >= Math.max(0.2, Math.abs(a) * 0.05),
};

/** Per row key and column: +1 went up, -1 went down since the previous snapshot. */
export function changes(prev: Row[] | null, next: Row[]): Map<string, Partial<Record<FlashKey, 1 | -1>>> {
  const out = new Map<string, Partial<Record<FlashKey, 1 | -1>>>();
  if (!prev) return out;
  const before = new Map(prev.map((r) => [r.key, r]));
  for (const r of next) {
    const b = before.get(r.key);
    if (!b) continue;
    const d: Partial<Record<FlashKey, 1 | -1>> = {};
    for (const k of FLASH_KEYS) {
      const x = b[k];
      const y = r[k];
      if (x !== null && y !== null && MIN_CHANGE[k](x, y)) d[k] = y > x ? 1 : -1;
    }
    if (Object.keys(d).length) out.set(r.key, d);
  }
  return out;
}

/** Green / amber / red by threshold (§13.4 consistent colours). */
export function tone(metric: "asr" | "dlr" | "marginPct", v: number | null): "good" | "warning" | "error" | "" {
  if (v === null) return "";
  const [good, warn] = metric === "asr" ? [90, 75] : metric === "dlr" ? [80, 60] : [10, 0];
  return v >= good ? "good" : v >= warn ? "warning" : "error";
}

/** A higher value is bad for cost only; a drop in volume, ASR, DLR, revenue or margin is bad. */
export const badWhenUp = (k: string) => k === "cost";

const SORT_METRIC: Partial<Record<SortKey, string>> = {
  attempts: "attempts",
  delivered: "delivered",
  asr: "asr",
  revenue: "revenue",
  cost: "cost",
  margin: "margin",
  marginPct: "marginPct",
};

/** The Master Report query behind a historical period (same Report By, search and sort). */
export function historicalQuery(
  groupBy: GroupBy,
  period: Exclude<Period, "live">,
  search: string,
  sort: SortKey,
  dir: "asc" | "desc",
): MasterReportQuery {
  const g = GROUPS.find((x) => x.value === groupBy)!;
  const vendorSide = groupBy === "vendor" || groupBy === "vendor_trunk";
  const dlr = vendorSide ? "dlrVendor" : "dlrCustomer";
  const field = sort === "name" ? g.dim : sort === "dlr" ? dlr : (SORT_METRIC[sort] ?? "attempts");
  return {
    groupBy: [g.dim],
    metrics: ["attempts", "successful", "delivered", "asr", dlr, "revenue", "cost", "margin", "marginPct", "tpsAvg"],
    timezone: "UTC",
    period,
    compare: "none",
    ...(search.trim()
      ? { filter: { logic: "and", conditions: [{ field: g.dim, op: "like", value: search.trim() }] } }
      : {}),
    sort: [{ field, dir }],
    limit: 200,
  };
}

/** Master Report rows in the live table's shape (no sparkline or compare column). */
export function rowsFromReport(page: MasterReportPage, groupBy: GroupBy): Row[] {
  const g = GROUPS.find((x) => x.value === groupBy)!;
  const vendorSide = groupBy === "vendor" || groupBy === "vendor_trunk";
  return page.rows.map((r) => {
    const m = r.metrics;
    const d = r.dims[g.dim];
    return {
      key: r.key,
      id: (d?.id ?? r.key) as number | string,
      name: d?.label ?? r.key,
      parent: null,
      attempts: m.attempts ?? 0,
      submitted: m.successful ?? 0,
      delivered: m.delivered ?? 0,
      asr: m.asr ?? null,
      dlr: (vendorSide ? m.dlrVendor : m.dlrCustomer) ?? null,
      revenue: vendorSide ? null : (m.revenue ?? null),
      cost: m.cost ?? null,
      margin: vendorSide ? null : (m.margin ?? null),
      marginPct: vendorSide ? null : (m.marginPct ?? null),
      tps: m.tpsAvg ?? null,
      tpsBefore: null,
      changePct: null,
      sparkline: null,
    };
  });
}

/** SVG polyline points for a sparkline. */
export function sparkPoints(values: number[], w = 90, h = 22): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 0.0001);
  return values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`)
    .join(" ");
}
