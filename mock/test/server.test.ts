// Every mock response must match the contract: the status code must be listed for the
// operation and the body must validate against that response's schema (CLAUDE.md rule 2).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX, ROUTING_WRITES } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, dbReady } from "../src/db.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
after(async () => {
  await app.close();
  await closeDb();
});

function assertMatchesContract(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId);
  assert.ok(op, `unknown operation ${operationId}`);
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list`);
  const validate = op.responses[status];
  if (validate) assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

test("every contract operation has a mock handler", async () => {
  const { handlers } = await import("../src/handlers.js");
  const missing = operations.filter((o) => !(o.operationId in handlers)).map((o) => o.operationId);
  assert.deepEqual(missing, []);
});

test("writes that move routing displays clear the route caches (QA 2026-10-31, §6.3)", () => {
  for (const op of [
    "setQbrVendorOverride",
    "clearQbrOverride",
    "createDialCode",
    "updateDialCode",
    "deleteDialCodes",
    "importDialCodes",
    "updateDialCodeProfile",
    "createDestination",
    "updateDestination",
    "archiveDestination",
    "restoreDestination",
    "importDestinations",
    "setDestinationDlrTarget",
    "updateCountry",
    "archiveProductCategory",
    "updateRouteRule",
    "changeRateLines",
  ])
    assert.match(op, ROUTING_WRITES, op);
  for (const op of ["queryQbrStats", "queryDestinations", "exportDialCodes", "getDestination", "simulateRoute"])
    assert.doesNotMatch(op, ROUTING_WRITES, op);
});

test("GET /health", async () => {
  const res = await call("GET", "/health");
  assert.equal(res.statusCode, 200);
  assertMatchesContract("getHealth", res);
  assert.equal(res.json().backend, "mock");
});

test("GET /me", async () => {
  const res = await call("GET", "/me");
  assert.equal(res.statusCode, 200);
  assertMatchesContract("getCurrentUser", res);
});

test("GET /meta/lists/{list}/fields", async () => {
  const res = await call("GET", "/meta/lists/enterprises/fields");
  assert.equal(res.statusCode, 200);
  assertMatchesContract("getListFields", res);

  const unknown = await call("GET", "/meta/lists/nope/fields");
  assert.equal(unknown.statusCode, 404);
  assertMatchesContract("getListFields", unknown);
});

test("POST /enterprises/query accepts a valid filter tree (§13.25)", async () => {
  const res = await call("POST", "/enterprises/query", {
    filter: {
      logic: "and",
      conditions: [
        { field: "name", op: "like", value: "%demo%" },
        {
          logic: "or",
          conditions: [
            { field: "type", op: "in", values: ["customer", "reciprocal"] },
            { field: "id", op: "gte", value: 10 },
          ],
        },
      ],
    },
    sort: [{ field: "name", dir: "asc" }],
    limit: 200,
  });
  // Without the seeded database the mock answers the contract's 503.
  assert.equal(res.statusCode, ready ? 200 : 503);
  assertMatchesContract("queryEnterprises", res);
});

test("POST /enterprises/query rejects bad queries with field-level errors", async () => {
  const cases: object[] = [
    { filter: { logic: "and", conditions: [{ field: "nope", op: "eq", value: 1 }] } },
    { filter: { logic: "and", conditions: [{ field: "type", op: "regex", value: "x" }] } },
    { filter: { logic: "and", conditions: [{ field: "id", op: "between", values: [1] }] } },
    { filter: { logic: "and", conditions: [{ field: "name", op: "regex", value: "(" }] } },
    { filter: { logic: "xor", conditions: [] } },
    { sort: [{ field: "nope", dir: "asc" }] },
    { limit: 0 },
  ];
  cases.push(
    { filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: "abc" }] } },
    { filter: { logic: "and", conditions: [{ field: "updatedAt", op: "gte", value: "yesterday" }] } },
  );
  for (const body of cases) {
    const res = await call("POST", "/enterprises/query", body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assertMatchesContract("queryEnterprises", res);
    assert.ok(res.json().errors.length > 0);
  }
});

test("GET /enterprises/{id}", async () => {
  const cases: [string, number][] = [
    ["42", ready ? 200 : 503],
    ["99999999", ready ? 404 : 503],
    ["abc", 404],
  ];
  for (const [id, status] of cases) {
    const res = await call("GET", `/enterprises/${id}`);
    assert.equal(res.statusCode, status, id);
    assertMatchesContract("getEnterprise", res);
  }
});

test("query parameters are checked against the contract", async () => {
  const missing = await call("GET", "/search");
  assert.equal(missing.statusCode, 400);
  const tooLong = await call("GET", `/search?q=${"x".repeat(101)}`);
  assert.equal(tooLong.statusCode, 400);
  const badList = await call("GET", "/views?list=nope");
  assert.equal(badList.statusCode, 400);
  assertMatchesContract("listViews", badList);
});

test("paths outside the contract answer 404 problem+json", async () => {
  const res = await call("GET", "/not-in-contract");
  assert.equal(res.statusCode, 404);
  assert.match(String(res.headers["content-type"]), /application\/problem\+json/);
});
