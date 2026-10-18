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

const TOTAL_TPS = Number(process.env.SIM_TOTAL_TPS ?? 1800);
const MINUTES = 120; // per-minute history kept for the movers (two 60-minute windows)
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
  submitted: number;
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

export interface Simulator {
  trunks: SimTrunk[];
  vendors: SimVendor[];
  today: DayTotals;
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

async function loadFromStores(): Promise<{ trunks: SimTrunk[]; vendors: SimVendor[]; today: DayTotals }> {
  const now = Date.now();
  const today: DayTotals = {
    day: platformDay(now),
    attempts: 0,
    submitted: 0,
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
      "SELECT m.mccmnc, m.network, co.name AS country FROM mccmnc m JOIN countries co ON co.id = m.country_id",
    ),
  ]);
  const entName = new Map(ents.map((e) => [Number(e.id), e.name as string]));
  const codeName = new Map(codes.map((c) => [c.mccmnc as string, [c.country as string, c.network as string] as const]));
  const f = await sysToPlatformFactor();
  type Stat = { id: number; n: string; rev: number; cost: number; ok: string; dl: string };
  const stats = (col: string) =>
    chRows<Stat>(
      `SELECT ${col} AS id, count() AS n, toFloat64(sum(revenue_sys * ${f})) AS rev, toFloat64(sum(cost_sys * ${f})) AS cost,
              countIf(is_submit_success = 1) AS ok, countIf(msg_status = 'DELIVRD') AS dl
         FROM edr WHERE submit_time > (SELECT max(submit_time) FROM edr) - INTERVAL 7 DAY AND ${col} > 0 GROUP BY id`,
      15_000,
    );
  const day = (col: string) =>
    chRows<Stat & { name?: string }>(
      `SELECT ${col} AS id, count() AS n, toFloat64(sum(revenue_sys * ${f})) AS rev, toFloat64(sum(cost_sys * ${f})) AS cost,
              countIf(is_submit_success = 1) AS ok, countIf(msg_status = 'DELIVRD') AS dl
         FROM edr WHERE submit_time >= ${PLATFORM_DAY_START_SQL} AND toString(${col}) NOT IN ('0', '') GROUP BY id`,
      15_000,
    );
  const [cStats, vStats, cDay, vDay, dDay] = await Promise.all([
    stats("c_trunk_id"),
    stats("v_trunk_id"),
    day("c_enterprise_id"),
    day("v_enterprise_id"),
    day("c_mccmnc"),
  ]);
  const cBy = new Map((cStats ?? []).map((s) => [Number(s.id), s]));
  const vBy = new Map((vStats ?? []).map((s) => [Number(s.id), s]));
  const cTotal = [...cBy.values()].reduce((s, x) => s + Number(x.n), 0) || 1;
  const vTotal = [...vBy.values()].reduce((s, x) => s + Number(x.n), 0) || 1;
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

  const trunks: SimTrunk[] = ct.map((r) => {
    const s = cBy.get(Number(r.id));
    const n = s ? Number(s.n) : 0;
    const share = n / cTotal;
    const limit = Number(r.tps);
    const base = s ? Math.min(limit * 0.85, Math.max(0.3, share * TOTAL_TPS)) : Math.min(limit * 0.5, rand(0.5, 4));
    const t: SimTrunk = {
      id: Number(r.id),
      name: r.name,
      enterpriseId: Number(r.enterprise_id),
      enterpriseName: entName.get(Number(r.enterprise_id)) ?? `#${r.enterprise_id}`,
      limit,
      base,
      tps: 0,
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
  return { trunks, vendors, today };
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
  for (const t of sim.trunks) total += t.tps = t.base * levelAt(t.segments, now);
  for (const v of sim.vendors) v.tps = total * v.weight;
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
  try {
    loaded = await loadFromStores();
  } catch (err) {
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
      today: {
        day: platformDay(now),
        attempts: 0,
        submitted: 0,
        delivered: 0,
        revenue: 0,
        cost: 0,
        clients: new Map(),
        vendors: new Map(),
        destinations: new Map(),
      },
    };
  }
  const sim: Simulator = { ...loaded, slotIndex: 0, lastTick: Date.now() };
  seedHistory(sim, Date.now());
  return sim;
}

// ---------------------------------------------------------------- one second

/** Advances the simulation to `now`: TPS per trunk and vendor, histories and today's totals. */
export function step(sim: Simulator, now = Date.now()) {
  const dt = Math.min(5, Math.max(0, (now - sim.lastTick) / 1000));
  const prevMinute = Math.floor(sim.lastTick / 60_000);
  const prevSlot = Math.floor(sim.lastTick / (SLOT_S * 1000));
  sim.lastTick = now;
  if (platformDay(now) !== sim.today.day) {
    sim.today = { ...sim.today, day: platformDay(now), attempts: 0, submitted: 0, delivered: 0, revenue: 0, cost: 0 };
    sim.today.clients = new Map();
    sim.today.vendors = new Map();
    sim.today.destinations = new Map();
    for (const x of [...sim.trunks, ...sim.vendors]) x.day = emptyDay();
  }
  const newMinute = Math.floor(now / 60_000) !== prevMinute;
  const newSlot = Math.floor(now / (SLOT_S * 1000)) !== prevSlot;
  if (newSlot) sim.slotIndex = (sim.slotIndex + 1) % SLOTS;
  let total = 0;
  for (const t of sim.trunks) {
    extendSegments(t.segments, now + 60 * 60_000, true);
    const target = t.base * levelAt(t.segments, now);
    // Smooth random walk around the timeline, with rare bursts past the limit.
    t.tps = target < 0.01 ? 0 : Math.max(0, t.tps * 0.6 + target * 0.4 + rand(-0.12, 0.12) * target);
    // About one burst every 5 seconds across the platform, so queues and red limit bars show up.
    if (target > 0 && Math.random() < 0.2 / sim.trunks.length) t.tps += t.limit * 0.6;
    total += t.tps;
    quality(t, t.tps > 0.05, now);
    rollMinute(t, newMinute);
    if (newSlot) {
      t.slotSum = 0;
      t.slotN = 0;
    }
    t.slotSum += t.tps;
    t.slotN += 1;
    t.slots[sim.slotIndex] = t.slotSum / t.slotN;

    // Today's money and counts, as messages accrue.
    const msgs = t.tps * dt;
    if (msgs > 0) {
      const asr = (t.asrNow ?? 95) / 100;
      const dlr = (t.dlrNow ?? 85) / 100;
      t.day.attempts += msgs;
      t.day.submitted += msgs * asr;
      t.day.delivered += msgs * asr * dlr;
      t.day.revenue += msgs * t.revenue;
      t.day.cost += msgs * t.cost;
      const today = sim.today;
      today.attempts += msgs;
      today.submitted += msgs * asr;
      today.delivered += msgs * asr * dlr;
      today.revenue += msgs * t.revenue;
      today.cost += msgs * t.cost;
      const c = today.clients.get(t.enterpriseId) ?? {
        name: t.enterpriseName,
        attempts: 0,
        money: 0,
        margin: 0,
        successful: 0,
        delivered: 0,
      };
      c.attempts += msgs;
      c.money += msgs * t.revenue;
      c.margin += msgs * (t.revenue - t.cost);
      c.successful += msgs * asr;
      c.delivered += msgs * asr * dlr;
      today.clients.set(t.enterpriseId, c);
    }
  }
  // Vendors carry the total by their share, with their own noise.
  for (const v of sim.vendors) {
    v.tps = Math.max(0, v.tps * 0.6 + total * v.weight * 0.4 * rand(0.85, 1.15));
    quality(v, v.tps > 0.05, now);
    rollMinute(v, newMinute);
    const msgs = v.tps * dt;
    if (msgs <= 0) continue;
    const vAsr = (v.asrNow ?? 95) / 100;
    const vDlr = (v.dlrNow ?? 85) / 100;
    v.day.attempts += msgs;
    v.day.submitted += msgs * vAsr;
    v.day.delivered += msgs * vAsr * vDlr;
    v.day.cost += msgs * v.cost;
    const p = sim.today.vendors.get(v.enterpriseId) ?? {
      name: v.enterpriseName,
      attempts: 0,
      money: 0,
      margin: 0,
      successful: 0,
      delivered: 0,
    };
    p.attempts += msgs;
    p.money += msgs * v.cost;
    p.successful += msgs * vAsr;
    p.delivered += msgs * vAsr * vDlr;
    sim.today.vendors.set(v.enterpriseId, p);
  }
  // Destinations keep today's mix.
  const destTotal = [...sim.today.destinations.values()].reduce((s, d) => s + d.attempts, 0);
  if (destTotal > 0 && total > 0) {
    const grow = (total * dt) / destTotal;
    for (const d of sim.today.destinations.values()) {
      d.attempts += d.attempts * grow;
      d.revenue += d.revenue * grow;
      d.margin += d.margin * grow;
      d.successful += d.successful * grow;
      d.delivered += d.delivered * grow;
    }
  }
  return total;
}

// ---------------------------------------------------------------- events

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);

