// Monitoring alerts (build step 5.12, §13.4, §13.6, §13.7): the rule evaluator on made-up series,
// live analytics snapshots, alert rule CRUD / test / undo, the engine raising, repeating and
// recovering an incident (with its e-mail), and incident acknowledge / snooze / notes / export.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { AlertRuleInput, Change } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { conditionLabel, entitiesFor, evaluate, isActiveAt, measure, type Series } from "../src/alerts/evaluate.js";
import { evaluateRound, invalidateRules, notifies } from "../src/alerts/engine.js";
import { analyticsParams, analyticsSnapshot, nameMatcher } from "../src/live/analytics.js";
import type { Simulator, SimTrunk } from "../src/live/simulator.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const started = new Date();
const run = Date.now().toString(36).slice(-5);
const maxIncident = ready
  ? Number((await db().query("SELECT coalesce(max(id), 0) AS id FROM incidents")).rows[0].id)
  : 0;
after(async () => {
  if (ready) {
    await db().query(
      "DELETE FROM incidents WHERE id > $1 AND rule_id IN (SELECT id FROM alert_rules WHERE inserted_at >= $2)",
      [maxIncident, started],
    );
    await db().query("DELETE FROM incident_notes WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM alert_rules WHERE inserted_at >= $1", [started]);
    await db().query("DELETE FROM email_logs WHERE inserted_at >= $1 AND email_type = 'monitoring_alert'", [started]);
    await db().query(
      "UPDATE incidents SET state = 'recovered', acknowledged_by_id = NULL, acknowledged_at = NULL, snoozed_until = NULL WHERE id <= $1 AND acknowledged_at >= $2",
      [maxIncident, started],
    );
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

// ---------------------------------------------------------------- made-up traffic

function series(
  id: number,
  opts: { tps?: number[]; asr?: number | null; dlr?: number | null; ent?: number; revenue?: number | null } = {},
): Series {
  const minutes = opts.tps ?? Array.from({ length: 120 }, () => 10);
  return {
    kind: "customer_trunk",
    id,
    name: `T${id}`,
    enterpriseId: opts.ent ?? 100 + id,
    enterpriseName: `E${opts.ent ?? 100 + id}`,
    tps: minutes[minutes.length - 1] ?? 0,
    minutes,
    minAsr: minutes.map(() => (opts.asr === undefined ? 95 : opts.asr)),
    minDlr: minutes.map(() => (opts.dlr === undefined ? 85 : opts.dlr)),
    minDelay: minutes.map(() => 3),
    revenue: opts.revenue === undefined ? 0.03 : opts.revenue,
    cost: 0.025,
    normalTps: 10,
    normalAsr: 95,
    normalDlr: 85,
    normalDelay: 3,
  };
}
const baseRule = (over: Partial<AlertRuleInput> = {}): AlertRuleInput => ({
  name: `Test rule ${run}`,
  status: "active",
  description: null,
  scope: { kind: "customer_trunk", ids: [], values: [] },
  metric: "dlr",
  condition: { type: "below", value: 60, baseline: null },
  windowMinutes: 15,
  minSample: 100,
  activeHours: { always: true, days: [0, 1, 2, 3, 4, 5, 6], fromHour: 0, toHour: 24 },
  severity: "warning",
  notifyUserIds: [],
  notifyDepartmentIds: [],
  channels: { popup: true, sound: true, email: false },
  emailAddresses: [],
  partnerContactType: null,
  repeatMinutes: null,
  cooldownMinutes: 15,
  recoveryNotice: true,
  ...over,
});

describe("§13.6 rule evaluation", () => {
  test("metrics over a window: volume, ASR / DLR weighted, unknown quality left out", () => {
    const s = [series(1, { tps: Array.from({ length: 30 }, () => 10) }), series(2, { asr: null, dlr: null })];
    assert.equal(measure(s, "attempts", 15, 0).value, 10 * 60 * 15 * 2);
    assert.equal(measure(s, "asr", 15, 0).value, 95, "the trunk without ASR history does not drag ASR down");
    assert.equal(Math.round(measure(s, "dlr", 15, 0).value!), 85);
    assert.equal(measure([series(3, { revenue: null })], "margin", 15, 0).value, null, "vendors have no revenue side");
  });

  test("conditions: below, decrease vs previous window, started, stopped, minimum sample", () => {
    const drop = Array.from({ length: 120 }, (_, i) => (i < 105 ? 10 : 10));
    const dlrDrop = series(1, { tps: drop });
    dlrDrop.minDlr = drop.map((_, i) => (i < 105 ? 90 : 50));
    const e = { kind: "customer_trunk", id: 1, name: "T1", enterpriseId: 101, series: [dlrDrop] };
    const below = evaluate(baseRule(), e);
    assert.equal(below.firing, true);
    assert.match(below.message, /T1 DLR 50 % below 60 %/);
    const dec = evaluate(baseRule({ condition: { type: "decrease_pct", value: 30, baseline: "previous_window" } }), e);
    assert.equal(dec.firing, true);
    assert.match(dec.message, /dropped from 90 % to 50 % in 15 min/);
    const started = series(2, { tps: Array.from({ length: 120 }, (_, i) => (i < 105 ? 0 : 5)) });
    const st = evaluate(baseRule({ metric: "attempts", condition: { type: "started", value: null, baseline: null } }), {
      ...e,
      series: [started],
    });
    assert.equal(st.firing, true);
    const stopped = series(3, { tps: Array.from({ length: 120 }, (_, i) => (i < 105 ? 5 : 0)) });
    assert.equal(
      evaluate(baseRule({ metric: "attempts", condition: { type: "stopped", value: null, baseline: null } }), {
        ...e,
        series: [stopped],
      }).firing,
      true,
    );
    const tiny = evaluate(baseRule({ minSample: 1_000_000 }), e);
    assert.equal(tiny.firing, false);
    assert.match(tiny.reason, /minimum/);
  });

  test("entities, active hours, labels, notify lists", () => {
    const cs = [series(1, { ent: 7 }), series(2, { ent: 7 }), series(3, { ent: 8 })];
    assert.equal(entitiesFor({ scope: { kind: "customer", ids: [], values: [] }, metric: "dlr" }, cs, []).length, 2);
    assert.equal(
      entitiesFor({ scope: { kind: "customer", ids: [7], values: [] }, metric: "dlr" }, cs, [])[0]!.series.length,
      2,
    );
    assert.equal(
      entitiesFor({ scope: { kind: "all", ids: [], values: [] }, metric: "tps" }, cs, [])[0]!.name,
      "All traffic",
    );
    const mon9 = Date.parse("2026-10-19T09:00:00Z");
    assert.equal(isActiveAt({ always: false, days: [1], fromHour: 8, toHour: 10 }, mon9), true);
    assert.equal(isActiveAt({ always: false, days: [2], fromHour: 8, toHour: 10 }, mon9), false);
    assert.equal(conditionLabel(baseRule()), "DLR below 60 % · 15 min · ≥ 100 msgs");
    assert.equal(notifies({ notifyUserIds: [], notifyDepartmentIds: [] }, 5, null), true);
    assert.equal(notifies({ notifyUserIds: [9], notifyDepartmentIds: [3] }, 5, 3), true);
    assert.equal(notifies({ notifyUserIds: [9], notifyDepartmentIds: [3] }, 5, 4), false);
  });
});

// A simulator with two trunks of real IDs (the rule under test watches only the first).
async function fakeSim(dlr: number): Promise<Simulator> {
  const { rows } = await db().query(
    "SELECT id, name, enterprise_id FROM customer_trunks WHERE deleted_at IS NULL ORDER BY id LIMIT 2",
  );
  const trunk = (r: Record<string, unknown>, d: number): SimTrunk =>
    ({
      ...series(Number(r.id), { ent: Number(r.enterprise_id) }),
      name: r.name as string,
      enterpriseName: "Fake",
      limit: 100,
      base: 10,
      asr: 95,
      dlr: 85,
      asrNow: 95,
      dlrNow: d,
      delayNow: 3,
      dip: null,
      minDlr: Array.from({ length: 120 }, () => d),
      qSum: [0, 0, 0],
      day: { attempts: 1000, submitted: 950, delivered: 800, revenue: 30, cost: 25 },
      segments: [],
      minuteSum: 0,
      minuteN: 0,
      slots: new Float32Array(1),
      slotSum: 0,
      slotN: 0,
    }) as unknown as SimTrunk;
  return {
    trunks: [trunk(rows[0], dlr), trunk(rows[1], 85)],
    vendors: [],
    today: {
      day: "2026-10-17",
      attempts: 0,
      submitted: 0,
      delivered: 0,
      revenue: 0,
      cost: 0,
      clients: new Map(),
      vendors: new Map(),
      destinations: new Map(),
    },
    slotIndex: 0,
    lastTick: Date.now(),
  } as Simulator;
}

describe("§13.4 live analytics snapshot", { skip }, () => {
  test("join params, search with wildcards, sort and totals", async () => {
    assert.equal(analyticsParams({ groupBy: "nope" }), null);
    assert.equal(analyticsParams({ groupBy: "customer", extra: 1 }), null);
    const p = analyticsParams({ groupBy: "customer_trunk", sort: "name", dir: "asc" })!;
    assert.equal(nameMatcher("ab%z")("ABxyz"), true);
    assert.equal(nameMatcher("a_c")("abc"), true);
    assert.equal(nameMatcher("a_c")("abbc"), false);
    const sim = await fakeSim(85);
    const snap = analyticsSnapshot(sim, p);
    assert.equal(snap.rows.length, 2);
    assert.ok(snap.rows[0]!.name.localeCompare(snap.rows[1]!.name) <= 0);
    assert.equal(snap.totals.attempts, 2000);
    assert.equal(snap.rows[0]!.sparkline!.length, 60);
    const one = analyticsSnapshot(sim, { ...p, search: sim.trunks[0]!.name });
    assert.equal(one.total, 1);
  });
});

describe("§13.6 alert rules and incidents", { skip }, () => {
  test("rule CRUD: validation, labels, enable / disable, clone, undo, test", async () => {
    const bad = await call(
      "POST",
      "/alert-rules",
      baseRule({ condition: { type: "below", value: null, baseline: null } }),
    );
    assert.equal(bad.statusCode, 400);
    const vend = await call(
      "POST",
      "/alert-rules",
      baseRule({ metric: "margin", scope: { kind: "vendor", ids: [], values: [] } }),
    );
    assert.equal(vend.statusCode, 400);
    const { record, change } = await ok(
      "createAlertRule",
      call("POST", "/alert-rules", baseRule({ name: `CRUD ${run}` })),
      201,
    );
    assert.equal(record.scopeLabel, "Each customer trunk");
    assert.equal(record.conditionLabel, "DLR below 60 % · 15 min · ≥ 100 msgs");
    assert.ok(change);
    const off = await ok(
      "setAlertRuleStatus",
      call("POST", `/alert-rules/${record.id}/status`, { status: "inactive" }),
    );
    assert.equal(off.record.status, "inactive");
    await undo(off.change);
    assert.equal((await ok("getAlertRule", call("GET", `/alert-rules/${record.id}`))).status, "active");
    const upd = await ok(
      "updateAlertRule",
      call("PUT", `/alert-rules/${record.id}`, {
        ...baseRule({ name: `CRUD ${run}` }),
        condition: { type: "decrease_pct", value: 25, baseline: null },
      }),
    );
    assert.equal(upd.record.condition.baseline, "previous_window", "a change rule always has a baseline");
    await undo(upd.change);
    assert.equal((await ok("getAlertRule", call("GET", `/alert-rules/${record.id}`))).condition.type, "below");
    await ok("cloneAlertRule", call("POST", `/alert-rules/${record.id}/clone`, { name: `CRUD copy ${run}` }), 201);
    const t = await ok(
      "testAlertRule",
      call(
        "POST",
        "/alert-rules/test",
        baseRule({
          metric: "tps",
          scope: { kind: "all", ids: [], values: [] },
          condition: { type: "above", value: 0, baseline: null },
          minSample: 0,
        }),
      ),
    );
    assert.equal(t.entities[0].name, "All traffic");
    await ok("archiveAlertRule", call("POST", `/alert-rules/${record.id}/archive`, {}));
    const list = await ok(
      "queryAlertRules",
      call("POST", "/alert-rules/query", { limit: 50, sort: [{ field: "lastTriggeredAt", dir: "desc" }] }),
    );
    assert.ok(list.rows.length > 5);
  });

  test("the engine opens, updates and recovers an incident, with its e-mail", async () => {
    const { rows: tr } = await db().query(
      "SELECT id FROM customer_trunks WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    const { record: rule } = await ok(
      "createAlertRule",
      call(
        "POST",
        "/alert-rules",
        baseRule({
          name: `Engine ${run}`,
          scope: { kind: "customer_trunk", ids: [Number(tr[0].id)], values: [] },
          condition: { type: "below", value: 50, baseline: null },
          severity: "critical",
          channels: { popup: true, sound: true, email: true },
          emailAddresses: ["noc-test@fenphy.example"],
          cooldownMinutes: 0,
        }),
      ),
      201,
    );
    invalidateRules();
    await evaluateRound(await fakeSim(30));
    const { rows: inc } = await db().query("SELECT * FROM incidents WHERE rule_id = $1", [rule.id]);
    assert.equal(inc.length, 1);
    assert.equal(inc[0].state, "open");
    assert.match(inc[0].message, /DLR 30 % below 50 %/);
    assert.ok(inc[0].emailed_at, "critical e-mails go at once");
    const { rows: mail } = await db().query(
      "SELECT to_addresses, subject FROM email_logs WHERE email_type = 'monitoring_alert' AND inserted_at >= $1 AND subject LIKE $2",
      [started, `%Engine ${run}%`],
    );
    assert.ok(mail[0]?.to_addresses.includes("noc-test@fenphy.example"));
    await evaluateRound(await fakeSim(20));
    const { rows: again } = await db().query(
      "SELECT count(*)::int AS n, min(peak_value)::float AS peak FROM incidents WHERE rule_id = $1",
      [rule.id],
    );
    assert.equal(again[0].n, 1, "still one incident while it lasts");
    assert.equal(again[0].peak, 20, "the peak keeps the worst value");

    const open = await ok("listOpenIncidents", call("GET", "/incidents/open"));
    const mine = open.incidents.find((x: { ruleId: number }) => x.ruleId === rule.id);
    assert.ok(mine, "the bell lists it (the rule notifies everyone)");
    const snoozed = await ok("snoozeIncident", call("POST", `/incidents/${mine.id}/snooze`, { for: "1h" }));
    assert.ok(snoozed.snoozedUntil);
    const acked = await ok(
      "acknowledgeIncident",
      call("POST", `/incidents/${mine.id}/acknowledge`, { note: "Looking into it" }),
    );
    assert.equal(acked.state, "acknowledged");
    assert.equal(acked.notes[0].text, "Looking into it");
    const noted = await ok(
      "addIncidentNote",
      call("POST", `/incidents/${mine.id}/notes`, { text: "Vendor fixed it" }),
      201,
    );
    assert.equal(noted.notes.length, 2);

    await evaluateRound(await fakeSim(85));
    const { rows: done } = await db().query("SELECT state, ended_at FROM incidents WHERE rule_id = $1", [rule.id]);
    assert.equal(done[0].state, "recovered");
    assert.ok(done[0].ended_at);
    const { rows: rec } = await db().query(
      "SELECT 1 FROM email_logs WHERE email_type = 'monitoring_alert' AND inserted_at >= $1 AND subject LIKE '[OK]%' AND subject LIKE $2",
      [started, `%Engine ${run}%`],
    );
    assert.ok(rec[0], "a recovery e-mail follows the alert e-mail");
    const detail = await ok("getIncident", call("GET", `/incidents/${mine.id}`));
    assert.equal(detail.conditionLabel, "DLR below 50 % · 15 min · ≥ 100 msgs");
  });

  test("incident list at volume and the CSV export", async () => {
    const t = Date.now();
    const page = await ok(
      "queryIncidents",
      call("POST", "/incidents/query", {
        limit: 200,
        withTotal: true,
        filter: { logic: "and", conditions: [{ field: "severity", op: "in", values: ["critical"] }] },
        sort: [{ field: "durationSeconds", dir: "desc" }],
      }),
    );
    assert.ok(page.rows.length > 50);
    assert.ok(Date.now() - t < 2000);
    const csv = await call("POST", "/incidents/export", { limit: 100 });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.body.split("\n")[0]!, /^incident,started_at/);
  });
});
