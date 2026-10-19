import { test } from "node:test";
import assert from "node:assert/strict";
import { tzLabel, tzOffsetMinutes, tzOptions, utcOffsetLabel } from "./timezones";

test("offset labels", () => {
  const jan = new Date("2026-01-15T12:00:00Z");
  assert.equal(tzLabel("UTC", jan), "UTC+00:00 · UTC");
  assert.equal(tzLabel("Asia/Dubai", jan), "UTC+04:00 · Asia/Dubai");
  assert.equal(tzLabel("Asia/Kolkata", jan), "UTC+05:30 · Asia/Kolkata");
  assert.equal(tzOffsetMinutes("America/New_York", jan), -300);
  assert.equal(utcOffsetLabel(-210), "UTC-03:30");
  assert.deepEqual(
    tzOptions(["Asia/Dubai", "UTC", "America/New_York"], jan).map((o) => o.value),
    ["America/New_York", "UTC", "Asia/Dubai"],
  );
});
