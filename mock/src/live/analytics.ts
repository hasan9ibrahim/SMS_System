// Live Analytics (§13.4): today's figures per Report By row from the traffic simulator, filtered,
// sorted and limited on the server (CLAUDE.md rule 3) and pushed on live:analytics every few seconds.
import type { AnalyticsJoinParams, AnalyticsSnapshotEvent } from "@sms/contract";
import { PLATFORM_CURRENCY } from "../currency.js";
import type { PartyDay, Simulator } from "./simulator.js";

type Row = AnalyticsSnapshotEvent["rows"][number];
export type AnalyticsParams = Required<Omit<AnalyticsJoinParams, "search">> & { search: string };

const GROUPS = ["customer", "customer_trunk", "vendor", "vendor_trunk", "destination", "country"] as const;
const SORTS = [
  "name",
  "attempts",
  "delivered",
  "asr",
  "dlr",
  "revenue",
  "cost",
  "margin",
  "marginPct",
  "tps",
  "changePct",
];

/** Validates and completes the join payload (analytics.join.json); null when invalid. */
export function analyticsParams(p: Record<string, unknown>): AnalyticsParams | null {
  const allowed = new Set([
    "groupBy",
    "intervalSeconds",
    "compareMinutes",
    "search",
    "onlyActive",
    "sort",
    "dir",
    "limit",
  ]);
  if (Object.keys(p).some((k) => !allowed.has(k))) return null;
  const out: AnalyticsParams = {
    groupBy: p.groupBy as AnalyticsParams["groupBy"],
    intervalSeconds: (p.intervalSeconds ?? 5) as AnalyticsParams["intervalSeconds"],
    compareMinutes: (p.compareMinutes ?? 15) as AnalyticsParams["compareMinutes"],
    search: typeof p.search === "string" ? p.search.slice(0, 100) : "",
    onlyActive: p.onlyActive === true,
    sort: (p.sort ?? "attempts") as AnalyticsParams["sort"],
    dir: (p.dir ?? "desc") as AnalyticsParams["dir"],
    limit: (p.limit ?? 200) as number,
  };
  if (!GROUPS.includes(out.groupBy)) return null;
  if (![1, 5, 15].includes(out.intervalSeconds) || ![5, 15, 60].includes(out.compareMinutes)) return null;
  if (!SORTS.includes(out.sort) || !["asc", "desc"].includes(out.dir)) return null;
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 500) return null;
  return out;
}

