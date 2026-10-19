// The password gate (§13.28): a must-change password leaves only the Change Password screen. This file
// signs in as seeded administrator 2, so the forced state never blocks the other test files, which run
// at the same time as user 1 against the same database.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_USER_ID = "2";
const { buildServer, API_PREFIX } = await import("../src/server.js");
const { closeDb, db, dbReady } = await import("../src/db.js");
const { invalidateGate } = await import("../src/admin/gate.js");

const app = await buildServer({ socket: false });
const ready = await dbReady();
const USER = 2;
after(async () => {
  if (ready) await db().query("UPDATE users SET must_change_password = false WHERE id = $1", [USER]);
  await app.close();
  await closeDb();
});
const call = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload ? { payload } : {}) });

test(
  "an expired or must-change password leaves only the Change Password screen",
  { skip: ready ? false : "seeded database not available" },
  async () => {
    await db().query("UPDATE users SET must_change_password = true WHERE id = $1", [USER]);
    invalidateGate();
    const blocked = await call("GET", "/security/overview");
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().code, "password_change_required");
    const status = (await call("GET", "/me/password-status")).json();
    assert.equal(status.blocked, true);
    assert.equal(status.state, "must_change");
    assert.equal(status.banner, true);
    assert.equal((await call("GET", "/me")).statusCode, 200);
    const check = await call("POST", "/password-check", { password: "a-long-new-password-1", userId: USER });
    assert.equal(check.statusCode, 200);
    await db().query("UPDATE users SET must_change_password = false WHERE id = $1", [USER]);
    invalidateGate();
    assert.equal((await call("GET", "/security/overview")).statusCode, 200);
  },
);
