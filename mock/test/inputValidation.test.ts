// Values the stores refuse answer 400, not 500 (QA 2026-10-31): IDs past 2^53, "1.0" for a whole number, NUL
// characters, dates JavaScript takes but PostgreSQL refuses, a LIKE pattern ending in its escape, a missing or null
// body, a regular expression PostgreSQL refuses. One check per class.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX, blankName, unsafeInput } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { checkListQuery, isIsoTime } from "../src/lists/validate.js";
import { listFields } from "../src/lists/fields.js";
import { searchPattern } from "../src/lists/engine.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
after(async () => {
  await app.close();
  await closeDb();
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `${API_PREFIX}${url}`,
    ...(payload === undefined
      ? {}
      : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
  });
const where = (c: object) => ({ filter: { logic: "and", conditions: [c] }, limit: 5 });

test("the checks themselves", () => {
  assert.deepEqual(unsafeInput({ a: [{ b: "x\u0000" }] }, ""), {
    path: "/a/0/b",
    message: "must not contain a NUL character",
  });
  assert.deepEqual(unsafeInput({ id: 1e20 }, ""), { path: "/id", message: "number too large" });
  assert.equal(unsafeInput({ id: 2 ** 53 - 1, rate: 0.0001, name: "ok" }, ""), null);
  for (const v of ["2026-02-30", "1", "2026-10-16T25:00:00Z", "16/10/2026"]) assert.equal(isIsoTime(v), false, v);
  for (const v of ["2026-10-16", "2026-10-16T10:00:00.123456Z", "2026-10-16T10:00+05:30"])
    assert.equal(isIsoTime(v), true, v);
  const f = listFields.enterprises;
  const errs = (c: object) => checkListQuery(where(c) as never, f).map((e) => e.message);
  assert.match(errs({ field: "id", op: "eq", value: "1.0" })[0]!, /whole number/);
  assert.match(errs({ field: "id", op: "in", values: [1, 1e20] })[0]!, /too large/);
  assert.match(errs({ field: "name", op: "like", value: "%\\" })[0]!, /single \\/);
  assert.deepEqual(errs({ field: "name", op: "like", value: "%\\\\" }), []);
  assert.equal(searchPattern("ab\\"), "%ab\\\\%");
});

test("names of spaces only are refused; other text is not", () => {
  assert.deepEqual(blankName({ name: "   " }), { path: "/name", message: "required" });
  assert.deepEqual(blankName({ name: "Acme", alias: " \t" }), { path: "/alias", message: "required" });
  assert.equal(blankName({ name: "", description: "  " }), null);
});

describe("the API answers 400 for each class (QA 2026-10-31)", { skip }, () => {
  test("a name of spaces only is not saved nameless", async () => {
    for (const [method, url] of [
      ["POST", "/enterprises"],
      ["PUT", "/enterprises/1"],
      ["POST", "/departments"],
    ] as const) {
      const r = await call(method, url, { name: "   " });
      assert.equal(r.statusCode, 400, `${url}: ${r.body}`);
      assert.ok(
        r.json().errors.some((e: { path: string }) => e.path === "/name"),
        r.body,
      );
    }
  });

  test("IDs past 2^53: in the path (404, no such record) and in a body or filter (400)", async () => {
    assert.equal((await call("GET", "/enterprises/99999999999999999999")).statusCode, 404);
    const r = await call("PUT", "/enterprises/1", { businessCompanyId: 99999999999999999999 });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(
      (await call("POST", "/enterprises/query", where({ field: "id", op: "eq", value: 99999999999999999999 })))
        .statusCode,
      400,
    );
    assert.equal(
      (await call("POST", "/enterprises/query", where({ field: "id", op: "eq", value: "1.0" }))).statusCode,
      400,
    );
  });

  test("NUL characters in a search, a filter or a record's text", async () => {
    assert.equal((await call("POST", "/enterprises/query", { search: "a\u0000b", limit: 5 })).statusCode, 400);
    assert.equal(
      (await call("POST", "/enterprises/query", where({ field: "name", op: "like", value: "a\u0000%" }))).statusCode,
      400,
    );
    const r = await call("PUT", "/enterprises/1", { website: "https://example.test/\u0000" });
    assert.equal(r.statusCode, 400, r.body);
  });

  test("dates that do not exist, and a LIKE pattern ending in a backslash", async () => {
    for (const value of ["2026-02-30", "1"]) {
      const r = await call("POST", "/enterprises/query", where({ field: "updatedAt", op: "gte", value }));
      assert.equal(r.statusCode, 400, `${value}: ${r.body}`);
    }
    assert.equal(
      (await call("POST", "/enterprises/query", where({ field: "name", op: "like", value: "%\\" }))).statusCode,
      400,
    );
    assert.equal((await call("POST", "/enterprises/query", { search: "abc\\", limit: 5 })).statusCode, 200);
  });

  test("a missing or null body is an empty one", async () => {
    for (const url of ["/enterprises/query", "/route-rules/query"]) {
      assert.equal((await app.inject({ method: "POST", url: `${API_PREFIX}${url}` })).statusCode, 200, url);
      assert.equal((await call("POST", url, null)).statusCode, 200, `${url} null`);
    }
    // EDR lists need a period: a 400 that says so, not a 500.
    assert.equal((await app.inject({ method: "POST", url: `${API_PREFIX}/edrs/query` })).statusCode, 400);
  });

  test("a regular expression PostgreSQL refuses (vendor costs' MCCMNC pattern)", async () => {
    const { rows } = await db().query("SELECT id FROM vendor_trunks ORDER BY id LIMIT 1");
    const r = await call("POST", "/route-rules/vendor-costs", {
      vendorTrunkIds: [Number(rows[0].id)],
      mccmncMode: "all",
      mccmncs: [],
      mccmncPattern: "(?<y>sign)",
    });
    assert.equal(r.statusCode, 400, r.body);
  });
});
