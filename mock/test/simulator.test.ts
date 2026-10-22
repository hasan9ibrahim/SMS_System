// Traffic movers (§13.3 item 2) and the simulator timelines, on made-up histories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTRY_ISO, computeMovers, extendSegments, levelAt, topCountries } from "../src/live/simulator.js";

const trunk = (id: number, minutes: number[]) => ({
  id,
  name: `T${id}`,
  enterpriseId: id,
  enterpriseName: `E${id}`,
  minutes,
  asr: 95,
  dlr: 80,
});
const hist = (before: number, now: number, w = 15) => [...Array(w).fill(before), ...Array(w).fill(now)];

const MIN = { customer: 0, vendor: 0 };

test("movers: started and stopped customers; customers and vendors that changed, biggest first (team trial round 2)", () => {
  const m = computeMovers(
    {
      customers: [
        trunk(1, hist(0, 5)), // started
        trunk(2, hist(8, 0)), // stopped
        trunk(3, hist(10, 14)), // +40 %
        trunk(4, hist(10, 6)), // -40 %
        trunk(5, hist(10, 12)), // +20 %: any change counts
        trunk(6, hist(0, 0.1)), // a trickle is not a start
      ],
      vendors: [trunk(11, hist(10, 5)), trunk(12, hist(10, 11))],
    },
    15,
    MIN,
    Date.parse("2026-10-16T12:00:00Z"),
    15,
    (kind, id) => (kind === "vendor" && id === 11 ? { mccmnc: "40474", name: "India BSNL" } : null),
  );
  assert.deepEqual(
    [m.started, m.stopped, m.customers, m.vendors].map((xs) => xs.map((r) => r.trunk.id)),
    [[1], [2], [3, 4, 5], [11, 12]],
  );
  assert.equal(m.customers[0]!.changePct, 40);
  assert.equal(m.vendors[0]!.trunk.kind, "vendor_trunk");
  assert.equal(m.vendors[0]!.enterprise.kind, "vendor_enterprise");
  assert.deepEqual(m.vendors[0]!.topDestination, { mccmnc: "40474", name: "India BSNL" });
  assert.equal(m.customers[0]!.messagesNow, 14 * 60 * 15, "messages in the window");
  assert.equal(m.started[0]!.changePct, null, "no change % from zero");
  assert.equal(m.started[0]!.sparkline.length, 30);
});

test("movers: the card volume leaves out small trunks", () => {
  const m = computeMovers(
    { customers: [trunk(1, hist(1, 2)), trunk(2, hist(10, 20))], vendors: [trunk(3, hist(1, 2))] },
    15,
    { customer: 2000, vendor: 5000 },
  );
  // 2 TPS × 900 s = 1,800 messages: below 2,000; 20 TPS = 18,000: above.
  assert.deepEqual(
    m.customers.map((r) => r.trunk.id),
    [2],
  );
  assert.equal(m.vendors.length, 0);
});

test("movers: the window only looks at its own minutes", () => {
  // Busier earlier, steady for the last 20 minutes: no change at 5 minutes, -33 % at 30.
  const minutes = [...Array(40).fill(20), ...Array(20).fill(10)];
  const five = computeMovers({ customers: [trunk(1, minutes)], vendors: [] }, 5, MIN);
  assert.equal(five.customers.length, 0);
  const thirty = computeMovers({ customers: [trunk(1, minutes)], vendors: [] }, 30, MIN);
  assert.equal(thirty.customers[0]?.trunk.id, 1);
});

test("movers: lists are sorted and capped", () => {
  const trunks = Array.from({ length: 30 }, (_, i) => trunk(i + 1, hist(10, 14 + i)));
  const m = computeMovers({ customers: trunks, vendors: [] }, 15, MIN, Date.now(), 15);
  assert.equal(m.customers.length, 15);
  assert.equal(m.customers[0]!.trunk.id, 30, "biggest change first");
});

test("timelines are continuous and cover the requested span", () => {
  const segs: Parameters<typeof extendSegments>[0] = [];
  const now = Date.parse("2026-10-16T12:00:00Z");
  extendSegments(segs, now + 3_600_000, true);
  assert.ok(segs[segs.length - 1]!.to >= now + 3_600_000);
  for (let i = 1; i < segs.length; i++) {
    assert.equal(segs[i]!.from, segs[i - 1]!.to);
    assert.equal(segs[i]!.a, segs[i - 1]!.b);
  }
  for (let t = now - 3_600_000; t < now + 3_600_000; t += 60_000) assert.ok(levelAt(segs, t) >= 0);
});

test("top destinations add up each country's networks (team trial round 2)", () => {
  COUNTRY_ISO.set("Nigeria", "NG").set("Ghana", "GH");
  const d = (country: string, network: string, attempts: number, successful: number, delivered: number) => ({
    country,
    network,
    attempts,
    revenue: attempts / 100,
    margin: attempts / 1000,
    successful,
    delivered,
  });
  const rows = topCountries(
    new Map([
      ["62130", d("Nigeria", "MTN", 600, 500, 400)],
      ["62120", d("Nigeria", "Airtel", 400, 300, 200)],
      ["62001", d("Ghana", "MTN", 700, 700, 700)],
      ["99999", d("Nowhere", "", 5000, 0, 0)],
    ]),
  );
  assert.deepEqual(
    rows.map((r) => [r.iso, r.networks, r.attempts]),
    [
      ["NG", 2, 1000],
      ["GH", 1, 700],
    ],
    "biggest first; a country missing from the master list is left out",
  );
  assert.equal(rows[0]!.asr, 80);
  assert.equal(rows[0]!.dlr, 75);
  assert.equal(rows[0]!.revenue, 10);
});
