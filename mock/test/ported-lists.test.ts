// The lists the Elixir API answers itself (backend step 9): Audit Trail and Logged In Users. Every query runs on the
// in-process mock and is checked against the contract; with API_URL set (e.g. http://127.0.0.1:4100) the same query
// also goes to the API, signed in as the seeded administrator, and both answers must be identical, so the screens
// see no difference when the list moves to Elixir (CLAUDE.md rule 2).
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { ListQuery as FullQuery } from "@sms/contract";

// Defaults (limit, withTotal) may be left out of a query.
type ListQuery = Partial<FullQuery>;
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { SEED_PASSWORD } from "../src/generator/admin.js";
import { API_URL, injector, remoteSession } from "./remote.js";
import { withFreshTotp } from "./totp.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const admin = ready ? ((await db().query("SELECT username FROM users WHERE id = 1")).rows[0]?.username as string) : "";
const session = () => remoteSession(admin, SEED_PASSWORD, (use) => withFreshTotp(1, use));
const remote = injector(app, session);

// Signed in before the first query: the sign-in's own audit rows must not land between the two answers.
before(async () => {
  if (API_URL && ready) await session();
});

after(async () => {
  await app.close();
  await closeDb();
});

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

/** The mock's answer, checked; with API_URL, the API's answer must be the same. */
async function same(operationId: string, path: string, body: unknown, status = 200, ignore: string[] = []) {
  const local = await app.inject({ method: "POST", url: `${API_PREFIX}${path}`, payload: body as object });
  assert.equal(local.statusCode, status, `${operationId} (mock): ${local.body}`);
  check(operationId, local);
  if (!API_URL) return local.json();
  const res = await remote({ method: "POST", url: `${API_PREFIX}${path}`, payload: body as object });
  assert.equal(res.statusCode, status, `${operationId} (API): ${res.body}`);
  check(operationId, res);
  const strip = (v: Record<string, unknown>) => {
    const out = structuredClone(v);
    if (status !== 200) return { status: out.status, paths: ((out.errors as { path: string }[]) ?? []).map((e) => e.path).sort() };
    for (const row of (out.rows as Record<string, unknown>[]) ?? []) for (const k of ignore) delete row[k];
    return out;
  };
  assert.deepEqual(strip(res.json()), strip(local.json()), `${operationId}: the API and the mock differ for ${JSON.stringify(body)}`);
  return local.json();
}

const audit = (q: ListQuery, status = 200) => same("queryAuditLog", "/audit-log/query", q, status);
const sessions = (q: ListQuery, status = 200) =>
  // "current" is the caller's own session, which differs between the two callers.
  same("queryUserSessions", "/user-sessions/query", q, status, ["current"]);

describe("ported lists (backend step 9)", { skip }, () => {
  test("Audit Trail: default sort, paging with the cursor, totals", async () => {
    const first = await audit({ limit: 50 });
    assert.ok(first.rows.length > 0);
    if (first.nextCursor) {
      const second = await audit({ limit: 50, cursor: first.nextCursor });
      assert.notDeepEqual(second.rows[0], first.rows[0]);
    }
    await audit({ limit: 20, withTotal: false });
  });

  test("Audit Trail: every operator kind, AND/OR groups, sorting, quick search", async () => {
    const queries: ListQuery[] = [
      { filter: { logic: "and", conditions: [{ field: "method", op: "in", values: ["PUT", "post"] }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "action", op: "like", value: "update%" }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "action", op: "not_like", value: "%e%" }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "controller", op: "regex", value: "^/users/" }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "status", op: "gte", value: 400 }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "durationMs", op: "between", values: [0, "50"] }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "id", op: "lt", value: "1000" }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "masterId", op: "empty" }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "masterId", op: "not_empty" }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "method", op: "neq", value: "post" }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "method", op: "not_in", values: ["PUT"] }] }, limit: 30 },
      { filter: { logic: "and", conditions: [{ field: "at", op: "gte", value: "2026-01-01T00:00:00Z" }] }, limit: 30 },
      {
        filter: {
          logic: "and",
          conditions: [
            { field: "status", op: "lt", value: 500 },
            {
              logic: "or",
              conditions: [
                { field: "method", op: "eq", value: "DELETE" },
                { field: "action", op: "like", value: "create%" },
              ],
            },
          ],
        },
        sort: [{ field: "action", dir: "asc" }, { field: "at", dir: "desc" }],
        limit: 40,
      },
      { search: "user", limit: 30 },
      { search: "%Rule_", limit: 30 },
      { sort: [{ field: "user", dir: "asc" }], limit: 30 },
      { sort: [{ field: "durationMs", dir: "desc" }], limit: 30 },
    ];
    for (const q of queries) await audit(q);
  });

  test("Audit Trail: queries that do not fit the catalogue are refused with the same fields", async () => {
    await audit({ filter: { logic: "and", conditions: [{ field: "nope", op: "eq", value: 1 }] } }, 400);
    await audit({ filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: "abc" }] } }, 400);
    await audit({ filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: 1.5 }] } }, 400);
    await audit({ filter: { logic: "and", conditions: [{ field: "at", op: "gte", value: "yesterday" }] } }, 400);
    await audit({ filter: { logic: "and", conditions: [{ field: "action", op: "regex", value: "(" }] } }, 400);
    await audit({ filter: { logic: "and", conditions: [{ field: "action", op: "in", values: [] }] } }, 400);
    await audit({ filter: { logic: "and", conditions: [{ field: "id", op: "between", values: [1] }] } }, 400);
    await audit({ sort: [{ field: "nope", dir: "asc" }] }, 400);
  });

  test("Logged In Users: open sessions, filters, sorting and search", async () => {
    await sessions({ limit: 200 });
    await sessions({ filter: { logic: "and", conditions: [{ field: "userKind", op: "in", values: ["customer"] }] }, limit: 50 });
    await sessions({ filter: { logic: "and", conditions: [{ field: "device", op: "in", values: ["mobile", "tablet"] }] }, limit: 50 });
    await sessions({ filter: { logic: "and", conditions: [{ field: "ip", op: "like", value: "10.%" }] }, limit: 50 });
    await sessions({ search: "a", sort: [{ field: "displayName", dir: "asc" }], limit: 50 });
    await sessions({ sort: [{ field: "lastSeenAt", dir: "asc" }], limit: 50 });
  });
});
