// Alert rule evaluation (§13.6) on live per-minute series: which entities a rule watches, the metric
// over its window, the baseline, and whether the condition holds. Pure, so it is tested with made-up
// series; the engine (engine.ts) feeds it the traffic simulator and raises incidents.
import type { AlertRuleFields } from "@sms/contract";

/** One trunk's (or vendor trunk's) live series, oldest minute first; the last minute is in progress. */
export interface Series {
  kind: "customer_trunk" | "vendor_trunk";
  id: number;
  name: string;
  enterpriseId: number;
  enterpriseName: string;
  tps: number;
  minutes: number[];
  minAsr: (number | null)[];
  minDlr: (number | null)[];
  minDelay: number[];
  /** Per message in the platform currency; null for vendor trunks (no revenue side). */
  revenue: number | null;
  cost: number;
  /**
   * Revenue and cost per minute from the stored EDRs, when the series comes from the EDR store (team trial
   * round 1: an alert's money must match Live analytics); otherwise money is messages × the averages above.
   */
  minRevenue?: number[];
  minCost?: number[];
  /** Normal levels, the baseline for "yesterday" and "last week" in this phase. */
  normalTps: number;
  normalAsr: number | null;
  normalDlr: number | null;
  normalDelay: number;
}

export interface Entity {
  kind: string;
  id: number | null;
  name: string;
  enterpriseId: number | null;
  series: Series[];
}

export interface Evaluation {
  value: number | null;
  baseline: number | null;
  sample: number;
  firing: boolean;
  reason: string;
  message: string;
}

type Rule = Pick<
  AlertRuleFields,
  "name" | "scope" | "metric" | "condition" | "windowMinutes" | "minSample" | "activeHours"
>;

const PCT = new Set(["asr", "dlr", "margin_pct"]);
const MONEY = new Set(["margin", "revenue"]);
export const METRIC_LABEL: Record<AlertRuleFields["metric"], string> = {
  attempts: "Attempts",
  submitted: "Submitted",
  delivered: "Delivered",
  tps: "TPS",
  asr: "ASR",
  dlr: "DLR",
  margin: "Margin",
  margin_pct: "Margin %",
  revenue: "Revenue",
  avg_delivery_delay: "Delivery delay",
  bind_status: "Bind status",
};

