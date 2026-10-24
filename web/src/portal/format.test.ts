import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtAmount, fmtPct, fmtRate, periodRange } from "./format";

test("portal formats and periods (§1)", () => {
  assert.equal(fmtAmount(1234.5), "1,234.5000");
  assert.equal(fmtAmount(0.123456), "0.1235");
  assert.equal(fmtRate(0.0312), "0.031200");
  assert.equal(fmtPct(null), "—");
  const now = new Date("2026-10-24T07:30:00Z");
  assert.deepEqual(periodRange("today", now), ["2026-10-24T00:00:00.000Z", "2026-10-24T23:59:59.999Z"]);
  assert.deepEqual(periodRange("yesterday", now), ["2026-10-23T00:00:00.000Z", "2026-10-23T23:59:59.999Z"]);
  assert.equal(periodRange("7d", now)[0], "2026-10-18T00:00:00.000Z");
});
