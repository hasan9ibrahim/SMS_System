// Enterprise report settings (§10, §13.31): defaults, the settings in the tab URL, quick
// periods, and the columns shown for each grouping and side.
import type { EnterpriseReportParams, ReportGroup } from "@sms/contract";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Quick periods as local start/end (exclusive) in the report's time zone. */
export function quickPeriod(kind: "today" | "yesterday" | "this_month" | "last_month" | "last_7", now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
  const month = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
  const [from, to] =
    kind === "today"
      ? [today, addDays(today, 1)]
      : kind === "yesterday"
        ? [addDays(today, -1), today]
        : kind === "last_7"
          ? [addDays(today, -6), addDays(today, 1)]
          : kind === "this_month"
            ? [
                month(today.getUTCFullYear(), today.getUTCMonth()),
                month(today.getUTCFullYear(), today.getUTCMonth() + 1),
              ]
            : [
                month(today.getUTCFullYear(), today.getUTCMonth() - 1),
                month(today.getUTCFullYear(), today.getUTCMonth()),
              ];
  return { from: `${day(from)}T00:00`, to: `${day(to)}T00:00` };
}

export function defaultParams(now = new Date()): EnterpriseReportParams {
  return {
    side: "customer",
    ...quickPeriod("this_month", now),
    timezone: "partner",
    reportBy: "daily",
    groupBy: ["enterprise", "trunk"],
  };
}

export function encodeParams(p: EnterpriseReportParams): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(p))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeParams(s: string | null): EnterpriseReportParams | null {
  if (!s) return null;
  try {
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    );
    const p = JSON.parse(json) as EnterpriseReportParams;
    return p && (p.side === "customer" || p.side === "vendor") && typeof p.from === "string" ? p : null;
  } catch {
    return null;
  }
}

const KEY_COLUMNS: Record<ReportGroup, string[]> = {
  enterprise: ["enterpriseName"],
  trunk: ["trunkName"],
  country: ["country"],
  destination: ["country", "mccmnc", "network"],
  account_manager: ["accountManagerName"],
};

/** The billing team's usual metrics per side (§10 Column Selection still offers all 27). */
export const DEFAULT_METRICS: Record<"customer" | "vendor", string[]> = {
  customer: [
    "attempts",
    "successful",
    "billableCustomer",
    "asr",
    "dlrCustomer",
    "revenue",
    "avgRateCustomer",
    "revenuePlatform",
    "costPlatform",
    "margin",
    "marginPct",
  ],
  vendor: [
    "attempts",
    "successful",
    "billableVendor",
    "asr",
    "dlrVendor",
    "cost",
    "avgRateVendor",
    "costPlatform",
    "revenuePlatform",
    "margin",
    "marginPct",
  ],
};

export const KEY_FIELDS = new Set([
  "period",
  "enterpriseName",
  "trunkName",
  "country",
  "mccmnc",
  "network",
  "accountManagerName",
  "currency",
  "timezone",
  "enterpriseId",
  "trunkId",
]);

/** Visible columns: the row keys of the settings, then the chosen metrics. */
export function columnsFor(p: EnterpriseReportParams, metrics: string[]): string[] {
  const keys = [
    ...((p.reportBy ?? "daily") !== "none" ? ["period"] : []),
    ...(p.groupBy ?? ["enterprise", "trunk"]).flatMap((g) => KEY_COLUMNS[g]),
    "currency",
  ];
  return [...new Set(keys), ...metrics.filter((m) => !KEY_FIELDS.has(m))];
}
