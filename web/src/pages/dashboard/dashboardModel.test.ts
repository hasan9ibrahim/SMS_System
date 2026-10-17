import { test } from "node:test";
import assert from "node:assert/strict";
import type { TpsHistoryEvent, TpsTickEvent } from "@sms/contract";
import { analyticsPath, appendTick, bufferFromHistory, chartWindow, limitLevel, newKeys } from "./dashboardModel";

const T0 = Date.parse("2026-10-16T12:00:00Z");
const trunk = (id: number) => ({ kind: "customer_trunk" as const, id, name: `T${id}` });
const history: TpsHistoryEvent = {
  at: new Date(T0 + 2000).toISOString(),
  stepSeconds: 5,
  total: [10, 20, 30],
  series: [{ trunk: trunk(1), values: [1, 2, 3] }],
};
const tick = (at: number, total: number, t1: number): TpsTickEvent => ({
  at: new Date(at).toISOString(),
  totalTps: total,
  trunks: [
    { trunk: trunk(1), tps: t1, tpsLimit: 100, queueDepth: 0 },
    { trunk: { kind: "vendor_trunk", id: 1, name: "V1" }, tps: 99, tpsLimit: 100, queueDepth: 0 },
  ],
});

test("averages ticks inside a slot and opens a new slot at the boundary", () => {
  let b = bufferFromHistory(history);
  b = appendTick(b, tick(T0 + 3000, 40, 4));
  assert.deepEqual(b.total, [10, 20, 40]);
  b = appendTick(b, tick(T0 + 4000, 60, 6));
  assert.deepEqual(b.total, [10, 20, 50]);
  assert.deepEqual(b.series[0]!.values, [1, 2, 5]);
  b = appendTick(b, tick(T0 + 5000, 70, 7));
  assert.deepEqual(b.total, [10, 20, 50, 70]);
  assert.deepEqual(b.series[0]!.values, [1, 2, 5, 7], "vendor trunk with the same id is ignored");
});

test("pads a gap with zeros and keeps an hour", () => {
  let b = bufferFromHistory({ ...history, total: Array(720).fill(1), series: [] });
  b = appendTick(b, tick(T0 + 20_000, 9, 0));
  assert.equal(b.total.length, 720);
  assert.deepEqual(b.total.slice(-4), [0, 0, 0, 9]);
});

test("windows the last minutes with timestamps", () => {
  const w = chartWindow(bufferFromHistory(history), 5);
  assert.deepEqual(w.total, [10, 20, 30]);
  assert.equal(w.times[2]! - w.times[1]!, 5000);
});

test("limit colours: amber above 80 %, red at 100 %", () => {
  assert.equal(limitLevel(80, 100).level, "ok");
  assert.equal(limitLevel(81, 100).level, "warn");
  assert.equal(limitLevel(100, 100).level, "over");
  assert.equal(limitLevel(5, 0).pct, 0);
});

test("new keys and analytics links", () => {
  assert.deepEqual([...newKeys(new Set(["a"]), ["a", "b"])], ["b"]);
  assert.equal(analyticsPath({ kind: "vendor_enterprise", id: 4, name: "V" }), "/live/analytics?by=vendor&q=V");
  assert.equal(analyticsPath({ mccmnc: "40474" }), "/live/analytics?by=destination&q=40474");
});
