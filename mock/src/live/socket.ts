// WebSocket endpoint speaking the Phoenix Channels V2 JSON protocol (CLAUDE.md rule 5),
// so the GUI client works unchanged against the Phoenix backend later.
// Frames: [join_ref, ref, topic, event, payload]; see contract/events/phoenix-message.json.
//
// Live traffic simulator (simulator.ts): `live:tps` ticks once a second (TPS pill §15.1 and
// the dashboard tables §13.3) and sends an hour of history on join; `live:dashboard` pushes
// the summary bar each second and the movers and tops panels every 5 seconds; `alerts:<userId>`
// raises incidents now and then (bell and pop-ups, §13.6).
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { IncidentEvent } from "@sms/contract";
import { CURRENT_USER_ID } from "../api/session.js";
import {
  computeMovers,
  createSimulator,
  historyEvent,
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
  movers: { windowMinutes: number; thresholdPct: number };
}

const clients = new Set<Client>();
let sim: Simulator | null = null;
let loading: Promise<Simulator> | null = null;
let timer: NodeJS.Timeout | null = null;
let ticks = 0;
let nextIncidentAt = 0;
let incidentSeq = 5000;
const openIncidents: { at: number; event: IncidentEvent }[] = [];

const rand = (min: number, max: number) => min + Math.random() * (max - min);

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
  push("live:dashboard", "summary", summaryEvent(sim, now));
  if (ticks % 5 === 0) {
    push("live:dashboard", "tops", topsEvent(sim, now));
    for (const c of clients) if (c.topics.has("live:dashboard")) moversFor(sim, c, now);
  }
  incidents(sim, now);
}

// Incidents: one every 1.5-4 minutes, recovering after 3-8 minutes.
function incidents(s: Simulator, now: number) {
  if (now >= nextIncidentAt && s.trunks.length) {
    nextIncidentAt = now + rand(90_000, 240_000);
    const t = s.trunks[Math.floor(Math.random() * s.trunks.length)]!;
    const metric = Math.random() < 0.6 ? "dlr" : "asr";
    const baseline = Math.round(rand(88, 97));
    const current = Math.round(baseline - rand(15, 35));
    const severity = baseline - current > 25 ? "critical" : "warning";
    const event: IncidentEvent = {
      incidentId: ++incidentSeq,
      ruleId: metric === "dlr" ? 12 : 14,
      ruleName: metric === "dlr" ? "DLR drop - key clients" : "ASR drop",
      state: "open",
      severity,
      message: `${t.name} ${metric.toUpperCase()} dropped from ${baseline} % to ${current} % in 15 min`,
      metric,
      currentValue: current,
      baselineValue: baseline,
      scope: [{ kind: "customer_trunk", id: t.id, name: t.name }],
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      acknowledgedBy: null,
    };
    openIncidents.push({ at: now + rand(180_000, 480_000), event });
    push(`alerts:${CURRENT_USER_ID}`, "incident", event);
  }
  for (let i = openIncidents.length - 1; i >= 0; i--) {
    const o = openIncidents[i]!;
    if (now < o.at) continue;
    openIncidents.splice(i, 1);
    push(`alerts:${CURRENT_USER_ID}`, "incident", {
      ...o.event,
      state: "recovered",
      endedAt: new Date(now).toISOString(),
    });
  }
}

function start() {
  if (timer) return;
  nextIncidentAt = Date.now() + rand(20_000, 60_000);
  timer = setInterval(tick, 1000);
  timer.unref();
  void getSimulator();
}

function stop() {
  if (timer && clients.size === 0) {
    clearInterval(timer);
    timer = null;
  }
}

/** Join params for live:dashboard (dashboard.join.json); defaults 15 minutes and 30 %. */
function moverParams(p: Record<string, unknown>): Client["movers"] | null {
  const w = p.windowMinutes ?? 15;
  const th = p.thresholdPct ?? 30;
  const extra = Object.keys(p).filter((k) => k !== "windowMinutes" && k !== "thresholdPct");
  if (extra.length || ![5, 15, 30, 60].includes(w as number)) return null;
  if (typeof th !== "number" || th < 5 || th > 500) return null;
  return { windowMinutes: w as number, thresholdPct: th };
}

const KNOWN_TOPICS = (topic: string) =>
  topic === "live:tps" || topic === "live:dashboard" || topic.startsWith("alerts:");

export async function registerSocket(app: FastifyInstance) {
  await app.register(websocket);
  app.get("/socket/websocket", { websocket: true }, (socket) => {
    const client: Client = { socket, topics: new Map(), movers: { windowMinutes: 15, thresholdPct: 30 } };
    clients.add(client);
    start();
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
        });
        return;
      }
      if (event === "phx_leave") {
        client.topics.delete(topic);
        return reply("ok");
      }
    });
    socket.on("close", () => {
      clients.delete(client);
      stop();
    });
  });
}

/** Test hook: run one simulator step now. */
export async function simulateTick(forceIncident = false) {
  await getSimulator();
  if (forceIncident) nextIncidentAt = 0;
  ticks = 4; // the next step also pushes movers and tops
  tick();
}
