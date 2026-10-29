// Set-password links (team trial round 11, §13.28): an administrator e-mails users a single-use link; the user sets
// a password under the usual rules without signing in, and the link never works twice. In production the logged
// e-mail holds a placeholder and the e-mail job puts the link in. Runs against the seeded database; the test's rows
// are removed.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { encryptSecret, verifyPassword } from "../src/admin/passwords.js";
import { deliver } from "../src/jobs/mailer.js";
import { LINK_PLACEHOLDER, linkUrl } from "../src/api/passwordLinks.js";

process.env.MOCK_PROXY_SECRET = "test-proxy-secret";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const run = Date.now().toString(36).slice(-5);
const users: number[] = [];

after(async () => {
  if (ready) {
    await db().query("DELETE FROM password_links WHERE user_id = ANY($1)", [users]);
    await db().query("DELETE FROM email_logs WHERE user_id = ANY($1)", [users]);
    await db().query("DELETE FROM password_history WHERE user_id = ANY($1)", [users]);
    await db().query("DELETE FROM audit_log WHERE master_id = ANY($1) AND module = 'security'", [users.map(String)]);
    await db().query("DELETE FROM audit_log WHERE user_id = ANY($1)", [users]);
    await db().query("DELETE FROM user_sessions WHERE user_id = ANY($1)", [users]);
    await db().query("DELETE FROM users WHERE id = ANY($1)", [users]);
  }
  await app.close();
  await closeDb();
});

async function user(tag: string, status = "active"): Promise<number> {
  const { rows } = await db().query(
    `INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, must_change_password,
                        status, department_id, address1)
     VALUES ($1, 'Testa', 'Linkperson', $2, 'x', now(), true, $3, (SELECT min(id) FROM departments), 'Test street 1')
     RETURNING id`,
    [`link.${tag}.${run}`, `link.${tag}.${run}@example.test`, status],
  );
  users.push(Number(rows[0].id));
  return Number(rows[0].id);
}

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

/** As the seeded administrator (user 1), forwarded by the API; null = nobody signed in. */
async function call(who: number | null, operationId: string, url: string, payload: object) {
  const res = await app.inject({
    method: "POST",
    url: `${API_PREFIX}${url}`,
    headers: who == null ? {} : { "x-sms-proxy-secret": "test-proxy-secret", "x-sms-user": String(who) },
    payload,
  });
  check(operationId, res);
  return res;
}

/** The link in the logged e-mail (development: nothing is sent, so the logged copy keeps it). */
async function tokenFor(userId: number): Promise<string> {
  const { rows } = await db().query(
    "SELECT body FROM email_logs WHERE user_id = $1 AND email_type = 'password_setup' ORDER BY id DESC LIMIT 1",
    [userId],
  );
  const m = /set-password#([A-Za-z0-9_-]+)/.exec(String(rows[0]?.body ?? ""));
  assert.ok(m, "the e-mail holds the link");
  return m[1]!;
}

const GOOD = "Quiet-Harbour-Lantern-2026";

