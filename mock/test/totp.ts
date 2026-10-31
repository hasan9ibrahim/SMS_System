// Authenticator codes in tests (§13.28). A code works once: the server keeps the user's last accepted 30 s step
// (users.totp_last_step, migration 102) and refuses a code whose step is not later. The seeded administrator's code is
// used by several test files, which `npm test` runs at the same time, so a test takes it through withFreshTotp: under
// an advisory lock it clears the stored step and runs the call with the current code, and no other file's call can
// use that step in between. The check itself is not relaxed.
import { totpCode, totpSecretOf } from "../src/admin/passwords.js";
import { db } from "../src/db.js";

const LOCK = 4_242_102; // pg_advisory_lock key, test files only

/** Runs `use` with the user's current authenticator code, cleared of earlier use (see above). */
export async function withFreshTotp<T>(userId: number, use: (code: string) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK]);
    const { rows } = await c.query("UPDATE users SET totp_last_step = NULL WHERE id = $1 RETURNING totp_secret", [
      userId,
    ]);
    const secret = totpSecretOf(rows[0]?.totp_secret);
    if (!secret) throw new Error(`user ${userId} has no authenticator secret`);
    return await use(totpCode(secret));
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => undefined);
    c.release();
  }
}
