// Admin › Security settings (§13.28): the password policy (lifetime, reminder days, temporary password
// hours, minimum length, history; never off), an overview of staff and portal users by password state
// with the latest security events, the reminder job (e-mail at each reminder day, never with a password
// or sign-in link, once per day mark and password) and the signed-in user's own password status.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  PasswordReminderRun,
  PasswordStateCounts,
  PasswordStatus,
  SecurityEvent,
  SecurityOverview,
  SecuritySettings,
  SecuritySettingsInput,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import { invalidateGate, STATE_SQL } from "../admin/gate.js";
import { LIFETIME_SQL, leakedListSize, loadPolicy, mapPolicy } from "../admin/passwords.js";
import { logEmail } from "./emailLog.js";
import type { DiffEntry } from "./records.js";
import { iso, recordChange } from "./records.js";
import { currentUserId, getCurrentUser } from "./session.js";

type Db = pg.Pool | pg.PoolClient;
/** The Users list's "expiring" filter (§13.28: expiring within 7 days). */
const EXPIRING_DAYS = 7;

/** Settings fields and their columns (also the undo map in changes.ts). */
export const SECURITY_COLUMNS: Record<keyof SecuritySettingsInput, string> = {
  passwordLifetimeDays: "password_lifetime_days",
  reminderDays: "reminder_days",
  tempPasswordHours: "temp_password_hours",
  minPasswordLength: "min_password_length",
  passwordHistory: "password_history",
};

async function loadSettings(c: Db): Promise<SecuritySettings> {
  const { rows } = await c.query(
    `SELECT s.*, u.username AS updated_by FROM security_settings s LEFT JOIN users u ON u.id = s.updated_by_id WHERE s.id = 1`,
  );
  const r = rows[0];
  return {
    ...mapPolicy(r),
    twoFactorRequired: true,
    leakedListSize: leakedListSize(),
    expiringDays: EXPIRING_DAYS,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
  };
}

export function getSecuritySettings(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, (pool) => loadSettings(pool));
}

