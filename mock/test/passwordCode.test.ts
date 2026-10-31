// Password change code (decided 2026-10-24, R6, §13.28): a code is always needed. A user without an authenticator
// app asks for an e-mailed code; it is checked, used up by wrong tries, and cleared by a successful change. Like the
// code for a credential export, it works once (§13.28). This file signs in as seeded user 3 (the other files use users
// 1 and 2) and puts its password back afterwards.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

process.env.MOCK_USER_ID = "3";
const { buildServer, API_PREFIX } = await import("../src/server.js");
const { closeDb, db, dbReady } = await import("../src/db.js");
const { SEED_PASSWORD } = await import("../src/generator/admin.js");

const { runningExports } = await import("../src/api/migration.js");

const app = await buildServer({ socket: false });
const ready = await dbReady();
const USER = 3;
const STRONG = "Another-long-fake-passphrase-27";
let saved: Record<string, unknown> | null = null;
const started = new Date();
/** Credential exports this file makes: rows, files and the admins' notices go at the end. */
const exports: number[] = [];
after(async () => {
  if (ready && exports.length) {
    for (const id of exports) await runningExports.get(id);
    const { rows } = await db().query("SELECT file_path FROM migration_exports WHERE id = ANY($1)", [exports]);
    for (const r of rows) if (r.file_path) await rm(r.file_path, { force: true });
    await db().query("DELETE FROM migration_exports WHERE id = ANY($1)", [exports]);
    await db().query(
      "DELETE FROM email_logs WHERE email_type = 'credential_transfer' AND inserted_at >= $1 AND body LIKE ANY($2)",
      [started, exports.map((id) => `%export #${id} %`)],
    );
  }
  if (ready && saved)
    await db().query(
      `UPDATE users SET password_hash = $2, password_changed_at = $3, totp_enabled = $4, password_code_hash = NULL,
              password_code_expires_at = NULL, password_code_sent_at = NULL, password_code_tries = 0 WHERE id = $1`,
      [USER, saved.password_hash, saved.password_changed_at, saved.totp_enabled],
    );
  if (ready) {
    await db().query("DELETE FROM password_history WHERE user_id = $1 AND changed_at >= $2", [USER, started]);
    await db()
      .query("DELETE FROM email_logs WHERE email_type = 'otp' AND inserted_at >= $1", [started])
      .catch(() => {});
  }
  await app.close();
  await closeDb();
});
const call = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload ? { payload } : {}) });
const lastCode = async () => {
  const { rows } = await db().query("SELECT body FROM email_logs WHERE email_type = 'otp' ORDER BY id DESC LIMIT 1");
  return /is (\d{6})\./.exec(rows[0]?.body ?? "")?.[1] ?? "";
};

test(
  "without an authenticator, an e-mailed code is required, checked and cleared (R6)",
  { skip: ready ? false : "seeded database not available" },
  async () => {
    const { rows } = await db().query(
      "SELECT password_hash, password_changed_at, totp_enabled, email FROM users WHERE id = $1",
      [USER],
    );
    saved = rows[0];
    assert.ok(saved?.email, "seeded user 3 has an e-mail address");
    await db().query("UPDATE users SET totp_enabled = false, password_code_sent_at = NULL WHERE id = $1", [USER]);

    // No code: refused on the code field.
    const none = await call("POST", "/me/password", {
      currentPassword: SEED_PASSWORD,
      newPassword: STRONG,
      totpCode: null,
    });
    assert.equal(none.statusCode, 400);
    assert.ok(none.json().errors.some((e: { path: string }) => e.path === "/emailCode"));

    // Ask for a code: masked address, 10 minutes; a second ask within a minute is refused.
    const sent = await call("POST", "/me/password/code");
    assert.equal(sent.statusCode, 200, sent.body);
    assert.match(sent.json().sentTo, /^.\*\*\*@/);
    assert.equal((await call("POST", "/me/password/code")).statusCode, 400);
    const code = await lastCode();
    assert.match(code, /^\d{6}$/);

    // A wrong code is refused and uses up a try.
    const wrongCode = code === "000000" ? "111111" : "000000";
    const wrong = await call("POST", "/me/password", {
      currentPassword: SEED_PASSWORD,
      newPassword: STRONG,
      totpCode: null,
      emailCode: wrongCode,
    });
    assert.equal(wrong.statusCode, 400);
    const tries = await db().query("SELECT password_code_tries FROM users WHERE id = $1", [USER]);
    assert.equal(Number(tries.rows[0].password_code_tries), 1);

    // The right code changes the password and clears the code.
    const good = await call("POST", "/me/password", {
      currentPassword: SEED_PASSWORD,
      newPassword: STRONG,
      totpCode: null,
      emailCode: code,
    });
    assert.equal(good.statusCode, 200, good.body);
    const after_ = await db().query("SELECT password_code_hash FROM users WHERE id = $1", [USER]);
    assert.equal(after_.rows[0].password_code_hash, null);

    // The code works once (§13.28): sent again, it is refused on the code field.
    const STRONGER = "Third-long-fake-passphrase-41";
    const reused = await call("POST", "/me/password", {
      currentPassword: STRONG,
      newPassword: STRONGER,
      totpCode: null,
      emailCode: code,
    });
    assert.equal(reused.statusCode, 400);
    assert.deepEqual(reused.json().errors, [
      { path: "/emailCode", message: "the code has expired or was already used; send a new one" },
    ]);

    // A new code sent twice at once changes the password once.
    await db().query("UPDATE users SET password_code_sent_at = NULL WHERE id = $1", [USER]);
    assert.equal((await call("POST", "/me/password/code")).statusCode, 200);
    const fresh = await lastCode();
    const both = await Promise.all(
      [STRONGER, "Fourth-long-fake-passphrase-52"].map((newPassword) =>
        call("POST", "/me/password", { currentPassword: STRONG, newPassword, totpCode: null, emailCode: fresh }),
      ),
    );
    assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 400], both.map((r) => r.body).join(" | "));
    const loser = both.find((r) => r.statusCode === 400)!.json();
    assert.ok(
      loser.errors.some((e: { path: string }) => e.path === "/emailCode"),
      JSON.stringify(loser),
    );

    // With 2FA on, the e-mailed code is not offered.
    await db().query("UPDATE users SET totp_enabled = true WHERE id = $1", [USER]);
    assert.equal((await call("POST", "/me/password/code")).statusCode, 409);
  },
);

test(
  "the e-mailed code for a credential export works once (§13.22, §13.28)",
  { skip: ready ? false : "seeded database not available" },
  async () => {
    // Seeded user 3 is an administrator; without the authenticator app its second factor is the e-mailed code.
    await db().query("UPDATE users SET totp_enabled = false, password_code_sent_at = NULL WHERE id = $1", [USER]);
    const sent = await call("POST", "/me/credential-code");
    assert.equal(sent.statusCode, 200, sent.body);
    const code = await lastCode();
    const body = {
      includeCredentials: true,
      withPasswords: false,
      rateLines: "none",
      password: "long-enough-password",
      totpCode: code,
    };
    const made = await call("POST", "/migration/exports", body);
    assert.equal(made.statusCode, 201, made.body);
    exports.push(Number(made.json().id));
    // It used to work again for its 10 minutes.
    const again = await call("POST", "/migration/exports", body);
    assert.equal(again.statusCode, 400, again.body);
    assert.deepEqual(again.json().errors, [
      { path: "/totpCode", message: "the code has expired or was already used; send a new one" },
    ]);
  },
);
