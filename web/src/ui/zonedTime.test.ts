import { test } from "node:test";
import assert from "node:assert/strict";
import { isoToZoned, nextMidnight, zonedToIso } from "./zonedCore";

test("platform time zone conversions", () => {
  assert.equal(zonedToIso("2026-10-21T00:00", "UTC"), "2026-10-21T00:00:00.000Z");
  assert.equal(zonedToIso("2026-10-21T00:00", "Europe/Berlin"), "2026-10-20T22:00:00.000Z");
  // Winter time after 25 Oct 2026
  assert.equal(zonedToIso("2026-11-01T00:00", "Europe/Berlin"), "2026-10-31T23:00:00.000Z");
  assert.equal(zonedToIso("2026-10-21T09:30", "Asia/Dubai"), "2026-10-21T05:30:00.000Z");
  assert.equal(isoToZoned("2026-10-20T22:00:00Z", "Europe/Berlin"), "2026-10-21T00:00");
  assert.equal(nextMidnight("UTC", Date.parse("2026-10-20T23:59:00Z")), "2026-10-21T00:00");
  assert.equal(nextMidnight("Asia/Dubai", Date.parse("2026-10-20T21:00:00Z")), "2026-10-22T00:00");
});
