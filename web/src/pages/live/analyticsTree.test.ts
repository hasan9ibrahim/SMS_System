import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketWindow, cellTone, detailQuery, fmt, levelQuery, presetRange, rangeProblem } from "./analyticsTree";

const base = { fromDate: "2026-10-10", toDate: "2026-10-12", hourFrom: 0, hourTo: 23, levels: ["customer", "customerTrunk"] as const };

test("colours: DLR and ASR amber or red, negative margin red", () => {
  assert.equal(cellTone("dlrCustomer", 61.85), "warn");
  assert.equal(cellTone("dlrVendor", 47.37), "bad");
  assert.equal(cellTone("dlrVendor", 92), "");
  assert.equal(cellTone("margin", -0.05), "bad");
  assert.equal(cellTone("asr", 80), "warn");
  assert.equal(fmt(0.0123456, "rate"), "0.01235");
});

test("period, hours and levels make the query", () => {
  const q = levelQuery({ ...base, levels: [...base.levels], hourFrom: 9, hourTo: 17 }, 1, [{ field: "customer", op: "eq", value: "Acme" }]);
  assert.equal(q.from, "2026-10-10T00:00:00.000Z");
  assert.equal(q.to, "2026-10-13T00:00:00.000Z");
  assert.deepEqual([q.hourFrom, q.hourTo], [9, 17]);
  assert.deepEqual(q.groupBy, ["customerTrunk"]);
  assert.equal(q.filter?.conditions.length, 1);
  const all = levelQuery({ ...base, levels: [...base.levels] }, 0, []);
  assert.equal(all.hourFrom, undefined);
  assert.equal(rangeProblem({ ...base, levels: [...base.levels], toDate: "2026-10-01" }), "To must be on or after From");
  assert.deepEqual(presetRange("yesterday", new Date("2026-10-18T10:00:00Z")), { fromDate: "2026-10-17", toDate: "2026-10-17" });
});

test("detail rows and the moment they open", () => {
  const d = detailQuery({ ...base, levels: [...base.levels] }, "minute", []);
  assert.deepEqual(d.groupBy, ["minute"]);
  assert.equal(d.sort?.[0]?.dir, "desc");
  assert.deepEqual(bucketWindow("minute", "2026-10-18 02:35"), {
    from: "2026-10-18T02:35:00.000Z",
    to: "2026-10-18T02:36:00.000Z",
    label: "2026-10-18 02:35 UTC",
  });
  assert.equal(bucketWindow("second", "2026-10-18 02:35:07")?.to, "2026-10-18T02:35:08.000Z");
  assert.equal(bucketWindow("date", "2026-10-18")?.to, "2026-10-19T00:00:00.000Z");
  const at = levelQuery({ ...base, levels: [...base.levels], hourFrom: 9, hourTo: 10, at: bucketWindow("hour", "2026-10-18 02:00") }, 0, []);
  assert.equal(at.from, "2026-10-18T02:00:00.000Z");
  assert.equal(at.hourFrom, undefined);
});