describe("set-password links (team trial round 11)", { skip }, () => {
  test("a link sets the password once, under the rules, without signing in", async () => {
    const id = await user("one");
    const off = await user("off", "inactive");
    const sent = await call(1, "sendPasswordLinks", "/users/password-links", { ids: [id, off] });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().sent, 1);
    assert.deepEqual(
      sent.json().skipped.map((s: { userId: number; reason: string }) => [s.userId, s.reason]),
      [[off, "inactive"]],
    );
    const token = await tokenFor(id);

    // Nobody is signed in: the token is the proof.
    const info = await call(null, "checkPasswordSetup", "/password-setup/check", { token, password: "short" });
    assert.equal(info.statusCode, 200, info.body);
    assert.equal(info.json().username, `link.one.${run}`);
    assert.equal(info.json().rules.find((r: { key: string }) => r.key === "length").met, false);

    const mismatch = await call(null, "completePasswordSetup", "/password-setup", {
      token,
      password: GOOD,
      confirmPassword: `${GOOD}x`,
    });
    assert.equal(mismatch.statusCode, 400);
    const weak = await call(null, "completePasswordSetup", "/password-setup", {
      token,
      password: "short",
      confirmPassword: "short",
    });
    assert.equal(weak.statusCode, 400);

    const done = await call(null, "completePasswordSetup", "/password-setup", {
      token,
      password: GOOD,
      confirmPassword: GOOD,
    });
    assert.equal(done.statusCode, 200, done.body);
    const { rows } = await db().query("SELECT password_hash, must_change_password FROM users WHERE id = $1", [id]);
    assert.ok(verifyPassword(GOOD, rows[0].password_hash));
    assert.equal(rows[0].must_change_password, false);

    // Used up.
    const again = await call(null, "checkPasswordSetup", "/password-setup/check", { token });
    assert.equal(again.statusCode, 404);
  });

  test("a new link replaces the earlier one; a wrong token is refused", async () => {
    const id = await user("two");
    await call(1, "sendPasswordLinks", "/users/password-links", { ids: [id] });
    const first = await tokenFor(id);
    await call(1, "sendPasswordLinks", "/users/password-links", { ids: [id] });
    const second = await tokenFor(id);
    assert.notEqual(first, second);
    assert.equal((await call(null, "checkPasswordSetup", "/password-setup/check", { token: first })).statusCode, 404);
    assert.equal((await call(null, "checkPasswordSetup", "/password-setup/check", { token: second })).statusCode, 200);
    const wrong = await call(null, "checkPasswordSetup", "/password-setup/check", { token: "x".repeat(43) });
    assert.equal(wrong.statusCode, 404);
  });

  test("addresses shared by several users are reported", async () => {
    const a = await user("sharea");
    const b = await user("shareb");
    await db().query("UPDATE users SET email = $2 WHERE id = ANY($1)", [[a, b], `shared.${run}@example.test`]);
    const res = (await call(1, "sendPasswordLinks", "/users/password-links", { ids: [a, b] })).json();
    assert.equal(res.sent, 2);
    assert.deepEqual(res.sharedEmails, [
      { email: `shared.${run}@example.test`, usernames: [`link.sharea.${run}`, `link.shareb.${run}`] },
    ]);
  });

  test("in production the e-mail job puts the link in; the log keeps the placeholder", async () => {
    const id = await user("prod");
    const token = "t".repeat(43);
    const saved = process.env.SMTP_URL;
    process.env.SMTP_URL = "smtp://platform%40example.test:pw@127.0.0.1:2525";
    try {
      const { rows } = await db().query(
        `INSERT INTO email_logs (email_type, status, to_addresses, subject, body, sender, user_id, next_try_at)
         VALUES ('password_setup', 'queued', ARRAY['a@example.test'], 'Set your Xpert password', $1, NULL, $2, now())
         RETURNING *`,
        [`Open this link:\n${LINK_PLACEHOLDER}\n`, id],
      );
      await db().query(
        `INSERT INTO password_links (user_id, token_hash, token_enc, email_log_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
        [id, `hash-${run}`, encryptSecret(token), rows[0].id],
      );
      let text = "";
      assert.equal(
        await deliver(db(), rows[0], async (_m, m) => {
          text = String(m.text);
          return { messageId: "<3@test>" };
        }),
        "sent",
      );
      assert.ok(text.includes(linkUrl(token)), text);
      const after = await db().query(
        "SELECT l.token_enc, e.body FROM password_links l JOIN email_logs e ON e.id = l.email_log_id WHERE l.user_id = $1",
        [id],
      );
      assert.equal(after.rows[0].token_enc, null);
      assert.ok(String(after.rows[0].body).includes(LINK_PLACEHOLDER));
      assert.ok(!String(after.rows[0].body).includes(token));
    } finally {
      if (saved) process.env.SMTP_URL = saved;
      else delete process.env.SMTP_URL;
    }
  });
});
