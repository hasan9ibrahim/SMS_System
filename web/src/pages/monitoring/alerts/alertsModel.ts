// Alert rules and incidents (§13.6) without React: labels, the blank rule, the form from a saved
// rule, which conditions need a value, and how long an incident lasted.
import type { AlertRuleInput, AlertRuleRow } from "@sms/contract";

export const METRICS: { value: AlertRuleInput["metric"]; label: string }[] = [
  { value: "attempts", label: "Volume – attempts" },
  { value: "submitted", label: "Volume – submitted" },
  { value: "delivered", label: "Volume – delivered" },
  { value: "tps", label: "TPS" },
  { value: "asr", label: "ASR %" },
  { value: "dlr", label: "DLR %" },
  { value: "margin", label: "Margin (amount)" },
  { value: "margin_pct", label: "Margin %" },
  { value: "revenue", label: "Revenue" },
  { value: "avg_delivery_delay", label: "Average delivery delay (s)" },
  { value: "bind_status", label: "Bind status" },
];
export const METRIC_SHORT: Record<AlertRuleInput["metric"], string> = {
  attempts: "Attempts",
  submitted: "Submitted",
  delivered: "Delivered",
  tps: "TPS",
  asr: "ASR",
  dlr: "DLR",
  margin: "Margin",
  margin_pct: "Margin %",
  revenue: "Revenue",
  avg_delivery_delay: "Delay",
  bind_status: "Bind",
};

export const CONDITIONS: { value: AlertRuleInput["condition"]["type"]; label: string }[] = [
  { value: "above", label: "Above a value" },
  { value: "below", label: "Below a value" },
  { value: "increase_pct", label: "Increase by % vs baseline" },
  { value: "decrease_pct", label: "Decrease by % vs baseline" },
  { value: "started", label: "Started sending" },
  { value: "stopped", label: "Stopped sending (no traffic for the window)" },
  { value: "bind_down", label: "Bind down" },
];

export const SCOPES: { value: AlertRuleInput["scope"]["kind"]; label: string; picks?: "ids" | "values" }[] = [
  { value: "all", label: "All traffic" },
  { value: "customer", label: "Customers", picks: "ids" },
  { value: "customer_trunk", label: "Customer trunks", picks: "ids" },
  { value: "vendor", label: "Vendors", picks: "ids" },
  { value: "vendor_trunk", label: "Vendor trunks", picks: "ids" },
  { value: "country", label: "Country (ISO codes)", picks: "values" },
  { value: "mccmnc", label: "Network / MCCMNC", picks: "values" },
  { value: "sender_id", label: "Sender ID", picks: "values" },
  { value: "product_category", label: "Product category", picks: "ids" },
];

export const SEVERITY_LABEL = { info: "Info", warning: "Warning", critical: "Critical" } as const;
export const SEVERITY_TONE = { info: "neutral", warning: "warning", critical: "error" } as const;
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Conditions with a number to enter (a value or a % change). */
export const needsValue = (t: AlertRuleInput["condition"]["type"]) =>
  t === "above" || t === "below" || t === "increase_pct" || t === "decrease_pct";
export const needsBaseline = (t: AlertRuleInput["condition"]["type"]) => t === "increase_pct" || t === "decrease_pct";

export function blankRule(): AlertRuleInput {
  return {
    name: "",
    status: "active",
    description: null,
    scope: { kind: "customer", ids: [], values: [] },
    metric: "dlr",
    condition: { type: "decrease_pct", value: 20, baseline: "previous_window" },
    windowMinutes: 15,
    minSample: 500,
    activeHours: { always: true, days: [1, 2, 3, 4, 5], fromHour: 8, toHour: 20 },
    severity: "warning",
    notifyUserIds: [],
    notifyDepartmentIds: [],
    channels: { popup: true, sound: true, email: false },
    emailAddresses: [],
    partnerContactType: null,
    repeatMinutes: null,
    cooldownMinutes: 15,
    recoveryNotice: true,
  };
}

