// Staff sign-in (backend step 9, contract v0.96.0, §13.28): password, then the 2FA code (authenticator or e-mailed,
// none when an administrator turned it off), lockout, single-login, sign-out, and the user forwarded by the Elixir
// API. Runs against the seeded database with MOCK_REQUIRE_SIGN_IN=1; the test's changes are undone.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { CurrentUser, SignInResult } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { SEED_PASSWORD } from "../src/generator/admin.js";
import { encryptSecret, TOTP_USED, totpCode } from "../src/admin/passwords.js";
import { API_URL, injector } from "./remote.js";
import { withFreshTotp } from "./totp.js";

process.env.MOCK_REQUIRE_SIGN_IN = "1";
process.env.MOCK_PROXY_SECRET = "test-proxy-secret";

const app = await buildServer({ socket: false });
// With API_URL the same calls go to that server (the Elixir API, backend step 9).
const inject = injector(app);
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const started = new Date();

// Two plain users (not the administrator), active, with a normal password and an e-mail address.
const users = ready
  ? (
      await db().query(
        `SELECT id, username, email, otp_method, totp_enabled, totp_secret, allow_multiple_login
           FROM users WHERE id > 1 AND status = 'active' AND deleted_at IS NULL AND email <> ''
            AND temp_password_expires_at IS NULL AND NOT totp_enabled
          ORDER BY id LIMIT 2`,
      )
    ).rows
  : [];
const [plain, other] = users;

