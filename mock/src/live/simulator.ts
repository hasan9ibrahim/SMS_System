// Live traffic simulator for the dashboard (§13.3) and the TPS pill (§15.1). Trunk shares,
// rates, ASR and DLR come from the last 7 days of EDRs, so the live view agrees with the
// reports; each customer trunk follows a timeline of segments (steady, ramping up or down,
// starting, stopping, idle) so the traffic movers panel has movers to show. Today's totals
// (the day in the platform time zone) start from the EDR store and grow with the simulated traffic. Two hours of history are
// seeded at start, so every panel is full from the first second.
import type {
  DashboardMoversEvent,
  DashboardSummaryEvent,
  DashboardTopsEvent,
  MoverRow,
  TpsHistoryEvent,
  TpsTickEvent,
} from "@sms/contract";
import { PLATFORM_CURRENCY, sysToPlatformFactor } from "../currency.js";
import { db } from "../db.js";
import { PLATFORM_DAY_START_SQL, platformDay } from "../platform.js";
import { chRows } from "../edr.js";

/**
 * Platform volume in messages per second (team trial round 1: "good sending", not a trickle). Every
 * simulated message is written to the EDR store, so the dashboard, alerts, Live analytics and the reports
 * count the same traffic at any volume. SIM_TOTAL_TPS changes it; 0 uses the stored EDRs' own rate.
 */
const SIM_TOTAL_TPS = (() => {
  const v = Number(process.env.SIM_TOTAL_TPS ?? 40);
  return Number.isFinite(v) && v > 0 ? v : null;
})();
export const MINUTES = 120; // per-minute history kept for the movers (two 60-minute windows)
const SLOT_S = 5; // chart history resolution
const SLOTS = 3600 / SLOT_S; // 60 minutes of chart history

type Kind = "steady" | "up" | "down" | "start" | "stop" | "idle";

interface Segment {
  from: number;
  to: number;
  kind: Kind;
  a: number; // level at `from`, as a factor of the trunk's base TPS
  b: number; // level at `to`
}

export interface SimTrunk {
  id: number;
  name: string;
  enterpriseId: number;
  enterpriseName: string;
  limit: number;
  base: number;
  tps: number;
  revenue: number; // per message, platform currency
  cost: number;
  /** Share of its messages sent to a vendor (the rest is rejected before routing). */
  sentShare: number;
  /** Sending rate (messages per second) and the part of a message built up but not sent yet. */
  rate?: number;
  owed?: number;
  /** Whole messages sent in each of the last seconds, and when it last sent one (TPS, "sending"). */
  recent?: number[];
  lastSentAt?: number;
  /**
   * Messages sent but not yet written to the EDR store (live EDRs), by outcome: delivered, accepted but
   * not delivered, refused by the vendor, not sent to a vendor.
   */
  pending?: [number, number, number, number];
  asr: number | null;
  dlr: number | null;
  segments: Segment[];
  /** Quality now (§13.6 alerts): ASR / DLR %, delivery delay in seconds; dips come and go. */
  asrNow: number | null;
  dlrNow: number | null;
  delayNow: number;
  dip: Dip | null;
  /** Per-minute averages aligned with `minutes`. */
  minAsr: (number | null)[];
  minDlr: (number | null)[];
  minDelay: number[];
  qSum: [number, number, number];
  day: PartyDay;
  /** Average TPS per minute, oldest first; the last entry is the current minute so far. */
  minutes: number[];
  minuteSum: number;
  minuteN: number;
  slots: Float32Array; // ring of 5-second averages
  slotSum: number;
  slotN: number;
}

export interface SimVendor {
  id: number;
  /** Smoothed messages per second; `tps` is the messages of the last 10 seconds per second. */
  rate?: number;
  /** Messages the live EDR writer routed to this vendor since the last step. */
  routed?: number;
  recent?: number[];
  lastSentAt?: number;
  name: string;
  enterpriseId: number;
  enterpriseName: string;
  limit: number;
  weight: number;
  tps: number;
  cost: number;
  asr: number | null;
  dlr: number | null;
  asrNow: number | null;
  dlrNow: number | null;
  delayNow: number;
  dip: Dip | null;
  minutes: number[];
  minAsr: (number | null)[];
  minDlr: (number | null)[];
  minDelay: number[];
  minuteSum: number;
  minuteN: number;
  qSum: [number, number, number];
  day: PartyDay;
}

/** A quality episode: ASR, DLR and delay factors until a time. */
export interface Dip {
  until: number;
  asrF: number;
  dlrF: number;
  delayF: number;
}

/** Today's figures of one trunk (live analytics §13.4). */
export interface PartyDay {
  attempts: number;
  submitted: number;
  delivered: number;
  revenue: number;
  cost: number;
}
const emptyDay = (): PartyDay => ({ attempts: 0, submitted: 0, delivered: 0, revenue: 0, cost: 0 });
/** Normal delivery delay in seconds when quality is fine. */
export const BASE_DELAY = 3;
/** Chance per second that a sending trunk starts a quality dip (about once a day per trunk). */
const DIP_PER_SECOND = Number(process.env.SIM_DIP_PER_DAY ?? 1) / 86_400;

interface DayTotals {
  day: string;
  attempts: number;
  /** Messages accepted by a vendor (ASR, DLR). */
  submitted: number;
  /** Messages sent to a vendor, accepted or not: "Submitted" on the dashboard, as in the reports. */
  sent: number;
  delivered: number;
  revenue: number;
  cost: number;
  clients: Map<number, PartyTotals>;
  vendors: Map<number, PartyTotals>;
  destinations: Map<string, DestTotals>;
}
interface PartyTotals {
  name: string;
  attempts: number;
  money: number;
  margin: number;
  successful: number;
  delivered: number;
}
interface DestTotals {
  country: string;
  network: string;
  attempts: number;
  revenue: number;
  margin: number;
  successful: number;
  delivered: number;
}

/** One destination in the traffic mix (last 7 days): its share and what one message brings (§13.3). */
interface DestMix {
  code: string;
  country: string;
  network: string;
  weight: number;
  revenue: number;
  margin: number;
  okP: number;
  dlP: number;
}

