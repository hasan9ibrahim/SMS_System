// Admin (build step 5.11, §11, §12.5, §13.28): password rules, hashing and TOTP, the access group
// catalogue against the web page registry, users (temporary password, forced change, QR 2FA, own
// password change, safe delete), departments, access groups, logged-in users, the audit trail,
// e-mail templates, business companies (secrets, files, SMTP check) and portal users, against the
// seeded database. Responses are checked against the contract; rows the tests add are removed.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LightMyRequestResponse } from "fastify";
import type { BusinessCompanyInput, BusinessCompanyRecord, Change, UserInput } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { MODULES, checkPermissions, checkTabs, effectiveAccess } from "../src/admin/catalog.js";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  passwordRules,
  TOTP_USED,
  totpCode,
  totpMatch,
  totpStep,
  verifyPassword,
  verifyTotp,
} from "../src/admin/passwords.js";
import { withFreshTotp } from "./totp.js";
import { DEMO_TOTP_SECRET, SEED_PASSWORD } from "../src/generator/admin.js";
import { fillTemplate } from "../src/api/admin.js";
import { tableOf } from "../src/api/audit.js";
import { companyDetails, companyPlaceholders, companyTemplate, senderFor } from "../src/api/emailLog.js";
import { fakeLogoPng } from "../src/email/png.js";
import { embedImages, fillBody, outlookFont, sanitizeHtml } from "../src/email/html.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const started = new Date();
const run = Date.now().toString(36).slice(-5);
let myHash: string | null = null;
const lastSession = ready
  ? Number((await db().query("SELECT coalesce(max(id), 0) AS id FROM user_sessions")).rows[0].id)
  : 0;
