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
import { MODULES, checkPermissions } from "../src/admin/catalog.js";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  passwordRules,
  totpCode,
  verifyPassword,
  verifyTotp,
} from "../src/admin/passwords.js";
import { DEMO_TOTP_SECRET, SEED_PASSWORD } from "../src/generator/admin.js";
import { fillTemplate } from "../src/api/admin.js";
import { tableOf } from "../src/api/audit.js";

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
    const keys = [...body.matchAll(/p\(\s*"[a-z]+",\s*"([a-z0-9-]+)"/g)].map((m) => m[1]!);
    assert.ok(keys.length > 50);
    assert.deepEqual([...keys].sort(), MODULES.map((m) => m.key).sort());
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
    const { rows } = await db().query("SELECT id FROM departments WHERE name = 'NOC'");
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
    const off = await ok("disableUserTotp", call("POST", `/users/${record.id}/totp/disable`));
    assert.equal(off.record.totpEnabled, false);
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
    const okRes = await ok(
      "changeMyPassword",
      call("POST", "/me/password", {
        currentPassword: SEED_PASSWORD,
        newPassword: STRONG,
        totpCode: totpCode(DEMO_TOTP_SECRET),
      }),
    );
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
      call("POST", "/departments", { name: "NOC", status: "active", managerId: null, description: null }),
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
    assert.equal(ph.types.length, 13);
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
      address: r.address,
      bank: r.bank,
      defaultTemplates: r.defaultTemplates,
      mailboxes: r.mailboxes.map(
        ({ hasSmtpPassword: _a, hasClientSecret: _b, lastCheckAt: _c, lastCheckOk: _d, ...m }) => ({
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
    const saved = await ok("updateBusinessCompany", call("PUT", `/business-companies/${copy.id}`, withSecrets));
    assert.equal(saved.record.bank.iban, "XX00FAKE000");
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
