// GUI access from /me (§11, team trial round 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADMIN_PAGES, can } from "./accessCore";
import { pagesOf } from "../nav/registry";

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

test("Admin pages: never by an every-page action, only when the group names the page (backend step 10)", () => {
  assert.equal(can(["view", "edit"], "users"), false);
  assert.equal(can(["view"], "audit"), false);
  assert.equal(can(["users:view"], "users"), true);
  assert.equal(can(["users:view"], "users", "edit"), false);
  assert.equal(can(["*"], "users", "edit"), true);
});

test("the Admin pages are the Admin section's and the contract's (access.json)", () => {
  const section = pagesOf("admin").map((p) => p.key);
  assert.deepEqual([...ADMIN_PAGES].sort(), [...section].sort());
  const access = JSON.parse(readFileSync(new URL("../../../contract/access.json", import.meta.url), "utf8"));
  assert.deepEqual([...ADMIN_PAGES].sort(), [...(access.admin as string[])].sort());
});