/** A value in words: "61 %", "1,250 msgs", "4.2 s", "312.40 USD". */
export function fmtMetric(metric: AlertRuleFields["metric"], v: number | null, currency = "USD"): string {
  if (v === null) return "—";
  if (PCT.has(metric)) return `${Math.round(v * 10) / 10} %`;
  if (MONEY.has(metric))
    return `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  if (metric === "avg_delivery_delay") return `${Math.round(v * 10) / 10} s`;
  if (metric === "tps") return `${Math.round(v * 10) / 10} TPS`;
  return Math.round(v).toLocaleString("en-US");
}

/** The entities a rule watches. Country, MCCMNC, sender ID and category scopes with values are read from the EDR store (engine.ts dimensionEntity); here they fall back to all traffic. */
export function entitiesFor(rule: Pick<Rule, "scope" | "metric">, customers: Series[], vendors: Series[]): Entity[] {
  const { kind, ids, values } = rule.scope;
  const each = (list: Series[], k: string): Entity[] =>
    list
      .filter((s) => !ids.length || ids.includes(s.id))
      .map((s) => ({ kind: k, id: s.id, name: s.name, enterpriseId: s.enterpriseId, series: [s] }));
  const byEnterprise = (list: Series[], k: string): Entity[] => {
    const groups = new Map<number, Series[]>();
    for (const s of list)
      if (!ids.length || ids.includes(s.enterpriseId))
        groups.set(s.enterpriseId, [...(groups.get(s.enterpriseId) ?? []), s]);
    return [...groups].map(([id, series]) => ({
      kind: k,
      id,
      name: series[0]!.enterpriseName,
      enterpriseId: id,
      series,
    }));
  };
  // Bind status is about each trunk's bind.
  if (rule.metric === "bind_status") {
    if (kind === "customer")
      return each(
        customers.filter((s) => !ids.length || ids.includes(s.enterpriseId)),
        "customer_trunk",
      );
    if (kind === "vendor")
      return each(
        vendors.filter((s) => !ids.length || ids.includes(s.enterpriseId)),
        "vendor_trunk",
      );
    if (kind === "vendor_trunk") return each(vendors, "vendor_trunk");
    if (kind === "customer_trunk") return each(customers, "customer_trunk");
    return [...each(customers, "customer_trunk")];
  }
  switch (kind) {
    case "customer":
      return byEnterprise(customers, "customer");
    case "customer_trunk":
      return each(customers, "customer_trunk");
    case "vendor":
      return byEnterprise(vendors, "vendor");
    case "vendor_trunk":
      return each(vendors, "vendor_trunk");
    case "all":
      return [{ kind: "all", id: null, name: "All traffic", enterpriseId: null, series: customers }];
    default:
      return [
        {
          kind,
          id: null,
          name: `${kind.replace("_", " ")} ${values.join(", ") || "any"}`,
          enterpriseId: null,
          series: customers,
        },
      ];
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The metric over `w` minutes ending `offset` minutes ago, and the number of messages it rests on. */
export function measure(
  series: Series[],
  metric: AlertRuleFields["metric"],
  w: number,
  offset: number,
): { value: number | null; sample: number } {
  let attempts = 0;
  let qAttempts = 0;
  let qSubmitted = 0;
  let submitted = 0;
  let delivered = 0;
  let revenue = 0;
  let cost = 0;
  let delaySum = 0;
  let hasRevenue = false;
  let tpsNow = 0;
  for (const s of series) {
    const n = s.minutes.length;
    const from = Math.max(0, n - offset - w);
    const to = Math.max(0, n - offset);
    for (let i = from; i < to; i++) {
      const a = (s.minutes[i] ?? 0) * 60;
      attempts += a;
      // A trunk without quality figures (no history) counts for volume, not for ASR / DLR.
      const asr = s.minAsr[i];
      const dlr = s.minDlr[i];
      if (asr != null) {
        const sub = a * (asr / 100);
        qAttempts += a;
        submitted += sub;
        if (dlr != null) {
          const del = sub * (dlr / 100);
          qSubmitted += sub;
          delivered += del;
          delaySum += del * (s.minDelay[i] ?? 0);
        }
      }
      if (s.revenue !== null) {
        hasRevenue = true;
        revenue += s.minRevenue ? (s.minRevenue[i] ?? 0) : a * s.revenue;
      }
      cost += s.minCost ? (s.minCost[i] ?? 0) : a * s.cost;
    }
    tpsNow += offset === 0 ? s.tps : sum(s.minutes.slice(from, to)) / Math.max(1, to - from);
  }
  const sample = Math.round(
    metric === "asr" ? qAttempts : metric === "dlr" || metric === "avg_delivery_delay" ? qSubmitted : attempts,
  );
  const ratio = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
  const value =
    metric === "attempts"
      ? attempts
      : metric === "submitted"
        ? submitted
        : metric === "delivered"
          ? delivered
          : metric === "tps"
            ? tpsNow
            : metric === "asr"
              ? ratio(submitted, qAttempts)
              : metric === "dlr"
                ? ratio(delivered, qSubmitted)
                : metric === "revenue"
                  ? hasRevenue
                    ? revenue
                    : null
                  : metric === "margin"
                    ? hasRevenue
                      ? revenue - cost
                      : null
                    : metric === "margin_pct"
                      ? hasRevenue
                        ? ratio(revenue - cost, revenue)
                        : null
                      : metric === "avg_delivery_delay"
                        ? delivered > 0
                          ? delaySum / delivered
                          : null
                        : null;
  return { value, sample };
}

/** "Normal" level: the trunks' usual TPS and quality (yesterday / last week baselines in this phase). */
export function normal(series: Series[], metric: AlertRuleFields["metric"], w: number): number | null {
  const attempts = series.map((s) => s.normalTps * 60 * w);
  const total = sum(attempts);
  const subm = series.map((s, i) => attempts[i]! * ((s.normalAsr ?? 0) / 100));
  const deliv = series.map((s, i) => subm[i]! * ((s.normalDlr ?? 0) / 100));
  const revenue = series.some((s) => s.revenue !== null)
    ? sum(series.map((s, i) => attempts[i]! * (s.revenue ?? 0)))
    : null;
  const cost = sum(series.map((s, i) => attempts[i]! * s.cost));
  switch (metric) {
    case "attempts":
      return total;
    case "submitted":
      return sum(subm);
    case "delivered":
      return sum(deliv);
    case "tps":
      return sum(series.map((s) => s.normalTps));
    case "asr":
      return total > 0 ? (sum(subm) / total) * 100 : null;
    case "dlr":
      return sum(subm) > 0 ? (sum(deliv) / sum(subm)) * 100 : null;
    case "revenue":
      return revenue;
    case "margin":
      return revenue === null ? null : revenue - cost;
    case "margin_pct":
      return revenue ? ((revenue - cost) / revenue) * 100 : null;
    case "avg_delivery_delay":
      return series.length ? sum(series.map((s) => s.normalDelay)) / series.length : null;
    default:
      return null;
  }
}

/** Whether the rule may fire at `now` (UTC days and hours). */
export function isActiveAt(hours: AlertRuleFields["activeHours"], now: number): boolean {
  if (hours.always) return true;
  const d = new Date(now);
  return hours.days.includes(d.getUTCDay()) && d.getUTCHours() >= hours.fromHour && d.getUTCHours() < hours.toHour;
}

const r1 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** Evaluates a rule on one entity. `bindDown` says whether the entity's trunk bind is down. */
export function evaluate(rule: Rule, entity: Entity, bindDown = false, currency = "USD"): Evaluation {
  const { metric, condition: c, windowMinutes: w } = rule;
  const label = METRIC_LABEL[metric];
  const f = (v: number | null) => fmtMetric(metric, v, currency);
  if (metric === "bind_status" || c.type === "bind_down") {
    return {
      value: bindDown ? 0 : 1,
      baseline: 1,
      sample: 0,
      firing: bindDown,
      reason: bindDown ? "the bind is down" : "the bind is up",
      message: `${entity.name} bind down`,
    };
  }
  const now = measure(entity.series, metric, w, 0);
  const before = measure(entity.series, metric, w, w);
  const vol = (x: { sample: number }) => x.sample;
  if (c.type === "started") {
    const firing = vol(before) < 1 && vol(now) >= Math.max(1, rule.minSample);
    return {
      value: now.sample,
      baseline: before.sample,
      sample: now.sample,
      firing,
      reason: firing ? "no traffic before, sending now" : vol(before) >= 1 ? "it was already sending" : "not sending",
      message: `${entity.name} started sending (${fmtMetric("tps", measure(entity.series, "tps", w, 0).value)})`,
    };
  }
  if (c.type === "stopped") {
    const firing = vol(now) < 1 && vol(before) >= Math.max(1, rule.minSample);
    return {
      value: now.sample,
      baseline: before.sample,
      sample: now.sample,
      firing,
      reason: firing
        ? `no traffic for ${w} min after sending`
        : vol(now) >= 1
          ? "still sending"
          : "was not sending before",
      message: `${entity.name} stopped sending (no traffic for ${w} min)`,
    };
  }
  const baseline =
    c.type === "increase_pct" || c.type === "decrease_pct"
      ? c.baseline === "yesterday" || c.baseline === "last_week"
        ? normal(entity.series, metric, w)
        : before.value
      : before.value;
  const value = now.value;
  if (now.sample < rule.minSample)
    return {
      value: r1(value),
      baseline: r1(baseline),
      sample: now.sample,
      firing: false,
      reason: `only ${now.sample.toLocaleString("en-US")} messages (minimum ${rule.minSample.toLocaleString("en-US")})`,
      message: "",
    };
  if (value === null)
    return {
      value: null,
      baseline: r1(baseline),
      sample: now.sample,
      firing: false,
      reason: `no ${label} for this scope`,
      message: "",
    };
  const v = c.value ?? 0;
  let firing = false;
  let message = "";
  if (c.type === "above") {
    firing = value > v;
    message = `${entity.name} ${label} ${f(value)} above ${f(v)} (${w} min)`;
  } else if (c.type === "below") {
    firing = value < v;
    message = `${entity.name} ${label} ${f(value)} below ${f(v)} (${w} min)`;
  } else {
    const change = baseline && baseline !== 0 ? ((value - baseline) / Math.abs(baseline)) * 100 : null;
    firing = change !== null && (c.type === "increase_pct" ? change >= v : change <= -v);
    const vs = c.baseline === "yesterday" ? " vs yesterday" : c.baseline === "last_week" ? " vs last week" : "";
    message = `${entity.name} ${label} ${c.type === "increase_pct" ? "rose" : "dropped"} from ${f(baseline)} to ${f(value)} in ${w} min${vs}`;
  }
  return {
    value: r1(value),
    baseline: r1(baseline),
    sample: now.sample,
    firing,
    reason: firing ? "the condition holds" : "within the limit",
    message,
  };
}

/** The worse of two values for a rule (the incident's peak). */
export function worse(rule: Pick<Rule, "condition">, a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  const up = rule.condition.type === "above" || rule.condition.type === "increase_pct";
  return up ? Math.max(a, b) : Math.min(a, b);
}

/** "DLR % decrease 20 % vs previous window · 15 min · ≥ 500 msgs" for grids and e-mails. */
export function conditionLabel(rule: Pick<Rule, "metric" | "condition" | "windowMinutes" | "minSample">): string {
  const m = METRIC_LABEL[rule.metric];
  const c = rule.condition;
  const base =
    c.baseline === "yesterday"
      ? "same time yesterday"
      : c.baseline === "last_week"
        ? "same weekday last week"
        : "previous window";
  const what =
    c.type === "above"
      ? `${m} above ${fmtMetric(rule.metric, c.value)}`
      : c.type === "below"
        ? `${m} below ${fmtMetric(rule.metric, c.value)}`
        : c.type === "increase_pct"
          ? `${m} up ${c.value ?? 0} % vs ${base}`
          : c.type === "decrease_pct"
            ? `${m} down ${c.value ?? 0} % vs ${base}`
            : c.type === "started"
              ? "Started sending"
              : c.type === "stopped"
                ? "Stopped sending"
                : "Bind down";
  const sample = rule.minSample ? ` · ≥ ${rule.minSample.toLocaleString("en-US")} msgs` : "";
  return c.type === "bind_down" ? what : `${what} · ${rule.windowMinutes} min${sample}`;
}
