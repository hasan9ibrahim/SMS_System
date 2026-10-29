// Administrator access groups (§11, team trial round 10): users given the "Administrator" group did not see the Admin
// pages, as only users.is_admin counted. A group marked administrator now makes its users full administrators, and
// only an administrator may give such a group, mark a group administrator, or change an administrator. Calls are made
// as forwarded by the Elixir API (X-Sms-User). Runs against the seeded database; the test's rows are removed.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { AccessGroupInput, UserInput } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";

process.env.MOCK_PROXY_SECRET = "test-proxy-secret";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const started = new Date();
const run = Date.now().toString(36).slice(-5);
const made: { groups: number[]; users: number[] } = { groups: [], users: [] };

after(async () => {
  if (ready) {
    await db().query("DELETE FROM audit_log WHERE user_id = ANY($1)", [made.users]);
    await db().query("DELETE FROM changes WHERE user_id = ANY($1)", [made.users]);
    await db().query("DELETE FROM password_history WHERE user_id = ANY($1)", [made.users]);
    // The groups name their editor and the users their group: unlink, then remove both.
    await db().query("UPDATE users SET access_group_id = NULL WHERE id = ANY($1) OR inserted_at >= $2", [made.users, started]);
    await db().query("DELETE FROM access_groups WHERE id = ANY($1) OR inserted_at >= $2", [made.groups, started]);
    await db().query("DELETE FROM users WHERE id = ANY($1) OR inserted_at >= $2", [made.users, started]);
  }
  await app.close();
  await closeDb();
});

async function group(name: string, permissions: Record<string, string[]>, admin: boolean): Promise<number> {
  const g = await db().query("INSERT INTO access_groups (name, permissions, is_admin) VALUES ($1, $2, $3) RETURNING id", [
    `${name} ${run}`,
    permissions,
    admin,
  ]);
  made.groups.push(Number(g.rows[0].id));
  return Number(g.rows[0].id);
}

async function user(tag: string, groupId: number): Promise<number> {
  const u = await db().query(
    `INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, access_group_id,
                        department_id, address1)
     VALUES ($1, 'Test', 'Admins', $2, 'x', now(), $3, (SELECT min(id) FROM departments), 'Test street 1') RETURNING id`,
    [`test.${tag}.${run}`, `test.${tag}.${run}@example.test`, groupId],
  );
  made.users.push(Number(u.rows[0].id));
  return Number(u.rows[0].id);
}

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

async function as(who: number, operationId: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) {
  const res = await app.inject({
    method,
    url: `${API_PREFIX}${url}`,
    headers: { "x-sms-proxy-secret": "test-proxy-secret", "x-sms-user": String(who) },
    ...(payload ? { payload } : {}),
  });
  check(operationId, res);
  return res;
}

const userForm = (tag: string, accessGroupId: number, departmentId: number): UserInput & { password: string } => ({
  username: `test.form.${tag.toLowerCase()}.${run}`,
  firstName: "Testa",
  lastName: "Fakeperson",
  email: `test.form.${tag.toLowerCase()}.${run}@example.test`,
  phone: null,
  departmentId,
  accessGroupId,
  businessCompanyId: null,
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
  password: "Fake-Temp-Passw0rd-2026!",
});

describe("administrator access groups (team trial round 10)", { skip }, () => {
  test("the Administrator group from the migration is an administrator group", async () => {
    const { rows } = await db().query("SELECT is_admin FROM access_groups WHERE name = 'Administrator'");
    if (rows[0]) assert.equal(rows[0].is_admin, true);
  });

  test("a user of an administrator group is an administrator; every-page grants still stop at the Admin pages", async () => {
    const admins = await group("test admins", { "*": ["view"] }, true);
    const everyPage = await group("test every page", { "*": ["view", "add", "edit"] }, false);
    const admin = await user("groupadmin", admins);
    const plain = await user("everypage", everyPage);
    const me = (await as(admin, "getCurrentUser", "GET", "/me")).json();
    assert.deepEqual(me.permissions, ["*"]);
    const other = (await as(plain, "getCurrentUser", "GET", "/me")).json();
    assert.ok(!other.permissions.includes("*"));
    assert.ok(other.permissions.includes("view"));
    const row = (await as(1, "getAccessGroup", "GET", `/access-groups/${admins}`)).json();
    assert.equal(row.administrator, true);
  });

  test("only an administrator gives administrator access or changes an administrator", async () => {
    const admins = await group("test admins 2", { "*": ["view"] }, true);
    const managers = await group("test user managers", { users: ["view", "add", "edit"], "access-groups": ["view", "add", "edit"] }, false);
    const admin = await user("admin2", admins);
    const manager = await user("manager", managers);
    const dept = Number((await db().query("SELECT min(id) AS id FROM departments WHERE deleted_at IS NULL")).rows[0].id);

    // A user manager who is not an administrator cannot make one...
    const refused = await as(manager, "createUser", "POST", "/users", userForm("byManager", admins, dept));
    assert.equal(refused.statusCode, 400, refused.body);
    assert.ok(refused.json().errors.some((e: { path: string }) => e.path === "/accessGroupId"), refused.body);
    // ...nor change, or reset the password of, an administrator.
    const { rows } = await db().query("SELECT username, email FROM users WHERE id = $1", [admin]);
    const edit = { ...userForm("x", admins, dept), username: rows[0].username, email: rows[0].email };
    assert.equal((await as(manager, "updateUser", "PUT", `/users/${admin}`, edit)).statusCode, 403);
    const pw = { password: "Fake-Temp-Passw0rd-2026!", confirmPassword: "Fake-Temp-Passw0rd-2026!" };
    assert.equal((await as(manager, "setUserPassword", "POST", `/users/${admin}/password`, pw)).statusCode, 403);
    // ...nor mark a group administrator, or change an administrator group.
    const g: AccessGroupInput = { name: `test made admin ${run}`, status: "active", description: null, permissions: { dashboard: ["view"] }, hiddenTabs: [], administrator: true };
    const mark = await as(manager, "createAccessGroup", "POST", "/access-groups", g);
    assert.equal(mark.statusCode, 400);
    assert.ok(mark.json().errors.some((e: { path: string }) => e.path === "/administrator"));
    const change = { name: `test admins 2 ${run}`, status: "active", description: "changed", permissions: { "*": ["view"] }, hiddenTabs: [], administrator: true };
    assert.equal((await as(manager, "updateAccessGroup", "PUT", `/access-groups/${admins}`, change)).statusCode, 403);

    // An administrator (of a group, too) can do all of it.
    const ok = await as(admin, "createUser", "POST", "/users", userForm("byAdmin", admins, dept));
    assert.equal(ok.statusCode, 201, ok.body);
    made.users.push(ok.json().record.id);
    const okGroup = await as(admin, "createAccessGroup", "POST", "/access-groups", g);
    assert.equal(okGroup.statusCode, 201, okGroup.body);
    assert.equal(okGroup.json().record.administrator, true);
    made.groups.push(okGroup.json().record.id);
  });
});
