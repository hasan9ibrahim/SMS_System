// Team report (§13.18): sections and their columns, the ranking metrics, periods, and links from a
// timeline entry to the record it changed.
import type { TeamMemberRow, TeamReportQuery } from "@sms/contract";

export const SECTIONS = [
  { key: "business", label: "Business results" },
  { key: "rates", label: "Rates & routing" },
  { key: "billing", label: "Billing" },
  { key: "noc", label: "NOC" },
  { key: "activity", label: "System activity" },
] as const;
export type Section = (typeof SECTIONS)[number]["key"];
export const isSection = (v: string | null): v is Section => SECTIONS.some((s) => s.key === v);

export const PERIODS: { value: TeamReportQuery["period"]; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_week", label: "Last week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom" },
];

export interface Metric {
  key: string;
  label: string;
  section: Section;
  value: (r: TeamMemberRow) => number | null;
  /** Lower is better (sorts the ranking ascending). */
  low?: boolean;
  money?: boolean;
  pct?: boolean;
}
export const METRICS: Metric[] = [
  { key: "revenue", label: "Revenue", section: "business", value: (r) => r.business?.revenue ?? null, money: true },
  { key: "margin", label: "Margin", section: "business", value: (r) => r.business?.margin ?? null, money: true },
  { key: "messages", label: "Messages", section: "business", value: (r) => r.business?.messages ?? null },
  {
    key: "achievedPct",
    label: "% of target",
    section: "business",
    value: (r) => r.business?.achievedPct ?? null,
    pct: true,
  },
  { key: "growthPct", label: "Growth %", section: "business", value: (r) => r.business?.growthPct ?? null, pct: true },
  {
    key: "activeClients",
    label: "Active clients",
    section: "business",
    value: (r) => r.business?.activeClients ?? null,
  },
  { key: "rateTablesChanged", label: "Rate tables changed", section: "rates", value: (r) => r.rates.rateTablesChanged },
  { key: "routeRulesChanged", label: "Route rules changed", section: "rates", value: (r) => r.rates.routeRulesChanged },
  { key: "rnDecided", label: "RNs decided", section: "rates", value: (r) => r.rates.rnAccepted + r.rates.rnRejected },
  { key: "invoices", label: "Invoices generated", section: "billing", value: (r) => r.billing.invoicesGenerated },
  { key: "payments", label: "Payments recorded", section: "billing", value: (r) => r.billing.paymentsRecorded },
  { key: "alerts", label: "Alerts acknowledged", section: "noc", value: (r) => r.noc.alertsAcknowledged },
  { key: "ackMinutes", label: "Avg time to acknowledge", section: "noc", value: (r) => r.noc.avgAckMinutes, low: true },
  { key: "saves", label: "Saves", section: "activity", value: (r) => r.activity.saves },
  { key: "hoursOnline", label: "Hours online", section: "activity", value: (r) => r.activity.hoursOnline },
];

/** Top members for a metric, without members that have no value. */
export function ranking(rows: TeamMemberRow[], m: Metric, top = 15): { name: string; value: number }[] {
  return rows
    .map((r) => ({ name: r.name, value: m.value(r) }))
    .filter((x): x is { name: string; value: number } => x.value !== null && (m.low ? true : x.value !== 0))
    .sort((a, b) => (m.low ? a.value - b.value : b.value - a.value))
    .slice(0, top);
}

/** Page that shows a record a timeline entry points at (null = none). */
export function recordLink(entityType: string | null, id: number | null): string | null {
  if (!entityType || id === null) return null;
  const paths: Record<string, string> = {
    enterprise: `/enterprises/${id}`,
    enterprises: `/enterprises/${id}`,
    rate_table: `/rates/manager?table=${id}`,
    rate_tables: `/rates/manager?table=${id}`,
    route_rule: `/routing/rules?rule=${id}`,
    route_rules: `/routing/rules?rule=${id}`,
    customer_trunk: `/enterprises/customer-trunks/${id}`,
    customer_trunks: `/enterprises/customer-trunks/${id}`,
    vendor_trunk: `/enterprises/vendor-trunks/${id}`,
    vendor_trunks: `/enterprises/vendor-trunks/${id}`,
  };
  return paths[entityType] ?? null;
}

export const fmtHours = (h: number) => (h < 10 ? h.toFixed(1) : Math.round(h).toString());
