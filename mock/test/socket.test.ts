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
import { CURRENT_USER_ID } from "../src/api/session.js";

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
  ws.send(JSON.stringify(["2", "2", `alerts:${CURRENT_USER_ID}`, "phx_join", {}]));
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