export interface Simulator {
  /**
   * Set once live EDRs are being written (live/edrWriter.ts): revenue, cost and the vendor of each message
   * then come from the written EDRs (routed by today's rules), not from the per-trunk averages.
   */
  moneyFromWriter?: boolean;
  trunks: SimTrunk[];
  vendors: SimVendor[];
  today: DayTotals;
  /** Where messages go; kept across midnight, when today's destination figures start again from zero. */
  destMix: DestMix[];
  /** The destination each customer and vendor trunk sent most to in the last hour (movers, team trial round 2). */
  topDest?: { customer: Map<number, string>; vendor: Map<number, string> };
  /** Index of the slot being filled in each trunk's ring. */
  slotIndex: number;
  lastTick: number;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(xs: [T, number][]): T => {
  let r = Math.random() * xs.reduce((s, x) => s + x[1], 0);
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[0]![0];
};

// ---------------------------------------------------------------- behaviour

/** Appends segments until `until`, continuing from the last level. */
export function extendSegments(segs: Segment[], until: number, active: boolean) {
  let last = segs[segs.length - 1];
  while (!last || last.to < until) {
    const from = last?.to ?? until - (MINUTES + 10) * 60_000;
    const level = last?.b ?? (active ? rand(0.7, 1.3) : 0);
    const len = rand(8, 35) * 60_000;
    const kind: Kind =
      level < 0.05
        ? pick<Kind>([
            ["idle", active ? 3 : 12],
            ["start", active ? 4 : 1],
          ])
        : pick<Kind>([
            ["steady", 14],
            ["up", 3],
            ["down", 3],
            ["stop", 1],
          ]);
    const b =
      kind === "steady"
        ? Math.min(2.5, Math.max(0.3, level * rand(0.9, 1.1)))
        : kind === "up"
          ? Math.min(2.5, level * rand(1.5, 2.3))
          : kind === "down"
            ? level * rand(0.3, 0.6)
            : kind === "start"
              ? rand(0.6, 1.2)
              : 0;
    last = { from, to: from + len, kind, a: level, b };
    segs.push(last);
  }
  // Keep only what the history still needs.
  const keepFrom = until - (MINUTES + 15) * 60_000;
  while (segs.length > 2 && segs[1]!.to < keepFrom) segs.shift();
}

/** The level (factor of base TPS) at time t; starts and stops are quick, ramps gradual. */
export function levelAt(segs: Segment[], t: number): number {
  const s = segs.find((x) => x.from <= t && t < x.to) ?? segs[segs.length - 1];
  if (!s) return 0;
  const p = Math.min(1, Math.max(0, (t - s.from) / (s.to - s.from)));
  const q = s.kind === "start" || s.kind === "stop" ? Math.min(1, p * 6) : p;
  return s.a + (s.b - s.a) * q;
}

// ---------------------------------------------------------------- loading

async function loadFromStores(): Promise<{
  trunks: SimTrunk[];
  vendors: SimVendor[];
  today: DayTotals;
  destMix: DestMix[];
}> {
  const now = Date.now();
  const today: DayTotals = {
    day: platformDay(now),
    attempts: 0,
    submitted: 0,
    sent: 0,
    delivered: 0,
    revenue: 0,
    cost: 0,
    clients: new Map(),
    vendors: new Map(),
    destinations: new Map(),
  };
  // Only live trunks of live enterprises send traffic: an archived enterprise's trunks stay
  // silent even if one was left active (§13.29).
  const liveTrunks = (table: string) =>
    db().query(
      `SELECT t.id, t.name, t.enterprise_id, t.tps FROM ${table} t JOIN enterprises e ON e.id = t.enterprise_id
        WHERE t.deleted_at IS NULL AND t.status = 'active' AND e.deleted_at IS NULL`,
    );
  const [{ rows: ct }, { rows: vt }, { rows: ents }, { rows: codes }] = await Promise.all([
    liveTrunks("customer_trunks"),
    liveTrunks("vendor_trunks"),
    // Live screens show enterprises by alias (team trial round 1); the name when the alias is empty.
    db().query("SELECT id, COALESCE(NULLIF(alias, ''), name) AS name FROM enterprises"),
    db().query(
      "SELECT m.mccmnc, m.network, co.name AS country, co.iso FROM mccmnc m JOIN countries co ON co.id = m.country_id",
    ),
  ]);
  const entName = new Map(ents.map((e) => [Number(e.id), e.name as string]));
  const codeName = new Map(codes.map((c) => [c.mccmnc as string, [c.country as string, c.network as string] as const]));
  for (const c of codes) if (c.iso) COUNTRY_ISO.set(c.country as string, c.iso as string);
  const f = await sysToPlatformFactor();
  type Stat = { id: number; n: string; rev: number; cost: number; ok: string; dl: string; sent: string };
  const stats = (col: string) =>
    chRows<Stat>(
      `SELECT ${col} AS id, count() AS n, toFloat64(sum(revenue_sys * ${f})) AS rev, toFloat64(sum(cost_sys * ${f})) AS cost,
              countIf(is_submit_success = 1) AS ok, countIf(msg_status = 'DELIVRD') AS dl, countIf(v_trunk_id > 0) AS sent
         FROM edr WHERE submit_time > (SELECT max(submit_time) FROM edr) - INTERVAL 7 DAY AND toString(${col}) NOT IN ('0', '') GROUP BY id`,
      15_000,
    );
  const day = (col: string) =>
    chRows<Stat & { name?: string }>(
      `SELECT ${col} AS id, count() AS n, toFloat64(sum(revenue_sys * ${f})) AS rev, toFloat64(sum(cost_sys * ${f})) AS cost,
              countIf(is_submit_success = 1) AS ok, countIf(msg_status = 'DELIVRD') AS dl, countIf(v_trunk_id > 0) AS sent
         FROM edr WHERE submit_time >= ${PLATFORM_DAY_START_SQL} AND toString(${col}) NOT IN ('0', '') GROUP BY id`,
      15_000,
    );
  const [cStats, vStats, dStats, cDay, vDay, dDay] = await Promise.all([
    stats("c_trunk_id"),
    stats("v_trunk_id"),
    stats("c_mccmnc"),
    day("c_enterprise_id"),
    day("v_enterprise_id"),
    day("c_mccmnc"),
  ]);
  // No EDR store yet (it starts after the server, or is busy): load again later rather than run a day with no
  // vendors and no destinations (team trial round 2; createSimulator retries every minute).
  if (cStats === null || vStats === null || dStats === null) throw new Error("the EDR store did not answer");
  const cBy = new Map((cStats ?? []).map((s) => [Number(s.id), s]));
  const vBy = new Map((vStats ?? []).map((s) => [Number(s.id), s]));
  const cTotal = [...cBy.values()].reduce((s, x) => s + Number(x.n), 0) || 1;
  const vTotal = [...vBy.values()].reduce((s, x) => s + Number(x.n), 0) || 1;
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const TOTAL_TPS = SIM_TOTAL_TPS ?? Math.max(0.01, (cStats ? cTotal : 0) / (7 * 86_400));

  const trunks: SimTrunk[] = ct.map((r) => {
    const s = cBy.get(Number(r.id));
    const n = s ? Number(s.n) : 0;
    const share = n / cTotal;
    const limit = Number(r.tps);
    // Floors scale with the platform, so quiet trunks never add up to more than the platform itself.
    const base = s
      ? Math.min(limit * 0.85, Math.max(TOTAL_TPS / 6000, share * TOTAL_TPS))
      : Math.min(limit * 0.5, (TOTAL_TPS / 2000) * rand(0.5, 4));
    const t: SimTrunk = {
      id: Number(r.id),
      name: r.name,
      enterpriseId: Number(r.enterprise_id),
      enterpriseName: entName.get(Number(r.enterprise_id)) ?? `#${r.enterprise_id}`,
      limit,
      base,
      tps: 0,
      sentShare: s && n ? Number(s.sent) / n : 0.98,
      revenue: s && n ? s.rev / n : 0.03,
      cost: s && n ? s.cost / n : 0.024,
      asr: s ? ratio(Number(s.ok), n) : null,
      dlr: s ? ratio(Number(s.dl), Number(s.ok)) : null,
      segments: [],
      asrNow: s ? ratio(Number(s.ok), n) : null,
      dlrNow: s ? ratio(Number(s.dl), Number(s.ok)) : null,
      delayNow: BASE_DELAY,
      dip: null,
      minAsr: [],
      minDlr: [],
      minDelay: [],
      qSum: [0, 0, 0],
      day: emptyDay(),
      minutes: [],
      minuteSum: 0,
      minuteN: 0,
      slots: new Float32Array(SLOTS),
      slotSum: 0,
      slotN: 0,
    };
    extendSegments(t.segments, now + 60 * 60_000, !!s);
    return t;
  });
  const vendors: SimVendor[] = vt
    .map((r) => {
      const s = vBy.get(Number(r.id));
      const n = s ? Number(s.n) : 0;
      return {
        id: Number(r.id),
        name: r.name as string,
        enterpriseId: Number(r.enterprise_id),
        enterpriseName: entName.get(Number(r.enterprise_id)) ?? `#${r.enterprise_id}`,
        limit: Number(r.tps),
        weight: n / vTotal,
        tps: 0,
        cost: s && n ? s.cost / n : 0.024,
        asr: s ? ratio(Number(s.ok), n) : null,
        dlr: s ? ratio(Number(s.dl), Number(s.ok)) : null,
        asrNow: s ? ratio(Number(s.ok), n) : null,
        dlrNow: s ? ratio(Number(s.dl), Number(s.ok)) : null,
        delayNow: BASE_DELAY,
        dip: null,
        minutes: [],
        minAsr: [],
        minDlr: [],
        minDelay: [],
        minuteSum: 0,
        minuteN: 0,
        qSum: [0, 0, 0] as [number, number, number],
        day: emptyDay(),
      };
    })
    .filter((v) => v.weight > 0);

  for (const s of cDay ?? []) {
    const id = Number(s.id);
    const n = Number(s.n);
    today.attempts += n;
    today.submitted += Number(s.ok);
    today.sent += Number(s.sent);
    today.delivered += Number(s.dl);
    today.revenue += s.rev;
    today.cost += s.cost;
    today.clients.set(id, {
      name: entName.get(id) ?? `#${id}`,
      attempts: n,
      money: s.rev,
      margin: s.rev - s.cost,
      successful: Number(s.ok),
      delivered: Number(s.dl),
    });
  }
  for (const s of vDay ?? []) {
    const id = Number(s.id);
    today.vendors.set(id, {
      name: entName.get(id) ?? `#${id}`,
      attempts: Number(s.n),
      money: s.cost,
      margin: s.rev - s.cost,
      successful: Number(s.ok),
      delivered: Number(s.dl),
    });
  }
  for (const s of dDay ?? []) {
    const code = String(s.id);
    const [country, network] = codeName.get(code) ?? ([code, ""] as const);
    today.destinations.set(code, {
      country,
      network,
      attempts: Number(s.n),
      revenue: s.rev,
      margin: s.rev - s.cost,
      successful: Number(s.ok),
      delivered: Number(s.dl),
    });
  }
  const destMix: DestMix[] = [];
  for (const d of dStats?.length ? dStats : (dDay ?? [])) {
    const code = String(d.id);
    const n = Number(d.n);
    if (!n || code === "0" || code === "") continue;
    const [country, network] = codeName.get(code) ?? ([code, ""] as const);
    const ok = Number(d.ok);
    destMix.push({
      code,
      country,
      network,
      weight: n,
      revenue: d.rev / n,
      margin: (d.rev - d.cost) / n,
      okP: ok / n,
      dlP: ok > 0 ? Number(d.dl) / ok : 0,
    });
  }
  return { trunks, vendors, today, destMix };
}

/** Fills two hours of per-minute history and an hour of 5-second chart slots from the timelines. */
function seedHistory(sim: Simulator, now: number) {
  // Today's figures per trunk: the enterprise's day split by the trunks' normal levels.
  const split = <T extends { enterpriseId: number; day: PartyDay }>(
    xs: T[],
    weight: (x: T) => number,
    m: Map<number, PartyTotals>,
    vendor: boolean,
  ) => {
    const byEnt = new Map<number, T[]>();
    for (const x of xs) byEnt.set(x.enterpriseId, [...(byEnt.get(x.enterpriseId) ?? []), x]);
    for (const [ent, list] of byEnt) {
      const p = m.get(ent);
      if (!p) continue;
      const w = list.reduce((acc, x) => acc + weight(x), 0) || 1;
      for (const x of list) {
        const f = weight(x) / w;
        x.day = {
          attempts: p.attempts * f,
          submitted: p.successful * f,
          delivered: p.delivered * f,
          revenue: vendor ? 0 : p.money * f,
          cost: vendor ? p.money * f : (p.money - p.margin) * f,
        };
      }
    }
  };
  split(sim.trunks, (t) => t.base, sim.today.clients, false);
  split(sim.vendors, (v) => v.weight, sim.today.vendors, true);
  for (const v of sim.vendors) {
    v.minutes = Array.from({ length: MINUTES }, () => 0);
    v.minAsr = Array.from({ length: MINUTES }, () => v.asr);
    v.minDlr = Array.from({ length: MINUTES }, () => v.dlr);
    v.minDelay = Array.from({ length: MINUTES }, () => BASE_DELAY);
  }
  for (const t of sim.trunks) {
    t.minAsr = Array.from({ length: MINUTES }, () => t.asr);
    t.minDlr = Array.from({ length: MINUTES }, () => t.dlr);
    t.minDelay = Array.from({ length: MINUTES }, () => BASE_DELAY);
    t.minutes = [];
    for (let m = MINUTES - 1; m >= 1; m--) {
      const at = now - m * 60_000 + 30_000;
      t.minutes.push(Math.max(0, t.base * levelAt(t.segments, at) * rand(0.95, 1.05)));
    }
    t.minutes.push(0);
    for (let i = 0; i < SLOTS; i++) {
      const at = now - (SLOTS - i) * SLOT_S * 1000;
      t.slots[i] = Math.max(0, t.base * levelAt(t.segments, at) * rand(0.9, 1.1));
    }
  }
  sim.slotIndex = SLOTS - 1; // the newest seeded slot; the next step moves on
  // Live values start at the seeded level, not at zero, so the chart has no dip after a restart.
  let total = 0;
  for (const t of sim.trunks) total += t.rate = t.base * levelAt(t.segments, now);
  for (const v of sim.vendors) v.rate = total * v.weight;
  // Until 10 seconds of messages are in, TPS starts at the seeded rate.
  for (const x of [...sim.trunks, ...sim.vendors]) {
    x.tps = Math.round((x.rate ?? 0) * 10) / 10;
    x.recent = Array.from({ length: TPS_WINDOW - 1 }, () => x.rate ?? 0);
    if ((x.rate ?? 0) > 0.001) x.lastSentAt = now;
  }
  // Vendor minute history follows the customers' total by share.
  for (let i = 0; i < MINUTES; i++) {
    const sum = sim.trunks.reduce((acc, t) => acc + (t.minutes[i] ?? 0), 0);
    for (const v of sim.vendors) v.minutes[i] = sum * v.weight;
  }
}

/** Starts, ends or applies a quality dip; returns the quality now (§13.6 alert material). */
function quality(
  x: {
    asr: number | null;
    dlr: number | null;
    dip: Dip | null;
    asrNow: number | null;
    dlrNow: number | null;
    delayNow: number;
  },
  sending: boolean,
  now: number,
) {
  if (x.dip && now >= x.dip.until) x.dip = null;
  if (!x.dip && sending && Math.random() < DIP_PER_SECOND)
    x.dip = { until: now + rand(6, 25) * 60_000, asrF: rand(0.75, 0.97), dlrF: rand(0.45, 0.8), delayF: rand(2, 6) };
  const d = x.dip;
  const jitter = () => rand(-0.6, 0.6);
  x.asrNow = x.asr === null ? null : Math.min(100, Math.max(0, x.asr * (d?.asrF ?? 1) + jitter()));
  x.dlrNow = x.dlr === null ? null : Math.min(100, Math.max(0, x.dlr * (d?.dlrF ?? 1) + jitter()));
  x.delayNow = Math.max(0.5, BASE_DELAY * (d?.delayF ?? 1) * rand(0.9, 1.1));
}

/** Per-minute averages of a trunk's or vendor's TPS and quality. */
function rollMinute(
  x: {
    minutes: number[];
    minAsr: (number | null)[];
    minDlr: (number | null)[];
    minDelay: number[];
    minuteSum: number;
    minuteN: number;
    qSum: [number, number, number];
    tps: number;
    asrNow: number | null;
    dlrNow: number | null;
    delayNow: number;
  },
  newMinute: boolean,
) {
  if (newMinute) {
    for (const a of [x.minutes, x.minAsr, x.minDlr, x.minDelay] as unknown[][]) {
      a.push(0);
      if (a.length > MINUTES) a.shift();
    }
    x.minuteSum = 0;
    x.minuteN = 0;
    x.qSum = [0, 0, 0];
  }
  x.minuteSum += x.tps;
  x.minuteN += 1;
  x.qSum[0] += x.asrNow ?? 0;
  x.qSum[1] += x.dlrNow ?? 0;
  x.qSum[2] += x.delayNow;
  const last = x.minutes.length - 1;
  x.minutes[last] = x.minuteSum / x.minuteN;
  x.minAsr[last] = x.asrNow === null ? null : x.qSum[0] / x.minuteN;
  x.minDlr[last] = x.dlrNow === null ? null : x.qSum[1] / x.minuteN;
  x.minDelay[last] = x.qSum[2] / x.minuteN;
}

export async function createSimulator(): Promise<Simulator> {
  let loaded: Awaited<ReturnType<typeof loadFromStores>>;
  let demo = false;
  try {
    loaded = await loadFromStores();
  } catch (err) {
    demo = !process.env.NODE_TEST_CONTEXT;
    console.warn(`live simulator: stores unavailable (${(err as Error).message}), using demo trunks`);
    // No database: a handful of fake trunks so the shell still shows live values (CLAUDE.md rule 1).
    const now = Date.now();
    const trunks = Array.from({ length: 20 }, (_, i) => {
      const t: SimTrunk = {
        id: i + 1,
        name: `DEMO_TRUNK_${i + 1}`,
        enterpriseId: i + 1,
        enterpriseName: `Demo client ${i + 1}`,
        limit: [50, 100, 200, 500][i % 4]!,
        base: rand(5, 60),
        tps: 0,
        sentShare: 0.98,
        revenue: 0.03,
        cost: 0.024,
        asr: 95,
        dlr: 85,
        segments: [],
        asrNow: 95,
        dlrNow: 85,
        delayNow: BASE_DELAY,
        dip: null,
        minAsr: [],
        minDlr: [],
        minDelay: [],
        qSum: [0, 0, 0],
        day: emptyDay(),
        minutes: [],
        minuteSum: 0,
        minuteN: 0,
        slots: new Float32Array(SLOTS),
        slotSum: 0,
        slotN: 0,
      };
      extendSegments(t.segments, now + 3_600_000, true);
      return t;
    });
    loaded = {
      trunks,
      vendors: [],
      destMix: [],
      today: {
        day: platformDay(now),
        attempts: 0,
        submitted: 0,
        sent: 0,
        delivered: 0,
        revenue: 0,
        cost: 0,
        clients: new Map(),
        vendors: new Map(),
        destinations: new Map(),
      },
    };
  }
  const sim: Simulator = {
    ...loaded,
    slotIndex: 0,
    lastTick: Date.now(),
    // Money comes from the live EDR writer from the first message, so nothing is counted twice while it
    // gets ready; it turns this off again if the EDR store can't be used.
    moneyFromWriter: process.env.SIM_WRITE_EDRS !== "0" && !process.env.NODE_TEST_CONTEXT,
  };
  seedHistory(sim, Date.now());
  if (demo) retryLoad(sim);
  return sim;
}

/**
 * After a failed start (stores down or busy, e.g. a statement timeout while the server starts) the demo
 * trunks stand in; the real ones are loaded again every minute and replace them (team trial round 2).
 */
function retryLoad(sim: Simulator) {
  const timer = setInterval(() => {
    loadFromStores()
      .then((loaded) => {
        clearInterval(timer);
        Object.assign(sim, loaded);
        seedHistory(sim, Date.now());
        console.log("live simulator: stores loaded, demo trunks replaced");
      })
      .catch((err: Error) => console.warn(`live simulator: stores still unavailable (${err.message})`));
  }, 60_000);
  timer.unref();
}

// ---------------------------------------------------------------- one second

/** Seconds of messages behind a TPS figure: TPS is a rate, measured over the last 10 seconds. */
const TPS_WINDOW = 10;

/** Records the whole messages a trunk sent this second; its TPS is their average over the window. */
function windowTps(x: SimTrunk | SimVendor, n: number, now: number) {
  const recent = (x.recent ??= []);
  recent.push(n);
  if (recent.length > TPS_WINDOW) recent.shift();
  x.tps = Math.round((recent.reduce((a, b) => a + b, 0) / TPS_WINDOW) * 10) / 10;
  if (n > 0) x.lastSentAt = now;
}

/** Sending: sent a message in the last minute. */
const sending = (x: SimTrunk | SimVendor, now: number) => (x.lastSentAt ?? 0) > now - 60_000;

/** Advances the simulation to `now`: TPS per trunk and vendor, histories and today's totals. */
export function step(sim: Simulator, now = Date.now()) {
  const dt = Math.min(5, Math.max(0, (now - sim.lastTick) / 1000));
  const prevMinute = Math.floor(sim.lastTick / 60_000);
  const prevSlot = Math.floor(sim.lastTick / (SLOT_S * 1000));
  sim.lastTick = now;
  if (platformDay(now) !== sim.today.day) {
    sim.today = {
      ...sim.today,
      day: platformDay(now),
      attempts: 0,
      submitted: 0,
      sent: 0,
      delivered: 0,
      revenue: 0,
      cost: 0,
    };
    sim.today.clients = new Map();
    sim.today.vendors = new Map();
    sim.today.destinations = new Map();
    for (const x of [...sim.trunks, ...sim.vendors]) x.day = emptyDay();
  }
  const newMinute = Math.floor(now / 60_000) !== prevMinute;
  const newSlot = Math.floor(now / (SLOT_S * 1000)) !== prevSlot;
  if (newSlot) sim.slotIndex = (sim.slotIndex + 1) % SLOTS;
  // SMS are whole (team trial round 1): each trunk has a sending rate, and sends the whole messages it
  // has built up this second; `tps` is the messages it sent in the last second.
  let total = 0;
  const sent: { t: SimTrunk; n: number }[] = [];
  for (const t of sim.trunks) {
    extendSegments(t.segments, now + 60 * 60_000, true);
    const target = t.base * levelAt(t.segments, now);
    // Smooth random walk around the timeline, with rare bursts past the limit.
    // Thresholds and bursts follow the trunk's own level, so the simulated money and alerts stay at the
    // volume of the stored traffic (a quiet trunk sends a few messages an hour; team trial round 1).
    const prev = t.rate ?? t.tps;
    let rate = target <= t.base * 0.02 ? 0 : Math.max(0, prev * 0.6 + target * 0.4 + rand(-0.12, 0.12) * target);
    // About one burst every 5 seconds across the platform: three times the trunk's usual level.
    if (target > 0 && Math.random() < 0.2 / sim.trunks.length) rate += t.base * 3;
    t.rate = rate;
    t.owed = (t.owed ?? 0) + rate * dt;
    const n = Math.floor(t.owed);
    t.owed -= n;
    windowTps(t, n, now);
    total += n;
    quality(t, rate > 0.001, now);
    rollMinute(t, newMinute);
    if (newSlot) {
      t.slotSum = 0;
      t.slotN = 0;
    }
    t.slotSum += t.tps;
    t.slotN += 1;
    t.slots[sim.slotIndex] = t.slotSum / t.slotN;
    if (n === 0) continue;
    sent.push({ t, n });

    // Today's money and counts, message by message.
    const asr = (t.asrNow ?? 95) / 100;
    const dlr = (t.dlrNow ?? 85) / 100;
    // Sent to a vendor but refused, beyond the ones accepted (the share stays at least the ASR).
    const refused = asr < 1 ? Math.max(0, t.sentShare - asr) / (1 - asr) : 0;
    let ok = 0;
    let dl = 0;
    let toVendor = 0;
    const pending = (t.pending ??= [0, 0, 0, 0]);
    for (let k = 0; k < n; k++) {
      if (Math.random() < asr) {
        ok++;
        toVendor++;
        if (Math.random() < dlr) {
          dl++;
          pending[0]++;
        } else pending[1]++;
      } else if (Math.random() < refused) {
        toVendor++;
        pending[2]++;
      } else pending[3]++;
    }
    t.day.attempts += n;
    t.day.submitted += ok;
    t.day.delivered += dl;
    const today = sim.today;
    today.attempts += n;
    today.submitted += ok;
    today.sent += toVendor;
    today.delivered += dl;
    // With live EDRs the money is added when the messages are written, at the routed vendor's cost.
    const money = !sim.moneyFromWriter;
    if (money) {
      t.day.revenue += n * t.revenue;
      t.day.cost += n * t.cost;
      today.revenue += n * t.revenue;
      today.cost += n * t.cost;
    }
    const c = today.clients.get(t.enterpriseId) ?? {
      name: t.enterpriseName,
      attempts: 0,
      money: 0,
      margin: 0,
      successful: 0,
      delivered: 0,
    };
    c.attempts += n;
    if (money) {
      c.money += n * t.revenue;
      c.margin += n * (t.revenue - t.cost);
    }
    c.successful += ok;
    c.delivered += dl;
    today.clients.set(t.enterpriseId, c);
  }
  // Each message goes to one vendor: the one today's route rules picked (live EDR writer, a second
  // behind), or else one picked by the vendors' shares.
  const weights = sim.vendors.map((v) => v.weight);
  const wSum = weights.reduce((a, w) => a + w, 0);
  const toVendor = new Map<SimVendor, number>();
  if (sim.moneyFromWriter)
    for (const v of sim.vendors) {
      if (v.routed) toVendor.set(v, v.routed);
      v.routed = 0;
    }
  else if (wSum > 0)
    for (let k = 0; k < total; k++) {
      let r = Math.random() * wSum;
      const v = sim.vendors.find((_, i) => (r -= weights[i]!) <= 0) ?? sim.vendors[0]!;
      toVendor.set(v, (toVendor.get(v) ?? 0) + 1);
    }
  for (const v of sim.vendors) {
    const n = toVendor.get(v) ?? 0;
    windowTps(v, n, now);
    v.rate = (v.rate ?? 0) * 0.8 + n * 0.2;
    quality(v, v.rate > 0.001, now);
    rollMinute(v, newMinute);
    // The writer has already counted these messages and their cost.
    if (n === 0 || sim.moneyFromWriter) continue;
    const vAsr = (v.asrNow ?? 95) / 100;
    const vDlr = (v.dlrNow ?? 85) / 100;
    let ok = 0;
    let dl = 0;
    for (let k = 0; k < n; k++)
      if (Math.random() < vAsr) {
        ok++;
        if (Math.random() < vDlr) dl++;
      }
    v.day.attempts += n;
    v.day.submitted += ok;
    v.day.delivered += dl;
    v.day.cost += n * v.cost;
    const p = sim.today.vendors.get(v.enterpriseId) ?? {
      name: v.enterpriseName,
      attempts: 0,
      money: 0,
      margin: 0,
      successful: 0,
      delivered: 0,
    };
    p.attempts += n;
    p.money += n * v.cost;
    p.successful += ok;
    p.delivered += dl;
    sim.today.vendors.set(v.enterpriseId, p);
  }
  // Each message goes to one destination, picked by the 7-day mix; today's figures grow from it, also
  // after midnight when they start again from zero (team trial round 2).
  const mix = sim.destMix;
  const dSum = mix.reduce((a, d) => a + d.weight, 0);
  if (dSum > 0)
    for (let k = 0; k < total; k++) {
      let r = Math.random() * dSum;
      const m = mix.find((x) => (r -= x.weight) <= 0) ?? mix[0]!;
      let d = sim.today.destinations.get(m.code);
      if (!d) {
        d = { country: m.country, network: m.network, attempts: 0, revenue: 0, margin: 0, successful: 0, delivered: 0 };
        sim.today.destinations.set(m.code, d);
      }
      d.revenue += m.revenue;
      d.margin += m.margin;
      d.attempts += 1;
      if (Math.random() < m.okP) {
        d.successful += 1;
        if (Math.random() < m.dlP) d.delivered += 1;
      }
    }
  return total;
}

// ---------------------------------------------------------------- events

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Money is calculated to 6 decimals; screens choose how many to show (team trial round 3). */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);

