// Every mock response must match the contract: the status code must be listed for the
// operation and the body must validate against that response's schema (CLAUDE.md rule 2).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";

const app = await buildServer();
after(() => app.close());

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
        { logic: "or", conditions: [{ field: "type", op: "in", values: ["customer", "reciprocal"] }, { field: "id", op: "gte", value: 10 }] },
      ],
    },
    sort: [{ field: "name", dir: "asc" }],
    limit: 200,
  });
  assert.equal(res.statusCode, 200);
  assertMatchesContract("queryEnterprises", res);
});

test("POST /enterprises/query rejects bad queries with field-level errors", async () => {
  const cases = [
    { filter: { logic: "and", conditions: [{ field: "nope", op: "eq", value: 1 }] } },
    { filter: { logic: "and", conditions: [{ field: "type", op: "regex", value: "x" }] } },
    { filter: { logic: "and", conditions: [{ field: "id", op: "between", values: [1] }] } },
    { filter: { logic: "and", conditions: [{ field: "name", op: "regex", value: "(" }] } },
    { filter: { logic: "xor", conditions: [] } },
    { sort: [{ field: "nope", dir: "asc" }] },
    { limit: 0 },
  ];
  for (const body of cases) {
    const res = await call("POST", "/enterprises/query", body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assertMatchesContract("queryEnterprises", res);
    assert.ok(res.json().errors.length > 0);
  }
});

test("GET /enterprises/{id}", async () => {
  for (const id of ["42", "abc"]) {
    const res = await call("GET", `/enterprises/${id}`);
    assert.equal(res.statusCode, 404);
    assertMatchesContract("getEnterprise", res);
  }
});

test("paths outside the contract answer 404 problem+json", async () => {
  const res = await call("GET", "/not-in-contract");
  assert.equal(res.statusCode, 404);
  assert.match(String(res.headers["content-type"]), /application\/problem\+json/);
});