after(async () => {
  // Close first: closing waits for the audit rows still being written after the last replies, so none lands after
  // the clean-up (a late row kept a test user from being deleted, CI 2026-10-30).
  await app.close();
  if (ready) {
    const q = (sql: string, p: unknown[] = [started]) => db().query(sql, p);
    if (myHash)
      await q("UPDATE users SET password_hash = $1, password_changed_at = password_changed_at WHERE id = 1", [myHash]);
    await q("DELETE FROM password_history WHERE changed_at >= $1");
    await q("DELETE FROM user_sessions WHERE id > $1", [lastSession]);
    await q("UPDATE user_sessions SET ended_at = NULL, ended_by_id = NULL, end_reason = NULL WHERE ended_at >= $1");
    await q("DELETE FROM users WHERE inserted_at >= $1");
    await q("DELETE FROM departments WHERE inserted_at >= $1");
    await q("DELETE FROM access_groups WHERE inserted_at >= $1");
    await q("DELETE FROM email_templates WHERE inserted_at >= $1");
    await q("DELETE FROM email_logs WHERE email_type = 'template_test' AND inserted_at >= $1");
    await q("DELETE FROM email_assets WHERE uploaded_at >= $1");
    await q("DELETE FROM customer_portal_users WHERE inserted_at >= $1");
    await q(
      "DELETE FROM business_company_files WHERE business_company_id IN (SELECT id FROM business_companies WHERE inserted_at >= $1)",
    );
    await q(
      "DELETE FROM business_company_mailboxes WHERE business_company_id IN (SELECT id FROM business_companies WHERE inserted_at >= $1)",
    );
    await q("DELETE FROM business_companies WHERE inserted_at >= $1");
    await q("DELETE FROM audit_log WHERE at >= $1");
  }
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
async function ok<T = any>(operationId: string, res: Promise<LightMyRequestResponse>, status = 200): Promise<T> {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return (/json/.test(String(r.headers["content-type"])) ? r.json() : r.body) as T;
}
async function fails(operationId: string, res: Promise<LightMyRequestResponse>, status: number) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return r.json();
}
const undo = (change: Change | null) =>
  change ? ok("undoChange", call("POST", `/changes/${change.id}/undo`, {})) : null;
const STRONG = "Long-enough-fake-passphrase-26";

describe("§11 access: group plus per-user overrides (team trial round 2)", () => {
  test("overrides replace the group's actions, No access beats Every page, tabs flip", () => {
    const a = effectiveAccess(
      { "*": ["view"], invoices: ["view", "edit"] },
      ["enterprises.docs", "vendor-trunks.http"],
      { invoices: ["view"], soa: [], "rate-manager": ["view", "edit"] },
      { "enterprises.docs": true, "enterprises.billing": false },
    );
    assert.deepEqual(a.permissions.invoices, ["view"]);
    assert.deepEqual(a.permissions["rate-manager"], ["view", "edit"]);
    assert.deepEqual(a.denied, ["soa"]);
    assert.deepEqual(a.hiddenTabs, ["enterprises.billing", "vendor-trunks.http"]);
  });
  test("tab keys come from the catalogue", () => {
    assert.deepEqual(checkTabs(["enterprises.docs", "customer-trunks.pricing"], "/hiddenTabs"), []);
    assert.equal(checkTabs(["enterprises.nope"], "/hiddenTabs").length, 1);
  });
});

describe("§13.28 password and 2FA helpers", () => {
  test("hashes verify, rules report each condition", () => {
    const h = hashPassword("correct horse battery");
    assert.ok(verifyPassword("correct horse battery", h));
    assert.ok(!verifyPassword("correct horse batterY", h));
    const rules = (p: string) =>
      Object.fromEntries(
        passwordRules(p, { username: "jane.doe", firstName: "Jane", lastName: "Doe" }, [h]).map((r) => [r.key, r.met]),
      );
    assert.deepEqual(rules("short"), { length: false, not_name: true, not_recent: true, not_leaked: true });
    assert.equal(rules("my-name-is-jane-ok").not_name, false);
    assert.equal(rules("correct horse battery").not_recent, false);
    assert.equal(rules("password1234").not_leaked, false);
    assert.ok(Object.values(rules(STRONG)).every(Boolean));
  });
  test("TOTP follows RFC 6238 (SHA-1 test vector) and accepts ±1 step", () => {
    // RFC 6238 appendix B: secret "12345678901234567890", T = 59 s -> 94287082 (8 digits) -> 287082.
    const rfc = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    assert.equal(totpCode(rfc, 59_000), "287082");
    const now = Date.now();
    assert.ok(verifyTotp(DEMO_TOTP_SECRET, totpCode(DEMO_TOTP_SECRET, now - 30_000), now));
    assert.ok(!verifyTotp(DEMO_TOTP_SECRET, totpCode(DEMO_TOTP_SECRET, now - 120_000), now));
    // The step a code belongs to, which the server remembers so the code works once (§13.28).
    assert.equal(totpMatch(DEMO_TOTP_SECRET, totpCode(DEMO_TOTP_SECRET, now - 30_000), now), totpStep(now) - 1);
    assert.equal(totpMatch(DEMO_TOTP_SECRET, totpCode(DEMO_TOTP_SECRET, now + 30_000), now), totpStep(now) + 1);
  });
  test("secrets round-trip and never decrypt when tampered", () => {
    const enc = encryptSecret("fake-secret");
    assert.equal(decryptSecret(enc), "fake-secret");
    assert.equal(decryptSecret(enc.slice(0, -4) + "AAAA"), null);
  });
  test("templates fill samples, escape values and list unknown placeholders", () => {
    const r = fillTemplate("bind_down", "Down {trunk}", "Hi {enterprise} 5 < 6\n{nope}", "Acme <Fake>");
    assert.equal(r.subject, "Down FENPHY-MAIN");
    assert.match(r.bodyHtml, /Hi Fenphy Demo Telecom 5 &lt; 6<br>\{nope\}/);
    assert.deepEqual(r.unknownPlaceholders, ["nope"]);
  });
  test("e-mail HTML: sanitising keeps designs, values cannot break them, Outlook font fallback (§11)", () => {
    const html = sanitizeHtml(
      '<div style="color:red" onmouseover="x()"><a href="javascript:x()">a</a><iframe src="//x"></iframe><!--[if mso]><b>o</b><![endif]--></div>',
    );
    assert.equal(html, '<div style="color:red"><a>a</a><!--[if mso]><b>o</b><![endif]--></div>');
    assert.equal(fillBody("<p>{a}</p>", { a: "<b>&\nx" }), "<p>&lt;b&gt;&amp;<br>x</p>");
    assert.equal(fillBody("Hi {a}", { a: "<b>" }), "Hi <b>", "plain text stays plain");
    assert.equal(outlookFont("'Montserrat', Arial, sans-serif"), "Arial, sans-serif");
    assert.equal(outlookFont("Montserrat"), "'Times New Roman', serif");
    assert.equal(outlookFont("Georgia, serif"), "Georgia, serif");
  });
  test("audit table names come from the path", () => {
    assert.equal(tableOf("/rate-tables/{id}/lines"), "rate_tables");
    assert.equal(tableOf("/me/password"), "users");
    assert.equal(tableOf("/reports/master/export"), null);
  });
});

describe("§11 access group catalogue", () => {
  test("every page of the web registry is in the catalogue and back", () => {
    const src = readFileSync(new URL("../../web/src/nav/registry.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export const PAGES"), src.indexOf("export const HOME"));
    // The help center (§15.1) is open to every user, so it has no access-group entry.
    // A page opened with another page's access ({ ...p(...), access: "x" }, e.g. Voice gateways with SMS to voice)
    // has no entry of its own; the page it borrows from must be in the catalogue.
    const borrowed = new Map(
      [...body.matchAll(/\.\.\.p\(\s*"[a-z]+",\s*"([a-z0-9-]+)"[^}]*?\),\s*access:\s*"([a-z0-9-]+)"/g)].map(
        (m) => [m[1]!, m[2]!] as const,
      ),
    );
    assert.ok(borrowed.has("voice-gateways"));
    const keys = [...body.matchAll(/p\(\s*"[a-z]+",\s*"([a-z0-9-]+)"/g)]
      .map((m) => m[1]!)
      .filter((k) => k !== "help" && !borrowed.has(k));
    assert.ok(keys.length > 50);
    assert.deepEqual([...keys].sort(), MODULES.map((m) => m.key).sort());
    for (const target of borrowed.values()) assert.ok(keys.includes(target), target);
  });
  test("permission checks need View and known actions", () => {
    assert.deepEqual(checkPermissions({ "route-rules": ["view", "edit"], "*": ["view"] }), []);
    assert.equal(checkPermissions({ "route-rules": ["edit"] })[0]!.message, "every other action needs View");
    assert.match(checkPermissions({ broadcast: ["view", "delete"] })[0]!.message, /not an action/);
    assert.equal(checkPermissions({ nowhere: ["view"] })[0]!.message, "unknown page");
  });
});

describe("§11 lists", { skip }, () => {
  test("every admin list answers at full volume, filtered and sorted", async () => {
    for (const [op, url, sort] of [
      ["queryUsers", "/users/query", "passwordDaysLeft"],
      ["queryDepartments", "/departments/query", "userCount"],
      ["queryAccessGroups", "/access-groups/query", "moduleCount"],
      ["queryUserSessions", "/user-sessions/query", "loggedInAt"],
      ["queryAuditLog", "/audit-log/query", "action"],
      ["queryBusinessCompanies", "/business-companies/query", "enterprises"],
      ["queryPortalUsers", "/customer-portal-users/query", "enterprise"],
      ["queryEmailTemplates", "/email-templates/query", "usedBy"],
    ] as const) {
      const t = Date.now();
      const page = await ok(
        op,
        call("POST", url, { limit: 100, sort: [{ field: sort, dir: "desc" }], withTotal: true }),
      );
      assert.ok(page.rows.length > 0, op);
      assert.ok(Date.now() - t < 2000, `${op} took ${Date.now() - t} ms`);
    }
    const expired = await ok(
      "queryUsers",
      call("POST", "/users/query", {
        limit: 50,
        filter: { logic: "and", conditions: [{ field: "passwordState", op: "in", values: ["expired"] }] },
      }),
    );
    assert.ok(expired.rows.every((u: { passwordDaysLeft: number }) => u.passwordDaysLeft < 0));
    const audit = await ok(
      "queryAuditLog",
      call("POST", "/audit-log/query", {
        limit: 20,
        filter: {
          logic: "and",
          conditions: [
            { field: "method", op: "in", values: ["PUT"] },
            { field: "user", op: "like", value: "%a%" },
          ],
        },
      }),
    );
    assert.ok(audit.rows.every((r: { method: string }) => r.method === "PUT"));
    const sessions = await ok("queryUserSessions", call("POST", "/user-sessions/query", { limit: 500 }));
    assert.equal(sessions.rows.filter((s: { current: boolean }) => s.current).length, 1);
  });
});

describe("§11 users, §13.28 passwords", { skip }, () => {
  const form = async (): Promise<UserInput> => {
    const { rows } = await db().query("SELECT id FROM departments WHERE name = 'NOC Support and Technical'");
    return {
      username: `test.user.${run}`,
      firstName: "Testa",
      lastName: "Fakeperson",
      email: `test.${run}@fenphy.example`,
      phone: null,
      departmentId: rows[0].id,
      accessGroupId: 4,
      businessCompanyId: 1,
      managerId: null,
      userType: "wholesale",
      isAccountManager: false,
      isTeamLead: false,
      status: "active",
      allowMultipleLogin: false,
      otpMethod: "off",
      language: "en",
      address1: "1 Fake Street",
      address2: null,
      countryIso: "AE",
      state: null,
      city: null,
      zip: null,
      permissionOverrides: {},
      tabOverrides: {},
    };
  };

  test("create needs a strong temporary password, then edit, undo and safe delete", async () => {
    const b = await form();
    const bad = await fails("createUser", call("POST", "/users", { ...b, password: "short" }), 400);
    assert.ok(bad.errors.some((e: { path: string }) => e.path === "/password"));
    const { record, change } = await ok("createUser", call("POST", "/users", { ...b, password: STRONG }), 201);
    assert.equal(record.passwordState, "temporary");
    assert.ok(record.tempPasswordExpiresAt);
    assert.ok(change);
    const dup = await fails("createUser", call("POST", "/users", { ...b, password: STRONG }), 400);
    assert.match(dup.errors[0].message, /username/);
    const edited = await ok(
      "updateUser",
      call("PUT", `/users/${record.id}`, { ...b, city: "Fake City", isTeamLead: true }),
    );
    assert.equal(edited.record.city, "Fake City");
    await undo(edited.change);
    const back = await ok("getUser", call("GET", `/users/${record.id}`));
    assert.equal(back.city, null);
    assert.equal(back.isTeamLead, false);
    const del = await ok("archiveUser", call("POST", `/users/${record.id}/archive`, {}));
    assert.ok(del.record.archivedAt);
    await ok("restoreUser", call("POST", `/users/${record.id}/restore`));
  });

  test("an account manager of live enterprises cannot be deleted (§13.29)", async () => {
    const { rows } = await db().query(
      "SELECT account_manager_id AS id FROM enterprises WHERE deleted_at IS NULL AND account_manager_id IS NOT NULL LIMIT 1",
    );
    const r = await fails("archiveUser", call("POST", `/users/${rows[0].id}/archive`, {}), 409);
    assert.ok(r.dependencies.blocked);
  });

  test("temporary password (24 h, history checked, sessions end) and forced change", async () => {
    const { record } = await ok(
      "createUser",
      call("POST", "/users", { ...(await form()), username: `temp.${run}`, password: STRONG }),
      201,
    );
    await db().query(
      "INSERT INTO user_sessions (user_kind, user_id, ip, device, os, browser, logged_in_at, last_seen_at) VALUES ('staff', $1, '192.0.2.9', 'desktop', 'Linux', 'Firefox', now(), now())",
      [record.id],
    );
    const mismatch = await fails(
      "setUserPassword",
      call("POST", `/users/${record.id}/password`, { password: STRONG, confirmPassword: "x" }),
      400,
    );
    assert.ok(mismatch.errors.some((e: { path: string }) => e.path === "/confirmPassword"));
    const reused = await fails(
      "setUserPassword",
      call("POST", `/users/${record.id}/password`, { password: STRONG, confirmPassword: STRONG }),
      400,
    );
    assert.ok(reused.errors.some((e: { message: string }) => /last 12/.test(e.message)));
    const fresh = "Another-fake-passphrase-99";
    const set = await ok(
      "setUserPassword",
      call("POST", `/users/${record.id}/password`, { password: fresh, confirmPassword: fresh }),
    );
    assert.equal(set.record.activeSessions, 0);
    assert.equal(set.record.passwordState, "temporary");
    const undone = await call("POST", `/changes/${set.change.id}/undo`, {});
    assert.notEqual(undone.statusCode, 200, "a password change is never undone");
    await db().query("UPDATE users SET temp_password_expires_at = NULL, must_change_password = false WHERE id = $1", [
      record.id,
    ]);
    const forced = await ok("forcePasswordChange", call("POST", "/users/force-password-change", { ids: [record.id] }));
    assert.equal(forced.updated, 1);
    assert.equal((await ok("getUser", call("GET", `/users/${record.id}`))).passwordState, "must_change");
    await undo(forced.change);
    assert.equal((await ok("getUser", call("GET", `/users/${record.id}`))).mustChangePassword, false);
  });

  test("QR 2FA enrolment needs a valid code", async () => {
    const { record } = await ok(
      "createUser",
      call("POST", "/users", { ...(await form()), username: `totp.${run}`, password: STRONG }),
      201,
    );
    const setup = await ok("setupUserTotp", call("POST", `/users/${record.id}/totp/setup`));
    assert.match(setup.otpauthUri, /^otpauth:\/\/totp\//);
    const wrong = totpCode(setup.secret) === "000000" ? "111111" : "000000";
    await fails("confirmUserTotp", call("POST", `/users/${record.id}/totp/confirm`, { code: wrong }), 400);
    const on = await ok(
      "confirmUserTotp",
      call("POST", `/users/${record.id}/totp/confirm`, { code: totpCode(setup.secret) }),
    );
    assert.equal(on.record.totpEnabled, true);
    // §13.28: the confirming code is used up, so it cannot sign in afterwards.
    const stepOf = async () =>
      (await db().query("SELECT totp_last_step FROM users WHERE id = $1", [record.id])).rows[0].totp_last_step;
    assert.ok(Number(await stepOf()) >= totpStep() - 1);
    const off = await ok("disableUserTotp", call("POST", `/users/${record.id}/totp/disable`));
    assert.equal(off.record.totpEnabled, false);
    assert.equal(await stepOf(), null, "a removed secret's last step goes with it");
    // Confirm sent twice at once: enabled once. The other finds the code used, or (when it starts after the first
    // ended) no enrolment left to confirm.
    const again = await ok("setupUserTotp", call("POST", `/users/${record.id}/totp/setup`));
    const code = totpCode(again.secret);
    const answers = await Promise.all([1, 2].map(() => call("POST", `/users/${record.id}/totp/confirm`, { code })));
    assert.deepEqual(answers.map((r) => r.statusCode).sort(), [200, 400], answers.map((r) => r.body).join(" | "));
    const refused = answers.find((r) => r.statusCode === 400)!;
    check("confirmUserTotp", refused);
    assert.ok([TOTP_USED, "start the QR enrolment first"].includes(refused.json().errors[0].message), refused.body);
  });

  test("my own password change checks the current password, 2FA and rules, and ends other sessions", async () => {
    const { rows } = await db().query("SELECT password_hash FROM users WHERE id = 1");
    myHash = rows[0].password_hash;
    await db().query(
      "INSERT INTO user_sessions (user_kind, user_id, ip, device, os, browser, logged_in_at, last_seen_at) VALUES ('staff', 1, '192.0.2.8', 'mobile', 'iOS', 'Safari', now() - interval '2 hours', now())",
    );
    const wrong = await fails(
      "changeMyPassword",
      call("POST", "/me/password", { currentPassword: "nope", newPassword: STRONG, totpCode: null }),
      400,
    );
    assert.deepEqual(wrong.errors.map((e: { path: string }) => e.path).sort(), ["/currentPassword", "/totpCode"]);
    const okRes = await withFreshTotp(1, async (code) => {
      // A refusal for another field does not use the code up (§13.28): it still works once the field is fixed...
      const weak = await fails(
        "changeMyPassword",
        call("POST", "/me/password", { currentPassword: SEED_PASSWORD, newPassword: "short", totpCode: code }),
        400,
      );
      assert.deepEqual(weak.errors.map((e: { path: string }) => e.path), ["/newPassword"]);
      const res = await ok(
        "changeMyPassword",
        call("POST", "/me/password", { currentPassword: SEED_PASSWORD, newPassword: STRONG, totpCode: code }),
      );
      // ...and after the change it is used: the same code cannot change the password again.
      const reused = await fails(
        "changeMyPassword",
        call("POST", "/me/password", {
          currentPassword: STRONG,
          newPassword: "Yet-another-fake-passphrase-31",
          totpCode: code,
        }),
        400,
      );
      assert.deepEqual(reused.errors, [{ path: "/totpCode", message: TOTP_USED }]);
      return res;
    });
    assert.ok(okRes.signedOutSessions >= 1);
    const sessions = await ok("queryUserSessions", call("POST", "/user-sessions/query", { limit: 500 }));
    assert.equal(sessions.rows.filter((s: { current: boolean }) => s.current).length, 1, "this session stays open");
    const check = await ok("checkPassword", call("POST", "/password-check", { password: STRONG, userId: 1 }));
    assert.equal(check.rules.find((r: { key: string }) => r.key === "not_recent").met, false);
  });

  test("ending a session; never one's own", async () => {
    const { rows } = await db().query(
      "INSERT INTO user_sessions (user_kind, user_id, ip, device, os, browser, logged_in_at, last_seen_at) VALUES ('staff', 2, '192.0.2.7', 'desktop', 'Linux', 'Chrome', now(), now()) RETURNING id",
    );
    assert.equal((await ok("endUserSession", call("POST", `/user-sessions/${rows[0].id}/end`))).ended, true);
    const { rows: mine } = await db().query(
      "SELECT max(id) AS id FROM user_sessions WHERE user_id = 1 AND ended_at IS NULL",
    );
    await fails("endUserSession", call("POST", `/user-sessions/${mine[0].id}/end`), 400);
  });

  test("writes reach the audit trail with module, action and master ID", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await db().query("SELECT * FROM audit_log WHERE at >= $1 AND action = 'createUser' LIMIT 1", [
      started,
    ]);
    assert.equal(rows[0]?.module, "admin");
    assert.equal(rows[0]?.status, 201);
    const { rows: upd } = await db().query(
      "SELECT master_id, table_name FROM audit_log WHERE at >= $1 AND action = 'updateUser' LIMIT 1",
      [started],
    );
    assert.equal(upd[0]?.table_name, "users");
    assert.ok(upd[0]?.master_id);
    const { rows: reads } = await db().query(
      "SELECT count(*)::int AS n FROM audit_log WHERE at >= $1 AND action LIKE 'query%'",
      [started],
    );
    assert.equal(reads[0].n, 0);
  });
});

describe("§11 departments, access groups, templates, portal users", { skip }, () => {
  test("departments: unique names, users block delete", async () => {
    const { record, change } = await ok(
      "createDepartment",
      call("POST", "/departments", { name: `Test dept ${run}`, status: "active", managerId: 1, description: null }),
      201,
    );
    assert.equal(record.manager, "Daniel Khoury");
    await fails(
      "createDepartment",
      call("POST", "/departments", { name: "NOC Support and Technical", status: "active", managerId: null, description: null }),
      400,
    );
    const blocked = await fails("archiveDepartment", call("POST", "/departments/3/archive", {}), 409);
    assert.ok(blocked.dependencies.items[0].count > 0);
    await undo(change);
    assert.ok((await ok("getDepartment", call("GET", `/departments/${record.id}`))).archivedAt);
  });

  test("access groups: matrix validated, clone, catalogue", async () => {
    const cat = await ok("getAccessCatalog", call("GET", "/access-groups/catalog"));
    assert.ok(cat.modules.some((m: { key: string }) => m.key === "route-rules"));
    const bad = await fails(
      "createAccessGroup",
      call("POST", "/access-groups", {
        name: `G ${run}`,
        status: "active",
        description: null,
        permissions: { "route-rules": ["edit"] },
      }),
      400,
    );
    assert.equal(bad.errors[0].path, "/permissions/route-rules");
    const { record } = await ok(
      "createAccessGroup",
      call("POST", "/access-groups", {
        name: `G ${run}`,
        status: "active",
        description: null,
        permissions: { "route-rules": ["edit", "view"], broadcast: [] },
      }),
      201,
    );
    assert.deepEqual(record.permissions, { "route-rules": ["view", "edit"] });
    const clone = await ok(
      "cloneAccessGroup",
      call("POST", `/access-groups/${record.id}/clone`, { name: `G2 ${run}` }),
      201,
    );
    assert.deepEqual(clone.record.permissions, record.permissions);
    const upd = await ok(
      "updateAccessGroup",
      call("PUT", `/access-groups/${record.id}`, {
        name: record.name,
        status: record.status,
        description: record.description,
        permissions: { "*": ["view"] },
      }),
    );
    assert.equal(upd.record.fullAccess, true);
    await undo(upd.change);
    assert.equal((await ok("getAccessGroup", call("GET", `/access-groups/${record.id}`))).fullAccess, false);
    await fails("archiveAccessGroup", call("POST", "/access-groups/4/archive", {}), 409);
  });

  test("e-mail templates: placeholders, preview, clone, in-use templates cannot be deleted", async () => {
    const ph = await ok("listEmailPlaceholders", call("GET", "/email-templates/placeholders"));
    assert.equal(ph.types.length, 14);
    const pv = await ok(
      "previewEmailTemplate",
      call("POST", "/email-templates/preview", {
        emailType: "invoice",
        subject: "{invoice_no}",
        body: "<p>{amount} {currency}</p>",
        businessCompanyId: null,
      }),
    );
    assert.equal(pv.subject, "INV-1042");
    const { record } = await ok(
      "createEmailTemplate",
      call("POST", "/email-templates", {
        name: `T ${run}`,
        emailType: "low_balance",
        subject: "Low {balance}",
        body: "Hi",
        businessCompanyId: 1,
      }),
      201,
    );
    assert.equal(record.businessCompany, "Fenphy Messaging Group");
    assert.ok(record.placeholders.some((p: { key: string }) => p.key === "threshold"));
    await ok("cloneEmailTemplate", call("POST", `/email-templates/${record.id}/clone`, { name: `T2 ${run}` }), 201);
    await ok("archiveEmailTemplate", call("POST", `/email-templates/${record.id}/archive`, {}));
    const used = await fails("archiveEmailTemplate", call("POST", "/email-templates/4/archive", {}), 409);
    assert.ok(used.dependencies.blocked);
  });

  test("e-mail designs: images, sanitising, the e-mail as sent, the Outlook view, test sends (§11)", async () => {
    const png = fakeLogoPng([200, 30, 30]);
    const bad = await fails(
      "uploadEmailAsset",
      call("POST", "/email-assets", {
        name: "x.svg",
        contentBase64: Buffer.from("<svg/>").toString("base64"),
        businessCompanyId: null,
      }),
      400,
    );
    assert.match(bad.errors[0].message, /PNG, JPEG or GIF/);
    const asset = await ok(
      "uploadEmailAsset",
      call("POST", "/email-assets", {
        name: `banner ${run}.png`,
        contentBase64: png.toString("base64"),
        businessCompanyId: 2,
      }),
      201,
    );
    assert.deepEqual([asset.width, asset.height, asset.contentType], [160, 48, "image/png"]);
    const file = await call("GET", asset.url.replace(API_PREFIX, ""));
    assert.equal(file.headers["content-type"], "image/png");
    assert.equal(file.rawPayload.length, png.length);
    const list = await ok("listEmailAssets", call("GET", "/email-assets?businessCompanyId=2"));
    assert.ok(list.items.some((x: { id: number }) => x.id === asset.id));
    const other = await ok("listEmailAssets", call("GET", "/email-assets?businessCompanyId=1"));
    assert.ok(!other.items.some((x: { id: number }) => x.id === asset.id), "another company's images stay out");

    const design = `<style>.btn{background:#2563eb;color:#ffffff;border-radius:6px;padding:10px 18px}</style>
      <table width="600" style="font-family:'Montserrat',Arial,sans-serif;background:#f3f4f6">
        <tr><td>{company_logo}<img src="${asset.url}" style="width:160px"></td></tr>
        <tr><td style="padding:16px"><p onclick="steal()">Dear {enterprise},</p>
          <a class="btn" href="javascript:steal()">Pay {due_amount} {currency}</a><p>{bank_details}</p></td></tr>
      </table><script>steal()</script>`;
    const p = await ok(
      "previewEmailTemplate",
      call("POST", "/email-templates/preview", {
        emailType: "invoice",
        subject: "Invoice {invoice_no}",
        body: design,
        businessCompanyId: 2,
      }),
    );
    assert.ok(!/<script|onclick|javascript:/i.test(p.emailHtml), "scripts, handlers and javascript: links are removed");
    assert.match(
      p.emailHtml,
      /class="btn" style="background: #2563eb; color: #ffffff; border-radius: 6px/,
      "CSS inlined",
    );
    assert.match(
      p.emailHtml,
      /business-companies\/2\/files\/logo" alt="[^"]+" width="160" height="48"/,
      "the company's logo",
    );
    assert.match(p.emailHtml, /IBAN: [A-Z0-9]+<br>/, "multi-line values keep their lines");
    assert.match(p.emailHtml, /<!--\[if mso\]>.*font-family: Arial/s, "Outlook gets the fallback font");
    assert.ok(!/border-radius/.test(p.outlookHtml), "square corners in classic Outlook");
    assert.match(p.outlookHtml, /font-family: Arial, sans-serif/);
    const features = p.issues.map((i: { feature: string }) => i.feature);
    for (const f of ["web_font", "border_radius"]) assert.ok(features.includes(f), f);
    assert.ok(!features.includes("external_image"), "uploaded images are embedded, not external");

    const saved = await ok(
      "createEmailTemplate",
      call("POST", "/email-templates", {
        name: `Design ${run}`,
        emailType: "invoice",
        subject: "Invoice {invoice_no}",
        body: design,
        businessCompanyId: 2,
      }),
      201,
    );
    assert.ok(!/<script|onclick/i.test(saved.record.body), "saved sanitised");
    assert.match(saved.record.body, /<style>/, "the design is kept");

    const sent = await ok(
      "testEmailTemplate",
      call("POST", "/email-templates/test", {
        emailType: "invoice",
        subject: "Invoice {invoice_no}",
        body: design,
        businessCompanyId: 2,
        to: ["qa@demo.example"],
      }),
    );
    assert.equal(sent.status, "sent");
    assert.equal(sent.inlineImages, 2, "logo and banner go inline");
    assert.match(sent.sender, /^billing@/);
    const log = await ok("getEmailLog", call("GET", `/email-logs/${sent.emailLogId}`));
    assert.equal(log.emailType, "template_test");
    assert.match(log.subject, /^\[Test\] Invoice /);
    assert.match(log.bodyHtml, /<!DOCTYPE html>/);
    assert.deepEqual(log.inlineImages.sort(), [`image-${asset.id}`, "logo-2"]);
    const cid = embedImages(log.bodyHtml);
    assert.ok(cid.html.includes(`cid:asset-${asset.id}@sms.local`));
  });

  test("portal users: customers only, temporary password", async () => {
    const pick = async (type: string) =>
      (await db().query("SELECT id FROM enterprises WHERE deleted_at IS NULL AND type = $1 LIMIT 1", [type])).rows[0]
        .id;
    const cust = await pick("customer");
    const vend = await pick("vendor");
    const base = {
      email: `portal.${run}@client.example`,
      username: `portal.${run}`,
      firstName: "Por",
      lastName: "Tal",
      status: "active",
    };
    await fails(
      "createPortalUser",
      call("POST", "/customer-portal-users", { ...base, enterpriseId: vend, password: STRONG }),
      400,
    );
    const { record } = await ok(
      "createPortalUser",
      call("POST", "/customer-portal-users", { ...base, enterpriseId: cust, password: STRONG }),
      201,
    );
    assert.equal(record.mustChangePassword, true);
    const fresh = "Client-fake-phrase-42x";
    const set = await ok(
      "setPortalUserPassword",
      call("POST", `/customer-portal-users/${record.id}/password`, { password: fresh, confirmPassword: fresh }),
    );
    assert.ok(set.record.tempPasswordExpiresAt);
    await ok("archivePortalUser", call("POST", `/customer-portal-users/${record.id}/archive`, {}));
  });
});

describe("§11 business companies", { skip }, () => {
  test("form round-trip: secrets write-only, mailboxes, undo, files, SMTP check, clone, delete blockers", async () => {
    const src: BusinessCompanyRecord = await ok("getBusinessCompany", call("GET", "/business-companies/1"));
    assert.ok(src.mailboxes.every((m) => m.hasClientSecret && m.hasSmtpPassword));
    assert.ok(!JSON.stringify(src).includes("fake-oauth"), "secrets are never returned");
    const input = (r: BusinessCompanyRecord, over: Partial<BusinessCompanyInput> = {}): BusinessCompanyInput => ({
      name: r.name,
      description: r.description,
      baseCurrency: r.baseCurrency,
      tpsLimit: r.tpsLimit,
      website: r.website,
      smppHost: r.smppHost,
      smppPort: r.smppPort,
      invoiceNumberStart: r.invoiceNumberStart,
      companyIp: r.companyIp,
      customerRateFileName: r.customerRateFileName,
      soaFileName: r.soaFileName,
      invoiceFileName: r.invoiceFileName,
      address: r.address,
      bank: r.bank,
      defaultTemplates: r.defaultTemplates,
      senders: r.senders,
      mailboxes: r.mailboxes.map(
        ({
          hasSmtpPassword: _a,
          hasClientSecret: _b,
          lastCheckAt: _c,
          lastCheckOk: _d,
          imapLastReadAt: _e,
          imapLastError: _f,
          ...m
        }) => ({
          ...m,
          smtpPassword: null,
          clientSecret: null,
        }),
      ),
      ...over,
    });
    const { record: copy } = await ok(
      "cloneBusinessCompany",
      call("POST", "/business-companies/1/clone", { name: `Clone ${run}` }),
      201,
    );
    assert.equal(copy.mailboxes.length, src.mailboxes.length);
    assert.ok(
      copy.mailboxes.every((m: { hasClientSecret: boolean }) => !m.hasClientSecret),
      "secrets are not cloned",
    );
    assert.equal(copy.files.length, src.files.length);
    const missing = await fails(
      "updateBusinessCompany",
      call("PUT", `/business-companies/${copy.id}`, input(copy)),
      400,
    );
    assert.ok(missing.errors.some((e: { path: string }) => /clientSecret/.test(e.path)));
    const withSecrets = input(copy);
    withSecrets.mailboxes = withSecrets.mailboxes.map((m) => ({ ...m, clientSecret: "fake-new-secret" }));
    withSecrets.bank = { ...withSecrets.bank, iban: "XX00FAKE000" };
    withSecrets.defaultTemplates = { ...withSecrets.defaultTemplates, lowBalance: 10 };
    // Senders (§11): tech info from the Support mailbox instead of NOC.
    assert.equal(copy.senders.techInfo, "noc");
    withSecrets.senders = { ...withSecrets.senders, techInfo: "support" };
    const saved = await ok("updateBusinessCompany", call("PUT", `/business-companies/${copy.id}`, withSecrets));
    assert.equal(saved.record.bank.iban, "XX00FAKE000");
    assert.equal(saved.record.senders.techInfo, "support");
    const support = saved.record.mailboxes.find((m: { department: string }) => m.department === "support")?.smtpEmail;
    assert.equal(await senderFor(db(), { companyId: copy.id }, "techInfo"), support);
    const billing = saved.record.mailboxes.find((m: { department: string }) => m.department === "billing")?.smtpEmail;
    assert.equal(await senderFor(db(), { companyId: copy.id }, "invoice"), billing);
    // Templates (§11): the company's chosen default wins, then its own template of the type, then a shared one.
    const firstCompany = await companyTemplate(db(), { companyId: 1 }, "low_balance");
    const { rows: own } = await db().query(
      `INSERT INTO email_templates (business_company_id, name, email_type, subject, body)
       VALUES ($1, $2, 'low_balance', 'Low balance – {company}', 'Pay to {bank_iban}') RETURNING id`,
      [copy.id, `Own low balance ${run}`],
    );
    const ownId = Number(own[0].id);
    assert.equal(
      (await companyTemplate(db(), { companyId: copy.id }, "low_balance"))?.id,
      saved.record.defaultTemplates.lowBalance,
    );
    await db().query(
      "UPDATE business_companies SET default_templates = default_templates - 'lowBalance' WHERE id = $1",
      [copy.id],
    );
    assert.equal((await companyTemplate(db(), { companyId: copy.id }, "low_balance"))?.id, ownId);
    assert.equal(
      (await companyTemplate(db(), { companyId: 1 }, "low_balance"))?.id,
      firstCompany?.id,
      "other companies keep theirs",
    );
    const placeholders = companyPlaceholders(await companyDetails(db(), { companyId: copy.id }));
    assert.equal(placeholders.bank_iban, "XX00FAKE000");
    assert.match(placeholders.bank_details!, /IBAN: XX00FAKE000/);
    assert.ok(saved.record.mailboxes.every((m: { hasClientSecret: boolean }) => m.hasClientSecret));
    const { rows: enc } = await db().query(
      "SELECT client_secret_enc FROM business_company_mailboxes WHERE business_company_id = $1 LIMIT 1",
      [copy.id],
    );
    assert.equal(decryptSecret(enc[0].client_secret_enc), "fake-new-secret");
    await undo(saved.change);
    const reverted = await ok("getBusinessCompany", call("GET", `/business-companies/${copy.id}`));
    assert.equal(reverted.bank.iban, src.bank.iban);
    assert.ok(
      reverted.mailboxes.every((m: { hasClientSecret: boolean }) => m.hasClientSecret),
      "undo keeps stored secrets",
    );
    const wrongType = await fails(
      "updateBusinessCompany",
      call("PUT", `/business-companies/${copy.id}`, {
        ...withSecrets,
        defaultTemplates: { ...withSecrets.defaultTemplates, invoice: 1 },
      }),
      400,
    );
    assert.match(wrongType.errors[0].message, /another type/);
    // File names (team trial round 12): known variables save, an unknown one is refused with its name.
    const named = await ok(
      "updateBusinessCompany",
      call("PUT", `/business-companies/${copy.id}`, {
        ...withSecrets,
        customerRateFileName: "{EnterpriseName}{ProductCategoryName}{Currency}{Username}{Date and Time}{Trunk}{Company}",
        soaFileName: "SOA_[EnterpriseName]_[BeneficiaryAddress]_[FromDate]_[ToDate]",
        invoiceFileName: "[InvoiceRefNumber]_[CompanyRegisteredName]_[PARAM1001]",
      }),
    );
    assert.equal(named.record.invoiceFileName, "[InvoiceRefNumber]_[CompanyRegisteredName]_[PARAM1001]");
    const badName = await fails(
      "updateBusinessCompany",
      call("PUT", `/business-companies/${copy.id}`, { ...withSecrets, soaFileName: "SOA_[InvoiceRefNumber]" }),
      400,
    );
    assert.equal(badName.errors[0].path, "/soaFileName");
    assert.match(badName.errors[0].message, /\[InvoiceRefNumber\]/);
    const formatVars = await ok("listFormatVariables", call("GET", "/business-companies/format-variables"));
    const keys = (kind: string) =>
      formatVars.formats.find((f: { kind: string }) => f.kind === kind).variables.map((v: { key: string }) => v.key);
    for (const k of ["[EnterpriseName]", "[ProductCategoryName]", "[Currency]", "[Timezone]"])
      assert.ok(keys("customer_rate_format").includes(k), `rate format has ${k}`);
    for (const k of ["[BeneficiaryAddress]", "[FromDate]", "[ToDate]"]) assert.ok(keys("soa_format").includes(k));
    for (const k of ["[InvoiceRefNumber]", "[PARAM1001]", "[FaxNumber]", "[SIDTitle]"])
      assert.ok(keys("invoice_format").includes(k));
    for (const k of ["[EnterpriseName]", "[ProductCategoryName]", "[Currency]", "[Username]", "[DateTime]", "[Trunk]"])
      assert.ok(keys("customer_rate_file_name").includes(k), `rate file name has ${k}`);

    await fails(
      "uploadCompanyFile",
      call("PUT", `/business-companies/${copy.id}/files/logo`, {
        name: "logo.png",
        contentBase64: Buffer.from("not a png").toString("base64"),
      }),
      400,
    );
    const png = Buffer.from("89504e470d0a1a0a0000", "hex");
    const up = await ok(
      "uploadCompanyFile",
      call("PUT", `/business-companies/${copy.id}/files/logo`, {
        name: "new-logo.png",
        contentBase64: png.toString("base64"),
      }),
    );
    assert.equal(up.record.files.find((f: { kind: string }) => f.kind === "logo").name, "new-logo.png");
    const dl = await call("GET", `/business-companies/${copy.id}/files/logo`);
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.headers["content-type"], "image/png");

    const mb = withSecrets.mailboxes[0]!;
    const smtp = await ok(
      "checkSmtp",
      call("POST", "/business-companies/check-smtp", { businessCompanyId: 1, mailbox: { ...mb, smtpPassword: null } }),
    );
    assert.equal(smtp.ok, true);
    const badPort = await ok(
      "checkSmtp",
      call("POST", "/business-companies/check-smtp", {
        businessCompanyId: null,
        mailbox: { ...mb, smtpPort: 80, smtpPassword: "x" },
      }),
    );
    assert.equal(badPort.ok, false);
    assert.equal(badPort.steps[2].detail, "skipped");

    const vars = await ok("listFormatVariables", call("GET", "/business-companies/format-variables"));
    assert.ok(vars.formats.length >= 3);
    const mbx = await ok("listCompanyMailboxes", call("GET", "/business-companies/1/mailboxes"));
    assert.equal(mbx.mailboxes.length, 5);

    await fails("archiveBusinessCompany", call("POST", "/business-companies/1/archive", {}), 409);
    await ok("archiveBusinessCompany", call("POST", `/business-companies/${copy.id}/archive`, {}));
  });
});