export function updateSecuritySettings(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SecuritySettingsInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!me.permissions.includes("*"))
      return sendProblem(reply, 403, "Security settings are changed by administrators only (§13.28)");
    const next = { ...b, reminderDays: [...new Set(b.reminderDays)].sort((x, y) => y - x) };
    if (next.reminderDays[0]! >= next.passwordLifetimeDays)
      return sendProblem(reply, 400, "Check the highlighted fields", {
        errors: [{ path: "/reminderDays", message: "reminders must come before the password expires" }],
      });
    const before = await loadSettings(pool);
    const diff: DiffEntry[] = [];
    for (const k of Object.keys(SECURITY_COLUMNS) as (keyof SecuritySettingsInput)[])
      if (JSON.stringify(before[k]) !== JSON.stringify(next[k]))
        diff.push({ entity_id: 1, field: k, before: before[k], after: next[k] });
    if (!diff.length) return { record: before, change: null };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE security_settings SET ${diff.map((d, i) => `${SECURITY_COLUMNS[d.field as keyof SecuritySettingsInput]} = $${i + 1}`).join(", ")},
                updated_by_id = $${diff.length + 1}, updated_at = now() WHERE id = 1`,
        [...diff.map((d) => d.after), me.id],
      );
      const change = await recordChange(client, {
        entityType: "security_settings",
        entityIds: [1],
        changeType: "edit",
        diff,
        note: "Security settings",
        userId: me.id,
        ip: request.ip,
      });
      await client.query("COMMIT");
      await loadPolicy(pool, true);
      invalidateGate();
      return { record: await loadSettings(pool), change };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
}

// ---------------------------------------------------------------- overview

/** The password state of a portal user, as SQL over `u` (customer_portal_users). */
const PORTAL_STATE = STATE_SQL;

async function counts(c: Db, table: "users" | "customer_portal_users"): Promise<PasswordStateCounts> {
  // Without 2FA (R9): no sign-in code at all; an e-mailed code counts, the app once enrolled.
  const twoFa =
    table === "users"
      ? "count(*) FILTER (WHERE NOT (u.otp_method = 'email' OR (u.otp_method = 'authenticator' AND u.totp_enabled)))::int"
      : "0";
  const { rows } = await c.query(
    `SELECT count(*)::int AS total, ${twoFa} AS without2fa,
            count(*) FILTER (WHERE st = 'ok')::int AS ok, count(*) FILTER (WHERE st = 'expiring')::int AS expiring,
            count(*) FILTER (WHERE st = 'expired')::int AS expired, count(*) FILTER (WHERE st = 'temporary')::int AS temporary,
            count(*) FILTER (WHERE st = 'must_change')::int AS must_change
       FROM (SELECT u.*, ${table === "users" ? STATE_SQL : PORTAL_STATE} AS st FROM ${table} u
              WHERE u.deleted_at IS NULL AND u.status = 'active') u`,
  );
  const r = rows[0];
  return {
    total: r.total,
    ok: r.ok,
    expiring: r.expiring,
    expired: r.expired,
    temporary: r.temporary,
    mustChange: r.must_change,
    without2fa: r.without2fa,
  };
}

const EVENT_ACTIONS: Record<string, SecurityEvent["kind"]> = {
  changeMyPassword: "changed",
  changeMyPasswordFailed: "failed",
  setUserPassword: "temporary",
  setPortalUserPassword: "temporary",
  forcePasswordChange: "forced",
  updateSecuritySettings: "settings",
};
const EVENT_TEXT: Record<SecurityEvent["kind"], string> = {
  changed: "Changed their password",
  failed: "Failed password change",
  temporary: "Set a temporary password",
  forced: "Forced a password change",
  settings: "Changed the security settings",
  reminder: "Reminder sent",
};

async function events(c: Db): Promise<SecurityEvent[]> {
  const { rows } = await c.query(
    `(SELECT 'a' || a.id AS id, a.at, a.action, a.user_id, u.first_name || ' ' || u.last_name AS user_name, false AS portal,
             host(a.ip) AS ip, a.status, a.table_name, a.master_id, NULL::int AS days
        FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.action = ANY($1) AND a.status < 400 OR a.action = 'changeMyPasswordFailed'
       ORDER BY a.at DESC LIMIT 100)
     UNION ALL
     (SELECT 'r' || r.id, r.sent_at, 'reminder', r.user_id,
             CASE WHEN r.user_kind = 'staff' THEN (SELECT first_name || ' ' || last_name FROM users WHERE id = r.user_id)
                  ELSE (SELECT first_name || ' ' || last_name FROM customer_portal_users WHERE id = r.user_id) END,
             r.user_kind = 'portal', NULL, 200, NULL, NULL, r.days_mark
        FROM password_reminders r ORDER BY r.sent_at DESC LIMIT 100)
     ORDER BY at DESC LIMIT 100`,
    [Object.keys(EVENT_ACTIONS).filter((k) => k !== "changeMyPasswordFailed")],
  );
  return rows.map((r) => {
    const kind = r.action === "reminder" ? "reminder" : EVENT_ACTIONS[r.action as string]!;
    const target =
      r.master_id && kind === "temporary"
        ? ` (${r.table_name === "customer_portal_users" ? "portal user" : "user"} #${r.master_id})`
        : "";
    return {
      id: r.id as string,
      at: iso(r.at)!,
      kind,
      userId: r.user_id == null ? null : Number(r.user_id),
      userName: (r.user_name as string | null) ?? null,
      portal: !!r.portal,
      ip: (r.ip as string | null) ?? null,
      summary:
        kind === "reminder"
          ? `${EVENT_TEXT.reminder}: ${r.days} day${r.days === 1 ? "" : "s"} left`
          : `${EVENT_TEXT[kind]}${target}`,
    };
  });
}

