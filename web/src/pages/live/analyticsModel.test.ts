import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { changes, historicalQuery, sparkPoints, tone, type Row } from "./analyticsModel";

const row = (key: string, attempts: number, asr: number | null): Row => ({
  key,
  id: key,
  name: key,
  parent: null,
  attempts,
  submitted: 0,
  delivered: 0,
  asr,
  dlr: null,
  revenue: null,
  cost: null,
  margin: null,
  marginPct: null,
  tps: null,
  tpsBefore: null,
  changePct: null,
  sparkline: null,
});

describe("live analytics model (§13.4)", () => {
  test("changed cells between snapshots", () => {
    const d = changes([row("a", 10, 90), row("b", 5, 80)], [row("a", 12, 85), row("b", 6, 80.05), row("c", 1, 1)]);
    assert.deepEqual(d.get("a"), { asr: -1 }, "growing counters do not flash, rates do");
    assert.equal(d.has("b"), false, "a change below 0.1 point is not shown");
    assert.equal(d.has("c"), false, "new rows do not flash");
    assert.equal(changes(null, [row("a", 1, 1)]).size, 0);
  });
  test("threshold colours", () => {
    assert.equal(tone("asr", 95), "good");
    assert.equal(tone("dlr", 70), "warning");
    assert.equal(tone("marginPct", -2), "error");
    assert.equal(tone("asr", null), "");
  });
  test("historical periods use the Master Report with the same Report By", () => {
    const q = historicalQuery("vendor_trunk", "yesterday", "acme", "dlr", "asc");
    assert.deepEqual(q.groupBy, ["vendorTrunk"]);
    assert.ok(q.metrics.includes("dlrVendor"));
    assert.deepEqual(q.sort, [{ field: "dlrVendor", dir: "asc" }]);
    assert.equal(q.filter?.conditions.length, 1);
    assert.equal(historicalQuery("customer", "this_week", "", "tps", "desc").sort?.[0]?.field, "attempts");
  });
  test("sparkline points", () => {
    assert.equal(sparkPoints([0, 10], 10, 10), "0.0,9.0 10.0,1.0");
    assert.equal(sparkPoints([1]), "");
  });
});
