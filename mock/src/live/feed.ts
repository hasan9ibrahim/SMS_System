// The live screens from the switch's events (backend step 11): in production the Live dashboard, Live analytics,
// the TPS pill and the alert engine's "now" figures come from the EDRs the switch publishes on NATS JetStream
// (`sms.edr.attempt`, `sms.edr.receipt`), not from the traffic simulator. Every server reads the stream with an
// ephemeral consumer of its own from "now" (the switch's durable EDR writer is not touched) and fills the same
// structure the simulator fills, so the events the GUI receives keep their format (contract/events).
//
//   * TPS: messages per second per customer trunk (first attempt of a message) and per vendor trunk (each attempt);
//   * quality now: ASR, DLR and delivery delay over the last 5 minutes from the attempts and vendor receipts;
//   * today's figures: counted as events arrive, and read again from the EDR store every minute (resyncToday).
//
// A shared durable consumer drives the bind status (`sms.session.*`, jobs/binds.ts) and the credit alert e-mails
// (`sms.billing.credit_alert`, jobs/creditAlerts.ts), each event once across the servers.
import { AckPolicy, connect, DeliverPolicy, nanos, type JsMsg, type NatsConnection } from "nats";
import { natsServers } from "../natsServers.js";
import { sysToPlatformFactors } from "../currency.js";
import { db } from "../db.js";
import { platformDay } from "../platform.js";
import { applySessionEvent } from "../jobs/binds.js";
import { sendCreditAlert } from "../jobs/creditAlerts.js";
import {
  BASE_DELAY,
  emptyDay,
  loadFromStores,
  MINUTES,
  rollMinute,
  SLOT_S,
  SLOTS,
  windowTps,
  type SimTrunk,
  type SimVendor,
  type Simulator,
} from "./simulator.js";
import { chRows } from "../edr.js";

/** One EDR row as the switch publishes it (backend/apps/sms_switch/lib/sms/switch/pipeline/edr.ex). */
export interface EdrEvent {
  business_company_id?: number;
  c_trunk_id?: number;
  v_trunk_id?: number;
  c_mccmnc?: string;
  attempt_no?: number;
  is_final_attempt?: number;
  is_submit_success?: number;
  revenue_sys?: number | string;
  cost_sys?: number | string;
  kind?: string;
  msg_status?: string;
  delivery_delay_ms?: number | null;
}

interface Counts {
  n: number;
  ok: number;
  dl: number;
  revenue: number;
  cost: number;
  delay: number;
  delayN: number;
}
const zero = (): Counts => ({ n: 0, ok: 0, dl: 0, revenue: 0, cost: 0, delay: 0, delayN: 0 });

/** What arrived since the last second, per customer trunk, vendor trunk and destination. */
export interface Pending {
  customer: Map<number, Counts>;
  vendor: Map<number, Counts>;
  dest: Map<string, Counts>;
  /** Sent to a vendor (any attempt), for today's "Submitted". */
  sent: number;
}
const emptyPending = (): Pending => ({ customer: new Map(), vendor: new Map(), dest: new Map(), sent: 0 });
let pending = emptyPending();

/** Quality over the last 5 minutes per trunk: one bucket per minute. */
const QUALITY_MINUTES = 5;
const quality = new Map<string, { minute: number; buckets: Counts[] }>();

/** `*_sys` amounts to the platform currency, by business company (refreshed every minute). */
let factors = new Map<number, number>();
const add = <K>(m: Map<K, Counts>, key: K, f: (c: Counts) => void) => {
  let c = m.get(key);
  if (!c) m.set(key, (c = zero()));
  f(c);
};

/**
 * Counts one EDR row (exported for tests). Messages, vendor attempts and acceptance come from the attempt rows;
 * deliveries from the outcome rows (one per attempt once its final status is known, with the destination); money
 * from both, as billed (§7: at send time on the attempt, on delivery on the outcome).
 */
