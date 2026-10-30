// Calls forwarded by the Elixir API (security audit, team trial round 12): the API names the operation it checked the
// user's access for (X-Sms-Op); the service refuses a forwarded call whose route is another operation, so a path the
// API could not match (e.g. "/api/v1/%75sers/1") can never run here as the user.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb } from "../src/db.js";

process.env.MOCK_PROXY_SECRET = "test-proxy-secret";
const app = await buildServer({ socket: false });
after(async () => {
  await app.close();
  await closeDb();
});

const as = (op?: string) => ({
  "x-sms-proxy-secret": "test-proxy-secret",
  "x-sms-user": "1",
  ...(op ? { "x-sms-op": op } : {}),
});

test("a forwarded call must be the operation the API checked", async () => {
  const wrong = await app.inject({ method: "GET", url: `${API_PREFIX}/users/1`, headers: as("getCurrentUser") });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().code, "operation_mismatch");
  // The encoded path the API used to pass on: decoded here to /users/1, refused all the same.
  const encoded = await app.inject({ method: "GET", url: `${API_PREFIX}/%75sers/1`, headers: as("getCurrentUser") });
  assert.equal(encoded.statusCode, 403);
  const right = await app.inject({ method: "GET", url: `${API_PREFIX}/me`, headers: as("getCurrentUser") });
  assert.notEqual(right.statusCode, 403, right.body);
  // Public operations need no operation name.
  const health = await app.inject({ method: "GET", url: `${API_PREFIX}/health`, headers: as() });
  assert.equal(health.statusCode, 200);
});
