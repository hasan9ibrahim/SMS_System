// What each operation needs from the user's GUI Access Group (backend step 9, contract/access.json): the pages and
// their actions match the Admin › Access Groups catalogue, and every contract operation is in the generated table
// the Elixir API checks (contract/generated/operations.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODULES } from "../src/admin/catalog.js";
import { operations } from "../src/contract.js";

const root = new URL("../../contract/", import.meta.url);
const access = JSON.parse(readFileSync(new URL("access.json", root), "utf8"));
const table: { operationId: string; module: string | null; action: string | null; readChecked: boolean }[] =
  JSON.parse(readFileSync(new URL("generated/operations.json", root), "utf8"));

test("access.json pages are the catalogue's pages with the same actions", () => {
  assert.deepEqual(access.pages, Object.fromEntries(MODULES.map((m) => [m.key, m.actions])));
});

test("every operation is in the table with a page and an action the page offers", () => {
  const byId = new Map(table.map((t) => [t.operationId, t]));
  for (const op of operations) {
    const t = byId.get(op.operationId);
    assert.ok(t, `${op.operationId} is not in contract/generated/operations.json (npm run gen)`);
    if (t.module === null) continue;
    assert.ok(access.pages[t.module], `${op.operationId}: unknown page ${t.module}`);
    if (t.action) assert.ok(access.pages[t.module].includes(t.action), `${op.operationId}: ${t.module} has no ${t.action}`);
  }
  assert.equal(table.length, operations.length);
});

test("examples: changes are checked, reads open, Admin pages closed except pickers", () => {
  const of = (id: string) => table.find((t) => t.operationId === id)!;
  assert.deepEqual([of("createEnterprise").module, of("createEnterprise").action], ["enterprises", "add"]);
  assert.equal(of("archiveEnterprise").action, "delete");
  assert.equal(of("queryEnterprises").action, null);
  assert.equal(of("queryEnterprises").readChecked, false);
  assert.equal(of("setUserPassword").action, "change_password");
  assert.equal(of("startTrunkBind").action, "start_stop");
  assert.equal(of("queryAuditLog").readChecked, true);
  assert.equal(of("queryUsers").readChecked, false);
  assert.equal(of("signIn").module, null);
  assert.equal(of("undoChange").module, null);
});
