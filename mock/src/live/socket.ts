// WebSocket endpoint speaking the Phoenix Channels V2 JSON protocol (CLAUDE.md rule 5),
// so the GUI client works unchanged against the Phoenix backend later.
// Frames: [join_ref, ref, topic, event, payload]; see contract/events/phoenix-message.json.
//
// Live traffic simulator (simulator.ts): `live:tps` ticks once a second (TPS pill §15.1 and
// the dashboard tables §13.3) and sends an hour of history on join; `live:dashboard` pushes
// the summary bar each second and the movers and tops panels every 5 seconds; `live:analytics`
// pushes each subscriber's Report By snapshot every 1, 5 or 15 seconds (§13.4); `alerts:<userId>`
// carries incidents raised by the alert engine (alerts/engine.ts, §13.6), which runs every 15 seconds
// from server start, whether or not anyone is connected.
//
// Backend step 11: the socket needs a signed-in user (the sms_session cookie, or the Elixir API's forwarded user),
// and each topic the page it feeds: live:dashboard the Dashboard, live:analytics Live analytics, alerts:<own id>
// Incidents. In production the figures come from the switch's events (live/feed.ts) instead of the simulator, the
// alert engine runs on the server that runs the jobs, and incidents reach users on either server through
// PostgreSQL NOTIFY (sms_incident).
import { WRITE_EVERY_MS, writeLiveEdrs } from "./edrWriter.js";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import pg from "pg";
import { EVALUATE_EVERY_MS, evaluateRound, incidentEvent, notifies, toEvent } from "../alerts/engine.js";
import { currentUserId, loadUser } from "../api/session.js";
import { allows } from "../auth/access.js";
import { requestUser } from "../auth/user.js";
import { db, PG_CONFIG } from "../db.js";
import { isLeader } from "../jobs/leader.js";
import { production } from "../mode.js";
import { createFeedSimulator, feedStep, startFeed } from "./feed.js";
import { analyticsParams, analyticsSnapshot, type AnalyticsParams } from "./analytics.js";
import {
  computeMovers,
  createSimulator,
  historyEvent,
  resyncToday,
  topDestinationOf,
  step,
  summaryEvent,
  tickEvent,
  topsEvent,
  type Simulator,
} from "./simulator.js";

type Frame = [string | null, string | null, string, string, Record<string, unknown>];

interface Client {
  socket: WebSocket;
  /** The signed-in user, the department (incident notifications) and what the access group gives. */
  userId: number;
  departmentId: number | null;
  permissions: string[];
  topics: Map<string, string | null>; // topic -> join_ref
  movers: { windowMinutes: number; customerMinMessages: number; vendorMinMessages: number; refreshSeconds: number };
  analytics: AnalyticsParams | null;
}

const clients = new Set<Client>();
let sim: Simulator | null = null;
let loading: Promise<Simulator> | null = null;
let timer: NodeJS.Timeout | null = null;
let ticks = 0;
let lastEvaluation = 0;
let lastEdrWrite = 0;
let lastResync = Date.now();
let resyncing = false;
/** How often the dashboard's today figures are read again from the EDR store (resyncToday). */
const RESYNC_EVERY_MS = 60_000;
let evaluating = false;

/** The simulator if it is running, without starting it (LCR TPS figures, §13.23). */
export function runningSimulator() {
  return sim ?? null;
}

/** The running simulator (started on first use). */
export function liveSimulator() {
  return getSimulator();
}

function getSimulator() {
  loading ??= (production ? createFeedSimulator() : createSimulator()).then((s) => (sim = s));
  return loading;
}

function send(c: Client, topic: string, event: string, payload: object) {
  if (!c.topics.has(topic)) return;
  c.socket.send(JSON.stringify([c.topics.get(topic) ?? null, null, topic, event, payload]));
}

function push(topic: string, event: string, payload: object) {
  for (const c of clients) send(c, topic, event, payload);
}

function moversFor(s: Simulator, c: Client, now: number) {
  send(
    c,
    "live:dashboard",
    "movers",
    computeMovers(
      { customers: s.trunks, vendors: s.vendors },
      c.movers.windowMinutes,
      { customer: c.movers.customerMinMessages, vendor: c.movers.vendorMinMessages },
      now,
      15,
      topDestinationOf(s),
    ),
  );
}

