// The live socket speaks Phoenix Channels V2 (CLAUDE.md rule 5) and pushes payloads that
// match contract/events (traffic.tps_tick.json, alerts.incident.json).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { buildServer } from "../src/server.js";
import { simulateTick } from "../src/live/socket.js";
import { closeDb } from "../src/db.js";
import { currentUserId } from "../src/api/session.js";

const require = createRequire(import.meta.url);
const eventsDir = dirname(require.resolve("@sms/contract/events/catalog.json"));
const ajv = new Ajv2020({ strict: false });
(addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
for (const f of readdirSync(eventsDir).filter((f) => f.endsWith(".json") && f !== "catalog.json")) {
  ajv.addSchema(JSON.parse(readFileSync(join(eventsDir, f), "utf8")));
}

const app = await buildServer();
await app.listen({ host: "127.0.0.1", port: 0 });
const port = (app.server.address() as { port: number }).port;
after(async () => {
  await app.close();
  await closeDb();
});

type Frame = [string | null, string | null, string, string, Record<string, unknown>];

test("join, heartbeat, then tps ticks and incidents that match the event schemas", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket/websocket?vsn=2.0.0`);
  const frames: Frame[] = [];
  const waitFor = (pred: (f: Frame) => boolean, ms = 5000) =>
    new Promise<Frame>((resolve, reject) => {
      const found = frames.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error("timed out waiting for frame")), ms);
      ws.on("message", (d) => {
        const f = JSON.parse(String(d)) as Frame;
        if (pred(f)) {
          clearTimeout(t);
          resolve(f);
        }
      });
    });
  ws.on("message", (d) => frames.push(JSON.parse(String(d)) as Frame));
  await new Promise((r) => ws.once("open", r));

  ws.send(JSON.stringify(["1", "1", "live:tps", "phx_join", {}]));
  ws.send(JSON.stringify(["2", "2", `alerts:${currentUserId()}`, "phx_join", {}]));
  ws.send(JSON.stringify(["3", "3", "nope:topic", "phx_join", {}]));
  ws.send(JSON.stringify([null, "4", "phoenix", "heartbeat", {}]));
  const joined = await waitFor((f) => f[1] === "1" && f[3] === "phx_reply");
  assert.deepEqual(joined[4], { status: "ok", response: {} });
  assert.equal((await waitFor((f) => f[1] === "3"))[4].status, "error");
  assert.equal((await waitFor((f) => f[1] === "4"))[4].status, "ok");

  await simulateTick(true);
  const tick = await waitFor((f) => f[2] === "live:tps" && f[3] === "tick");
  assert.equal(tick[0], "1", "pushes carry the join_ref");
  assert.equal(tick[1], null, "server pushes have no ref");
  const validTick = ajv.getSchema("traffic.tps_tick.json")!;
  assert.ok(validTick(tick[4]), JSON.stringify(validTick.errors));
  const incident = await waitFor((f) => f[3] === "incident");
  const validIncident = ajv.getSchema("alerts.incident.json")!;
  assert.ok(validIncident(incident[4]), JSON.stringify(validIncident.errors));
  ws.close();
});

test("live:dashboard: join params, then summary, movers and tops; history on live:tps join", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket/websocket?vsn=2.0.0`);
  const frames: Frame[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(String(d)) as Frame));
  const waitFor = async (pred: (f: Frame) => boolean, ms = 20_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const f = frames.find(pred);
      if (f) return f;
      if (Date.now() > until) throw new Error("timed out waiting for frame");
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify(["9", "9", "live:dashboard", "phx_join", { windowMinutes: 7 }]));
  assert.equal((await waitFor((f) => f[1] === "9"))[4].status, "error", "window outside the enum");
  // The ± threshold is gone; Customer and Vendor each have a volume (team trial round 2, §13.3).
  ws.send(JSON.stringify(["8", "8", "live:dashboard", "phx_join", { windowMinutes: 5, thresholdPct: 20 }]));
  assert.equal((await waitFor((f) => f[1] === "8"))[4].status, "error", "thresholdPct is no longer a join param");
  ws.send(
    JSON.stringify([
      "1",
      "1",
      "live:dashboard",
      "phx_join",
      { windowMinutes: 5, customerMinMessages: 20, vendorMinMessages: 30 },
    ]),
  );
  ws.send(JSON.stringify(["2", "2", "live:tps", "phx_join", {}]));
  assert.equal((await waitFor((f) => f[1] === "1"))[4].status, "ok");

  const valid = (schema: string, payload: unknown) => {
    const v = ajv.getSchema(schema)!;
    assert.ok(v(payload), `${schema}: ${JSON.stringify(v.errors)}`);
  };
  const history = await waitFor((f) => f[3] === "history");
  valid("traffic.tps_history.json", history[4]);
  assert.equal((history[4].total as number[]).length, 720, "an hour in 5-second steps");
  const movers = await waitFor((f) => f[3] === "movers");
  valid("dashboard.movers.json", movers[4]);
  assert.equal(movers[4].windowMinutes, 5, "the join params drive the movers");
  assert.equal(movers[4].customerMinMessages, 20);
  assert.equal(movers[4].vendorMinMessages, 30);
  valid("dashboard.tops.json", (await waitFor((f) => f[3] === "tops"))[4]);
  valid("dashboard.summary.json", (await waitFor((f) => f[3] === "summary"))[4]);

  frames.length = 0;
  await simulateTick();
  valid("dashboard.movers.json", (await waitFor((f) => f[3] === "movers"))[4]);
  const tick = (await waitFor((f) => f[3] === "tick"))[4] as { trunks: { trunk: { kind: string } }[] };
  valid("traffic.tps_tick.json", tick);

  // Live analytics (§13.4): join params validated, a snapshot at once and on the interval.
  ws.send(JSON.stringify(["7", "7", "live:analytics", "phx_join", { groupBy: "region" }]));
  assert.equal((await waitFor((f) => f[1] === "7"))[4].status, "error", "groupBy outside the enum");
  ws.send(
    JSON.stringify([
      "8",
      "8",
      "live:analytics",
      "phx_join",
      { groupBy: "customer", intervalSeconds: 1, sort: "tps", limit: 20 },
    ]),
  );
  assert.equal((await waitFor((f) => f[1] === "8"))[4].status, "ok");
  const snap = (await waitFor((f) => f[2] === "live:analytics" && f[3] === "snapshot"))[4] as {
    rows: { tps: number | null }[];
    groupBy: string;
  };
  valid("analytics.snapshot.json", snap);
  assert.equal(snap.groupBy, "customer");
  assert.ok(snap.rows.length <= 20);
  const tps = snap.rows.map((r) => r.tps ?? 0);
  assert.deepEqual(
    tps,
    [...tps].sort((a, b) => b - a),
    "sorted on the server",
  );
  ws.close();
});