after(async () => {
  if (ready) {
    for (const u of users)
      await db().query(
        `UPDATE users SET otp_method = $2, allow_multiple_login = $3, totp_enabled = $4, totp_secret = $5,
                totp_last_step = NULL, failed_logins = 0, locked_until = NULL
          WHERE id = $1`,
        [u.id, u.otp_method, u.allow_multiple_login, u.totp_enabled, u.totp_secret],
      );
    await db().query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = 1");
    await db().query("DELETE FROM user_sessions WHERE user_kind = 'staff' AND logged_in_at >= $1", [started]);
    // Seeded sessions ended by a sign-in of a user without Allow Multiple Login are open again.
    await db().query(
      "UPDATE user_sessions SET ended_at = NULL, end_reason = NULL WHERE end_reason = 'replaced' AND ended_at >= $1",
      [started],
    );
    await db().query("DELETE FROM sign_in_challenges WHERE created_at >= $1", [started]);
    await db().query("DELETE FROM email_logs WHERE email_type = 'otp' AND inserted_at >= $1", [started]);
  }
  delete process.env.MOCK_REQUIRE_SIGN_IN;
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

const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  inject({
    method,
    url: `${API_PREFIX}${url}`,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
async function expect<T = any>(operationId: string, res: Promise<LightMyRequestResponse>, status = 200): Promise<T> {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return (/json/.test(String(r.headers["content-type"])) ? r.json() : r.body) as T;
}
const cookieOf = (r: LightMyRequestResponse) => String(r.headers["set-cookie"] ?? "").split(";")[0]!;
const me = (cookie: string) => call("GET", "/me", undefined, cookie ? { cookie } : {});

async function signInWith(username: string, password = SEED_PASSWORD) {
  const r = await call("POST", "/session", { username, password });
  return r;
}

describe("staff sign-in (§13.28)", { skip: skip || (!other && "no plain users") }, () => {
  test("no session: 401; code turned off by an administrator: signed in at once; sign-out ends it", async () => {
    await expect("getCurrentUser", me(""), 401);
    await db().query("UPDATE users SET otp_method = 'off' WHERE id = $1", [plain.id]);
    await expect("signIn", signInWith(plain.username, "wrong-password-123"), 401);
    const r = await signInWith(plain.username.toUpperCase());
    const res = await expect<SignInResult>("signIn", Promise.resolve(r));
    assert.equal(res.status, "signed_in");
    assert.equal(res.user?.id, Number(plain.id));
    const cookie = cookieOf(r);
    const user = await expect<CurrentUser>("getCurrentUser", me(cookie));
    assert.equal(user.id, Number(plain.id));
    await expect("signOut", call("DELETE", "/session", undefined, { cookie }), 204);
    await expect("getCurrentUser", me(cookie), 401);
  });

  test("e-mailed code: wrong code uses a try, the right one signs in, resend waits a minute", async () => {
    await db().query("UPDATE users SET otp_method = 'email' WHERE id = $1", [plain.id]);
    const first = await expect<SignInResult>("signIn", signInWith(plain.username));
    assert.equal(first.status, "code_required");
    assert.equal(first.method, "email");
    assert.match(first.sentTo ?? "", /\*\*\*@/);
    const { rows } = await db().query(
      `SELECT body FROM email_logs WHERE email_type = 'otp' AND $1 = ANY(to_addresses) ORDER BY id DESC LIMIT 1`,
      [plain.email],
    );
    const code = /code is (\d{6})/.exec(rows[0].body as string)![1]!;
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await expect("signInCode", call("POST", "/session/code", { challenge: first.challenge, code: wrong }), 401);
    assert.equal(bad.code, "wrong_code");
    await expect("resendSignInCode", call("POST", "/session/code/resend", { challenge: first.challenge }), 409);
    const r = await call("POST", "/session/code", { challenge: first.challenge, code });
    const done = await expect<SignInResult>("signInCode", Promise.resolve(r));
    assert.equal(done.status, "signed_in");
    await expect("getCurrentUser", me(cookieOf(r)));
    // A used challenge does not work again.
    const again = await expect("signInCode", call("POST", "/session/code", { challenge: first.challenge, code }), 401);
    assert.equal(again.code, "challenge_expired");
  });

  test("authenticator code for a user with 2FA on (the seeded administrator)", async () => {
    const { rows } = await db().query("SELECT username FROM users WHERE id = 1");
    const first = await expect<SignInResult>("signIn", signInWith(rows[0].username as string));
    assert.equal(first.method, "authenticator");
    assert.equal(first.sentTo, undefined);
    await expect("resendSignInCode", call("POST", "/session/code/resend", { challenge: first.challenge }), 409);
    const done = await withFreshTotp(1, (code) =>
      expect<SignInResult>("signInCode", call("POST", "/session/code", { challenge: first.challenge, code })),
    );
    assert.equal(done.user?.id, 1);
  });

  // §13.28: a code seen over someone's shoulder or caught in transit must not sign in again inside its 30 s window.
  // A plain user gets a test-only authenticator secret here (put back after the file).
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238 test secret, fake
  const challengeOf = async (username: string) => {
    const r = await expect<SignInResult>("signIn", signInWith(username));
    assert.equal(r.method, "authenticator");
    return r.challenge!;
  };
  const sendCode = (challenge: string, code: string) => call("POST", "/session/code", { challenge, code });
  const withSecret = (multiple: boolean) =>
    db().query(
      `UPDATE users SET otp_method = 'authenticator', totp_enabled = true, totp_secret = $2, totp_last_step = NULL,
              allow_multiple_login = $3
        WHERE id = $1`,
      [plain.id, encryptSecret(SECRET), multiple],
    );

  test("an authenticator code works once; the next step's code still signs in", async () => {
    await withSecret(false);
    const t0 = Date.now();
    const code = totpCode(SECRET, t0);
    const first = await expect<SignInResult>("signInCode", sendCode(await challengeOf(plain.username), code));
    assert.equal(first.status, "signed_in");
    // Same code, new sign-in with the password: refused, without using one of the challenge's tries.
    const challenge = await challengeOf(plain.username);
    const again = await expect("signInCode", sendCode(challenge, code), 401);
    assert.equal(again.title, TOTP_USED);
    assert.equal(again.code, "code_used");
    const { rows } = await db().query(
      "SELECT tries FROM sign_in_challenges WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
      [plain.id],
    );
    assert.equal(Number(rows[0].tries), 0);
    // The code of the next 30 s step (inside the clock-drift window) is a new code: it signs in on the same challenge.
    const next = await expect<SignInResult>("signInCode", sendCode(challenge, totpCode(SECRET, t0 + 30_000)));
    assert.equal(next.status, "signed_in");
  });

  test("the same authenticator code sent twice at once signs in only once", async () => {
    await withSecret(true);
    const [a, b] = [await challengeOf(plain.username), await challengeOf(plain.username)];
    const code = totpCode(SECRET);
    const answers = await Promise.all([sendCode(a, code), sendCode(b, code)]);
    assert.deepEqual(answers.map((r) => r.statusCode).sort(), [200, 401], answers.map((r) => r.body).join(" | "));
    const refused = answers.find((r) => r.statusCode === 401)!;
    check("signInCode", refused);
    assert.equal(refused.json().code, "code_used");
  });

  test("the same e-mailed code sent twice at once signs in only once", async () => {
    await db().query("UPDATE users SET otp_method = 'email', totp_enabled = false WHERE id = $1", [plain.id]);
    const first = await expect<SignInResult>("signIn", signInWith(plain.username));
    const { rows } = await db().query(
      `SELECT body FROM email_logs WHERE email_type = 'otp' AND $1 = ANY(to_addresses) ORDER BY id DESC LIMIT 1`,
      [plain.email],
    );
    const code = /code is (\d{6})/.exec(rows[0].body as string)![1]!;
    const answers = await Promise.all([sendCode(first.challenge!, code), sendCode(first.challenge!, code)]);
    assert.deepEqual(answers.map((r) => r.statusCode).sort(), [200, 401], answers.map((r) => r.body).join(" | "));
    const refused = answers.find((r) => r.statusCode === 401)!;
    check("signInCode", refused);
    assert.equal(refused.json().code, "challenge_expired");
  });

  test("without Allow Multiple Login a new sign-in ends the other session", async () => {
    await db().query("UPDATE users SET otp_method = 'off', allow_multiple_login = false WHERE id = $1", [other.id]);
    const a = cookieOf(await signInWith(other.username));
    await expect("getCurrentUser", me(a));
    const b = cookieOf(await signInWith(other.username));
    await expect("getCurrentUser", me(b));
    await expect("getCurrentUser", me(a), 401);
  });

  test("five wrong passwords lock the user for 15 minutes", async () => {
    await db().query("UPDATE users SET otp_method = 'off' WHERE id = $1", [other.id]);
    for (let i = 1; i < 5; i++) await expect("signIn", signInWith(other.username, "wrong-password-123"), 401);
    const locked = await expect("signIn", signInWith(other.username, "wrong-password-123"), 429);
    assert.match(locked.detail, /15 minutes/);
    await expect("signIn", signInWith(other.username), 429);
    // An unknown user gets the same answer as a wrong password.
    const unknown = await expect("signIn", signInWith("no-such-user-xyz"), 401);
    assert.equal(unknown.title, "Wrong username or password");
  });

  test("the Elixir API forwards the signed-in user with the shared secret", { skip: !!API_URL }, async () => {
    const headers = { "x-sms-proxy-secret": "test-proxy-secret", "x-sms-user": String(plain.id) };
    const user = await expect<CurrentUser>("getCurrentUser", call("GET", "/me", undefined, headers));
    assert.equal(user.id, Number(plain.id));
    const forged = { ...headers, "x-sms-proxy-secret": "not-the-secret" };
    await expect("getCurrentUser", call("GET", "/me", undefined, forged), 401);
  });
});