function tick() {
  if (!sim) return;
  const now = Date.now();
  if (production) feedStep(sim, now);
  else step(sim, now);
  ticks++;
  push("live:tps", "tick", tickEvent(sim, now));
  // Each dashboard client at its own refresh period (team trial round 1).
  const summary = summaryEvent(sim, now);
  let tops: ReturnType<typeof topsEvent> | null = null;
  for (const c of clients) {
    if (!c.topics.has("live:dashboard")) continue;
    if (ticks % c.movers.refreshSeconds === 0) send(c, "live:dashboard", "summary", summary);
    if (ticks % Math.max(5, c.movers.refreshSeconds) === 0) {
      send(c, "live:dashboard", "tops", (tops ??= topsEvent(sim, now)));
      moversFor(sim, c, now);
    }
  }
  for (const c of clients)
    if (c.analytics && c.topics.has("live:analytics") && ticks % c.analytics.intervalSeconds === 0)
      send(c, "live:analytics", "snapshot", analyticsSnapshot(sim, c.analytics, now));
  // The simulated messages go to the EDR store too, so Live analytics and the reports grow with them (never in
  // production: the switch writes the real EDRs).
  if (!production && now - lastEdrWrite >= WRITE_EVERY_MS) {
    lastEdrWrite = now;
    void writeLiveEdrs(sim);
  }
  if (!resyncing && now - lastResync >= RESYNC_EVERY_MS) {
    lastResync = now;
    resyncing = true;
    resyncToday(sim)
      .catch((err: Error) => console.warn(`live today figures: ${err.message}`))
      .finally(() => (resyncing = false));
  }
  // One server raises the incidents (jobs/leader.ts); every server relays them (relayIncidents).
  if (!evaluating && isLeader() && now - lastEvaluation >= EVALUATE_EVERY_MS) {
    lastEvaluation = now;
    evaluating = true;
    evaluateRound(sim, now, undefined, true)
      .catch((err: Error) => console.warn(`alert engine: ${err.message}`))
      .finally(() => (evaluating = false));
  }
}

/** Runs the simulator and the alert engine from server start (§13.6: alerts fire with nobody connected). */
export function startLive() {
  if (timer) return;
  void relayIncidents();
  if (production) startFeed();
  lastEvaluation = Date.now() - EVALUATE_EVERY_MS + 20_000; // first round once the history is in
  timer = setInterval(tick, 1000);
  timer.unref();
  void getSimulator();
}

/** Join params for live:dashboard (dashboard.join.json); defaults 15 minutes, 100 messages per card, every second. */
function moverParams(p: Record<string, unknown>): Client["movers"] | null {
  const w = p.windowMinutes ?? 15;
  const cm = p.customerMinMessages ?? 100;
  const vm = p.vendorMinMessages ?? 100;
  const r = p.refreshSeconds ?? 1;
  const known = ["windowMinutes", "customerMinMessages", "vendorMinMessages", "refreshSeconds"];
  if (Object.keys(p).some((k) => !known.includes(k)) || ![5, 15, 30, 60].includes(w as number)) return null;
  if (![1, 5, 10, 30, 60].includes(r as number)) return null;
  const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000;
  if (!count(cm) || !count(vm)) return null;
  return {
    windowMinutes: w as number,
    customerMinMessages: cm as number,
    vendorMinMessages: vm as number,
    refreshSeconds: r as number,
  };
}

const KNOWN_TOPICS = (topic: string) =>
  topic === "live:tps" || topic === "live:dashboard" || topic === "live:analytics" || topic.startsWith("alerts:");

/** Whether the user may join the topic: the page it feeds, and only their own alerts (backend step 11). */
export function mayJoin(c: Pick<Client, "userId" | "permissions">, topic: string): boolean {
  if (topic === "live:tps") return true;
  if (topic === "live:dashboard") return allows(c.permissions, "dashboard");
  if (topic === "live:analytics") return allows(c.permissions, "live-analytics");
  if (topic.startsWith("alerts:")) return topic === `alerts:${c.userId}` && allows(c.permissions, "incidents");
  return false;
}

let listener: pg.Client | null = null;
let stopping = false;

/** Stops the live loop and the incident relay (the server is closing). */
export async function stopLive() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  const l = listener;
  listener = null;
  await l?.end().catch(() => undefined);
}
/**
 * Relays the incidents announced on `sms_incident` (alerts/engine.ts pushIncident) to this server's users whose
 * rule notifies them. Reconnects after 5 s if the connection drops.
 */
async function relayIncidents() {
  if (listener || stopping) return;
  const c = new pg.Client(PG_CONFIG);
  listener = c;
  const retry = () => {
    if (stopping || listener !== c) return;
    listener = null;
    setTimeout(() => void relayIncidents(), 5_000).unref();
  };
  c.on("error", () => {
    void c.end().catch(() => undefined);
    retry();
  });
  c.on("notification", (n) => {
    if (n.channel !== "sms_incident" || !n.payload) return;
    const { id, repeat } = JSON.parse(n.payload) as { id: number; repeat?: boolean };
    void incidentEvent(db(), id, repeat)
      .then((found) => {
        if (!found) return;
        for (const cl of clients)
          if (cl.topics.has(`alerts:${cl.userId}`) && notifies(found.rule, cl.userId, cl.departmentId))
            send(cl, `alerts:${cl.userId}`, "incident", found.event);
      })
      .catch((err: Error) => console.warn(`incident relay: ${err.message}`));
  });
  try {
    await c.connect();
    await c.query("LISTEN sms_incident");
  } catch {
    retry();
  }
}

