import { test } from "node:test";
import assert from "node:assert/strict";
import { joinDateTime, normalizeTime } from "./DateTimeInput";

test("24-hour time typed any usual way; a date alone is the start of the day", () => {
  assert.equal(normalizeTime("7"), "07:00");
  assert.equal(normalizeTime("15"), "15:00");
  assert.equal(normalizeTime("930"), "09:30");
  assert.equal(normalizeTime("1530"), "15:30");
  assert.equal(normalizeTime("15:30"), "15:30");
  assert.equal(normalizeTime("9.05"), "09:05");
  assert.equal(normalizeTime("24:00"), null);
  assert.equal(normalizeTime("12:60"), null);
  assert.equal(normalizeTime("3pm"), null);
  assert.equal(joinDateTime("2026-10-21", ""), "2026-10-21T00:00");
  assert.equal(joinDateTime("2026-10-21", "1530"), "2026-10-21T15:30");
  assert.equal(joinDateTime("", "1530"), "");
});
