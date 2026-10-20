// Reports (build step 5.10, §10, §13.15): periods, CRON, the Master Report engine (grouping, filters
// before and after grouping, compare, totals, export), presets, Sales / NOC insights, the Billing
// report list, scheduled reports and daily traffic alerts, against the seeded database and EDR
// store. Responses are checked against the contract; rows the tests add are removed.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change, MasterReportPage, MasterReportQuery } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { chRows } from "../src/edr.js";
import { cronFor, describeCron, nextRuns, parseCron } from "../src/reports/cron.js";
import { splitFilter } from "../src/reports/engine.js";
import { previousWindow, resolvePeriod } from "../src/reports/period.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const edrStore = ready && (await chRows<{ n: string }>("SELECT count() AS n FROM edr LIMIT 1")) !== null;
const skip = ready && edrStore ? false : "seeded database and EDR store not available";
const started = new Date();
const run = Date.now().toString(36).slice(-5);
after(async () => {
  if (ready) {
    await db().query("DELETE FROM email_logs WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM scheduled_reports WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM daily_traffic_alerts WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM saved_views WHERE inserted_at >= $1 AND list = 'master_report'", [started]);
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
const undo = (change: Change | null) =>
  change ? ok("undoChange", call("POST", `/changes/${change.id}/undo`, {})) : null;

describe("§10 helpers", () => {
  test("periods resolve in the time zone and compare windows line up", () => {
    const now = Date.parse("2026-10-16T21:30:00Z");
    const y = resolvePeriod("yesterday", "UTC", now);
    assert.equal(y.from.toISOString(), "2026-10-15T00:00:00.000Z");
    assert.equal(y.to.toISOString(), "2026-10-16T00:00:00.000Z");
    const y3 = resolvePeriod("yesterday", "Etc/GMT-3", now); // GMT+3: it is already 10-17 00:30 there
    assert.equal(y3.from.toISOString(), "2026-10-15T21:00:00.000Z");
    assert.equal(resolvePeriod("last_month", "UTC", now).from.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(resolvePeriod("this_week", "UTC", now).from.toISOString(), "2026-10-12T00:00:00.000Z");
    const p = previousWindow(y, "previous_period");
    assert.equal(p.to.toISOString(), y.from.toISOString());
    assert.equal(previousWindow(y, "previous_week").from.toISOString(), "2026-10-08T00:00:00.000Z");
  });
  test("CRON parsing, next runs and descriptions", () => {
    const after = new Date("2026-10-17T10:00:00Z");
    assert.deepEqual(
      nextRuns("0 6 * * 1", after, 2).map((d) => d.toISOString()),
      ["2026-10-19T06:00:00.000Z", "2026-10-26T06:00:00.000Z"],
    );
    assert.equal(nextRuns("*/15 * * * *", after)[0]!.toISOString(), "2026-10-17T10:15:00.000Z");
    assert.equal(nextRuns("0 5 1 * *", after)[0]!.toISOString(), "2026-11-01T05:00:00.000Z");
    assert.equal(nextRuns("0 9 13 * 5", after)[0]!.toISOString(), "2026-10-23T09:00:00.000Z", "day or weekday");
    assert.equal(nextRuns("0 0 * * 7", after)[0]!.getUTCDay(), 0, "7 = Sunday");
    assert.throws(() => parseCron("61 * * * *"), /minute/);
    assert.throws(() => parseCron("* * *"), /five fields/);
    assert.equal(describeCron("30 6 * * *"), "every day at 06:30 UTC");
    assert.equal(describeCron("0 6 * * 1"), "every Monday at 06:00 UTC");
    assert.equal(cronFor("hourly", 4), "0 */4 * * *");
  });
  test("filters split into field conditions and metric thresholds", () => {
    const f = splitFilter({
      logic: "and",
      conditions: [
        { field: "customer", op: "like", value: "%a%" },
        { field: "margin", op: "lt", value: 0 },
        {
          logic: "or",
          conditions: [
            { field: "country", op: "eq", value: "NG" },
            { field: "country", op: "eq", value: "GH" },
          ],
        },
      ],
    });
    assert.equal(f.error, null);
    assert.equal(f.dims!.conditions.length, 2);
    assert.equal(f.metrics!.conditions.length, 1);
    const bad = splitFilter({
      logic: "or",
      conditions: [
        { field: "customer", op: "eq", value: "x" },
        { field: "asr", op: "lt", value: 50 },
      ],
    });
    assert.match(bad.error!, /cannot be OR-ed/);
  });
});

const Q = (over: Partial<MasterReportQuery>): MasterReportQuery => ({
  groupBy: ["customer"],
  metrics: ["attempts", "revenue", "margin", "asr"],
  timezone: "UTC",
  period: "yesterday",
  compare: "none",
  limit: 200,
  ...over,
});

describe("§13.15 Master Report", { skip }, () => {
  test("numeric Sender IDs group as Numeric and drill down by Sender ID (team trial round 2)", async () => {
    const groups = await ok<MasterReportPage>(
      "runMasterReport",
      call("POST", "/reports/master", Q({ groupBy: ["senderGroup"], limit: 4000 })),
    );
    assert.ok(groups.rows.every((r) => !/^[+]?[0-9]+$/.test(String(r.dims.senderGroup!.label))));
    const numeric = groups.rows.find((r) => r.dims.senderGroup!.label === "Numeric");
    if (!numeric) return;
    const each = await ok<MasterReportPage>(
      "runMasterReport",
      call(
        "POST",
        "/reports/master",
        Q({
          groupBy: ["senderId"],
          limit: 4000,
          filter: { logic: "and", conditions: [{ field: "senderGroup", op: "eq", value: "Numeric" }] },
        }),
      ),
    );
    assert.ok(each.rows.length > 0 && each.rows.every((r) => /^[+]?[0-9]+$/.test(String(r.dims.senderId!.label))));
    assert.equal(each.totals.metrics.attempts, numeric.metrics.attempts);
  });

  test("Vendor Sender ID (after translation) groups and filters like the customer one (team trial round 2)", async () => {
    const groups = await ok<MasterReportPage>(
      "runMasterReport",
      call("POST", "/reports/master", Q({ groupBy: ["vendorSenderGroup"], limit: 4000 })),
    );
    assert.ok(groups.rows.length > 0);
    assert.ok(groups.rows.every((r) => !/^[+]?[0-9]+$/.test(String(r.dims.vendorSenderGroup!.label))));
    const edrs = await ok<{ rows: { senderId: string; vendorSenderId: string }[] }>(
      "queryEdrs",
      call("POST", "/edrs/query", { limit: 5, filter: { logic: "and", conditions: [] } }),
    );
    assert.ok(edrs.rows.every((r) => typeof r.vendorSenderId === "string"));
  });

  test("grouping, totals equal the rows, paging, labels", async () => {
    const all = await ok<MasterReportPage>(
      "runMasterReport",
      call("POST", "/reports/master", Q({ groupBy: ["vendorTrunk"], limit: 4000 })),
    );
    assert.ok(all.total > 50 && all.rows.length === all.total);
    const sum = all.rows.reduce((a, r) => a + (r.metrics.attempts ?? 0), 0);
    assert.equal(sum, all.totals.metrics.attempts);
    assert.ok(all.rows.some((r) => r.dims.vendorTrunk!.label === "not routed"));
    const p1 = await ok<MasterReportPage>(
      "runMasterReport",
      call("POST", "/reports/master", Q({ groupBy: ["vendorTrunk"], limit: 10 })),
    );
    const p2 = await ok<MasterReportPage>(
      "runMasterReport",
      call("POST", "/reports/master", Q({ groupBy: ["vendorTrunk"], limit: 10, cursor: p1.nextCursor })),
    );
    assert.deepEqual(
      [...p1.rows, ...p2.rows].map((r) => r.key),
      all.rows.slice(0, 20).map((r) => r.key),
    );
    assert.ok(p1.rows[0]!.metrics.attempts! >= p1.rows[9]!.metrics.attempts!, "default sort: first metric, descending");
  });

  test("live screens label and filter enterprises by alias (team trial round 1)", async () => {
    const byAlias = await ok<MasterReportPage>(
      "runMasterReport",
      call("POST", "/reports/master", Q({ groupBy: ["customer"], limit: 1, enterpriseLabel: "alias" })),
    );
    const top = byAlias.rows[0]!;
    const { rows } = await db().query("SELECT name, alias FROM enterprises WHERE id = $1", [top.dims.customer!.id]);
    assert.equal(top.dims.customer!.label, rows[0].alias || rows[0].name);
    const byName = await ok<MasterReportPage>(
      "runMasterReport",
      call("POST", "/reports/master", Q({ groupBy: ["customer"], limit: 1 })),
    );
    assert.equal(byName.rows[0]!.dims.customer!.label, rows[0].name, "the Master Report keeps full names");
    const drilled = await ok<MasterReportPage>(
      "runMasterReport",
      call(
        "POST",
        "/reports/master",
        Q({
          groupBy: ["customer"],
          enterpriseLabel: "alias",
          filter: { logic: "and", conditions: [{ field: "customer", op: "eq", value: top.dims.customer!.label }] },
        }),
      ),
    );
    assert.equal(drilled.totals.metrics.attempts, top.metrics.attempts, "a drill-down by alias finds the same traffic");
  });

  test("field filters before grouping, thresholds after, sorting, compare", async () => {
    const r = await ok<MasterReportPage>(
      "runMasterReport",
      call(
        "POST",
        "/reports/master",
        Q({
          groupBy: ["customer", "destination"],
          period: "last_7_days",
          compare: "previous_period",
          sort: [{ field: "margin", dir: "asc" }],
          filter: {
            logic: "and",
            conditions: [
              { field: "country", op: "in", values: ["IN", "NG"] },
              { field: "margin", op: "lt", value: 0 },
            ],
          },
          limit: 50,
        }),
      ),
    );
    assert.ok(r.rows.length > 0);
    assert.ok(r.rows.every((x) => x.metrics.margin! < 0 && /\((40[45]|621)\d+\)$/.test(x.dims.destination!.label)));
    assert.ok(r.rows.every((x, i) => i === 0 || r.rows[i - 1]!.metrics.margin! <= x.metrics.margin!));
    assert.ok(r.previousFrom && r.rows.every((x) => x.previous !== null) && r.totals.previous);
    const bad = await call(
      "POST",
      "/reports/master",
      Q({
        filter: {
          logic: "or",
          conditions: [
            { field: "customer", op: "eq", value: "x" },
            { field: "asr", op: "lt", value: 1 },
          ],
        },
      }),
    );
    assert.equal(bad.statusCode, 400);
    const badSort = await call("POST", "/reports/master", Q({ sort: [{ field: "cost", dir: "asc" }] }));
    assert.equal(badSort.statusCode, 400, "sort by a chosen metric");
    const badCustom = await call(
      "POST",
      "/reports/master",
      Q({ period: "custom", from: "2026-10-10T00:00:00Z", to: "2026-10-09T00:00:00Z" }),
    );
    assert.equal(badCustom.statusCode, 400);
  });

  test("time zone shifts the days; TPS peak; export", async () => {
    const utc = await ok<MasterReportPage>(
      "runMasterReport",
      call("POST", "/reports/master", Q({ groupBy: ["hour"], metrics: ["attempts", "tpsAvg", "tpsPeak"], limit: 30 })),
    );
    // One row per hour with traffic: at most 24 (an hour can be empty, e.g. between the seed and live traffic).
    assert.ok(utc.rows.length >= 20 && utc.rows.length <= 24, `${utc.rows.length} hours`);
    assert.ok(utc.rows.every((r) => r.metrics.tpsPeak! >= r.metrics.tpsAvg!));
    const plus3 = await ok<MasterReportPage>(
      "runMasterReport",
      call(
        "POST",
        "/reports/master",
        Q({ groupBy: ["hour"], metrics: ["attempts"], timezone: "Etc/GMT-3", limit: 30 }),
      ),
    );
    // "Yesterday" counts from the latest EDR (the fake data ends when it was generated), in GMT+3.
    const [latest] = (await chRows<{ t: string }>("SELECT toString(max(start_time)) AS t FROM edr"))!;
    const plus3Day = new Date(Date.parse(`${latest!.t.replace(" ", "T")}Z`) + 3 * 3_600_000 - 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.ok(
      plus3.rows.every((r) => String(r.dims.hour!.id).startsWith(plus3Day)),
      `yesterday in GMT+3 is ${plus3Day}`,
    );
    const csv = await call("POST", "/reports/master/export", {
      fileType: "csv",
      query: Q({ groupBy: ["msgType"], metrics: ["attempts", "asr"] }),
    });
    assert.equal(csv.statusCode, 200);
    const lines = csv.body.trim().split("\r\n");
    assert.equal(lines[0], "Type,Attempts,ASR %");
    assert.match(lines.at(-1)!, /^Total,/);
    const pdf = await call("POST", "/reports/master/export", { fileType: "pdf", query: Q({}) });
    assert.match(pdf.body.slice(0, 8), /%PDF/);
  });

  test("presets and saved views with report settings", async () => {
    const { presets } = await ok("listReportPresets", call("GET", "/reports/presets"));
    assert.ok(
      ["sales", "billing", "noc", "negative_margin", "bilateral"].every((k) =>
        presets.some((p: { key: string }) => p.key === k),
      ),
    );
    for (const p of presets) await ok("runMasterReport", call("POST", "/reports/master", { ...p.settings, limit: 5 }));
    const view = await ok(
      "createView",
      call("POST", "/views", { list: "master_report", name: `R ${run}`, state: { report: presets[0].settings } }),
      201,
    );
    assert.deepEqual(view.state.report.groupBy, presets[0].settings.groupBy);
    const badView = await call("POST", "/views", {
      list: "master_report",
      name: `R2 ${run}`,
      state: {
        report: {
          ...presets[0].settings,
          filter: { logic: "and", conditions: [{ field: "nope", op: "eq", value: 1 }] },
        },
      },
    });
    assert.equal(badView.statusCode, 400);
  });
});

describe("§13.15 department reports", { skip }, () => {
  test("sales movers, billing list, NOC problems", async () => {
    const s = await ok(
      "salesInsights",
      call("POST", "/reports/sales/insights", { period: "last_7_days", timezone: "UTC", thresholdPct: 10 }),
    );
    assert.ok(s.growing.every((m: { changePct: number }) => m.changePct >= 10));
    assert.ok(s.declining.every((m: { changePct: number }) => m.changePct <= -10));
    assert.ok(s.newClients.every((m: { previousAttempts: number }) => m.previousAttempts === 0));
    const b = await ok(
      "queryBillingReport",
      call("POST", "/reports/billing/query", {
        params: { period: "last_month" },
        query: { limit: 20, sort: [{ field: "customerAmount", dir: "desc" }] },
      }),
    );
    assert.ok(b.total > 100 && b.rows[0].customerAmount >= b.rows[19].customerAmount);
    const neg = await ok(
      "queryBillingReport",
      call("POST", "/reports/billing/query", {
        params: { period: "last_month" },
        query: {
          limit: 5,
          filter: { logic: "and", conditions: [{ field: "negativeMarginMessages", op: "gt", value: 0 }] },
        },
      }),
    );
    assert.ok(neg.rows.every((r: { negativeMarginMessages: number }) => r.negativeMarginMessages > 0));
    const n = await ok("nocInsights", call("POST", "/reports/noc/insights", { period: "today", timezone: "UTC" }));
    assert.ok(n.topErrors.length > 0 && n.topErrors.every((e: { causeCode: number }) => e.causeCode !== 0));
  });
});

describe("§10 scheduled reports and daily traffic alerts", { skip }, () => {
  test("scheduled report: add, change, undo, run, delete", async () => {
    const body = {
      name: `Weekly ${run}`,
      description: null,
      templateKind: "preset",
      presetKey: "noc",
      viewId: null,
      status: "active",
      businessCompanyId: 1,
      notificationEmails: ["noc@example.net"],
      cronInterval: "weekly",
      cronFrequency: 1,
      cronExpression: "0 6 * * 1",
      fileType: "csv",
      emailBody: "<p>{report} {from} {to}</p>",
    };
    assert.equal((await call("POST", "/scheduled-reports", { ...body, cronExpression: "0 25 * * *" })).statusCode, 400);
    const c = await ok("createScheduledReport", call("POST", "/scheduled-reports", body), 201);
    assert.ok(c.record.nextRunAt > new Date().toISOString());
    const u = await ok(
      "updateScheduledReport",
      call("PUT", `/scheduled-reports/${c.record.id}`, { ...body, cronExpression: "0 7 * * *", status: "inactive" }),
    );
    assert.equal(u.record.nextRunAt, null);
    await undo(u.change);
    assert.equal(
      (await ok("getScheduledReport", call("GET", `/scheduled-reports/${c.record.id}`))).cronExpression,
      "0 6 * * 1",
    );
    const r = await ok("runScheduledReport", call("POST", `/scheduled-reports/${c.record.id}/run`));
    assert.equal(r.lastStatus, "sent", r.lastError);
    const { rows } = await db().query(
      "SELECT * FROM email_logs WHERE email_type = 'schedule_report_alert' AND inserted_at >= $1",
      [started],
    );
    assert.ok(rows.some((x) => x.subject.startsWith(`Weekly ${run}`) && /\.csv$/.test(x.file_name)));
    await ok("archiveScheduledReport", call("POST", `/scheduled-reports/${c.record.id}/archive`, {}));
    const preview = await ok(
      "previewCron",
      call("POST", "/scheduled-reports/cron-preview", { expression: "*/30 * * * *", count: 2 }),
    );
    assert.equal(preview.runs.length, 2);
  });

  test("daily traffic alert: add, send", async () => {
    const { rows } = await db().query(
      "SELECT id FROM enterprises WHERE type <> 'vendor' AND deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    const c = await ok(
      "createDailyTrafficAlert",
      call("POST", "/daily-traffic-alerts", {
        name: `Daily ${run}`,
        status: "active",
        businessCompanyId: null,
        contactType: "commercial",
        enterpriseId: Number(rows[0].id),
        sendHour: 6,
        emailBody: "Summary for {date}\n{summary}",
      }),
      201,
    );
    const mail = await ok("sendDailyTrafficAlert", call("POST", `/daily-traffic-alerts/${c.record.id}/send`));
    assert.match(mail.subject, /^Daily traffic summary 2026-10-1\d/);
    assert.match(mail.body, /Messages|No traffic/);
  });
});
