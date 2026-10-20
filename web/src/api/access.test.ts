// GUI access from /me (§11, team trial round 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { can } from "./accessCore";

test("can honours admin, every-page actions, page actions and denials", () => {
  assert.equal(can(["*"], "invoices", "delete"), true);
  assert.equal(can(["view"], "invoices"), true);
  assert.equal(can(["view", "!invoices"], "invoices"), false);
  assert.equal(can(["rate-manager:view"], "rate-manager"), true);
  assert.equal(can(["rate-manager:view"], "rate-manager", "edit"), false);
  assert.equal(can([], "invoices"), false);
});

test("Home and Help are always open", () => {
  assert.equal(can([], "help"), true);
  assert.equal(can(["!home"], "home"), true);
});
