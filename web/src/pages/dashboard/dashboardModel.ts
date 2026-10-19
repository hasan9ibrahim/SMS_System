// Pure helpers for the live dashboard (§13.3): the TPS chart buffer fed by the history event
// and the 1-second ticks, the TPS limit colours, mover changes and Analytics links.
import type { PartyRef, TpsHistoryEvent, TpsTickEvent } from "@sms/contract";

export const CHART_SLOTS = 720; // one hour in 5-second steps, as the history event sends

export interface ChartBuffer {
  stepSeconds: number;
  /** Start of the newest slot, ms since epoch. */
  lastSlot: number;
  total: number[];
  series: { trunk: PartyRef; values: number[] }[];
  /** Running sums for the newest slot, so a slot holds the average of its ticks. */
  acc: { n: number; total: number; series: number[] };
}

const slotOf = (at: number, step: number) => Math.floor(at / (step * 1000)) * step * 1000;

export function bufferFromHistory(ev: TpsHistoryEvent): ChartBuffer {
  const step = ev.stepSeconds;
  return {
    stepSeconds: step,
    lastSlot: slotOf(Date.parse(ev.at), step),
    total: ev.total.slice(-CHART_SLOTS),
    series: ev.series.map((s) => ({ trunk: s.trunk, values: s.values.slice(-CHART_SLOTS) })),
    acc: { n: 0, total: 0, series: ev.series.map(() => 0) },
  };
}

/** Adds one tick: a new slot when the tick crosses a step boundary, else the newest slot's average. */
export function appendTick(buf: ChartBuffer, tick: TpsTickEvent): ChartBuffer {
  const at = Date.parse(tick.at);
  const slot = slotOf(at, buf.stepSeconds);
  if (slot < buf.lastSlot) return buf; // late tick
  const tps = new Map(
    tick.trunks.filter((t) => t.trunk.kind === "customer_trunk").map((t) => [t.trunk.id, t.tps] as const),
  );
  const fresh = slot > buf.lastSlot;
  const acc = fresh ? { n: 0, total: 0, series: buf.series.map(() => 0) } : buf.acc;
  const n = acc.n + 1;
  const nextAcc = {
    n,
    total: acc.total + tick.totalTps,
    series: buf.series.map((s, i) => (acc.series[i] ?? 0) + (tps.get(s.trunk.id) ?? 0)),
  };
  const put = (xs: number[], v: number) => {
    const out = fresh ? [...xs, v] : [...xs.slice(0, -1), v];
    // A gap of several steps (tab asleep) is filled with zeros so time stays linear.
    return out.slice(-CHART_SLOTS);
  };
  const gap = fresh ? Math.min(CHART_SLOTS, Math.round((slot - buf.lastSlot) / (buf.stepSeconds * 1000)) - 1) : 0;
  const pad = (xs: number[]) => (gap > 0 ? [...xs, ...Array<number>(gap).fill(0)] : xs);
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    ...buf,
    lastSlot: slot,
    total: put(pad(buf.total), round(nextAcc.total / n)),
    series: buf.series.map((s, i) => ({ ...s, values: put(pad(s.values), round(nextAcc.series[i]! / n)) })),
    acc: nextAcc,
  };
}

/** The last `minutes` of the buffer, with each point's time. */
export function chartWindow(buf: ChartBuffer, minutes: number) {
  const n = Math.min(buf.total.length, Math.round((minutes * 60) / buf.stepSeconds));
  const times = Array.from({ length: n }, (_, i) => buf.lastSlot - (n - 1 - i) * buf.stepSeconds * 1000);
  return {
    times,
    total: buf.total.slice(-n),
    series: buf.series.map((s) => ({ trunk: s.trunk, values: s.values.slice(-n) })),
  };
}

/** Share of the TPS limit in use; amber above 80 %, red at 100 % (§13.3 item 4). */
export function limitLevel(tps: number, limit: number): { pct: number; level: "ok" | "warn" | "over" } {
  const pct = limit > 0 ? (tps / limit) * 100 : 0;
  return { pct, level: pct >= 100 ? "over" : pct > 80 ? "warn" : "ok" };
}

/** Keys present now that were not in the previous push: they get the "new" badge and pulse. */
export function newKeys(prev: Set<string>, now: string[]): Set<string> {
  return new Set(now.filter((k) => !prev.has(k)));
}

/** Analytics view (§13.4) for a client, vendor, trunk or destination, opened in a new tab. */
export function analyticsPath(target: PartyRef | { mccmnc: string }): string {
  // Live analytics (§13.4) takes Report By and a search (name, parent or code).
  if ("mccmnc" in target) return `/live/analytics?by=destination&q=${encodeURIComponent(target.mccmnc)}`;
  const by = {
    customer_enterprise: "customer",
    vendor_enterprise: "vendor",
    customer_trunk: "customer_trunk",
    vendor_trunk: "vendor_trunk",
  }[target.kind];
  return `/live/analytics?by=${by}&q=${encodeURIComponent(target.name)}`;
}
