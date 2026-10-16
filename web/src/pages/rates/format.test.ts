import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, formatPct, formatRate, formatSigned } from "./format";

test("rates keep 4 to 6 decimals", () => {
  assert.equal(formatRate(0.042), "0.0420");
  assert.equal(formatRate(0.04215), "0.04215");
  assert.equal(formatRate(0.042157), "0.042157");
  assert.equal(formatRate(null), "—");
});

test("signed margins, percentages and money", () => {
  assert.equal(formatSigned(0.0011), "+0.0011");
  assert.equal(formatSigned(-0.0022), "−0.0022");
  assert.equal(formatPct(18.44), "18.4%");
  assert.equal(formatPct(4.6, true), "+4.6%");
  assert.equal(formatMoney(4812.4, "EUR"), "€4,812");
  assert.equal(formatMoney(23.24, "USD"), "$23.24");
});
