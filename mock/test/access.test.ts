// What each operation needs from the user's GUI Access Group (backend steps 9 and 10, contract/access.json): the pages and
// their actions match the Admin › Access Groups catalogue, and every contract operation is in the generated table
// the Elixir API checks (contract/generated/operations.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODULES } from "../src/admin/catalog.js";
import { operations } from "../src/contract.js";

const root = new URL("../../contract/", import.meta.url);
const access = JSON.parse(readFileSync(new URL("access.json", root), "utf8"));
const table: {
  operationId: string;
  module: string | null;
  action: string | null;
  readChecked: boolean;
  admin: boolean;
  alsoOn: { module: string; action: string | null }[];
}[] =
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

test("examples: every call checked, reads too; Admin pages flagged; shared pages (backend step 10)", () => {
  const of = (id: string) => table.find((t) => t.operationId === id)!;
  assert.deepEqual([of("createEnterprise").module, of("createEnterprise").action], ["enterprises", "add"]);
  assert.equal(of("archiveEnterprise").action, "delete");
  assert.equal(of("queryEnterprises").action, null);
  assert.equal(of("queryEnterprises").readChecked, true);
  assert.equal(of("queryEnterprises").admin, false);
  assert.equal(of("setUserPassword").action, "change_password");
  assert.equal(of("startTrunkBind").action, "start_stop");
  assert.equal(of("queryAuditLog").admin, true);
  assert.equal(of("queryUsers").admin, true);
  assert.equal(of("signIn").module, null);
  assert.equal(of("undoChange").module, null);
  assert.equal(of("queryLookup").module, null);
  // Reports of their own page; the master report shared with the pages that run it.
  assert.equal(of("queryBillingReport").module, "billing-report");
  assert.ok(of("runMasterReport").alsoOn.some((a) => a.module === "dashboard"));
  assert.deepEqual(
    of("requestEdrDownload").alsoOn.find((a) => a.module === "edr-search"),
    { module: "edr-search", action: "export" },
  );
});

test("every lookup list has a list definition and its fields are list fields", async () => {
  const { listFields } = await import("../src/lists/fields.js");
  for (const [list, l] of Object.entries(access.lookups as Record<string, { fields: string[] }>)) {
    const fields = (listFields as Record<string, { fields: { field: string }[] } | undefined>)[list];
    assert.ok(fields, `lookup ${list} has no list`);
    const names = new Set(fields.fields.map((f) => f.field));
    for (const f of l.fields) assert.ok(names.has(f), `lookup ${list}: ${f} is not a field of the list`);
  }
});