/** `%` and `_` wildcards as typed, otherwise "contains"; case-insensitive (§13.25). */
export function nameMatcher(search: string): (name: string) => boolean {
  const q = search.trim();
  if (!q) return () => true;
  const re = new RegExp(
    `^${(/[%_]/.test(q) ? q : `%${q}%`)
      .split("")
      .map((ch) => (ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
    "i",
  );
  return (name) => re.test(name);
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Acc {
  key: string;
  id: number | string;
  name: string;
  parent: string | null;
  day: PartyDay;
  hasRevenue: boolean;
  tps: number | null;
  minutes: number[][] | null;
}

function figures(a: Acc, compare: number): Row {
  const d = a.day;
  const margin = a.hasRevenue ? d.revenue - d.cost : null;
  let tpsBefore: number | null = null;
  let sparkline: number[] | null = null;
  let tpsNow: number | null = a.tps;
  if (a.minutes) {
    const len = Math.max(0, ...a.minutes.map((m) => m.length));
    const at = (i: number) => a.minutes!.reduce((s, m) => s + (m[i] ?? 0), 0);
    const all = Array.from({ length: len }, (_, i) => at(i));
    const now = avg(all.slice(-compare));
    tpsBefore = r1(avg(all.slice(-2 * compare, -compare)));
    sparkline = all.slice(-60).map(r1);
    tpsNow = tpsNow ?? r1(now);
  }
  return {
    key: a.key,
    id: a.id,
    name: a.name,
    parent: a.parent,
    attempts: Math.round(d.attempts),
    submitted: Math.round(d.submitted),
    delivered: Math.round(d.delivered),
    asr: pct(d.submitted, d.attempts),
    dlr: pct(d.delivered, d.submitted),
    revenue: a.hasRevenue ? r2(d.revenue) : null,
    cost: r2(d.cost),
    margin: margin === null ? null : r2(margin),
    marginPct: margin === null || d.revenue <= 0 ? null : r1((margin / d.revenue) * 100),
    tps: tpsNow === null ? null : r1(tpsNow),
    tpsBefore,
    changePct:
      tpsNow !== null && tpsBefore !== null && tpsBefore > 0.001 ? r1(((tpsNow - tpsBefore) / tpsBefore) * 100) : null,
    sparkline,
  };
}

const addDay = (a: PartyDay, b: PartyDay) => {
  a.attempts += b.attempts;
  a.submitted += b.submitted;
  a.delivered += b.delivered;
  a.revenue += b.revenue;
  a.cost += b.cost;
};
const zero = (): PartyDay => ({ attempts: 0, submitted: 0, delivered: 0, revenue: 0, cost: 0 });

/** The snapshot for one subscriber. */
export function analyticsSnapshot(sim: Simulator, p: AnalyticsParams, now = Date.now()): AnalyticsSnapshotEvent {
  const accs: Acc[] = [];
  const g = p.groupBy;
  if (g === "customer_trunk" || g === "vendor_trunk") {
    const list = g === "customer_trunk" ? sim.trunks : sim.vendors;
    for (const t of list)
      accs.push({
        key: `${g === "customer_trunk" ? "ct" : "vt"}:${t.id}`,
        id: t.id,
        name: t.name,
        parent: t.enterpriseName,
        day: { ...t.day },
        hasRevenue: g === "customer_trunk",
        tps: t.tps,
        minutes: [t.minutes],
      });
  } else if (g === "customer" || g === "vendor") {
    const list = g === "customer" ? sim.trunks : sim.vendors;
    const by = new Map<number, Acc>();
    for (const t of list) {
      const a = by.get(t.enterpriseId) ?? {
        key: `${g === "customer" ? "c" : "v"}:${t.enterpriseId}`,
        id: t.enterpriseId,
        name: t.enterpriseName,
        parent: null,
        day: zero(),
        hasRevenue: g === "customer",
        tps: 0,
        minutes: [],
      };
      addDay(a.day, t.day);
      a.tps = (a.tps ?? 0) + t.tps;
      a.minutes!.push(t.minutes);
      by.set(t.enterpriseId, a);
    }
    accs.push(...by.values());
  } else {
    // Destinations keep today's mix (simulator); countries add up their networks.
    const by = new Map<string, Acc>();
    for (const [code, d] of sim.today.destinations) {
      const key = g === "destination" ? `d:${code}` : `co:${d.country}`;
      const a = by.get(key) ?? {
        key,
        id: g === "destination" ? code : d.country,
        name: g === "destination" ? `${d.country} – ${d.network || "All networks"}` : d.country,
        parent: g === "destination" ? d.country : null,
        day: zero(),
        hasRevenue: true,
        tps: null,
        minutes: null,
      };
      a.day.attempts += d.attempts;
      a.day.submitted += d.successful;
      a.day.delivered += d.delivered;
      a.day.revenue += d.revenue;
      a.day.cost += d.revenue - d.margin;
      by.set(key, a);
    }
    accs.push(...by.values());
  }
  const match = nameMatcher(p.search);
  let rows = accs
    .filter((a) => match(a.name) || (a.parent !== null && match(a.parent)) || match(String(a.id)))
    .map((a) => figures(a, p.compareMinutes))
    .filter((r) => r.attempts > 0 || (r.tps ?? 0) > 0.001);
  if (p.onlyActive) rows = rows.filter((r) => (r.tps ?? 0) > 0.001);
  const total = rows.length;
  const dir = p.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (p.sort === "name") return dir * a.name.localeCompare(b.name);
    const x = a[p.sort as keyof Row] as number | null;
    const y = b[p.sort as keyof Row] as number | null;
    if (x === y) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return dir * (x - y);
  });
  const sum = (k: "attempts" | "submitted" | "delivered" | "revenue" | "cost" | "tps") =>
    rows.reduce((s, r) => s + ((r[k] as number | null) ?? 0), 0);
  const revenueRows = rows.some((r) => r.revenue !== null);
  const revenue = sum("revenue");
  const cost = sum("cost");
  return {
    at: new Date(now).toISOString(),
    groupBy: g,
    currency: PLATFORM_CURRENCY,
    day: sim.today.day,
    compareMinutes: p.compareMinutes,
    total,
    rows: rows.slice(0, p.limit),
    totals: {
      attempts: Math.round(sum("attempts")),
      submitted: Math.round(sum("submitted")),
      delivered: Math.round(sum("delivered")),
      asr: pct(sum("submitted"), sum("attempts")),
      dlr: pct(sum("delivered"), sum("submitted")),
      revenue: revenueRows ? r2(revenue) : null,
      cost: r2(cost),
      margin: revenueRows ? r2(revenue - cost) : null,
      marginPct: revenueRows && revenue > 0 ? r1(((revenue - cost) / revenue) * 100) : null,
      tps: g === "destination" || g === "country" ? null : r1(sum("tps")),
    },
  };
}