export function countEvent(type: string, row: EdrEvent, into: Pending = pending) {
  const f = factors.get(Number(row.business_company_id ?? 0)) ?? 1;
  const revenue = Number(row.revenue_sys ?? 0) * f;
  const cost = Number(row.cost_sys ?? 0) * f;
  const money = (c: Counts) => {
    c.revenue += revenue;
    c.cost += cost;
  };
  const c = row.c_trunk_id ? Number(row.c_trunk_id) : 0;
  const v = row.v_trunk_id ? Number(row.v_trunk_id) : 0;
  const dest = row.c_mccmnc || "";
  if (type === "edr.attempt") {
    const first = Number(row.attempt_no ?? 1) <= 1;
    const ok = Number(row.is_submit_success) === 1;
    const counted = (x: Counts) => {
      if (first) x.n += 1;
      if (ok) x.ok += 1;
      money(x);
    };
    if (c) add(into.customer, c, counted);
    if (dest) add(into.dest, dest, counted);
    if (v) {
      into.sent += 1;
      add(into.vendor, v, (x) => {
        x.n += 1;
        if (ok) x.ok += 1;
        money(x);
      });
    }
    return;
  }
  if (type !== "edr.receipt" || row.kind !== "outcome") return;
  const delivered = row.msg_status === "DELIVRD";
  const delay = row.delivery_delay_ms == null ? null : Number(row.delivery_delay_ms) / 1000;
  const outcome = (x: Counts) => {
    money(x);
    if (!delivered) return;
    x.dl += 1;
    if (delay !== null) {
      x.delay += delay;
      x.delayN += 1;
    }
  };
  if (c) add(into.customer, c, outcome);
  if (v) add(into.vendor, v, outcome);
  if (dest) add(into.dest, dest, outcome);
}

/** Takes what was counted since the last call (exported for tests). */
export function takePending(): Pending {
  const got = pending;
  pending = emptyPending();
  return got;
}

function qualityOf(key: string, c: Counts | undefined, now: number) {
  const minute = Math.floor(now / 60_000);
  let q = quality.get(key);
  if (!q) quality.set(key, (q = { minute, buckets: [zero()] }));
  while (q.minute < minute) {
    q.buckets.push(zero());
    if (q.buckets.length > QUALITY_MINUTES) q.buckets.shift();
    q.minute += 1;
  }
  if (c) {
    const b = q.buckets[q.buckets.length - 1]!;
    b.n += c.n;
    b.ok += c.ok;
    b.dl += c.dl;
    b.delay += c.delay;
    b.delayN += c.delayN;
  }
  const sum = q.buckets.reduce((a, x) => ({ ...a, n: a.n + x.n, ok: a.ok + x.ok, dl: a.dl + x.dl, delay: a.delay + x.delay, delayN: a.delayN + x.delayN }), zero());
  return {
    asr: sum.n > 0 ? Math.min(100, (sum.ok / sum.n) * 100) : null,
    dlr: sum.ok > 0 ? Math.min(100, (sum.dl / sum.ok) * 100) : null,
    delay: sum.delayN > 0 ? sum.delay / sum.delayN : BASE_DELAY,
  };
}

async function refreshFactors() {
  factors = await sysToPlatformFactors().catch(() => factors);
}

/** A trunk or vendor as the feed keeps it: no traffic yet (the simulator's invented figures cleared). */
function asFeedParty<T extends SimTrunk | SimVendor>(x: T): T {
  x.tps = 0;
  x.minutes = Array(MINUTES).fill(0);
  x.minAsr = Array(MINUTES).fill(null);
  x.minDlr = Array(MINUTES).fill(null);
  x.minDelay = Array(MINUTES).fill(0);
  x.asrNow = null;
  x.dlrNow = null;
  x.dip = null;
  if ("segments" in x) x.segments = [];
  return x;
}

/**
 * A simulator structure over the live trunks with no traffic yet, its history read from the EDR store. Every live
 * vendor is there from the start (team trial round 12: only those with traffic last week were, so a new server showed
 * no vendors), and an EDR store that does not answer at start no longer stops the service: the figures come from the
 * switch's events and today's are read again every minute.
 */