export function tickEvent(sim: Simulator, now = Date.now()): TpsTickEvent {
  // Sending now (by rate); the TPS shown is the whole messages of the last second.
  const customers = sim.trunks
    .filter((t) => sending(t, now))
    .sort((a, b) => b.tps - a.tps || (b.rate ?? 0) - (a.rate ?? 0));
  const vendors = sim.vendors
    .filter((v) => sending(v, now))
    .sort((a, b) => b.tps - a.tps || (b.rate ?? 0) - (a.rate ?? 0));
  const queue = (tps: number, limit: number) => (tps > limit ? Math.round((tps - limit) * 5) : 0);
  return {
    at: new Date(now).toISOString(),
    totalTps: r1(customers.reduce((s, t) => s + t.tps, 0)),
    trunks: [
      ...customers.slice(0, 60).map((t) => ({
        trunk: { kind: "customer_trunk" as const, id: t.id, name: t.name },
        tps: r2(t.tps),
        tpsLimit: t.limit,
        queueDepth: queue(t.tps, t.limit),
      })),
      ...vendors.slice(0, 40).map((v) => ({
        trunk: { kind: "vendor_trunk" as const, id: v.id, name: v.name },
        tps: r2(v.tps),
        tpsLimit: v.limit,
        queueDepth: queue(v.tps, v.limit),
      })),
    ],
  };
}

