// The live screens follow the viewer's visibility policy (§13.17, security audit of team trial round 12): names of
// other AMs' enterprises and trunks masked, withheld money null (and still valid against contract/events), others'
// rows left out when their traffic is hidden; and a socket opened from another site is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { VisibilityPolicyRow } from "@sms/contract";
import { liveView } from "../src/live/visibility.js";
import { sameOrigin } from "../src/live/socket.js";
import { PRESETS, type Viewer } from "../src/visibility/policy.js";
import type { Maps } from "../src/visibility/walk.js";

const require = createRequire(import.meta.url);
const eventsDir = dirname(require.resolve("@sms/contract/events/catalog.json"));
const ajv = new Ajv2020({ strict: false });
(addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
for (const f of readdirSync(eventsDir).filter((f) => f.endsWith(".json") && f !== "catalog.json"))
  ajv.addSchema(JSON.parse(readFileSync(join(eventsDir, f), "utf8")));
const valid = (schema: string, payload: unknown) => {
  const v = ajv.getSchema(schema)!;
  assert.ok(v(payload), `${schema}: ${JSON.stringify(v.errors)}`);
};

// Enterprise 1 is the viewer's client, 2 another AM's client, 3 another AM's vendor; trunks 11, 12 and 31 are theirs.
const maps: Maps = {
  at: Date.now(),
  type: new Map([
    [1, "customer"],
    [2, "customer"],
    [3, "vendor"],
  ]),
  customerTrunk: new Map([
    [11, 1],
    [12, 2],
  ]),
  vendorTrunk: new Map([[31, 3]]),
};
const policy = (traffic: "show" | "hide" = "show") => {
  const p = PRESETS.find((x) => x.key === "standard_am")!.fields;
  return { ...p, items: { ...p.items, traffic: { own: "show", others: traffic } } } as unknown as VisibilityPolicyRow;
};
const viewer = (traffic: "show" | "hide" = "show") =>
  ({ own: [1], costOwn: [1], exempt: false, policy: policy(traffic) }) as unknown as Viewer & {
    policy: VisibilityPolicyRow;
  };
const party = (kind: string, id: number, name: string) => ({ kind, id, name });
const top = (p: ReturnType<typeof party>) => ({ party: p, attempts: 10, money: 5, margin: 1, asr: 90, dlr: 80 });

test("tops, summary and ticks: others masked, their money and totals over everyone withheld", () => {
  const view = liveView(viewer(), maps);
  const tops = {
    at: "2026-10-30T10:00:00Z",
    currency: "EUR",
    clients: [top(party("customer_enterprise", 1, "Mine Ltd")), top(party("customer_enterprise", 2, "Theirs Ltd"))],
    vendors: [top(party("vendor_enterprise", 3, "Carrier SA"))],
    destinations: [
      { iso: "NG", country: "Nigeria", networks: 3, attempts: 20, revenue: 9, margin: 2, asr: 90, dlr: 80 },
    ],
  };
  const shaped = view.shape("live:dashboard", "tops", tops) as typeof tops;
  assert.equal(tops.clients[1]!.party.name, "Theirs Ltd", "the shared payload is left alone");
  assert.equal(shaped.clients[0]!.party.name, "Mine Ltd");
  assert.equal(shaped.clients[0]!.money, 5);
  assert.equal(shaped.clients[1]!.party.name, "Customer #2");
  assert.equal(shaped.clients[1]!.money, null);
  assert.equal(shaped.clients[1]!.margin, null);
  assert.equal(shaped.vendors[0]!.party.name, "Vendor #3");
  assert.equal(shaped.vendors[0]!.money, null);
  assert.equal(shaped.destinations[0]!.revenue, null, "a country's total includes others' clients");
  valid("dashboard.tops.json", shaped);

  const tick = {
    at: "2026-10-30T10:00:00Z",
    totalTps: 3,
    trunks: [
      { trunk: party("customer_trunk", 11, "MINE_T"), tps: 1, tpsLimit: 10, queueDepth: 0 },
      { trunk: party("customer_trunk", 12, "THEIRS_T"), tps: 1, tpsLimit: 10, queueDepth: 0 },
      { trunk: party("vendor_trunk", 31, "CARRIER_T"), tps: 1, tpsLimit: 10, queueDepth: 0 },
    ],
  };
  const t = view.shape("live:tps", "tick", tick) as typeof tick;
  assert.deepEqual(
    t.trunks.map((x) => x.trunk.name),
    ["MINE_T", "Customer trunk #12", "Vendor trunk #31"],
  );
  valid("traffic.tps_tick.json", t);
});

test("analytics rows by trunk: name and parent masked, money withheld; others left out when traffic is hidden", () => {
  const row = (id: number, name: string, parent: string) => ({
    key: `ct:${id}`,
    id,
    name,
    parent,
    attempts: 5,
    submitted: 5,
    delivered: 4,
    asr: 100,
    dlr: 80,
    revenue: 2,
    cost: 1,
    margin: 1,
    marginPct: 50,
    tps: 1,
    tpsBefore: 1,
    changePct: 0,
    sparkline: [1],
  });
  const snapshot = {
    at: "2026-10-30T10:00:00Z",
    groupBy: "customer_trunk",
    currency: "EUR",
    day: "2026-10-30",
    compareMinutes: 15,
    total: 2,
    rows: [row(11, "MINE_T", "Mine Ltd"), row(12, "THEIRS_T", "Theirs Ltd")],
    totals: { attempts: 10, submitted: 10, delivered: 8, asr: 100, dlr: 80, revenue: 4, cost: 2, margin: 2, marginPct: 50, tps: 2 },
  };
  const shaped = liveView(viewer(), maps).shape("live:analytics", "snapshot", snapshot) as typeof snapshot;
  assert.equal(shaped.rows[0]!.revenue, 2);
  assert.equal(shaped.rows[1]!.name, "Customer trunk #12");
  assert.equal(shaped.rows[1]!.parent, "Customer #2");
  assert.equal(shaped.rows[1]!.revenue, null);
  assert.equal(shaped.totals.revenue, null);
  valid("analytics.snapshot.json", shaped);
  const hidden = liveView(viewer("hide"), maps).shape("live:analytics", "snapshot", snapshot) as typeof snapshot;
  assert.deepEqual(
    hidden.rows.map((r) => r.id),
    [11],
  );
});

test("an incident on someone else's trunk names it neutrally, in its text too", () => {
  const incident = {
    entityName: "THEIRS_T",
    message: "THEIRS_T DLR dropped from 90 % to 60 % in 15 min",
    scope: [party("customer_trunk", 12, "THEIRS_T")],
  };
  const shaped = liveView(viewer(), maps).shape("alerts:9", "incident", incident) as typeof incident;
  assert.equal(shaped.entityName, "Customer trunk #12");
  assert.equal(shaped.message, "Customer trunk #12 DLR dropped from 90 % to 60 % in 15 min");
  assert.equal(shaped.scope[0]!.name, "Customer trunk #12");
});

test("the socket's Origin must name the page's host; calls without one pass", () => {
  assert.ok(sameOrigin(undefined, "sms.example.test"));
  assert.ok(sameOrigin("https://sms.example.test", "sms.example.test"));
  assert.ok(sameOrigin("https://sms.example.test:8443", "sms.example.test"), "nginx forwards the host without its port");
  assert.ok(sameOrigin("http://127.0.0.1:5173", "127.0.0.1:5173"));
  assert.ok(!sameOrigin("https://evil.example.test", "sms.example.test"));
  assert.ok(!sameOrigin("null", "sms.example.test"));
  assert.ok(!sameOrigin("https://sms.example.test", undefined));
});