export async function createFeedSimulator(): Promise<Simulator> {
  await refreshFactors();
  const loaded = await loadFromStores({ feed: true });
  const sim: Simulator = { ...loaded, slotIndex: 0, lastTick: Date.now(), moneyFromWriter: false };
  for (const x of [...sim.trunks, ...sim.vendors]) asFeedParty(x);
  await loadHistory(sim).catch((err: Error) => console.warn(`live history: ${err.message}`));
  await refreshBaselines(sim);
  setInterval(() => void refreshBaselines(sim), 15 * 60_000).unref();
  setInterval(() => void refreshParties(sim).catch((err: Error) => console.warn(`live trunks: ${err.message}`)), 60_000).unref();
  return sim;
}

/**
 * The live trunks and vendors again (every minute): trunks created, renamed, re-limited, switched off or deleted since
 * the service started show on the live screens without a restart (team trial round 12). What a kept trunk counted so
 * far stays.
 */
export async function refreshParties(sim: Simulator) {
  const fresh = await loadFromStores({ feed: true, stats: false });
  const merge = <T extends SimTrunk | SimVendor>(old: T[], now: T[]): T[] => {
    const byId = new Map(old.map((x) => [x.id, x]));
    return now.map((n) => {
      const kept = byId.get(n.id);
      if (!kept) return asFeedParty(n);
      kept.name = n.name;
      kept.enterpriseId = n.enterpriseId;
      kept.enterpriseName = n.enterpriseName;
      kept.limit = n.limit;
      return kept;
    });
  };
  sim.trunks = merge(sim.trunks, fresh.trunks);
  sim.vendors = merge(sim.vendors, fresh.vendors);
}

/**
 * The alert engine's "normal" levels (backend step 12, §13.6): each trunk's TPS, ASR and DLR in the same hour
 * yesterday and a week ago (half an hour either side of now), from the EDR store. A trunk that sent nothing then has
 * a normal of no traffic.
 */
export async function refreshBaselines(sim: Simulator) {
  type Row = { id: string; n: string; ok: string; dl: string };
  const around = (days: number) =>
    `start_time BETWEEN now() - INTERVAL ${days} DAY - INTERVAL 30 MINUTE AND now() - INTERVAL ${days} DAY + INTERVAL 30 MINUTE`;
  const q = (col: string) =>
    chRows<Row>(
      `SELECT toString(${col}) AS id, countIf(kind = 'attempt') AS n, countIf(is_submit_success = 1) AS ok,
              countIf(msg_status = 'DELIVRD') AS dl
         FROM edr_all WHERE ${col} > 0 AND ((${around(1)}) OR (${around(7)})) GROUP BY id`,
      15_000,
    );
  const [c, v] = await Promise.all([q("c_trunk_id"), q("v_trunk_id")]).catch(() => [null, null]);
  if (!c || !v) return;
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const apply = (xs: (SimTrunk | SimVendor)[], rows: Row[]) => {
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    for (const x of xs) {
      const r = byId.get(x.id);
      const n = r ? Number(r.n) : 0;
      // Two windows of an hour each: messages per second over 7,200 s.
      if ("base" in x) x.base = n / 7200;
      x.asr = r ? ratio(Number(r.ok), n) : null;
      x.dlr = r ? ratio(Number(r.dl), Number(r.ok)) : null;
    }
  };
  apply(sim.trunks, c);
  apply(sim.vendors, v);
}

