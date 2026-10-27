import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNumber, formatNumbers } from "./numberFormat";

test("number format: any length, brackets, short numbers untouched (team trial round 6)", () => {
  assert.equal(formatNumber("210271019", "### ### ###"), "210 271 019");
  assert.equal(formatNumber("210271019123", "### ### ###"), "210 271 019 123");
  assert.equal(formatNumber("21027101", "### ### ###"), "210 271 01");
  assert.equal(formatNumber("2102710190", "(###) ###-####"), "(210) 271-0190");
  assert.equal(formatNumber("210271019", "###-###"), "210-271-019");
  assert.equal(formatNumbers("Call 210271019, code 1234", "### ### ###"), "Call 210 271 019, code 1234");
  assert.equal(formatNumbers("210271019", ""), "210271019");
});
