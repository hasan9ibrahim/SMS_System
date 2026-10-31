// Customer portal (§1, team trial round 5): its own sign-in (wrong password, lockout, must-change), and the
// customer's own overview, rates, rate sheet, traffic and messages, never another enterprise's data. Runs against
// the seeded database; responses are checked against the contract and the test's changes are undone.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type {
  PortalMessagePage,
  PortalOverview,
  PortalRatePage,
  PortalSession,
  PortalSignInResult,
  PortalTraffic,
} from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { resetPortalAddressLimits } from "../src/api/portal.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { SEED_PASSWORD } from "../src/generator/admin.js";
import { chQuery } from "../src/edr.js";
import { deleteTestEdrs } from "./testEdrs.js";
import { randomUUID } from "node:crypto";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const started = new Date();

// A signed-in-ready portal user: active, password not temporary, not forced, not expired.
const user = ready
  ? (
      await db().query(
        `SELECT u.id, u.username, u.enterprise_id, u.password_hash, u.must_change_password, u.password_changed_at,
                u.otp_method, u.email
           FROM customer_portal_users u
          WHERE u.status = 'active' AND u.deleted_at IS NULL AND NOT u.must_change_password
            AND u.temp_password_expires_at IS NULL AND u.password_changed_at > now() - interval '25 days'
            AND EXISTS (SELECT 1 FROM customer_trunks t WHERE t.enterprise_id = u.enterprise_id AND t.deleted_at IS NULL)
          ORDER BY u.id LIMIT 1`,
      )
    ).rows[0]
  : null;
// The sign-in code tests turn the code on; the others sign in without it.
if (user) await db().query("UPDATE customer_portal_users SET otp_method = 'off' WHERE id = $1", [user.id]);

after(async () => {
  if (ready && user) {
    await db().query(
      `UPDATE customer_portal_users SET password_hash = $2, must_change_password = $3, password_changed_at = $4,
              failed_logins = 0, locked_until = NULL, otp_method = $5 WHERE id = $1`,
      [user.id, user.password_hash, user.must_change_password, user.password_changed_at, user.otp_method],
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
    const res = r.json() as PortalSignInResult;
    assert.equal(res.status, "signed_in", "this login has the e-mailed code turned off");
    const s = res.session!;
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

  test("our Test SMS and repushed messages on the customer's trunk never show (backend step 13)", async () => {
    if (!cookie) assert.equal((await signIn()).statusCode, 200);
    const trunk = Number(
      (await db().query("SELECT id FROM customer_trunks WHERE enterprise_id = $1 ORDER BY id LIMIT 1", [user.enterprise_id]))
        .rows[0].id,
    );
    const receiver = `99${Date.now()}`.slice(0, 15);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    // Marked (destination code) so the hourly figures and long-term totals their views took are removed too, and only
    // them (QA 2026-10-31: the hourly figures were left on the seeded client).
    const MARK = "portal-test";
    const row = (id: string, kind: string) =>
      `('${id}', now(), now(), 'MT', 1, ${user.enterprise_id}, ${trunk}, '${receiver}', 1, 1, 1, 1, 'ACCEPTD', '${kind}', '${MARK}', '${receiver}', '${MARK}')`;
    await chQuery(
      `INSERT INTO edr (edr_id, start_time, submit_time, msg_type, business_company_id, c_enterprise_id, c_trunk_id,
                        dst_addr, attempt_no, is_final_attempt, is_submit_success, msg_count, c_msg_status, internal_kind,
                        route_type, src_addr, c_mccmnc)
       VALUES ${row(ids[0]!, "")}, ${row(ids[1]!, "test")}, ${row(ids[2]!, "repush")}`,
    );
    try {
      const msgs = await expect<PortalMessagePage>(
        "portalQueryMessages",
        call("POST", "/portal/messages/query", {
          limit: 10,
          filter: { logic: "and", conditions: [{ field: "receiver", op: "eq", value: receiver }] },
        }),
      );
      assert.deepEqual(
        msgs.rows.map((m) => m.id),
        [ids[0]],
        "only the customer's own message",
      );
    } finally {
      await deleteTestEdrs(`c_enterprise_id = ${user.enterprise_id} AND c_trunk_id = ${trunk} AND c_mccmnc = '${MARK}'`);
    }
  });

  test("the e-mailed sign-in code: wrong code, resend too soon, right code (backend step 13)", async () => {
    cookie = "";
    resetPortalAddressLimits();
    // An earlier test changed the password: back to the seeded one.
    await db().query(
      `UPDATE customer_portal_users SET otp_method = 'email', password_hash = $2, must_change_password = false,
              password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [user.id, user.password_hash],
    );
    try {
      const r = await signIn();
      assert.equal(r.statusCode, 200, r.body);
      check("portalSignIn", r);
      const res = r.json() as PortalSignInResult;
      assert.equal(res.status, "code_required");
      assert.equal(cookie, "", "no session before the code");
      assert.match(res.sentTo!, /\*\*\*@/);
      const { rows } = await db().query(
        `SELECT body FROM email_logs WHERE email_type = 'otp' AND $1 = ANY(to_addresses) ORDER BY id DESC LIMIT 1`,
        [user.email],
      );
      const code = /code is (\d{6})/.exec(String(rows[0]?.body))![1]!;
      const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
      const bad = await call("POST", "/portal/session/code", { challenge: res.challenge, code: wrong });
      assert.equal(bad.statusCode, 401);
      check("portalSignInCode", bad);
      assert.equal(bad.json().code, "wrong_code");
      const soon = await call("POST", "/portal/session/code/resend", { challenge: res.challenge });
      assert.equal(soon.statusCode, 409, "one code a minute");
      const ok = await call("POST", "/portal/session/code", { challenge: res.challenge, code });
      assert.equal(ok.statusCode, 200, ok.body);
      check("portalSignInCode", ok);
      cookie = String(ok.headers["set-cookie"]).split(";")[0]!;
      assert.equal((await expect<PortalSession>("portalGetSession", call("GET", "/portal/session"))).user.id, user.id);
      const again = await call("POST", "/portal/session/code", { challenge: res.challenge, code });
      assert.equal(again.statusCode, 401, "a challenge signs in once");
    } finally {
      await db().query("UPDATE customer_portal_users SET otp_method = 'off' WHERE id = $1", [user.id]);
    }
  });

  test("one address cannot keep trying, whatever the usernames (backend step 13)", async () => {
    resetPortalAddressLimits();
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (await call("POST", "/portal/session", { username: `nobody-${i}`, password: "x" })).statusCode;
    assert.equal(last, 429);
    resetPortalAddressLimits();
  });
});

