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
import { WRITE_EVERY_MS, writeLiveEdrs } from "./edrWriter.js";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { EVALUATE_EVERY_MS, evaluateRound, setPusher, toEvent } from "../alerts/engine.js";
import { CURRENT_USER_ID } from "../api/session.js";
import { analyticsParams, analyticsSnapshot, type AnalyticsParams } from "./analytics.js";
import {
  computeMovers,
  createSimulator,
  historyEvent,
  resyncToday,
  step,
  summaryEvent,
  tickEvent,
  topsEvent,
  type Simulator,
} from "./simulator.js";

type Frame = [string | null, string | null, string, string, Record<string, unknown>];

interface Client {
  socket: WebSocket;
  topics: Map<string, string | null>; // topic -> join_ref
  movers: { windowMinutes: number; thresholdPct: number; refreshSeconds: number };
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
  loading ??= createSimulator().then((s) => (sim = s));
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
  send(c, "live:dashboard", "movers", computeMovers(s.trunks, c.movers.windowMinutes, c.movers.thresholdPct, now));
}

function tick() {
  if (!sim) return;
  const now = Date.now();
  step(sim, now);
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
  // The simulated messages go to the EDR store too, so Live analytics and the reports grow with them.
  if (now - lastEdrWrite >= WRITE_EVERY_MS) {
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
  if (!evaluating && now - lastEvaluation >= EVALUATE_EVERY_MS) {
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
  setPusher(push);
  lastEvaluation = Date.now() - EVALUATE_EVERY_MS + 20_000; // first round once the history is in
  timer = setInterval(tick, 1000);
  timer.unref();
  void getSimulator();
}

/** Join params for live:dashboard (dashboard.join.json); defaults 15 minutes, 30 % and every second. */
function moverParams(p: Record<string, unknown>): Client["movers"] | null {
  const w = p.windowMinutes ?? 15;
  const th = p.thresholdPct ?? 30;
  const r = p.refreshSeconds ?? 1;
  const extra = Object.keys(p).filter((k) => !["windowMinutes", "thresholdPct", "refreshSeconds"].includes(k));
  if (extra.length || ![5, 15, 30, 60].includes(w as number)) return null;
  if (![1, 5, 10, 30, 60].includes(r as number)) return null;
  if (typeof th !== "number" || th < 5 || th > 500) return null;
  return { windowMinutes: w as number, thresholdPct: th, refreshSeconds: r as number };
}

const KNOWN_TOPICS = (topic: string) =>
  topic === "live:tps" || topic === "live:dashboard" || topic === "live:analytics" || topic.startsWith("alerts:");

export async function registerSocket(app: FastifyInstance) {
  await app.register(websocket);
  app.get("/socket/websocket", { websocket: true }, (socket) => {
    const client: Client = {
      socket,
      topics: new Map(),
      movers: { windowMinutes: 15, thresholdPct: 30, refreshSeconds: 1 },
      analytics: null,
    };
    clients.add(client);
    startLive();
    socket.on("message", (data) => {
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
    });
    socket.on("close", () => {
      clients.delete(client);
    });
  });
}

/** Test hook: run one simulator step now (movers and tops included), optionally with a sample incident. */
export async function simulateTick(withIncident = false) {
  await getSimulator();
  setPusher(push);
  ticks = 4; // the next step also pushes movers and tops
  lastEvaluation = Date.now(); // the engine is tested on its own (alerts.test.ts)
  tick();
  if (withIncident) {
    const at = new Date().toISOString();
    push(
      `alerts:${CURRENT_USER_ID}`,
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
        },
        { channels: { popup: true, sound: true, email: false } },
      ),
    );
  }
}