export function summaryEvent(sim: Simulator, now = Date.now()): DashboardSummaryEvent {
  const t = sim.today;
  const tps = sim.trunks.reduce((s, x) => s + x.tps, 0);
  const online = (xs: (SimTrunk | SimVendor)[]) =>
    new Set(xs.filter((x) => sending(x, now)).map((x) => x.enterpriseId)).size;
  const top = [...t.destinations.entries()]
    .filter(([code]) => code.length >= 5)
    .sort((a, b) => b[1].attempts - a[1].attempts)
    .slice(0, 5);
  return {
    at: new Date(now).toISOString(),
    currency: PLATFORM_CURRENCY,
    attempts: Math.round(t.attempts),
    // "Submitted" as in the reports and Live analytics: sent to a vendor (team trial round 1).
    submitted: Math.round(t.sent),
    delivered: Math.round(t.delivered),
    revenue: r6(t.revenue),
    cost: r6(t.cost),
    margin: r6(t.revenue - t.cost),
    marginPct: t.revenue > 0 ? r2(((t.revenue - t.cost) / t.revenue) * 100) : 0,
    asr: pct(t.submitted, t.attempts) ?? 0,
    dlr: pct(t.delivered, t.submitted) ?? 0,
    tps: r2(tps),
    onlineCustomers: online(sim.trunks),
    onlineVendors: online(sim.vendors),
    topDestinations: top.map(([mccmnc, d]) => ({
      mccmnc,
      country: d.country,
      network: d.network,
      attempts: Math.round(d.attempts),
    })),
  };
}

