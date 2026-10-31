// Team report (build step 5.18, §13.18): scope by role (admin, department manager, account manager),
// business results and targets, work and activity sections, member detail and timeline, CSV export,
// targets, online users and page views, the scheduled Team summary, and visibility (§13.17) on money.
// Every response is checked against the contract. Needs the seeded database and the EDR store.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { clearVisibilityCache, PRESETS } from "../src/visibility/policy.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
  clearVisibilityCache();
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
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, as: number | null = null) =>
  app.inject({
    method,
    url: `${API_PREFIX}${url}`,
    ...(as ? { headers: { "x-view-as": String(as) } } : {}),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return status === 204 ? null : /json/.test(String(r.headers["content-type"])) ? r.json() : r.body;
}
const Q = { period: "last_7_days", compare: true };

describe("Team report (§13.18)", { skip }, () => {
  let am = 0; // an account manager with traffic, not a team lead or manager
  let manager = 0; // a department manager (not an administrator)
  let department = 0;
  before(async () => {
    const { rows } = await db().query(
      `SELECT u.id FROM users u WHERE u.is_account_manager AND NOT u.is_admin AND NOT u.is_team_lead AND u.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.manager_id = u.id)
          AND EXISTS (SELECT 1 FROM enterprises e WHERE e.account_manager_id = u.id) ORDER BY u.id LIMIT 1`,
    );
    am = Number(rows[0].id);
    const { rows: m } = await db().query(
      `SELECT d.manager_id, d.id FROM departments d JOIN users u ON u.id = d.manager_id AND NOT u.is_admin
        WHERE d.deleted_at IS NULL ORDER BY d.id LIMIT 1`,
    );
    manager = Number(m[0].manager_id);
    department = Number(m[0].id);
  });

  test("everyone for an administrator, with sections, totals and the previous period", async () => {
    const r = await ok("runTeamReport", call("POST", "/reports/team", Q));
    assert.equal(r.scope, "all");
    assert.ok(r.previous);
    assert.ok(r.rows.length > 50);
    assert.equal(r.hourly.length, 24);
    const ams = r.rows.filter((x: { business: unknown }) => x.business);
    assert.ok(ams.length > 5);
    const msgs = ams.reduce((a: number, x: { business: { messages: number } }) => a + x.business.messages, 0);
    assert.equal(r.totals.messages, msgs);
    assert.ok(msgs > 0, "account managers' clients sent traffic");
    assert.ok(r.rows.some((x: { activity: { daysActive: number } }) => x.activity.daysActive > 0));
    // Acknowledged alerts in a window that holds the newest one: the seeded incidents stop at seed time.
    const { rows: last } = await db().query("SELECT max(acknowledged_at) AS at FROM incidents");
    const to = new Date(new Date(last[0].at).getTime() + 1000).toISOString();
    const noc = await ok(
      "runTeamReport",
      call("POST", "/reports/team", {
        period: "custom",
        from: new Date(Date.parse(to) - 7 * 86_400_000).toISOString(),
        to,
      }),
    );
    assert.ok(noc.rows.some((x: { noc: { alertsAcknowledged: number } }) => x.noc.alertsAcknowledged > 0));
    assert.ok(r.rows.some((x: { rates: { routeRulesChanged: number } }) => x.rates.routeRulesChanged > 0));
    const filtered = await ok("runTeamReport", call("POST", "/reports/team", { ...Q, role: "account_manager" }));
    assert.ok(filtered.rows.every((x: { roles: string[] }) => x.roles.includes("account_manager")));
    const bad = await call("POST", "/reports/team", { period: "custom", compare: false });
    assert.equal(bad.statusCode, 400);
    const csv = await ok("exportTeamReport", call("POST", "/reports/team/export", Q));
    assert.match(String(csv).split("\r\n")[0]!, /^Member,Department,Roles,Active clients/);
  });

  test("a year of the whole team answers in well under the statement timeout (QA 2026-10-31)", async () => {
    // Per-member subqueries took 5 to 11 s and once timed out; one grouped pass per table takes a few hundred ms.
    const to = new Date().toISOString();
    const from = new Date(Date.parse(to) - 365 * 86_400_000).toISOString();
    const t = Date.now();
    const r = await ok("runTeamReport", call("POST", "/reports/team", { period: "custom", from, to, compare: true }));
    const ms = Date.now() - t;
    assert.ok(r.rows.length > 50);
    assert.ok(ms < 5000, `${ms} ms`);
  });

  test("a department manager sees their department, an account manager themselves", async () => {
    const d = await ok("runTeamReport", call("POST", "/reports/team", Q, manager));
    assert.equal(d.scope, "department");
    const { rows } = await db().query(
      `SELECT u.id FROM users u JOIN departments d ON d.id = u.department_id
        WHERE d.manager_id = $1 AND u.deleted_at IS NULL`,
      [manager],
    );
    const ids = new Set(rows.map((x) => Number(x.id)));
    assert.ok(d.rows.every((x: { id: number }) => ids.has(x.id) || x.id === manager));
    const me = await ok("runTeamReport", call("POST", "/reports/team", Q, am));
    assert.equal(me.scope, "self");
    assert.deepEqual(
      me.rows.map((x: { id: number }) => x.id),
      [am],
    );
    const other = await call("POST", `/reports/team/users/${manager}`, Q, am);
    assert.equal(other.statusCode, 403);
    check("getTeamMember", other);
  });

  test("member detail, timeline and targets", async () => {
    const m = await ok("getTeamMember", call("POST", `/reports/team/users/${am}`, Q));
    assert.equal(m.row.id, am);
    assert.equal(m.hourly.length, 24);
    assert.ok(m.trend.length > 0, "daily results of their clients");
    const tl = await ok(
      "queryTeamTimeline",
      call("POST", "/team-timeline/query", {
        filter: { logic: "and", conditions: [{ field: "userId", op: "eq", value: am }] },
        limit: 20,
      }),
    );
    assert.ok(tl.total > 0);
    assert.ok(tl.rows.every((x: { userId: number }) => x.userId === am));
    const logins = await ok(
      "queryTeamTimeline",
      call("POST", "/team-timeline/query", {
        filter: {
          logic: "and",
          conditions: [
            { field: "userId", op: "eq", value: am },
            { field: "kind", op: "in", values: ["login"] },
          ],
        },
        limit: 5,
      }),
    );
    assert.ok(logins.rows.every((x: { kind: string }) => x.kind === "login"));
    assert.equal((await call("POST", "/team-timeline/query", { limit: 5 })).statusCode, 400);

    // Targets: the month's target is prorated to the period and drives % achieved.
    const month = new Date().toISOString().slice(0, 7);
    const before = (await ok("getTeamTargets", call("GET", `/team-targets?month=${month}`))) as {
      userId: number;
      revenueTarget: number | null;
      marginTarget: number | null;
    }[];
    const mine = before.find((t) => t.userId === am)!;
    cleanup.push(() =>
      call("PUT", "/team-targets", {
        month,
        items: [{ userId: am, revenueTarget: mine.revenueTarget, marginTarget: mine.marginTarget }],
      }),
    );
    const saved = await ok(
      "updateTeamTargets",
      call("PUT", "/team-targets", { month, items: [{ userId: am, revenueTarget: 1_000_000, marginTarget: 300_000 }] }),
    );
    assert.equal(saved.find((t: { userId: number }) => t.userId === am).revenueTarget, 1_000_000);
    const r = await ok("runTeamReport", call("POST", "/reports/team", { ...Q, userId: am }));
    assert.ok(r.rows[0].business.revenueTarget > 0);
    assert.ok(r.rows[0].business.achievedPct !== null && r.rows[0].business.achievedPct < 100);
    const denied = await call("PUT", "/team-targets", { month, items: [] }, am);
    assert.equal(denied.statusCode, 403);
  });

  test("online users and page views", async () => {
    await ok("recordPageView", call("POST", "/me/page-views", { path: "/reports/team" }), 204);
    const o = await ok("getOnlineUsers", call("GET", "/online-users"));
    assert.equal(o.scope, "all");
    assert.equal(o.total, o.users.length);
    assert.equal(o.active, o.users.filter((u: { active: boolean }) => u.active).length);
    const { rows } = await db().query("SELECT path FROM page_views WHERE user_id = 1 ORDER BY at DESC LIMIT 1");
    assert.equal(rows[0].path, "/reports/team");
    // Home's most used and recent (team trial round 1): last opened first, with counts and record names.
    const mine = await ok("getMyPages", call("GET", "/me/pages"));
    assert.equal(mine.pages[0].path, "/reports/team");
    assert.ok(mine.pages[0].views >= 1);
    assert.ok(mine.pages.length <= 50);
    const { rows: ent } = await db().query(
      "SELECT id, name FROM enterprises WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    await ok("recordPageView", call("POST", "/me/page-views", { path: `/enterprises/${ent[0].id}` }), 204);
    const again = await ok("getMyPages", call("GET", "/me/pages"));
    assert.equal(again.pages[0].path, `/enterprises/${ent[0].id}`);
    assert.equal(again.pages[0].title, ent[0].name);
  });

  test("visibility hides money the viewer's policy hides (§13.17)", async () => {
    const strict = PRESETS.find((p) => p.key === "strict_am")!.fields;
    const p = await ok(
      "createVisibilityPolicy",
      call("POST", "/visibility-policies", { ...strict, name: `Test team strict ${Date.now()}` }),
      201,
    );
    const a = await ok(
      "assignVisibilityPolicy",
      call("POST", "/visibility-assignments", { policyId: p.record.id, targetType: "user", targetId: am }),
      201,
    );
    cleanup.push(() => call("POST", `/visibility-policies/${p.record.id}/archive`, {}));
    cleanup.push(() => app.inject({ method: "DELETE", url: `${API_PREFIX}/visibility-assignments/${a.id}` }));
    const r = await ok("runTeamReport", call("POST", "/reports/team", Q, am));
    assert.equal(r.rows[0].business.revenue, null);
    assert.equal(r.rows[0].business.margin, null);
    assert.ok(r.masked.some((m: { field: string; text: string }) => m.field === "revenue" && m.text === "Hidden"));
    assert.equal(r.totals.revenue, null);
  });

  test("the Team report as a scheduled e-mail", async () => {
    const { rows: bc } = await db().query("SELECT id FROM business_companies ORDER BY id LIMIT 1");
    const body = {
      name: `Test weekly team ${Date.now()}`,
      description: null,
      templateKind: "team",
      presetKey: null,
      viewId: null,
      teamDepartmentId: department,
      teamPeriod: "last_week",
      status: "active",
      businessCompanyId: Number(bc[0].id),
      notificationEmails: ["manager@example.com"],
      cronInterval: "weekly",
      cronFrequency: 1,
      cronExpression: "0 7 * * 1",
      fileType: "csv",
      emailBody: "Weekly team summary {{from}} to {{to}}",
    };
    const bad = await call("POST", "/scheduled-reports", { ...body, teamPeriod: null });
    assert.equal(bad.statusCode, 400);
    const created = await ok("createScheduledReport", call("POST", "/scheduled-reports", body), 201);
    const id = created.record?.id ?? created.id;
    cleanup.push(() => call("POST", `/scheduled-reports/${id}/archive`, {}));
    const run = await ok("runScheduledReport", call("POST", `/scheduled-reports/${id}/run`));
    assert.equal(run.lastStatus, "sent", run.lastError ?? "");
    assert.match(run.template, /^Team report/);
  });
});