/** The last two hours per minute (TPS) from the EDR store, so the charts and movers start filled. */
async function loadHistory(sim: Simulator) {
  type Row = { id: string; m: string; n: string };
  const q = (col: string) =>
    chRows<Row>(
      `SELECT toString(${col}) AS id, toString(toStartOfMinute(start_time)) AS m, count() AS n FROM edr
        WHERE start_time > now() - INTERVAL ${MINUTES} MINUTE AND ${col} > 0 AND attempt_no <= 1
        GROUP BY id, m`,
      15_000,
    );
  const [c, v] = await Promise.all([q("c_trunk_id"), q("v_trunk_id")]);
  const nowMinute = Math.floor(Date.now() / 60_000);
  const fill = (xs: (SimTrunk | SimVendor)[], rows: Row[] | null) => {
    const byId = new Map(xs.map((x) => [x.id, x]));
    for (const r of rows ?? []) {
      const x = byId.get(Number(r.id));
      if (!x) continue;
      const i = MINUTES - 1 - (nowMinute - Math.floor(Date.parse(`${r.m.replace(" ", "T")}Z`) / 60_000));
      if (i >= 0 && i < MINUTES) x.minutes[i] = Number(r.n) / 60;
    }
  };
  fill(sim.trunks, c);
  fill(sim.vendors, v);
}

/** One second of real traffic: what the switch reported since the last second. */
export function feedStep(sim: Simulator, now = Date.now()) {
  const got = takePending();
  const prevMinute = Math.floor(sim.lastTick / 60_000);
  const prevSlot = Math.floor(sim.lastTick / (SLOT_S * 1000));
  sim.lastTick = now;
  if (platformDay(now) !== sim.today.day) {
    sim.today = { ...sim.today, day: platformDay(now), attempts: 0, submitted: 0, sent: 0, delivered: 0, revenue: 0, cost: 0 };
    sim.today.clients = new Map();
    sim.today.vendors = new Map();
    sim.today.destinations = new Map();
    for (const x of [...sim.trunks, ...sim.vendors]) x.day = emptyDay();
  }
  const newMinute = Math.floor(now / 60_000) !== prevMinute;
  const newSlot = Math.floor(now / (SLOT_S * 1000)) !== prevSlot;
  if (newSlot) sim.slotIndex = (sim.slotIndex + 1) % SLOTS;
  if (newMinute) void refreshFactors();
  let total = 0;
  const today = sim.today;
  for (const t of sim.trunks) {
    const c = got.customer.get(t.id);
    const n = c?.n ?? 0;
    windowTps(t, n, now);
    total += n;
    const q = qualityOf(`c${t.id}`, c, now);
    t.asrNow = q.asr;
    t.dlrNow = q.dlr;
    t.delayNow = q.delay;
    rollMinute(t, newMinute);
    if (newSlot) {
      t.slotSum = 0;
      t.slotN = 0;
    }
    t.slotSum += t.tps;
    t.slotN += 1;
    t.slots[sim.slotIndex] = t.slotSum / t.slotN;
    if (!c) continue;
    t.day.attempts += c.n;
    t.day.submitted += c.ok;
    t.day.delivered += c.dl;
    t.day.revenue += c.revenue;
    t.day.cost += c.cost;
    today.attempts += c.n;
    today.submitted += c.ok;
    today.delivered += c.dl;
    today.revenue += c.revenue;
    today.cost += c.cost;
    const p = today.clients.get(t.enterpriseId) ?? { name: t.enterpriseName, attempts: 0, money: 0, margin: 0, successful: 0, delivered: 0 };
    p.attempts += c.n;
    p.money += c.revenue;
    p.margin += c.revenue - c.cost;
    p.successful += c.ok;
    p.delivered += c.dl;
    today.clients.set(t.enterpriseId, p);
  }
  today.sent += got.sent;
  for (const v of sim.vendors) {
    const c = got.vendor.get(v.id);
    const n = c?.n ?? 0;
    windowTps(v, n, now);
    v.rate = (v.rate ?? 0) * 0.8 + n * 0.2;
    const q = qualityOf(`v${v.id}`, c, now);
    v.asrNow = q.asr;
    v.dlrNow = q.dlr;
    v.delayNow = q.delay;
    rollMinute(v, newMinute);
    if (!c) continue;
    v.day.attempts += c.n;
    v.day.submitted += c.ok;
    v.day.delivered += c.dl;
    v.day.cost += c.cost;
    const p = today.vendors.get(v.enterpriseId) ?? { name: v.enterpriseName, attempts: 0, money: 0, margin: 0, successful: 0, delivered: 0 };
    p.attempts += c.n;
    p.money += c.cost;
    p.successful += c.ok;
    p.delivered += c.dl;
    today.vendors.set(v.enterpriseId, p);
  }
  for (const [code, c] of got.dest) {
    let d = today.destinations.get(code);
    if (!d) {
      const known = sim.destMix.find((m) => m.code === code);
      d = { country: known?.country ?? "", network: known?.network ?? code, attempts: 0, revenue: 0, margin: 0, successful: 0, delivered: 0 };
      today.destinations.set(code, d);
    }
    d.attempts += c.n;
    d.revenue += c.revenue;
    d.margin += c.revenue - c.cost;
    d.successful += c.ok;
    d.delivered += c.dl;
  }
  return total;
}