/** Country name → ISO code, from the destination master list (top destinations by country, team trial round 2). */
export const COUNTRY_ISO = new Map<string, string>();

/** Today's destinations added up per country, all networks together (team trial round 2). */
export function topCountries(destinations: Map<string, DestTotals>, limit = 15): DashboardTopsEvent["destinations"] {
  const by = new Map<string, DestTotals & { networks: number }>();
  for (const d of destinations.values()) {
    const c = by.get(d.country) ?? {
      ...d,
      network: "",
      attempts: 0,
      revenue: 0,
      margin: 0,
      successful: 0,
      delivered: 0,
      networks: 0,
    };
    c.attempts += d.attempts;
    c.revenue += d.revenue;
    c.margin += d.margin;
    c.successful += d.successful;
    c.delivered += d.delivered;
    c.networks += 1;
    by.set(d.country, c);
  }
  return [...by.values()]
    .filter((c) => COUNTRY_ISO.has(c.country))
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, limit)
    .map((c) => ({
      iso: COUNTRY_ISO.get(c.country)!,
      country: c.country,
      networks: c.networks,
      attempts: Math.round(c.attempts),
      revenue: r6(c.revenue),
      margin: r6(c.margin),
      asr: pct(c.successful, c.attempts),
      dlr: pct(c.delivered, c.successful),
    }));
}