export function getSecurityOverview(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool): Promise<SecurityOverview> => {
    await loadPolicy(pool);
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM audit_log WHERE action = 'changeMyPasswordFailed' AND at > now() - interval '24 hours') AS failed,
              (SELECT count(*)::int FROM password_reminders WHERE sent_at > now() - interval '7 days') AS reminders,
              (SELECT last_reminder_run_at FROM security_settings WHERE id = 1) AS last_run`,
    );
    return {
      settings: await loadSettings(pool),
      staff: await counts(pool, "users"),
      portal: await counts(pool, "customer_portal_users"),
      failedAttempts24h: rows[0].failed,
      remindersSent7d: rows[0].reminders,
      lastReminderRunAt: iso(rows[0].last_run),
      events: await events(pool),
    };
  });
}

// ---------------------------------------------------------------- reminders

/** Sends the reminders that are due: the nearest reminder day not yet sent for the current password. */
export async function runReminders(c: Db): Promise<PasswordReminderRun> {
  const pol = await loadPolicy(c, true);
  const out: PasswordReminderRun = { checked: 0, sent: 0, skipped: 0, recipients: [] };
  for (const kind of ["staff", "portal"] as const) {
    const table = kind === "staff" ? "users" : "customer_portal_users";
    const { rows } = await c.query(
      `SELECT u.id, u.email, u.first_name || ' ' || u.last_name AS name, u.password_changed_at,
              floor(extract(epoch FROM (u.password_changed_at + ${LIFETIME_SQL} - now())) / 86400)::int AS days_left
         FROM ${table} u
        WHERE u.deleted_at IS NULL AND u.status = 'active' AND u.temp_password_expires_at IS NULL AND NOT u.must_change_password
          AND u.password_changed_at + ${LIFETIME_SQL} > now()
          AND u.password_changed_at + ${LIFETIME_SQL} <= now() + make_interval(days => $1)`,
      [Math.max(...pol.reminderDays) + 1],
    );
    for (const r of rows) {
      out.checked++;
      const daysLeft = Number(r.days_left);
      const mark = [...pol.reminderDays].sort((a, b) => a - b).find((m) => daysLeft <= m);
      if (mark === undefined) continue;
      const { rowCount } = await c.query(
        `INSERT INTO password_reminders (user_kind, user_id, days_mark, password_changed_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [kind, r.id, mark, r.password_changed_at],
      );
      if (!rowCount) {
        out.skipped++;
        continue;
      }
      const when = daysLeft <= 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
      // §13.28: never a password or a link that signs the user in.
      await logEmail(c, {
        type: "password_reminder",
        to: [r.email as string],
        subject: `Your password expires ${when}`,
        body:
          `Hello ${r.name},\n\nYour password for the SMS platform expires ${when}. Sign in as usual and change it under ` +
          `My password. After it expires, the next sign-in opens only the Change Password screen.\n\n` +
          `This e-mail never contains a password or a sign-in link. If you did not expect it, contact your administrator.`,
      });
      // Team activity (§13.18) shows the reminder on the staff member's timeline.
      if (kind === "staff")
        await c.query(
          `INSERT INTO audit_log (user_id, ip, module, controller, method, action, table_name, master_id, status)
           VALUES ($1, NULL, 'security', '/security/reminders', 'JOB', 'passwordReminder', 'users', $2, 200)`,
          [r.id, String(r.id)],
        );
      out.sent++;
      out.recipients.push({ userId: Number(r.id), userName: r.name as string, portal: kind === "portal", daysLeft });
    }
  }
  await c.query("UPDATE security_settings SET last_reminder_run_at = now() WHERE id = 1");
  return out;
}

export function runPasswordReminders(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!me.permissions.includes("*"))
      return sendProblem(reply, 403, "Reminders are run by administrators only (§13.28)");
    return runReminders(pool);
  });
}

/** Hourly reminder job (the first run a minute after start). */
export function startSecurityJobs() {
  const tick = () => void runReminders(db()).catch(() => undefined);
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 3_600_000).unref();
}

// ---------------------------------------------------------------- my status

export function getMyPasswordStatus(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool): Promise<PasswordStatus | FastifyReply> => {
    const pol = await loadPolicy(pool);
    const { rows } = await pool.query(
      `SELECT u.password_changed_at, u.password_changed_at + ${LIFETIME_SQL} AS expires_at, u.totp_enabled,
              floor(extract(epoch FROM (u.password_changed_at + ${LIFETIME_SQL} - now())) / 86400)::int AS days_left,
              ${STATE_SQL} AS state
         FROM users u WHERE u.id = $1`,
      [currentUserId()],
    );
    const r = rows[0];
    if (!r) return sendProblem(reply, 401, "Sign in again");
    const state = r.state as PasswordStatus["state"];
    const blocked = state === "expired" || state === "temporary" || state === "must_change";
    return {
      state,
      changedAt: iso(r.password_changed_at)!,
      expiresAt: iso(r.expires_at)!,
      daysLeft: Number(r.days_left),
      reminderDays: pol.reminderDays,
      banner: blocked || Number(r.days_left) <= Math.max(...pol.reminderDays),
      blocked,
      totpEnabled: !!r.totp_enabled,
    };
  });
}