/** Who opens the socket: the signed-in user with their access group, or null (backend step 11). */
async function socketUser(req: import("fastify").FastifyRequest) {
  const who = await requestUser(req, db);
  if (!who) return null;
  const user = await loadUser(db(), who.userId);
  if (!user) return null;
  const { rows } = await db().query("SELECT department_id FROM users WHERE id = $1", [who.userId]);
  return {
    userId: who.userId,
    departmentId: rows[0]?.department_id == null ? null : Number(rows[0].department_id),
    permissions: user.permissions,
  };
}

export async function registerSocket(app: FastifyInstance) {
  await app.register(websocket);
  app.addHook("onClose", async () => stopLive());
  app.get("/socket/websocket", { websocket: true }, (socket, req) => {
    // Frames that arrive while the user is looked up wait for it, so the first joins are not lost.
    const ready: Promise<Client | null> = socketUser(req)
      .catch(() => null)
      .then((who) => {
        if (!who) {
          // Not signed in: the GUI shows Sign in from its API calls; the socket tries again later.
          socket.close(4401, "sign in required");
          return null;
        }
        const client: Client = {
          socket,
          ...who,
          topics: new Map(),
          movers: { windowMinutes: 15, customerMinMessages: 100, vendorMinMessages: 100, refreshSeconds: 1 },
          analytics: null,
        };
        clients.add(client);
        startLive();
        return client;
      });
    socket.on("message", (data) => {
      void ready.then((client) => {
        if (client) onFrame(client, data);
      });
    });
    socket.on("close", () => {
      void ready.then((client) => client && clients.delete(client));
    });
  });
}

function onFrame(client: Client, data: unknown) {
  const socket = client.socket;
  let frame: Frame;
  try {
    frame = JSON.parse(String(data)) as Frame;
  } catch {
    return;
  }
  const [joinRef, ref, topic, event, payload] = frame;
  const reply = (status: "ok" | "error", response: Record<string, unknown> = {}) =>
    socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status, response }] satisfies Frame));
  if (topic === "phoenix" && event === "heartbeat") return reply("ok");
  if (event === "phx_join") {
    if (!KNOWN_TOPICS(topic)) return reply("error", { reason: "unknown topic" });
    if (!mayJoin(client, topic)) return reply("error", { reason: "not allowed" });
    if (topic === "live:dashboard") {
      const params = moverParams(payload ?? {});
      if (!params) return reply("error", { reason: "invalid join params" });
      client.movers = params;
    }
    if (topic === "live:analytics") {
      const params = analyticsParams(payload ?? {});
      if (!params) return reply("error", { reason: "invalid join params" });
      client.analytics = params;
    }
    client.topics.set(topic, joinRef);
    reply("ok");
    // Panels fill at once instead of after the first 5-second push.
    void getSimulator().then((s) => {
      const now = Date.now();
      if (topic === "live:tps") send(client, topic, "history", historyEvent(s, now));
      if (topic === "live:dashboard") {
        send(client, topic, "summary", summaryEvent(s, now));
        send(client, topic, "tops", topsEvent(s, now));
        moversFor(s, client, now);
      }
      if (topic === "live:analytics" && client.analytics)
        send(client, topic, "snapshot", analyticsSnapshot(s, client.analytics, now));
    });
    return;
  }
  if (event === "phx_leave") {
    client.topics.delete(topic);
    if (topic === "live:analytics") client.analytics = null;
    return reply("ok");
  }
}

/** Test hook: run one simulator step now (movers and tops included), optionally with a sample incident. */
export async function simulateTick(withIncident = false) {
  await getSimulator();
  ticks = 4; // the next step also pushes movers and tops
  lastEvaluation = Date.now(); // the engine is tested on its own (alerts.test.ts)
  tick();
  if (withIncident) {
    const at = new Date().toISOString();
    push(
      `alerts:${currentUserId()}`,
      "incident",
      toEvent(
        {
          id: 1,
          ruleId: 1,
          ruleName: "DLR drop – sample",
          severity: "warning",
          metric: "dlr",
          entityKind: "customer_trunk",
          entityId: 1,
          entityName: "SAMPLE_TRUNK",
          message: "SAMPLE_TRUNK DLR dropped from 90 % to 60 % in 15 min",
          state: "open",
          currentValue: 60,
          baselineValue: 90,
          peakValue: 58,
          startedAt: at,
          endedAt: null,
          durationSeconds: 0,
          acknowledgedBy: null,
          acknowledgedAt: null,
          snoozedUntil: null,
          notesCount: 0,
          emailedAt: null,
          condition: { type: "decrease_pct", value: 20, baseline: "previous_window" },
          windowMinutes: 15,
          breakdown: [],
        },
        { channels: { popup: true, sound: true, email: false } },
      ),
    );
  }
}