export function tickEvent(sim: Simulator, now = Date.now()): TpsTickEvent {
  const customers = sim.trunks.filter((t) => t.tps > 0.05).sort((a, b) => b.tps - a.tps);
  const vendors = sim.vendors.filter((v) => v.tps > 0.05).sort((a, b) => b.tps - a.tps);
  const queue = (tps: number, limit: number) => (tps > limit ? Math.round((tps - limit) * 5) : 0);
  return {
    at: new Date(now).toISOString(),
    totalTps: r1(customers.reduce((s, t) => s + t.tps, 0)),
    trunks: [
      ...customers.slice(0, 60).map((t) => ({
        trunk: { kind: "customer_trunk" as const, id: t.id, name: t.name },
        tps: r1(t.tps),
        tpsLimit: t.limit,
        queueDepth: queue(t.tps, t.limit),
      })),
      ...vendors.slice(0, 40).map((v) => ({
        trunk: { kind: "vendor_trunk" as const, id: v.id, name: v.name },
        tps: r1(v.tps),
        tpsLimit: v.limit,
        queueDepth: queue(v.tps, v.limit),
      })),
    ],
  };
}

export function summaryEvent(sim: Simulator, now = Date.now()): DashboardSummaryEvent {
  const t = sim.today;
  const tps = sim.trunks.reduce((s, x) => s + x.tps, 0);
  const online = (xs: { tps: number; enterpriseId: number }[]) =>
    new Set(xs.filter((x) => x.tps > 0.05).map((x) => x.enterpriseId)).size;
  const top = [...t.destinations.entries()]
    .filter(([code]) => code.length >= 5)
    .sort((a, b) => b[1].attempts - a[1].attempts)
    .slice(0, 5);
  return {
    at: new Date(now).toISOString(),
    currency: PLATFORM_CURRENCY,
    attempts: Math.round(t.attempts),
    submitted: Math.round(t.submitted),
    delivered: Math.round(t.delivered),
    revenue: r2(t.revenue),
    cost: r2(t.cost),
    margin: r2(t.revenue - t.cost),
    marginPct: t.revenue > 0 ? r2(((t.revenue - t.cost) / t.revenue) * 100) : 0,
    asr: pct(t.submitted, t.attempts) ?? 0,
    dlr: pct(t.delivered, t.submitted) ?? 0,
    tps: r1(tps),
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

export function topsEvent(sim: Simulator, now = Date.now()): DashboardTopsEvent {
  const party = (kind: "customer_enterprise" | "vendor_enterprise", m: Map<number, PartyTotals>) =>
    [...m.entries()]
      .sort((a, b) => b[1].attempts - a[1].attempts)
      .slice(0, 15)
      .map(([id, p]) => ({
        party: { kind, id, name: p.name },
        attempts: Math.round(p.attempts),
        money: r2(p.money),
        margin: r2(p.margin),
        asr: pct(p.successful, p.attempts),
        dlr: pct(p.delivered, p.successful),
      }));
  return {
    at: new Date(now).toISOString(),
    currency: PLATFORM_CURRENCY,
    clients: party("customer_enterprise", sim.today.clients),
    vendors: party("vendor_enterprise", sim.today.vendors),
    destinations: [...sim.today.destinations.entries()]
      .sort((a, b) => b[1].attempts - a[1].attempts)
      .slice(0, 15)
      .map(([mccmnc, d]) => ({
        mccmnc,
        country: d.country,
        network: d.network || "All networks",
        attempts: Math.round(d.attempts),
        revenue: r2(d.revenue),
        margin: r2(d.margin),
        asr: pct(d.successful, d.attempts),
        dlr: pct(d.delivered, d.successful),
      })),
  };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/**
 * Traffic movers (§13.3 item 2): the last `window` minutes against the window before. Started:
 * no traffic before, sending now; stopped: the reverse; increasing / decreasing: changed by more
 * than the threshold. Pure, so it can be tested with made-up histories.
 */
export function computeMovers(
  trunks: Pick<SimTrunk, "id" | "name" | "enterpriseId" | "enterpriseName" | "minutes" | "asr" | "dlr">[],
  windowMinutes: number,
  thresholdPct: number,
  now = Date.now(),
  limit = 15,
): DashboardMoversEvent {
  const ON = 0.2; // TPS that counts as sending
  const OFF = 0.05;
  const out: DashboardMoversEvent = {
    at: new Date(now).toISOString(),
    windowMinutes,
    thresholdPct,
    started: [],
    increasing: [],
    decreasing: [],
    stopped: [],
  };
  for (const t of trunks) {
    const m = t.minutes;
    const cur = avg(m.slice(-windowMinutes));
    const before = avg(m.slice(-2 * windowMinutes, -windowMinutes));
    const row: MoverRow = {
      trunk: { kind: "customer_trunk", id: t.id, name: t.name },
      enterprise: { kind: "customer_enterprise", id: t.enterpriseId, name: t.enterpriseName },
      tpsNow: r1(cur),
      tpsBefore: r1(before),
      changePct: before > OFF ? r1(((cur - before) / before) * 100) : null,
      sparkline: m.slice(-60).map(r1),
      asr: t.asr,
      dlr: t.dlr,
    };
    if (before < OFF && cur >= ON) out.started.push(row);
    else if (before >= ON && cur < OFF) out.stopped.push(row);
    else if (before >= OFF && cur >= OFF && row.changePct !== null) {
      if (row.changePct >= thresholdPct) out.increasing.push(row);
      else if (row.changePct <= -thresholdPct) out.decreasing.push(row);
    }
  }
  out.started = out.started.sort((a, b) => b.tpsNow - a.tpsNow).slice(0, limit);
  out.stopped = out.stopped.sort((a, b) => b.tpsBefore - a.tpsBefore).slice(0, limit);
  out.increasing = out.increasing.sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)).slice(0, limit);
  out.decreasing = out.decreasing.sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0)).slice(0, limit);
  return out;
}

/** Total TPS and the 10 busiest customer trunks over the last hour, in 5-second steps. */
export function historyEvent(sim: Simulator, now = Date.now()): TpsHistoryEvent {
  const order = (i: number) => (sim.slotIndex + 1 + i) % SLOTS; // oldest first
  const total = Array.from({ length: SLOTS }, (_, i) => r1(sim.trunks.reduce((s, t) => s + t.slots[order(i)]!, 0)));
  const top = [...sim.trunks].sort((a, b) => b.tps - a.tps).slice(0, 10);
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
