import { test } from "node:test";
import assert from "node:assert/strict";
import { columnsFor, decodeParams, defaultParams, encodeParams, quickPeriod } from "./reportModel";

test("quick periods are local start and exclusive end", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  assert.deepEqual(quickPeriod("today", now), { from: "2026-10-16T00:00", to: "2026-10-17T00:00" });
  assert.deepEqual(quickPeriod("last_month", now), { from: "2026-09-01T00:00", to: "2026-10-01T00:00" });
  assert.deepEqual(quickPeriod("this_month", new Date("2026-12-05T00:00:00Z")), {
    from: "2026-12-01T00:00",
    to: "2027-01-01T00:00",
  });
});

test("settings round-trip through the URL; columns follow the grouping", () => {
  const p = {
    ...defaultParams(new Date("2026-10-16T00:00:00Z")),
    groupBy: ["destination" as const],
    reportBy: "none" as const,
  };
  assert.deepEqual(decodeParams(encodeParams(p)), p);
  assert.equal(decodeParams("bad"), null);
  assert.deepEqual(columnsFor(p, ["attempts", "country"]), ["country", "mccmnc", "network", "currency", "attempts"]);
  assert.deepEqual(columnsFor(defaultParams(), ["revenue"]), [
    "period",
    "enterpriseName",
    "trunkName",
    "currency",
    "revenue",
  ]);
});
