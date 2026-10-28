// Endpoints backed by the seeded database: lists, search, views, undo, preferences and
// workspace. Every response is checked against the contract. Needs `npm run seed:small`
// (CI seeds a PostgreSQL service); without a database these tests are skipped.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { currentUserId } from "../src/api/session.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
after(async () => {
  await app.close();
  await closeDb();
});

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate) assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("lists (§13.25)", { skip }, () => {
  test("trunk lists show the connection: up, reconnecting (vendors only) or down (team trial round 2)", async () => {
    for (const kind of ["customer", "vendor"] as const) {
      const res = await call("POST", `/${kind}-trunks/query`, { limit: 200 });
      assert.equal(res.statusCode, 200);
      check(kind === "customer" ? "queryCustomerTrunks" : "queryVendorTrunks", res);
      const rows = res.json().rows as { connection: string }[];
      const allowed = kind === "vendor" ? ["up", "reconnecting", "down"] : ["up", "down"];
      assert.ok(rows.length > 0 && rows.every((r) => allowed.includes(r.connection)));
      const down = await call("POST", `/${kind}-trunks/query`, {
        limit: 5,
        filter: { logic: "and", conditions: [{ field: "connection", op: "in", values: ["down"] }] },
      });
      assert.ok((down.json().rows as { connection: string }[]).every((r) => r.connection === "down"));
    }
  });

  test("pages through enterprises with the cursor, no repeats, total stays", async () => {
    const seen = new Set<number>();
    let cursor: string | null = null;
    let total = -1;
    let pages = 0;
    do {
      const res = await call("POST", "/enterprises/query", {
        limit: 25,
        cursor,
        sort: [{ field: "name", dir: "asc" }],
      });
      assert.equal(res.statusCode, 200);
      check("queryEnterprises", res);
      const page = res.json();
      if (total < 0) total = page.total;
      assert.equal(page.total, total);
      for (const r of page.rows) {
        assert.ok(!seen.has(r.id), `row ${r.id} repeated`);
        seen.add(r.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    assert.equal(seen.size, total);
  });

  test("filters match the database exactly", async () => {
    const res = await call("POST", "/enterprises/query", {
      filter: {
        logic: "and",
        conditions: [
          { field: "name", op: "like", value: "%A%" },
          {
            logic: "or",
            conditions: [
              { field: "type", op: "in", values: ["VENDOR"] },
              { field: "tier", op: "eq", value: "tier1" },
            ],
          },
        ],
      },
      limit: 4000,
    });
    assert.equal(res.statusCode, 200);
    const { rows: expected } = await db().query(
      `SELECT count(*)::int AS n FROM enterprises WHERE deleted_at IS NULL AND name ILIKE '%a%' AND (type = 'vendor' OR tier = 'tier1')`,
    );
    assert.equal(res.json().total, expected[0].n);
    for (const r of res.json().rows) {
      assert.match(r.name, /a/i);
      assert.ok(r.type === "vendor" || r.tier === "tier1");
    }
  });

  test("sorts by a joined column and supports regex and quick search", async () => {
    const sorted = await call("POST", "/enterprises/query", {
      sort: [{ field: "accountManager", dir: "desc" }],
      limit: 50,
    });
    const { rows: expected } = await db().query(
      `SELECT e.id FROM enterprises e LEFT JOIN users am ON am.id = e.account_manager_id WHERE e.deleted_at IS NULL
        ORDER BY (am.first_name || ' ' || am.last_name) DESC NULLS LAST, e.id DESC LIMIT 50`,
    );
    assert.deepEqual(
      sorted.json().rows.map((r: { id: number }) => r.id),
      expected.map((r) => r.id),
    );
    const re = await call("POST", "/enterprises/query", {
      filter: { logic: "and", conditions: [{ field: "alias", op: "regex", value: "^[a-c]" }] },
    });
    check("queryEnterprises", re);
    for (const r of re.json().rows) assert.match(r.alias, /^[a-c]/i);
    const badRe = await call("POST", "/enterprises/query", {
      filter: { logic: "and", conditions: [{ field: "alias", op: "regex", value: "[[:nope:]]" }] },
    });
    assert.equal(badRe.statusCode, 400);
    check("queryEnterprises", badRe);
  });

  test("enterprise and trunk rows carry names for the hover lists", async () => {
    const ent = await call("POST", "/enterprises/query", {
      limit: 50,
      sort: [{ field: "customerTrunkCount", dir: "desc" }],
    });
    check("queryEnterprises", ent);
    const rows = ent.json().rows as {
      customerTrunkCount: number;
      customerTrunkNames: string[];
      vendorTrunkCount: number;
      vendorTrunkNames: string[];
    }[];
    assert.ok(rows[0]!.customerTrunkCount >= rows[1]!.customerTrunkCount, "sorts by the count");
    for (const r of rows) {
      assert.equal(r.customerTrunkNames.length, Math.min(100, r.customerTrunkCount));
      assert.equal(r.vendorTrunkNames.length, Math.min(100, r.vendorTrunkCount));
    }
    for (const list of ["customer-trunks", "vendor-trunks"]) {
      const res = await call("POST", `/${list}/query`, { limit: 50 });
      assert.equal(res.statusCode, 200);
      for (const r of res.json().rows as { rulesCount: number; ruleNames: string[] }[])
        assert.equal(r.ruleNames.length, Math.min(100, r.rulesCount));
    }
  });

  test("enterprise quick search matches the start of a name (team trial round 3)", async () => {
    const first = (await call("POST", "/enterprises/query", { limit: 1 })).json().rows[0] as { name: string };
    const head = first.name.slice(0, 4);
    const res = await call("POST", "/enterprises/query", { search: head.toLowerCase(), limit: 200 });
    assert.equal(res.statusCode, 200);
    const rows = res.json().rows as { name: string; alias: string; accountManagerName: string | null }[];
    assert.ok(rows.some((r) => r.name === first.name));
    for (const r of rows)
      assert.ok(
        [r.name, r.alias, r.accountManagerName ?? ""].some((v) => v.toLowerCase().startsWith(head.toLowerCase())),
        `${r.name} starts with ${head}`,
      );
    // The middle of a name no longer matches unless typed with %.
    const middle = first.name.slice(2, 6);
    const mid = (await call("POST", "/enterprises/query", { search: `%${middle}`, limit: 200 })).json().rows as {
      name: string;
    }[];
    assert.ok(mid.some((r) => r.name === first.name));
  });

  test("users and change history", async () => {
    const users = await call("POST", "/users/query", { search: "a", limit: 10 });
    assert.equal(users.statusCode, 200);
    check("queryUsers", users);
    const changes = await call("POST", "/changes/query", {
      filter: { logic: "and", conditions: [{ field: "entityType", op: "eq", value: "route_rule" }] },
      limit: 20,
    });
    assert.equal(changes.statusCode, 200);
    check("queryChanges", changes);
    const rows = changes.json().rows;
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].at >= rows[i].at, "newest first");
    const one = rows[0];
    const byRecord = await call("POST", "/changes/query", {
      filter: {
        logic: "and",
        conditions: [
          { field: "entityType", op: "eq", value: "route_rule" },
          { field: "entityId", op: "eq", value: one.entityIds[0] },
        ],
      },
    });
    for (const r of byRecord.json().rows) assert.ok(r.entityIds.includes(one.entityIds[0]));
  });
});

describe("search (Ctrl K)", { skip }, () => {
  test("finds records by name and exact ID", async () => {
    const { rows } = await db().query("SELECT id, name FROM enterprises WHERE deleted_at IS NULL ORDER BY id LIMIT 1");
    const byName = await call("GET", `/search?q=${encodeURIComponent(rows[0].name.slice(0, 5))}`);
    assert.equal(byName.statusCode, 200);
    check("search", byName);
    assert.ok(
      byName.json().hits.some((h: { kind: string; id: number }) => h.kind === "enterprise" && h.id === rows[0].id),
    );
    const byId = await call("GET", `/search?q=${rows[0].id}&limit=5`);
    assert.equal(byId.json().hits[0].id, rows[0].id, "exact ID ranks first");
  });
});

describe("saved views (§13.25)", { skip }, () => {
  test("create, list, update, share read-only, delete", async () => {
    const name = `Test view ${Date.now()}`;
    const state = {
      filter: { logic: "and", conditions: [{ field: "type", op: "in", values: ["vendor"] }] },
      sort: [{ field: "name", dir: "asc" }],
    };
    const created = await call("POST", "/views", { list: "enterprises", name, sharedWithUserIds: [2], state });
    assert.equal(created.statusCode, 201);
    check("createView", created);
    const view = created.json();
    assert.equal(view.readOnly, false);
    assert.deepEqual(view.sharedWithUserIds, [2]);

    const dup = await call("POST", "/views", { list: "enterprises", name, state });
    assert.equal(dup.statusCode, 400);
    check("createView", dup);
    const badFilter = await call("POST", "/views", {
      list: "enterprises",
      name: `${name} x`,
      state: { filter: { logic: "and", conditions: [{ field: "nope", op: "eq", value: 1 }] } },
    });
    assert.equal(badFilter.statusCode, 400);

    const updated = await call("PUT", `/views/${view.id}`, {
      list: "enterprises",
      name: `${name} (renamed)`,
      sharedWithUserIds: [],
      state,
    });
    assert.equal(updated.statusCode, 200);
    check("updateView", updated);
    assert.deepEqual(updated.json().sharedWithUserIds, []);

    // A view another user shared with us is visible but read-only.
    const { rows } = await db().query(
      "INSERT INTO saved_views (list, name, owner_id, state) VALUES ('enterprises', $1, 2, '{}') RETURNING id",
      [`Shared ${Date.now()}`],
    );
    await db().query("INSERT INTO saved_view_shares (saved_view_id, user_id) VALUES ($1, $2)", [
      rows[0].id,
      currentUserId(),
    ]);
    const list = await call("GET", "/views?list=enterprises");
    check("listViews", list);
    const shared = list.json().find((v: { id: number }) => v.id === rows[0].id);
    assert.equal(shared.readOnly, true);
    const forbidden = await call("DELETE", `/views/${rows[0].id}`);
    assert.equal(forbidden.statusCode, 403);
    check("deleteView", forbidden);

    const deleted = await call("DELETE", `/views/${view.id}`);
    assert.equal(deleted.statusCode, 204);
    assert.equal((await call("DELETE", `/views/${view.id}`)).statusCode, 404);
    await db().query("DELETE FROM saved_views WHERE id = $1", [rows[0].id]);
  });
});

describe("undo (§13.10)", { skip }, () => {
  test("undo restores the field, is itself a change, and cannot run twice", async () => {
    const { rows } = await db().query(
      `SELECT c.id, (c.diff->0->>'entity_id')::int AS rule_id, (c.diff->0->>'before')::int AS before
         FROM changes c
        WHERE c.change_type = 'edit' AND c.entity_type = 'route_rule' AND c.diff->0->>'field' = 'priority'
          AND NOT EXISTS (SELECT 1 FROM changes x WHERE x.undo_of_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM changes l WHERE l.id > c.id AND l.entity_ids && c.entity_ids AND l.diff->0->>'field' = 'priority')
        ORDER BY c.id DESC LIMIT 1`,
    );
    const target = rows[0];
    const res = await call("POST", `/changes/${target.id}/undo`, {});
    assert.equal(res.statusCode, 200, res.body);
    check("undoChange", res);
    assert.equal(res.json().undoOfId, target.id);
    assert.equal(res.json().changeType, "undo");
    const { rows: rule } = await db().query("SELECT priority FROM route_rules WHERE id = $1", [target.rule_id]);
    assert.equal(rule[0].priority, target.before);
    const again = await call("POST", `/changes/${target.id}/undo`, {});
    assert.equal(again.statusCode, 400);
    check("undoChange", again);
  });

  test("a later change by someone else answers 409 with both values", async () => {
    const { rows } = await db().query(
      `SELECT c.id FROM changes c
        WHERE c.change_type = 'edit' AND c.entity_type = 'route_rule' AND c.diff->0->>'field' = 'priority'
          AND NOT EXISTS (SELECT 1 FROM changes x WHERE x.undo_of_id = c.id)
          AND EXISTS (SELECT 1 FROM changes l WHERE l.id > c.id AND l.user_id <> c.user_id AND l.change_type <> 'undo'
                        AND l.entity_ids && c.entity_ids AND l.diff->0->>'field' = 'priority'
                        AND NOT EXISTS (SELECT 1 FROM changes y WHERE y.undo_of_id = l.id))
        ORDER BY c.id LIMIT 1`,
    );
    const res = await call("POST", `/changes/${rows[0].id}/undo`, {});
    assert.equal(res.statusCode, 409);
    check("undoChange", res);
    const conflict = res.json().conflicts[0];
    assert.equal(conflict.field, "priority");
    assert.notEqual(conflict.mine, conflict.current);
    const keep = await call("POST", `/changes/${rows[0].id}/undo`, { resolution: "keep_current" });
    assert.equal(keep.statusCode, 400, "only the conflicting field was touched, so nothing is left");
  });

  test("unknown change answers 404", async () => {
    const res = await call("POST", "/changes/99999999/undo", {});
    assert.equal(res.statusCode, 404);
    check("undoChange", res);
  });
});

describe("preferences and workspace (§13.5, §15.2)", { skip }, () => {
  test("theme and open tabs are saved per user", async () => {
    const dark = await call("PATCH", "/me/preferences", { theme: "dark" });
    assert.equal(dark.statusCode, 200);
    check("updatePreferences", dark);
    assert.equal(dark.json().preferences.theme, "dark");
    assert.equal((await call("GET", "/me")).json().preferences.theme, "dark");
    await call("PATCH", "/me/preferences", { theme: "light" });
    assert.equal((await call("PATCH", "/me/preferences", {})).statusCode, 400, "empty update");

    const ws = {
      tabs: [{ id: "t1", path: "/enterprises?view=1", title: "Enterprises", pinned: true }],
      activeTabId: "t1",
    };
    const saved = await call("PUT", "/me/workspace", ws);
    assert.equal(saved.statusCode, 200);
    check("saveWorkspace", saved);
    const loaded = await call("GET", "/me/workspace");
    check("getWorkspace", loaded);
    assert.deepEqual(loaded.json(), { ...ws, groups: [] }, "no tab groups saved = none");
    // Tab groups (team trial round 8): kept with their tabs; a group without tabs is dropped.
    const grouped = {
      tabs: [{ ...ws.tabs[0]!, pinned: false, groupId: "g1" }],
      activeTabId: "t1",
      groups: [
        { id: "g1", label: "Ops", color: "blue", collapsed: false },
        { id: "g2", label: "Empty", color: "red", collapsed: true },
      ],
    };
    check("saveWorkspace", await call("PUT", "/me/workspace", grouped));
    const back = (await call("GET", "/me/workspace")).json();
    assert.deepEqual(back.groups, [grouped.groups[0]]);
    assert.equal(back.tabs[0].groupId, "g1");
    await call("PUT", "/me/workspace", ws);
  });
});
