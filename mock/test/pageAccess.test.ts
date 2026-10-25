// A page the user may not open is not reached from another page either (backend step 10, product owner
// 2026-10-25): names-only lookups, the global search, a record's change history and undo, for a user whose access
// group gives Route rules only. The Elixir API checks each call by its page; these answers mix pages, so the mock
// applies the same rules inside them. Runs against the seeded database; the test's group and user are removed.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";

process.env.MOCK_PROXY_SECRET = "test-proxy-secret";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const made: { groups: number[]; users: number[] } = { groups: [], users: [] };

after(async () => {
  if (ready) {
    // The undo refused above is still audited.
    await db().query("DELETE FROM audit_log WHERE user_id = ANY($1)", [made.users]);
    await db().query("DELETE FROM users WHERE id = ANY($1)", [made.users]);
    await db().query("DELETE FROM access_groups WHERE id = ANY($1)", [made.groups]);
  }
  await app.close();
  await closeDb();
});

/** A user whose access group gives these pages. */
async function userWith(permissions: Record<string, string[]>): Promise<number> {
  const n = `${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
  const g = await db().query("INSERT INTO access_groups (name, permissions) VALUES ($1, $2) RETURNING id", [
    `test page access ${n}`,
    permissions,
  ]);
  made.groups.push(Number(g.rows[0].id));
  const u = await db().query(
    `INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, access_group_id,
                        department_id, address1)
     VALUES ($1, 'Test', 'Pages', $2, 'x', now(), $3, (SELECT min(id) FROM departments), 'Test street 1') RETURNING id`,
    [`test.pages.${n}`, `test.pages.${n}@example.test`, g.rows[0].id],
  );
  made.users.push(Number(u.rows[0].id));
  return Number(u.rows[0].id);
}

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

/** A call forwarded by the Elixir API as `user`. */
async function as(user: number, operationId: string, method: "GET" | "POST", url: string, payload?: object) {
  const res = await app.inject({
    method,
    url: `${API_PREFIX}${url}`,
    headers: { "x-sms-proxy-secret": "test-proxy-secret", "x-sms-user": String(user) },
    ...(payload ? { payload } : {}),
  });
  check(operationId, res);
  return res;
}

describe("pages not given are not reached from other pages (backend step 10)", { skip }, () => {
  test("lookups answer the lookup fields only, filter on them only, and only for a page that picks", async () => {
    const rules = await userWith({ "route-rules": ["view"] });
    const ok = await as(rules, "queryLookup", "POST", "/lookups/vendor_trunks/query", { limit: 5, withTotal: false });
    assert.equal(ok.statusCode, 200);
    const rows = ok.json().rows as Record<string, unknown>[];
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(typeof r.name === "string" && "enterpriseName" in r);
      // Not a lookup field: the trunk's host and username stay on the Vendor trunks page.
      assert.ok(!("host" in r) && !("username" in r) && !("tps" in r), JSON.stringify(r));
    }
    // Filtering on another field could probe it: refused.
    const probe = await as(rules, "queryLookup", "POST", "/lookups/vendor_trunks/query", {
      filter: { logic: "and", conditions: [{ field: "host", op: "contains", value: "1" }] },
    });
    assert.equal(probe.statusCode, 400);
    // Filtering by id (a picker showing its current choice) works.
    const one = await as(rules, "queryLookup", "POST", "/lookups/vendor_trunks/query", {
      filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: Number(rows[0]!.id) }] },
    });
    assert.equal(one.json().rows.length, 1);
    // No page of this user picks invoices.
    const refused = await as(rules, "queryLookup", "POST", "/lookups/invoices/query", {});
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().code, "not_allowed");
    // The list's own page may use its lookup.
    const invoices = await userWith({ invoices: ["view"] });
    assert.equal((await as(invoices, "queryLookup", "POST", "/lookups/invoices/query", { limit: 1 })).statusCode, 200);
    // Users' names: every signed-in user (saved views are shared with users on every list).
    assert.equal((await as(rules, "queryLookup", "POST", "/lookups/users/query", { limit: 1 })).statusCode, 200);
  });

  test("the global search finds records of the user's pages only", async () => {
    const rules = await userWith({ "route-rules": ["view"] });
    const { rows } = await db().query("SELECT name FROM route_rules WHERE deleted_at IS NULL ORDER BY id LIMIT 1");
    const term = String(rows[0].name).slice(0, 3);
    const res = await as(rules, "search", "GET", `/search?q=${encodeURIComponent(term)}`);
    assert.equal(res.statusCode, 200);
    const kinds = new Set((res.json().hits as { kind: string }[]).map((h) => h.kind));
    assert.ok(kinds.has("route_rule"));
    for (const k of kinds) assert.equal(k, "route_rule");
    const nothing = await userWith({ dashboard: ["view"] });
    const none = await as(nothing, "search", "GET", `/search?q=${encodeURIComponent(term)}`);
    assert.deepEqual(none.json().hits, []);
  });

  test("change history lists changes of the user's pages only; undo needs edit on the record's page", async () => {
    const rules = await userWith({ "route-rules": ["view"] });
    const res = await as(rules, "queryChanges", "POST", "/changes/query", { limit: 50, withTotal: false });
    assert.equal(res.statusCode, 200);
    const types = new Set((res.json().rows as { entityType: string }[]).map((r) => r.entityType));
    assert.ok(types.size > 0);
    for (const t of types) assert.equal(t, "route_rule");

    const { rows } = await db().query(
      `SELECT c.id FROM changes c WHERE c.entity_type = 'route_rule' AND c.change_type <> 'undo'
          AND NOT EXISTS (SELECT 1 FROM changes x WHERE x.undo_of_id = c.id) ORDER BY c.id DESC LIMIT 1`,
    );
    const undo = await as(rules, "undoChange", "POST", `/changes/${rows[0].id}/undo`, {});
    assert.equal(undo.statusCode, 403);
    assert.equal(undo.json().code, "not_allowed");
  });

  test("the every-page grant opens every page but not the Admin pages", async () => {
    const every = await userWith({ "*": ["view", "edit"] });
    const me = (await as(every, "getCurrentUser", "GET", "/me")).json() as { permissions: string[] };
    assert.ok(me.permissions.includes("view"));
    const { allows } = await import("../src/auth/access.js");
    assert.equal(allows(me.permissions, "route-rules"), true);
    assert.equal(allows(me.permissions, "users"), false);
    assert.equal(allows(me.permissions, "audit"), false);
    assert.equal(allows(["users:view"], "users"), true);
  });
});