export function topsEvent(sim: Simulator, now = Date.now()): DashboardTopsEvent {
  const party = (kind: "customer_enterprise" | "vendor_enterprise", m: Map<number, PartyTotals>) =>
    [...m.entries()]
      .sort((a, b) => b[1].attempts - a[1].attempts)
      .slice(0, 15)
      .map(([id, p]) => ({
        party: { kind, id, name: p.name },
        attempts: Math.round(p.attempts),
        money: r2(p.money),
        margin: r6(p.margin),
        asr: pct(p.successful, p.attempts),
        dlr: pct(p.delivered, p.successful),
      }));
  return {
    at: new Date(now).toISOString(),
    currency: PLATFORM_CURRENCY,
    clients: party("customer_enterprise", sim.today.clients),
    vendors: party("vendor_enterprise", sim.today.vendors),
    destinations: topCountries(sim.today.destinations),
  };
}

/**
 * Today's figures again from the EDR store (team trial round 2), so the dashboard shows what Live analytics and
 * the reports show: the same messages and the same conversion to the platform currency at the current rate.
 * Run every minute; also catches up when the EDR store was not ready at start. Messages sent in the last
 * second and not yet written come in on the next run. Skipped (figures kept) when the store does not answer.
 */
export async function resyncToday(sim: Simulator): Promise<boolean> {
  if (process.env.NODE_TEST_CONTEXT) return false;
  const day = platformDay(Date.now());
  const f = await sysToPlatformFactor();
  type Row = { id: string; n: string; rev: number; cost: number; ok: string; dl: string; sent: string };
  const q = (col: string) =>
    chRows<Row>(
      `SELECT toString(${col}) AS id, count() AS n, toFloat64(sum(revenue_sys * ${f})) AS rev,
              toFloat64(sum(cost_sys * ${f})) AS cost, countIf(is_submit_success = 1) AS ok,
              countIf(msg_status = 'DELIVRD') AS dl, countIf(v_trunk_id > 0) AS sent
         FROM edr WHERE submit_time >= ${PLATFORM_DAY_START_SQL} AND toString(${col}) NOT IN ('0', '') GROUP BY id`,
      15_000,
    );
  const top = (col: string) =>
    chRows<{ id: string; code: string }>(
      `SELECT toString(${col}) AS id, toString(topK(1)(c_mccmnc)[1]) AS code FROM edr
        WHERE submit_time > now() - INTERVAL 1 HOUR AND ${col} > 0 GROUP BY ${col}`,
      15_000,
    );
  const [cDay, vDay, dDay, cTop, vTop] = await Promise.all([
    q("c_enterprise_id"),
    q("v_enterprise_id"),
    q("c_mccmnc"),
    top("c_trunk_id"),
    top("v_trunk_id"),
  ]);
  if (cTop && vTop)
    sim.topDest = {
      customer: new Map(cTop.map((r) => [Number(r.id), r.code])),
      vendor: new Map(vTop.map((r) => [Number(r.id), r.code])),
    };
  if (!cDay || !vDay || !dDay || day !== sim.today.day) return false;
  const names = new Map<number, string>();
  for (const x of [...sim.trunks, ...sim.vendors]) names.set(x.enterpriseId, x.enterpriseName);
  const party = (rows: Row[], old: Map<number, PartyTotals>, vendor: boolean) =>
    new Map(
      rows.map((r) => {
        const id = Number(r.id);
        return [
          id,
          {
            name: old.get(id)?.name ?? names.get(id) ?? `#${id}`,
            attempts: Number(r.n),
            money: vendor ? r.cost : r.rev,
            margin: r.rev - r.cost,
            successful: Number(r.ok),
            delivered: Number(r.dl),
          },
        ];
      }),
    );
  const mix = new Map(sim.destMix.map((m) => [m.code, m]));
  const t = sim.today;
  t.clients = party(cDay, t.clients, false);
  t.vendors = party(vDay, t.vendors, true);
  t.destinations = new Map(
    dDay.map((r) => {
      const old = t.destinations.get(r.id) ?? mix.get(r.id);
      return [
        r.id,
        {
          country: old?.country ?? r.id,
          network: old?.network ?? "",
          attempts: Number(r.n),
          revenue: r.rev,
          margin: r.rev - r.cost,
          successful: Number(r.ok),
          delivered: Number(r.dl),
        },
      ];
    }),
  );
  t.attempts = cDay.reduce((a, r) => a + Number(r.n), 0);
  t.submitted = cDay.reduce((a, r) => a + Number(r.ok), 0);
  t.sent = cDay.reduce((a, r) => a + Number(r.sent), 0);
  t.delivered = cDay.reduce((a, r) => a + Number(r.dl), 0);
  t.revenue = cDay.reduce((a, r) => a + r.rev, 0);
  t.cost = cDay.reduce((a, r) => a + r.cost, 0);
  return true;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

type MoverInput = Pick<SimTrunk, "id" | "name" | "enterpriseId" | "enterpriseName" | "minutes" | "asr" | "dlr">;
type TopDestination = MoverRow["topDestination"];

/**
 * Traffic movers (§13.3 item 2): the last `window` minutes against the window before. Started: no traffic before,
 * sending now; stopped: the reverse (customer trunks). Customer and Vendor (team trial round 2, in place of
 * Increasing and Decreasing): the customer and vendor trunks whose traffic changed, biggest change first, that
 * sent at least the card's volume (messages in the window, now or before). Pure, so it can be tested with
 * made-up histories.
 */
export function computeMovers(
  trunks: { customers: MoverInput[]; vendors: MoverInput[] },
  windowMinutes: number,
  minMessages: { customer: number; vendor: number },
  now = Date.now(),
  limit = 15,
  topDestination: (kind: "customer" | "vendor", id: number) => TopDestination = () => null,
): DashboardMoversEvent {
  const ON = 0.2; // TPS that counts as sending
  const OFF = 0.05;
  const out: DashboardMoversEvent = {
    at: new Date(now).toISOString(),
    windowMinutes,
    customerMinMessages: minMessages.customer,
    vendorMinMessages: minMessages.vendor,
    started: [],
    customers: [],
    vendors: [],
    stopped: [],
  };
  const rowOf = (t: MoverInput, kind: "customer" | "vendor") => {
    const m = t.minutes;
    const cur = avg(m.slice(-windowMinutes));
    const before = avg(m.slice(-2 * windowMinutes, -windowMinutes));
    const row: MoverRow = {
      trunk: { kind: kind === "customer" ? "customer_trunk" : "vendor_trunk", id: t.id, name: t.name },
      enterprise: {
        kind: kind === "customer" ? "customer_enterprise" : "vendor_enterprise",
        id: t.enterpriseId,
        name: t.enterpriseName,
      },
      tpsNow: r1(cur),
      tpsBefore: r1(before),
      changePct: before > OFF ? r1(((cur - before) / before) * 100) : null,
      messagesNow: Math.round(cur * 60 * windowMinutes),
      messagesBefore: Math.round(before * 60 * windowMinutes),
      sparkline: m.slice(-60).map(r1),
      asr: t.asr,
      dlr: t.dlr,
      topDestination: topDestination(kind, t.id),
    };
    return { row, cur, before };
  };
  const changed = (kind: "customer" | "vendor", list: MoverInput[], min: number) =>
    list
      .map((t) => rowOf(t, kind))
      .filter(
        ({ row, cur, before }) =>
          before >= OFF &&
          cur >= OFF &&
          row.changePct !== null &&
          row.changePct !== 0 &&
          Math.max(row.messagesNow, row.messagesBefore) >= min,
      )
      .map((x) => x.row)
      .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!))
      .slice(0, limit);
  for (const t of trunks.customers) {
    const { row, cur, before } = rowOf(t, "customer");
    if (before < OFF && cur >= ON) out.started.push(row);
    else if (before >= ON && cur < OFF) out.stopped.push(row);
  }
  out.started = out.started.sort((a, b) => b.tpsNow - a.tpsNow).slice(0, limit);
  out.stopped = out.stopped.sort((a, b) => b.tpsBefore - a.tpsBefore).slice(0, limit);
  out.customers = changed("customer", trunks.customers, minMessages.customer);
  out.vendors = changed("vendor", trunks.vendors, minMessages.vendor);
  return out;
}