let nc: NatsConnection | null = null;

/**
 * Connects to NATS and reads the switch's events; nats.js reconnects on its own, and a failed start is retried.
 *   * EDRs: an ordered consumer of each server's own, from now on (every server shows the same live figures);
 *   * session and credit alert events: one durable consumer shared by every server (`sms-service`), so each event is
 *     handled once, on whichever server takes it, and none is lost while the service restarts (acknowledged when
 *     handled; redelivered after 60 s otherwise).
 */
export function startFeed() {
  if (nc) return;
  void run().catch((err: Error) => {
    console.warn(`live feed: ${err.message}; retrying in 10 s`);
    void nc?.close().catch(() => undefined);
    nc = null;
    setTimeout(startFeed, 10_000).unref();
  });
}

export const DURABLE = "sms-service";
const stream = () => process.env.NATS_STREAM ?? "SMS";

async function run() {
  nc = await connect({
    ...natsServers(),
    maxReconnectAttempts: -1,
    name: "sms-service",
  });
  const jsm = await nc.jetstreamManager();
  await jsm.consumers
    .add(stream(), {
      durable_name: DURABLE,
      filter_subjects: ["sms.session.>", "sms.billing.credit_alert"],
      deliver_policy: DeliverPolicy.New,
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(60_000),
      max_deliver: 5,
    })
    .catch((err: Error) => {
      // Already there (another server made it): fine.
      if (!/already in use|exists/i.test(err.message)) throw err;
    });
  const js = nc.jetstream();
  const edrs = await js.consumers.get(stream(), { filterSubjects: ["sms.edr.>"], deliver_policy: DeliverPolicy.New });
  const events = await js.consumers.get(stream(), DURABLE);
  await Promise.all([readEdrs(await edrs.consume()), readEvents(await events.consume())]);
  throw new Error("NATS consumers ended");
}

type Messages = AsyncIterable<JsMsg>;
const envelope = (m: JsMsg): { type: string; data: Record<string, unknown> } | null => {
  try {
    const e = m.json<{ type?: string; data?: Record<string, unknown> }>();
    return { type: e.type ?? "", data: e.data ?? {} };
  } catch {
    return null;
  }
};

async function readEdrs(messages: Messages) {
  for await (const m of messages) {
    const e = envelope(m);
    if (e) countEvent(e.type, e.data as EdrEvent);
  }
}

async function readEvents(messages: Messages) {
  for await (const m of messages) {
    const e = envelope(m);
    if (!e) {
      m.ack();
      continue;
    }
    try {
      await handleEvent(e.type, e.data);
      m.ack();
    } catch (err) {
      console.warn(`${e.type}: ${(err as Error).message}`);
      m.nak(10_000);
    }
  }
}

/** One session or credit alert event (exported for tests). */
export async function handleEvent(type: string, data: Record<string, unknown>) {
  if (type.startsWith("session.")) await applySessionEvent(db(), type, data);
  else if (type === "billing.credit_alert") await sendCreditAlert(db(), data);
}
