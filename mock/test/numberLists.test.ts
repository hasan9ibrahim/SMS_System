// Number lists (§6.4) against the seeded database, QA 2026-10-31: text columns sort case-insensitively (§13.25). Every
// list this file makes is removed after, with its entries and changes.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const run = Date.now().toString(36).slice(-6);
const made: number[] = [];

after(async () => {
  if (ready && made.length) {
    const entries = "SELECT id FROM number_list_entries WHERE number_list_id = ANY($1)";
    await db().query(
      `DELETE FROM changes WHERE (entity_type = 'number_list' AND entity_ids && $1::bigint[])
        OR (entity_type = 'number_list_entry' AND entity_ids && ARRAY(${entries}))`,
      [made],
    );
    await db().query("DELETE FROM number_list_entries WHERE number_list_id = ANY($1)", [made]);
    await db().query("DELETE FROM number_lists WHERE id = ANY($1)", [made]);
  }
  await app.close();
  await closeDb();
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function ok(res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, r.body);
  return r.json();
}

async function newList(name: string, values: string[]) {
  const { record } = await ok(call("POST", "/number-lists", { name, listType: "tag" }), 201);
  made.push(record.id as number);
  const added = values.length ? await ok(call("POST", `/number-lists/${record.id}/entries`, { values })) : null;
  return { id: record.id as number, change: added?.change as { id: number } | null };
}

describe("number lists (§6.4)", { skip }, () => {
  test("text columns sort case-insensitively (QA 2026-10-31, §13.25)", async () => {
    // Byte order puts every capital first: ABD before abc, and abc after ABE.
    const a = await newList(`qa-sort-${run}-abc`, ["abc", "ABD", "Abe"]);
    await newList(`qa-sort-${run}-ABD`, []);
    const names = await ok(
      call("POST", "/number-lists/query", {
        filter: { logic: "and", conditions: [{ field: "name", op: "like", value: `qa-sort-${run}-%` }] },
        sort: [{ field: "name", dir: "asc" }],
      }),
    );
    assert.deepEqual(
      names.rows.map((r: { name: string }) => r.name),
      [`qa-sort-${run}-abc`, `qa-sort-${run}-ABD`],
    );
    for (const dir of ["asc", "desc"] as const) {
      const entries = await ok(
        call("POST", "/number-list-entries/query", {
          filter: { logic: "and", conditions: [{ field: "numberListId", op: "eq", value: a.id }] },
          sort: [{ field: "value", dir }],
        }),
      );
      const want = ["abc", "ABD", "Abe"];
      assert.deepEqual(
        entries.rows.map((r: { value: string }) => r.value),
        dir === "asc" ? want : want.reverse(),
      );
    }
  });
});