export function ruleInput(r: AlertRuleRow): AlertRuleInput {
  return {
    name: r.name,
    status: r.status,
    description: r.description,
    scope: { ...r.scope, ids: [...r.scope.ids], values: [...r.scope.values] },
    metric: r.metric,
    condition: { ...r.condition },
    windowMinutes: r.windowMinutes,
    minSample: r.minSample,
    activeHours: { ...r.activeHours, days: [...r.activeHours.days] },
    severity: r.severity,
    notifyUserIds: [...r.notifyUserIds],
    notifyDepartmentIds: [...r.notifyDepartmentIds],
    channels: { ...r.channels },
    emailAddresses: [...r.emailAddresses],
    partnerContactType: r.partnerContactType,
    repeatMinutes: r.repeatMinutes,
    cooldownMinutes: r.cooldownMinutes,
    recoveryNotice: r.recoveryNotice,
  };
}

export const channelsLabel = (c: AlertRuleInput["channels"]) =>
  [c.popup && "Pop-up", c.sound && "Sound", c.email && "E-mail"].filter(Boolean).join(", ") || "—";

export function activeHoursLabel(h: AlertRuleInput["activeHours"]): string {
  if (h.always) return "Always";
  const days =
    h.days.length === 7
      ? "Every day"
      : [...h.days]
          .sort()
          .map((d) => DAYS[d])
          .join(", ");
  return `${days}, ${String(h.fromHour).padStart(2, "0")}:00–${String(h.toHour).padStart(2, "0")}:00 UTC`;
}

/** "1 h 05 min", "12 min", "45 s". */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Live analytics for an incident's scope (§13.4): Report By and a name search in the URL. */
export function analyticsFor(entityKind: string, entityName: string): string {
  const by = ["customer_trunk", "vendor_trunk", "vendor", "customer"].includes(entityKind) ? entityKind : "customer";
  const named = ["customer_trunk", "vendor_trunk", "vendor", "customer"].includes(entityKind);
  return `/live/analytics?by=${by}${named ? `&q=${encodeURIComponent(entityName)}` : ""}`;
}

type Metric = AlertRuleInput["metric"];
type Condition = AlertRuleInput["condition"];
const PCT_METRICS = new Set<Metric>(["asr", "dlr", "margin_pct"]);
const MONEY_METRICS = new Set<Metric>(["margin", "revenue"]);

/** An alert value in words, as the pop-up and the incident show it: "61.0 %", "-0.02 EUR", "4.2 s", "1,250". */
export function fmtAlertValue(metric: Metric, v: number | null, currency: string): string {
  if (v === null) return "—";
  if (PCT_METRICS.has(metric)) return `${v.toFixed(1)} %`;
  if (MONEY_METRICS.has(metric))
    return `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  if (metric === "avg_delivery_delay") return `${v.toFixed(1)} s`;
  if (metric === "tps") return `${v.toFixed(1)} TPS`;
  return Math.round(v).toLocaleString("en-US");
}

const BASELINE_WORDS = { previous_window: "the previous window", yesterday: "yesterday", last_week: "last week" };

/** The rule's condition in words: "below 0.00 EUR", "down 20 % vs the previous window", "bind down". */
export function conditionText(metric: Metric, c: Condition | null, currency: string): string | null {
  if (!c) return null;
  const vs = BASELINE_WORDS[c.baseline ?? "previous_window"];
  switch (c.type) {
    case "above":
      return `above ${fmtAlertValue(metric, c.value, currency)}`;
    case "below":
      return `below ${fmtAlertValue(metric, c.value, currency)}`;
    case "increase_pct":
      return `up ${c.value ?? 0} % vs ${vs}`;
    case "decrease_pct":
      return `down ${c.value ?? 0} % vs ${vs}`;
    case "started":
      return "started sending";
    case "stopped":
      return "stopped sending";
    default:
      return "bind down";
  }
}

/** What the baseline value is, for the "was …" line: the previous window, yesterday or last week. */
export const baselineWords = (c: Condition | null) =>
  c && (c.type === "increase_pct" || c.type === "decrease_pct") && c.baseline
    ? BASELINE_WORDS[c.baseline]
    : "the previous window";

/** Conditions measured as a number over a window (the others are events: started, stopped, bind down). */
export const isMeasured = (c: Condition | null) =>
  !c || c.type === "above" || c.type === "below" || c.type === "increase_pct" || c.type === "decrease_pct";
