// Customer portal (§1, team trial round 5): its own sign-in (wrong password, lockout, must-change), and the
// customer's own overview, rates, rate sheet, traffic and messages, never another enterprise's data. Runs against
// the seeded database; responses are checked against the contract and the test's changes are undone.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { PortalMessagePage, PortalOverview, PortalRatePage, PortalSession, PortalTraffic } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { SEED_PASSWORD } from "../src/generator/admin.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const started = new Date();

// A signed-in-ready portal user: active, password not temporary, not forced, not expired.
const user = ready
  ? (
      await db().query(
        `SELECT u.id, u.username, u.enterprise_id, u.password_hash, u.must_change_password, u.password_changed_at
           FROM customer_portal_users u
          WHERE u.status = 'active' AND u.deleted_at IS NULL AND NOT u.must_change_password
            AND u.temp_password_expires_at IS NULL AND u.password_changed_at > now() - interval '25 days'
            AND EXISTS (SELECT 1 FROM customer_trunks t WHERE t.enterprise_id = u.enterprise_id AND t.deleted_at IS NULL)
          ORDER BY u.id LIMIT 1`,
      )
    ).rows[0]
  : null;

after(async () => {
  if (ready && user) {
    await db().query(
      `UPDATE customer_portal_users SET password_hash = $2, must_change_password = $3, password_changed_at = $4,
              failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [user.id, user.password_hash, user.must_change_password, user.password_changed_at],
    );
    await db().query("DELETE FROM user_sessions WHERE portal_user_id = $1 AND logged_in_at >= $2", [user.id, started]);
    await db().query("DELETE FROM password_history WHERE portal_user_id = $1 AND changed_at >= $2", [user.id, started]);
  }
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

let cookie = "";
const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `${API_PREFIX}${url}`,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
async function expect<T = any>(operationId: string, res: Promise<LightMyRequestResponse>, status = 200): Promise<T> {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return (/json/.test(String(r.headers["content-type"])) ? r.json() : r.body) as T;
}
const signIn = async (password = SEED_PASSWORD) => {
  const r = await call("POST", "/portal/session", { username: user.username.toUpperCase(), password });
  const set = String(r.headers["set-cookie"] ?? "");
  if (r.statusCode === 200) cookie = set.split(";")[0]!;
  return r;
};

describe("customer portal (§1)", { skip: skip || (!user && "no portal user") }, () => {
  test("sign-in: no cookie, wrong password, lockout, session, sign-out", async () => {
    cookie = "";
    await expect("portalOverview", call("GET", "/portal/overview"), 401);
    await expect("portalGetSession", call("GET", "/portal/session"), 401);
    for (let i = 1; i <= 4; i++) {
      const r = await signIn("wrong-password-123");
      assert.equal(r.statusCode, 401);
      check("portalSignIn", r);
    }
    const locked = await signIn("wrong-password-123");
    assert.equal(locked.statusCode, 429, "the fifth wrong password locks the user");
    assert.equal((await signIn()).statusCode, 429, "locked even with the right password");
    await db().query("UPDATE customer_portal_users SET locked_until = NULL, failed_logins = 0 WHERE id = $1", [
      user.id,
    ]);

    const r = await signIn();
    assert.equal(r.statusCode, 200, r.body);
    check("portalSignIn", r);
    assert.match(String(r.headers["set-cookie"]), /HttpOnly/);
    const s = r.json() as PortalSession;
    assert.equal(s.enterprise.id, Number(user.enterprise_id));
    assert.equal(s.mustChangePassword, false);
    assert.equal((await expect<PortalSession>("portalGetSession", call("GET", "/portal/session"))).user.id, user.id);

    await expect("portalSignOut", call("DELETE", "/portal/session"), 204);
    await expect("portalOverview", call("GET", "/portal/overview"), 401);
  });

  test("a password that must be changed opens only the password change (§13.28)", async () => {
    await db().query("UPDATE customer_portal_users SET must_change_password = true WHERE id = $1", [user.id]);
    assert.equal((await signIn()).statusCode, 200);
    await expect("portalOverview", call("GET", "/portal/overview"), 403);
    const bad = await call("POST", "/portal/password", { currentPassword: SEED_PASSWORD, newPassword: "short" });
    assert.equal(bad.statusCode, 400);
    check("portalChangePassword", bad);
    const s = await expect<PortalSession>(
      "portalChangePassword",
      call("POST", "/portal/password", {
        currentPassword: SEED_PASSWORD,
        newPassword: `Calm-River-Portal-${Date.now().toString(36)}!`,
      }),
    );
    assert.equal(s.mustChangePassword, false);
    await expect("portalOverview", call("GET", "/portal/overview"));
  });

  test("overview, rates, rate sheet, traffic and messages are the customer's own", async () => {
    const own = new Set(
      (await db().query("SELECT name FROM customer_trunks WHERE enterprise_id = $1", [user.enterprise_id])).rows.map(
        (r) => r.name as string,
      ),
    );
    const o = await expect<PortalOverview>("portalOverview", call("GET", "/portal/overview"));
    assert.ok(o.trunks.length > 0 && o.trunks.every((t) => own.has(t.name)));

    const rates = await expect<PortalRatePage>("portalQueryRates", call("POST", "/portal/rates/query", { limit: 50 }));
    assert.ok(
      rates.rows.every((r) => own.has(r.trunk)),
      "only the customer's trunks",
    );
    const keys = rates.rows.map((r) => `${r.trunk}|${r.mccmnc}|${r.state}`);
    assert.equal(new Set(keys).size, keys.length, "one rate per trunk, destination and state");
    const fr = await expect<PortalRatePage>(
      "portalQueryRates",
      call("POST", "/portal/rates/query", {
        limit: 20,
        filter: { logic: "and", conditions: [{ field: "state", op: "in", values: ["upcoming"] }] },
      }),
    );
    assert.ok(fr.rows.every((r) => r.state === "upcoming"));
    const csv = await expect<string>("portalExportRates", call("POST", "/portal/rates/export", { limit: 10 }));
    assert.match(csv.split("\n")[0]!, /^Trunk,Country,Network,MCCMNC,Rate/);

    const msgs = await expect<PortalMessagePage>(
      "portalQueryMessages",
      call("POST", "/portal/messages/query", { limit: 50 }),
    );
    assert.ok(msgs.rows.every((m) => m.trunk === null || own.has(m.trunk)));
    const body = JSON.stringify(msgs);
    for (const leak of ["vendor", "cost", "margin", "route"])
      assert.ok(!new RegExp(`"${leak}`, "i").test(body), `no ${leak} field in the message log`);

    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const t = await expect<PortalTraffic>(
      "portalTraffic",
      call("POST", "/portal/traffic", { from, to, groupBy: "trunk" }),
    );
    assert.ok(t.rows.every((r) => own.has(r.label)));
    assert.equal(
      t.total.messages,
      t.rows.reduce((a, r) => a + r.messages, 0),
    );
    await expect(
      "portalTraffic",
      call("POST", "/portal/traffic", { from: "2026-01-01", to: "2026-12-31", groupBy: "day" }),
      400,
    );
    await expect("portalListFields", call("GET", "/portal/meta/lists/portal_messages/fields"));
  });
});
