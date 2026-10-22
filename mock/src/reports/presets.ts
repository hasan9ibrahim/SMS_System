// Ready-made report settings (§13.15): the department reports, and the §10 reports that became
// saved views of the Master Report. No I/O.
import type { MasterReportSettings } from "@sms/contract";

export interface Preset {
  key: string;
  name: string;
  description: string;
  department: "sales" | "billing" | "noc" | null;
  settings: MasterReportSettings;
}

const base = { timezone: "UTC", msgType: null, compare: "none" as const, from: null, to: null };
export const PRESETS: Preset[] = [
  {
    key: "sales",
    name: "Sales report",
    description: "Per customer and destination: volume, revenue and margin against the previous period.",
    department: "sales",
    settings: {
      ...base,
      groupBy: ["customer", "destination"],
      metrics: ["attempts", "delivered", "revenue", "margin", "marginPct", "avgRateCustomer"],
      period: "last_7_days",
      compare: "previous_period",
    },
  },
  {
    key: "billing",
    name: "Billing report",
    description: "Per customer: billable volume and amount, cost and margin for last month.",
    department: "billing",
    settings: {
      ...base,
      groupBy: ["customer"],
      metrics: ["billableCustomer", "revenue", "billableVendor", "cost", "margin", "marginPct"],
      period: "last_month",
    },
  },
  {
    key: "noc",
    name: "NOC report",
    description:
      "Per vendor trunk today: TPS, ASR, DLR, delay, failed submits and re-routes, against the same day last week.",
    department: "noc",
    settings: {
      ...base,
      groupBy: ["vendorTrunk"],
      metrics: ["attempts", "tpsAvg", "tpsPeak", "asr", "dlrVendor", "deliveryDelayS", "failedSubmits", "reroutes"],
      period: "today",
      compare: "previous_week",
    },
  },
  {
    key: "customize",
    name: "Customize (§10 /report/1)",
    description: "Three grouping levels: date, customer, vendor.",
    department: null,
    settings: {
      ...base,
      groupBy: ["date", "customer", "vendor"],
      metrics: ["attempts", "successful", "asr", "dlrCustomer", "revenue", "cost", "margin"],
      period: "last_7_days",
    },
  },
  {
    key: "enterprise",
    name: "Enterprise (§10 /report/2)",
    description: "Per customer enterprise and trunk; the Enterprise report page adds billing time zones.",
    department: null,
    settings: {
      ...base,
      groupBy: ["customer", "customerTrunk"],
      metrics: ["attempts", "successful", "billableCustomer", "asr", "dlrCustomer", "revenue", "margin", "marginPct"],
      period: "yesterday",
    },
  },
  {
    key: "master_grouping",
    name: "Master Grouping (§10 /report/10)",
    description: "Date, customer and trunk, vendor and trunk.",
    department: null,
    settings: {
      ...base,
      groupBy: ["date", "customer", "customerTrunk", "vendor", "vendorTrunk"],
      metrics: ["attempts", "successful", "asr", "revenue", "cost", "margin"],
      period: "yesterday",
    },
  },
  {
    key: "usage_enterprise",
    name: "Usage Enterprise (§10 /report/11)",
    description: "Billable usage per customer and destination for billing reconciliation.",
    department: null,
    settings: {
      ...base,
      groupBy: ["customer", "destination"],
      metrics: ["billableCustomer", "revenue", "avgRateCustomer"],
      period: "last_month",
    },
  },
  {
    key: "negative_margin",
    name: "Negative Margin (§10 /report/12)",
    description: "Traffic sold below cost: date, customer, destination, trunks and category, margin under 0.",
    department: null,
    settings: {
      ...base,
      groupBy: ["date", "customer", "destination", "vendor", "productCategory"],
      metrics: ["successful", "asr", "margin", "marginPct", "hlrCost"],
      period: "last_7_days",
      filter: { logic: "and", conditions: [{ field: "margin", op: "lt", value: 0 }] },
    },
  },
  {
    key: "bilateral",
    name: "Bilateral (§10 /bilateral)",
    description: "Traffic each way with bilateral partners: add a filter on the partner as customer or vendor.",
    department: null,
    settings: {
      ...base,
      groupBy: ["customer", "vendor"],
      metrics: ["attempts", "billableCustomer", "billableVendor", "revenue", "cost", "margin"],
      period: "last_month",
    },
  },
];
export const presetName = (key: string | null) => PRESETS.find((p) => p.key === key)?.name ?? key ?? "";
