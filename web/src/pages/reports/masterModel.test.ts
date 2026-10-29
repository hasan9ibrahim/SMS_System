import { test } from "node:test";
import assert from "node:assert/strict";
import type { MasterReportRow } from "@sms/contract";
import { decodeState } from "../../grid/filterModel";
import {
  decodeSettings,
  defaultSettings,
  deltaPct,
  drillConditions,
  edrSearchPath,
  encodeSettings,
  flatten,
  fmtMetric,
  splitVisible,
  TIMEZONES,
} from "./masterModel";

const row: MasterReportRow = {
  key: "436|40474|2026-10-15 07:00",
  dims: {
    customer: { id: 436, label: "Briavtek Global BV" },
    destination: { id: "40474", label: "India · BSNL (40474)" },
    hour: { id: "2026-10-15 07:00", label: "2026-10-15 07:00" },
    errorCode: { id: 88, label: "88 ESME_RTHROTTLED" },
  },
  metrics: { attempts: 120, margin: -2.5 },
  previous: null,
};

test("visible columns split into group-by fields and metrics", () => {
  assert.deepEqual(splitVisible(["customer", "attempts", "destination", "margin"]), {
    groupBy: ["customer", "destination"],
    metrics: ["attempts", "margin"],
  });
  const f = flatten(row);
  assert.equal(f.customer, "Briavtek Global BV");
  assert.equal(f.attempts, 120);
  assert.ok(Number.isSafeInteger(f.id));
});

test("settings round-trip, deltas, formats, time zones", () => {
  const s = {
    ...defaultSettings(),
    period: "custom" as const,
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-02T00:00:00.000Z",
  };
  assert.deepEqual(decodeSettings(encodeSettings(s), defaultSettings()), s);
  assert.deepEqual(decodeSettings("%%%", defaultSettings()), defaultSettings());
  assert.equal(deltaPct(110, 100), 10);
  assert.equal(deltaPct(5, 0), null);
  assert.equal(fmtMetric("marginPct", 31.42), "31.4 %");
  assert.equal(fmtMetric("revenue", 1234.5), "1,234.50");
  assert.equal(TIMEZONES.length, 31);
  assert.equal(TIMEZONES[0]!.label, "GMT−12:00");
  assert.equal(TIMEZONES.find((z) => z.value === "Etc/GMT-3")!.label, "GMT+03:00");
});

test("drill-down conditions and the EDRs behind a row", () => {
  assert.deepEqual(drillConditions(row, ["customer", "destination", "errorCode"]), [
    { field: "customer", op: "eq", value: "Briavtek Global BV" },
    { field: "destination", op: "eq", value: "40474" },
    { field: "errorCode", op: "in", values: ["88"] },
  ]);
  const path = edrSearchPath(
    row,
    ["customer", "destination", "hour", "errorCode"],
    "2026-10-15T00:00:00.000Z",
    "2026-10-16T00:00:00.000Z",
  );
  const g = decodeState(new URLSearchParams(path.split("?")[1]).get("g")!);
  assert.deepEqual(g.columns.customerEnterpriseId, { field: "customerEnterpriseId", op: "eq", value: 436 });
  assert.deepEqual(g.columns.causeCode, { field: "causeCode", op: "in", values: ["88"] });
  // The period is EDR search's period switch, not its Start Time header box (team trial round 10).
  assert.equal(g.columns.startTime, undefined);
  assert.deepEqual(g.switches!.startTime!.values, ["2026-10-15T07:00:00.000Z", "2026-10-15T08:00:00.000Z"]);
});