/** Total TPS and the 10 busiest customer trunks over the last hour, in 5-second steps. */
export function historyEvent(sim: Simulator, now = Date.now()): TpsHistoryEvent {
  const order = (i: number) => (sim.slotIndex + 1 + i) % SLOTS; // oldest first
  const total = Array.from({ length: SLOTS }, (_, i) => r1(sim.trunks.reduce((s, t) => s + t.slots[order(i)]!, 0)));
  const top = [...sim.trunks].sort((a, b) => (b.rate ?? b.tps) - (a.rate ?? a.tps)).slice(0, 10);
  return {
    at: new Date(now).toISOString(),
    stepSeconds: SLOT_S,
    total,
    series: top.map((t) => ({
      trunk: { kind: "customer_trunk" as const, id: t.id, name: t.name },
      values: Array.from({ length: SLOTS }, (_, i) => r1(t.slots[order(i)]!)),
    })),
  };
}

/** Movers' top destination with its country and network name (team trial round 2). */
export function topDestinationOf(sim: Simulator): (kind: "customer" | "vendor", id: number) => TopDestination {
  const names = new Map(sim.destMix.map((m) => [m.code, `${m.country}${m.network ? ` ${m.network}` : ""}`]));
  return (kind, id) => {
    const code = sim.topDest?.[kind].get(id);
    return code ? { mccmnc: code, name: names.get(code) ?? code } : null;
  };
}
