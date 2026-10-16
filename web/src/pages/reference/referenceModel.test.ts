import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImportResult } from "@sms/contract";
import { canApply, codeLabel, importSummary, TEMPLATES } from "./referenceModel";

const result = (over: Partial<ImportResult>): ImportResult => ({
  applied: false,
  dryRun: true,
  total: 3,
  added: 0,
  updated: 0,
  unchanged: 0,
  archived: 0,
  errors: [],
  warnings: [],
  kept: [],
  change: null,
  ...over,
});

test("import summary: dry run says what will happen, applied says what did", () => {
  assert.equal(importSummary(result({ added: 2, unchanged: 1 })), "2 to add, 1 unchanged");
  assert.equal(importSummary(result({ applied: true, added: 1200, archived: 3 })), "1,200 added, 3 archived");
  assert.equal(importSummary(result({ unchanged: 0 })), "nothing to change");
});

test("import can run only without errors and with something to do", () => {
  assert.equal(canApply(null), false);
  assert.equal(canApply(result({ added: 1 })), true);
  assert.equal(canApply(result({ added: 1, errors: [{ line: 2, key: null, message: "bad" }] })), false);
  assert.equal(canApply(result({ unchanged: 3 })), false);
});

test("templates start with the columns the server needs; codes show All networks", () => {
  assert.match(TEMPLATES.destinations, /^mcc,mnc,original_mnc,country,network\n/);
  assert.match(TEMPLATES.dial_codes, /^prefix,mccmnc\n/);
  assert.match(TEMPLATES.mo_numbers, /^customer_trunk,number,keyword,rate/);
  assert.equal(codeLabel("262", ""), "262 · all");
  assert.equal(codeLabel("262", "01"), "26201");
});
