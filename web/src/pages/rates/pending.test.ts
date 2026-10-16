import { test } from "node:test";
import assert from "node:assert/strict";
import { buildItems, changeRate, merge } from "./pending";

test("change by percent, amount or margin over best buy", () => {
  assert.equal(changeRate({ rate: 0.05, bestBuy: 0.04 }, "percent", 10), 0.055);
  assert.equal(changeRate({ rate: 0.05, bestBuy: 0.04 }, "amount", -0.002), 0.048);
  assert.equal(changeRate({ rate: 0.05, bestBuy: 0.04 }, "margin", 0.005), 0.045);
  assert.equal(changeRate({ rate: 0.05, bestBuy: null }, "margin", 0.005), null, "no best buy, no margin rule");
  assert.equal(changeRate({ rate: 0.001, bestBuy: null }, "amount", -0.01), null, "never below zero");
});

test("items: blocks first, unchanged values dropped, scheduled lines keep their date", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const rows = new Map([
    [1, { rate: 0.05, validFrom: "2026-10-01T00:00:00Z", isBlocked: false }],
    [2, { rate: 0.06, validFrom: "2026-10-20T00:00:00Z", isBlocked: false }],
    [3, { rate: 0.07, validFrom: "2026-10-01T00:00:00Z", isBlocked: false }],
  ]);
  let pending = merge(new Map(), [1], { rate: 0.055 });
  pending = merge(pending, [1], { blocked: true });
  pending = merge(pending, [2], { rate: 0.065 });
  pending = merge(pending, [3], { rate: 0.07 });
  const items = buildItems(pending, rows, null, now);
  assert.deepEqual(items, [
    { action: "block", lineId: 1, blocked: true },
    { action: "set", lineId: 1, rate: 0.055 },
    { action: "set", lineId: 2, rate: 0.065, effectiveFrom: "2026-10-20T00:00:00Z" },
  ]);
  const dated = buildItems(merge(new Map(), [1], { close: true }), rows, "2026-11-01T00:00:00.000Z", now);
  assert.deepEqual(dated, [{ action: "close", lineId: 1, at: "2026-11-01T00:00:00.000Z" }]);
});
