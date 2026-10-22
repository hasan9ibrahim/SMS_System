import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoCoding,
  autoTonNpi,
  fmtBytes,
  messageEncoding,
  needsUcs2,
  parseIdList,
  parseMixedList,
  parseReceivers,
  timeBounds,
  timeCondition,
  toGridRow,
  uuidKey,
} from "./monitorModel";

test("UUID keys are stable numbers", () => {
  const k = uuidKey("5e030f58-295d-4a9d-9f69-8e3577742311");
  assert.equal(k, parseInt("5e030f58295d4", 16));
  assert.ok(Number.isSafeInteger(k));
  assert.equal(
    toGridRow({ id: "5e030f58-295d-4a9d-9f69-8e3577742311" } as never).uuid,
    "5e030f58-295d-4a9d-9f69-8e3577742311",
  );
});

test("message ID lists and UTC time boxes", () => {
  assert.deepEqual(parseIdList(" a1, b2\nb2 ;c3 "), ["a1", "b2", "c3"]);
  // Numbers and message IDs in one box: a number written with spaces stays whole.
  assert.deepEqual(parseMixedList("+44 7700 900123, 586f7e92c4d1471d b772a0279f661a7e;2348030000001"), [
    "+44 7700 900123",
    "586f7e92c4d1471d",
    "b772a0279f661a7e",
    "2348030000001",
  ]);
  const c = timeCondition("startTime", "2026-10-16T00:00", "2026-10-16T06:30")!;
  assert.deepEqual(c, {
    field: "startTime",
    op: "between",
    values: ["2026-10-16T00:00:00.000Z", "2026-10-16T06:30:00.000Z"],
  });
  assert.deepEqual(timeBounds(c), { from: "2026-10-16T00:00", to: "2026-10-16T06:30" });
  assert.deepEqual(timeCondition("startTime", "", "2026-10-16T06:30"), {
    field: "startTime",
    op: "lte",
    value: "2026-10-16T06:30:00.000Z",
  });
  assert.equal(timeCondition("startTime", "", ""), null);
});

test("sizes and the message counter", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(269266), "263.0 KB");
  assert.equal(messageEncoding("Hello €", 0).chars, 8);
  assert.equal(messageEncoding("a".repeat(306), 0).segments, 2);
  assert.equal(messageEncoding("a".repeat(307), 0).segments, 3);
  assert.equal(messageEncoding("مرحبا", 8).bytes, 10);
  assert.ok(needsUcs2("مرحبا") && !needsUcs2("Code 1234 €"));
});

test("route simulator: receivers list, coding and TON/NPI picked from the message (team trial round 1)", () => {
  assert.deepEqual(parseReceivers("447700900123, 447700900124;\n447700900123, +33 612345678"), [
    "447700900123",
    "447700900124",
    "33612345678",
  ]);
  assert.equal(autoCoding("Your code is 1234"), 0);
  assert.equal(autoCoding("Код 1234"), 8);
  assert.deepEqual(autoTonNpi("INFO"), { ton: 5, npi: 0 });
  assert.deepEqual(autoTonNpi("12345"), { ton: 3, npi: 0 });
  assert.deepEqual(autoTonNpi("+447700900123"), { ton: 1, npi: 1 });
});
