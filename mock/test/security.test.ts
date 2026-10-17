// Security settings (build step 5.21, §13.28): the policy (never off, floors kept, undoable), the Users list
// and the password rules following it, the overview, the reminder job (once per day mark and password, no
// password or link in the e-mail), my password status and the gate that leaves only the Change Password
// screen. Every response is checked against the contract. Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { invalidateGate } from "../src/admin/gate.js";
import { loadPolicy } from "../src/admin/passwords.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
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
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return r.json();
}
const DEFAULTS = {
  passwordLifetimeDays: 30,
  reminderDays: [7, 3, 1],
  tempPasswordHours: 24,
  minPasswordLength: 12,
  passwordHistory: 12,
};
async function resetSettings() {
  await db().query(
    `UPDATE security_settings SET password_lifetime_days = 30, reminder_days = '{7,3,1}', temp_password_hours = 24,
            min_password_length = 12, password_history = 12 WHERE id = 1`,
  );
  await loadPolicy(db(), true);
  invalidateGate();
}

describe("security settings", { skip }, () => {
  test("policy: floors kept, never off, undoable; lists and rules follow it", async () => {
    cleanup.push(resetSettings);
    await resetSettings();
    const s = await ok("getSecuritySettings", call("GET", "/security/settings"));
    assert.deepEqual(
      { ...DEFAULTS, twoFactorRequired: true },
      Object.fromEntries(Object.keys({ ...DEFAULTS, twoFactorRequired: 0 }).map((k) => [k, s[k]])),
    );
    for (const bad of [
      { ...DEFAULTS, passwordLifetimeDays: 0 },
      { ...DEFAULTS, minPasswordLength: 8 },
      { ...DEFAULTS, passwordHistory: 3 },
      { ...DEFAULTS, reminderDays: [] },
    ]) {
      const r = await call("PUT", "/security/settings", bad);
      assert.equal(r.statusCode, 400, JSON.stringify(bad));
    }
    const late = await call("PUT", "/security/settings", {
      ...DEFAULTS,
      passwordLifetimeDays: 10,
      reminderDays: [14, 3],
    });
    assert.equal(late.statusCode, 400);
    check("updateSecuritySettings", late);

    const user = (
      await db().query(
        "SELECT id FROM users WHERE deleted_at IS NULL AND id > 3 AND temp_password_expires_at IS NULL ORDER BY id LIMIT 1",
      )
    ).rows[0].id;
    const daysLeft = async () => (await ok("getUser", call("GET", `/users/${user}`))).passwordDaysLeft as number;
    const before = await daysLeft();
    const saved = await ok(
      "updateSecuritySettings",
      call("PUT", "/security/settings", {
        ...DEFAULTS,
        passwordLifetimeDays: 60,
        minPasswordLength: 14,
        reminderDays: [1, 10, 3],
      }),
    );
    assert.deepEqual(saved.record.reminderDays, [10, 3, 1]);
    assert.equal(saved.change.entityType, "security_settings");
    assert.equal(await daysLeft(), before + 30);
    const rules = await ok(
      "checkPassword",
      call("POST", "/password-check", { password: "abcdefghijkl", username: "x" }),
    );
    assert.equal(rules.rules.find((r: { key: string }) => r.key === "length").label, "At least 14 characters");
    assert.equal(rules.ok, false);
    const none = await ok(
      "updateSecuritySettings",
      call("PUT", "/security/settings", {
        ...DEFAULTS,
        passwordLifetimeDays: 60,
        minPasswordLength: 14,
        reminderDays: [10, 3, 1],
      }),
    );
    assert.equal(none.change, null);

    await ok("undoChange", call("POST", `/changes/${saved.change.id}/undo`, {}));
    await loadPolicy(db(), true);
    const back = await ok("getSecuritySettings", call("GET", "/security/settings"));
    assert.equal(back.passwordLifetimeDays, 30);
    assert.deepEqual(back.reminderDays, [7, 3, 1]);
    assert.equal(await daysLeft(), before);
  });

  test("overview, reminders once per day mark, my status", async () => {
    const o = await ok("getSecurityOverview", call("GET", "/security/overview"));
    assert.ok(o.staff.total > 0 && o.portal.total > 0);
    assert.equal(
      o.staff.total,
      o.staff.ok + o.staff.expiring + o.staff.expired + o.staff.temporary + o.staff.mustChange,
    );

    // A user whose password expires in 2 days gets the 3-day reminder, once.
    const { rows } = await db().query(
      `SELECT id, password_changed_at FROM users WHERE deleted_at IS NULL AND status = 'active' AND id > 3
          AND NOT must_change_password AND temp_password_expires_at IS NULL ORDER BY id DESC LIMIT 1`,
    );
    const u = rows[0];
    cleanup.push(async () => {
      await db().query("UPDATE users SET password_changed_at = $2 WHERE id = $1", [u.id, u.password_changed_at]);
      await db().query("DELETE FROM password_reminders WHERE user_kind = 'staff' AND user_id = $1", [u.id]);
    });
    await db().query(
      "UPDATE users SET password_changed_at = now() - interval '28 days' + interval '1 hour' WHERE id = $1",
      [u.id],
    );
    const first = await ok("runPasswordReminders", call("POST", "/security/reminders/run"));
    const mine = first.recipients.find((r: { userId: number; portal: boolean }) => r.userId === u.id && !r.portal);
    assert.ok(mine, "the user got a reminder");
    assert.equal(mine.daysLeft, 2);
    const { rows: marks } = await db().query(
      "SELECT days_mark FROM password_reminders WHERE user_kind = 'staff' AND user_id = $1",
      [u.id],
    );
    assert.ok(marks.some((m) => m.days_mark === 3), JSON.stringify(marks));
    const { rows: mail } = await db().query(
      `SELECT subject, body FROM email_logs WHERE email_type = 'password_reminder' AND to_addresses[1] =
         (SELECT email FROM users WHERE id = $1) ORDER BY id DESC LIMIT 1`,
      [u.id],
    );
    assert.match(mail[0].subject, /expires in 2 days/);
    assert.doesNotMatch(mail[0].body, /https?:\/\/|password:\s*\S/i);
    const second = await ok("runPasswordReminders", call("POST", "/security/reminders/run"));
    assert.ok(!second.recipients.some((r: { userId: number; portal: boolean }) => r.userId === u.id && !r.portal));
    assert.ok(second.skipped >= 1);
    const after = await ok("getSecurityOverview", call("GET", "/security/overview"));
    assert.ok(after.lastReminderRunAt);
    assert.ok(after.events.some((e: { kind: string; userId: number }) => e.kind === "reminder" && e.userId === u.id));

    const me = await ok("getMyPasswordStatus", call("GET", "/me/password-status"));
    assert.equal(me.blocked, false);
    assert.equal(me.state === "ok" || me.state === "expiring", true);
  });

  test("an expired or must-change password leaves only the Change Password screen", async () => {
    cleanup.push(async () => {
      await db().query("UPDATE users SET must_change_password = false WHERE id = 1");
      invalidateGate();
    });
    await db().query("UPDATE users SET must_change_password = true WHERE id = 1");
    invalidateGate();
    const blocked = await call("GET", "/security/overview");
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().code, "password_change_required");
    const status = await ok("getMyPasswordStatus", call("GET", "/me/password-status"));
    assert.equal(status.blocked, true);
    assert.equal(status.state, "must_change");
    assert.equal(status.banner, true);
    await ok("getCurrentUser", call("GET", "/me"));
    await ok("checkPassword", call("POST", "/password-check", { password: "a-long-new-password-1", userId: 1 }));
    await db().query("UPDATE users SET must_change_password = false WHERE id = 1");
    invalidateGate();
    await ok("getSecurityOverview", call("GET", "/security/overview"));
  });
});
