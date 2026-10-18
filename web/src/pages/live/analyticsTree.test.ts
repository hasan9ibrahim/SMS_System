import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketWindow,
  cellTone,
  COLUMNS,
  detailQuery,
  fmt,
  levelOptions,
  levelQuery,
  nextSort,
  presetRange,
  rangeProblem,
} from "./analyticsTree";

const base = {
  fromDate: "2026-10-10",
  toDate: "2026-10-12",
  hourFrom: 0,
  hourTo: 23,
};

test("colours: ASR and DLR green from 80, orange from 60, red below; margin green or red (team trial round 1)", () => {
  assert.equal(cellTone("dlrCustomer", 61.85), "warn");
  assert.equal(cellTone("dlrVendor", 47.37), "bad");
  assert.equal(cellTone("dlrVendor", 92), "good");
  assert.equal(cellTone("asr", 80), "good");
  assert.equal(cellTone("asr", 79.9), "warn");
  assert.equal(cellTone("asr", 59.9), "bad");
  assert.equal(cellTone("margin", -0.05), "bad");
  assert.equal(cellTone("margin", 3), "good");
  assert.equal(cellTone("margin", 0), "");
  assert.equal(cellTone("revenue", 3), "");
  assert.equal(fmt(0.0123456, "rate"), "0.01235");
});

test("period, hours and levels make the query", () => {
  const q = levelQuery({ ...base, hourFrom: 9, hourTo: 17 }, "customerTrunk", [
    { field: "customer", op: "eq", value: "Acme" },
  ]);
  assert.equal(q.from, "2026-10-10T00:00:00.000Z");
  assert.equal(q.to, "2026-10-13T00:00:00.000Z");
  assert.deepEqual([q.hourFrom, q.hourTo], [9, 17]);
  assert.deepEqual(q.groupBy, ["customerTrunk"]);
  assert.equal(q.filter?.conditions.length, 1);
  const all = levelQuery(base, "customer", []);
  assert.equal(all.hourFrom, undefined);
  assert.equal(rangeProblem({ ...base, toDate: "2026-10-01" }), "To must be on or after From");
  assert.deepEqual(presetRange("yesterday", new Date("2026-10-18T10:00:00Z")), {
    fromDate: "2026-10-17",
    toDate: "2026-10-17",
  });
});

test("detail rows and the moment they open", () => {
  const d = detailQuery(base, "minute", []);
  assert.deepEqual(d.groupBy, ["minute"]);
  assert.equal(d.sort?.[0]?.dir, "desc");
  assert.deepEqual(bucketWindow("minute", "2026-10-18 02:35"), {
    from: "2026-10-18T02:35:00.000Z",
    to: "2026-10-18T02:36:00.000Z",
    label: "2026-10-18 02:35 UTC",
  });
  assert.equal(bucketWindow("second", "2026-10-18 02:35:07")?.to, "2026-10-18T02:35:08.000Z");
  assert.equal(bucketWindow("date", "2026-10-18")?.to, "2026-10-19T00:00:00.000Z");
  const at = levelQuery(
    { ...base, hourFrom: 9, hourTo: 10, at: bucketWindow("hour", "2026-10-18 02:00") },
    "customer",
    [],
  );
  assert.equal(at.from, "2026-10-18T02:00:00.000Z");
  assert.equal(at.hourFrom, undefined);
});

test("a row's + offers every level not used above it; headers are one line (team trial round 1)", () => {
  const opts = levelOptions(["customer", "customerTrunk"]).map((l) => l.value);
  assert.ok(!opts.includes("customer") && !opts.includes("customerTrunk"));
  assert.ok(opts.includes("vendor") && opts.includes("senderId") && opts.includes("hour"));
  assert.equal(levelOptions([]).length, opts.length + 2);
  assert.equal(COLUMNS.find((c) => c.metric === "submitted")?.label, "Submitted");
  assert.equal(COLUMNS.find((c) => c.metric === "tpsNow")?.label, "TPS");
  assert.ok(!COLUMNS.some((c) => c.metric === "hlrPorted"), "TPS replaced HLR ported");
});

test("column sort: a header flips its direction, names sort by the level's field (team trial round 1)", () => {
  assert.deepEqual(nextSort(null, "margin"), { key: "margin", dir: "desc" });
  assert.deepEqual(nextSort({ key: "margin", dir: "desc" }, "margin"), { key: "margin", dir: "asc" });
  assert.deepEqual(nextSort({ key: "margin", dir: "asc" }, "name"), { key: "name", dir: "asc" });
  assert.deepEqual(levelQuery(base, "customerTrunk", [], 100, { key: "name", dir: "desc" }).sort, [
    { field: "customerTrunk", dir: "desc" },
  ]);
  assert.deepEqual(levelQuery(base, "customer", [], 100, { key: "tpsNow", dir: "desc" }).sort, [
    { field: "tpsNow", dir: "desc" },
  ]);
});
