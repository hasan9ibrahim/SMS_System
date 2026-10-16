// WebSocket endpoint speaking the Phoenix Channels V2 JSON protocol (CLAUDE.md rule 5),
// so the GUI client works unchanged against the Phoenix backend later.
// Frames: [join_ref, ref, topic, event, payload]; see contract/events/phoenix-message.json.
//
// Minimal live traffic simulator for the app shell: `live:tps` ticks once a second (TPS
// pill, §15.1) and `alerts:<userId>` incidents now and then (bell and pop-ups, §13.6).
// The full traffic simulator (dashboard, analytics, hover volumes) grows from here.
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { IncidentEvent, TpsTickEvent } from "@sms/contract";
import { db } from "../db.js";
import { CURRENT_USER_ID } from "../api/session.js";

type Frame = [string | null, string | null, string, string, Record<string, unknown>];

interface SimTrunk {
  id: number;
  name: string;
  limit: number;
  base: number;
  tps: number;
}

interface Client {
  socket: WebSocket;
  topics: Map<string, string | null>; // topic -> join_ref
}

const clients = new Set<Client>();
let trunks: SimTrunk[] | null = null;
let timer: NodeJS.Timeout | null = null;
let nextIncidentAt = 0;
let incidentSeq = 5000;
const openIncidents: { at: number; event: IncidentEvent }[] = [];

const rand = (min: number, max: number) => min + Math.random() * (max - min);

async function loadTrunks(): Promise<SimTrunk[]> {
  try {
    const { rows } = await db().query(
      `SELECT t.id, t.name, t.tps FROM customer_trunks t
        WHERE t.deleted_at IS NULL AND t.status = 'active' ORDER BY random() LIMIT 60`,
    );
    if (rows.length)
      return rows.map((r) => ({ id: r.id, name: r.name, limit: r.tps, base: r.tps * rand(0.05, 0.6), tps: 0 }));
  } catch {
    // No database: fall back to fake trunks so the shell still shows live values.
  }
  return Array.from({ length: 20 }, (_, i) => {
    const limit = [50, 100, 200, 500][i % 4]!;
    return { id: i + 1, name: `DEMO_TRUNK_${i + 1}`, limit, base: limit * rand(0.05, 0.6), tps: 0 };
  });
}

function push(topic: string, event: string, payload: Record<string, unknown>) {
  for (const c of clients) {
    for (const [t, joinRef] of c.topics) {
      if (t === topic) c.socket.send(JSON.stringify([joinRef, null, topic, event, payload] satisfies Frame));
    }
  }
}

function tick() {
  if (!trunks) return;
  const now = Date.now();
  for (const t of trunks) {
    // Random walk around a base load, with rare bursts above the limit.
    t.tps = Math.max(0, t.tps * 0.7 + t.base * 0.3 + rand(-0.15, 0.15) * t.base + (Math.random() < 0.01 ? t.limit : 0));
  }
  const active = trunks.filter((t) => t.tps > 0.05).sort((a, b) => b.tps - a.tps);
  const tick: TpsTickEvent = {
    at: new Date(now).toISOString(),
    totalTps: Math.round(active.reduce((s, t) => s + t.tps, 0) * 10) / 10,
    trunks: active.slice(0, 40).map((t) => ({
      trunk: { kind: "customer_trunk", id: t.id, name: t.name },
      tps: Math.round(t.tps * 10) / 10,
      tpsLimit: t.limit,
      queueDepth: t.tps > t.limit ? Math.round((t.tps - t.limit) * 5) : 0,
    })),
  };
  push("live:tps", "tick", tick as unknown as Record<string, unknown>);

  // Incidents: one every 1.5-4 minutes, recovering after 3-8 minutes.
  if (now >= nextIncidentAt) {
    nextIncidentAt = now + rand(90_000, 240_000);
    const t = trunks[Math.floor(Math.random() * trunks.length)]!;
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
    push(`alerts:${CURRENT_USER_ID}`, "incident", event as unknown as Record<string, unknown>);
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
  if (!trunks) void loadTrunks().then((t) => (trunks = t));
}

function stop() {
  if (timer && clients.size === 0) {
    clearInterval(timer);
    timer = null;
  }
}

const KNOWN_TOPICS = (topic: string) =>
  topic === "live:tps" || topic === "live:dashboard" || topic.startsWith("alerts:");

export async function registerSocket(app: FastifyInstance) {
  await app.register(websocket);
  app.get("/socket/websocket", { websocket: true }, (socket) => {
    const client: Client = { socket, topics: new Map() };
    clients.add(client);
    start();
    socket.on("message", (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(data)) as Frame;
      } catch {
        return;
      }
      const [joinRef, ref, topic, event] = frame;
      const reply = (status: "ok" | "error", response: Record<string, unknown> = {}) =>
        socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status, response }] satisfies Frame));
      if (topic === "phoenix" && event === "heartbeat") return reply("ok");
      if (event === "phx_join") {
        if (!KNOWN_TOPICS(topic)) return reply("error", { reason: "unknown topic" });
        client.topics.set(topic, joinRef);
        return reply("ok");
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
  trunks ??= await loadTrunks();
  if (forceIncident) nextIncidentAt = 0;
  tick();
}
