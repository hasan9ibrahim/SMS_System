// Traffic movers (§13.3 item 2) and the simulator timelines, on made-up histories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMovers, extendSegments, levelAt } from "../src/live/simulator.js";

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

test("movers: started, stopped, increasing and decreasing by the threshold", () => {
  const m = computeMovers(
    [
      trunk(1, hist(0, 5)), // started
      trunk(2, hist(8, 0)), // stopped
      trunk(3, hist(10, 14)), // +40 %
      trunk(4, hist(10, 6)), // -40 %
      trunk(5, hist(10, 12)), // +20 %: below the threshold
      trunk(6, hist(0, 0.1)), // a trickle is not a start
    ],
    15,
    30,
    Date.parse("2026-10-16T12:00:00Z"),
  );
  assert.deepEqual(
    [m.started, m.stopped, m.increasing, m.decreasing].map((xs) => xs.map((r) => r.trunk.id)),
    [[1], [2], [3], [4]],
  );
  assert.equal(m.increasing[0]!.changePct, 40);
  assert.equal(m.decreasing[0]!.changePct, -40);
  assert.equal(m.started[0]!.changePct, null, "no change % from zero");
  assert.equal(m.started[0]!.sparkline.length, 30);
});

test("movers: the window only looks at its own minutes", () => {
  // Busier earlier, steady for the last 20 minutes: no mover at 5 minutes, -33 % at 30.
  const minutes = [...Array(40).fill(20), ...Array(20).fill(10)];
  const five = computeMovers([trunk(1, minutes)], 5, 30);
  assert.equal(five.increasing.length + five.decreasing.length, 0);
  const thirty = computeMovers([trunk(1, minutes)], 30, 30);
  assert.equal(thirty.decreasing[0]?.trunk.id, 1);
});

test("movers: lists are sorted and capped", () => {
  const trunks = Array.from({ length: 30 }, (_, i) => trunk(i + 1, hist(10, 14 + i)));
  const m = computeMovers(trunks, 15, 30, Date.now(), 15);
  assert.equal(m.increasing.length, 15);
  assert.equal(m.increasing[0]!.trunk.id, 30, "biggest change first");
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
