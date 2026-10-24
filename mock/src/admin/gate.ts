// The password gate (§13.28): when the signed-in user's password expired, is temporary or must be changed,
// only the Change Password screen works. Every other contract call answers 403 with code
// password_change_required until it is changed. The state is cached for a few seconds and dropped on
// every password change, forced reset or settings save.
import { db } from "../db.js";
import { CURRENT_USER_ID } from "../api/session.js";
import { LIFETIME_SQL, loadPolicy } from "./passwords.js";

/** Calls that keep working while blocked: the session, the change itself and the shell around it. */
export const GATE_OPEN = new Set([
  "getHealth",
  "getCurrentUser",
  "getMyPasswordStatus",
  "changeMyPassword",
  "sendMyPasswordCode",
  "checkPassword",
  "getWorkspace",
  "saveWorkspace",
  "updatePreferences",
  "recordPageView",
  "getMyPages",
]);

let cache: { blocked: boolean; at: number } | null = null;
export const invalidateGate = () => {
  cache = null;
};

/** The password state of a staff user, as SQL over `u` (users). */
export const STATE_SQL = `(CASE WHEN u.temp_password_expires_at IS NOT NULL THEN 'temporary'
  WHEN u.must_change_password THEN 'must_change'
  WHEN u.password_changed_at + ${LIFETIME_SQL} <= now() THEN 'expired'
  WHEN u.password_changed_at + ${LIFETIME_SQL} <= now() + interval '7 days' THEN 'expiring' ELSE 'ok' END)`;

export async function isBlocked(): Promise<boolean> {
  if (cache && Date.now() - cache.at < 3000) return cache.blocked;
  try {
    const pool = db();
    await loadPolicy(pool);
    const { rows } = await pool.query(`SELECT ${STATE_SQL} AS state FROM users u WHERE u.id = $1`, [CURRENT_USER_ID]);
    const blocked = ["expired", "temporary", "must_change"].includes(rows[0]?.state);
    cache = { blocked, at: Date.now() };
    return blocked;
  } catch {
    // No database: the mock answers 503 elsewhere; the gate stays open.
    return false;
  }
}
