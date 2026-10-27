// Long-term report totals (product owner 2026-10-27, docs/BACKEND_PLAN.md §3.7): a report on a period older than the
// detailed EDRs reads edr_totals / edr_sender_daily (ClickHouse 008) and must show the same figures the detailed EDRs
// gave. Each query runs twice on the seeded EDR store: on edr_all, then with the detail horizon moved past it.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { MasterReportQuery } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { runEnterpriseReport } from "../src/api/enterpriseReport.js";
import { usageLines } from "../src/billing/edrFigures.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { chRows } from "../src/edr.js";
import { masterSource, runMasterReport, windowOf, type ReportResult } from "../src/reports/engine.js";
import { PastDetailError, setDetailHorizonForTests } from "../src/reports/source.js";

const ready = await dbReady();
const totals =
  ready && (await chRows<{ n: string }>("SELECT count() AS n FROM system.tables WHERE name = 'edr_totals'"));
const skip = totals && Number(totals[0]!.n) ? false : "seeded database and EDR store with the 008 totals not available";
const app = await buildServer({ socket: false });
after(async () => {
  setDetailHorizonForTests(null);
  await app.close();
  await closeDb();
});

/** The same call on the detailed EDRs, then on the totals (detail horizon moved past the period). */
async function twice<T>(f: () => Promise<T>): Promise<[T, T]> {
  setDetailHorizonForTests(null);
  const detail = await f();
  setDetailHorizonForTests(new Date(Date.now() + 86_400_000));
  try {
    return [detail, await f()];
  } finally {
    setDetailHorizonForTests(null);
  }
}
const post = async (url: string, payload: object) => {
  const r = await app.inject({ method: "POST", url: `${API_PREFIX}${url}`, payload });
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  const body = r.json();
  delete body.tookMs;
  return body;
};

/** Two full days a few days before the newest EDR, so the live simulator never writes into them. */
async function days(): Promise<{ from: string; to: string }> {
  const r = await chRows<{ d: string }>("SELECT toString(toDate(max(start_time)) - 6) AS d FROM edr");
  const d = r![0]!.d;
  const next = new Date(Date.parse(`${d}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  return { from: `${d}T00:00:00Z`, to: `${next}T00:00:00Z` };
}

async function both(q: MasterReportQuery): Promise<[ReportResult, ReportResult]> {
  const w = windowOf(q, Date.now());
  assert.ok(typeof w !== "string", String(w));
  setDetailHorizonForTests(null);
  // Every group, or with compare the first page (the previous period is looked up for the page's groups).
  const all = !q.compare || q.compare === "none";
  const detail = await runMasterReport(db(), q, w, { all });
  setDetailHorizonForTests(new Date(Date.now() + 86_400_000));
  try {
    return [detail, await runMasterReport(db(), q, w, { all })];
  } finally {
    setDetailHorizonForTests(null);
  }
}

const close = (a: number | null, b: number | null, what: string) => {
  if (a === null || b === null) return assert.equal(a, b, what);
  assert.ok(Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-9), `${what}: ${a} vs ${b}`);
};
function same(detail: ReportResult, tot: ReportResult) {
  assert.ok(detail.rows.length > 0, "the period has traffic");
  assert.equal(tot.total, detail.total, "group count");
  const byKey = new Map(tot.rows.map((r) => [r.key, r]));
  for (const r of detail.rows) {
    const t = byKey.get(r.key);
    assert.ok(t, `group ${r.key} in the totals`);
    for (const [m, v] of Object.entries(r.metrics)) close(v, t.metrics[m] ?? null, `${r.key} ${m}`);
  }
  for (const [m, v] of Object.entries(detail.totals.metrics)) close(v, tot.totals.metrics[m] ?? null, `total ${m}`);
}

const METRICS: MasterReportQuery["metrics"] = [
  "attempts",
  "successful",
  "submitted",
  "delivered",
  "failedSubmits",
  "billableCustomer",
  "billableVendor",
  "reportedCustomer",
  "reportedVendor",
  "asr",
  "dlrCustomer",
  "dlrVendor",
  "deliveryDelayS",
  "revenue",
  "cost",
  "margin",
  "marginPct",
  "avgRateCustomer",
  "revenueBase",
  "hlrLive",
  "hlrCached",
  "hlrAccomplished",
  "hlrCost",
  "reroutes",
  "moCount",
  "tpsAvg",
];

describe("§3.7 long-term totals answer like the detailed EDRs", { skip }, () => {
  test("Master report by customer, vendor trunk and destination, with compare", async () => {
    const p = await days();
    const q = {
      period: "custom",
      ...p,
      timezone: "UTC",
      groupBy: ["customer", "vendorTrunk", "destination"],
      metrics: METRICS,
      compare: "previous_period",
    } as MasterReportQuery;
    const [d, t] = await both(q);
    same(d, t);
    for (const [m, v] of Object.entries(d.totals.previous ?? {})) close(v, t.totals.previous?.[m] ?? null, `prev ${m}`);
  });

  test("days and hours in a half-hour time zone, rate table, currency, error code, delivery status", async () => {
    const p = await days();
    for (const groupBy of [
      ["date", "currency"],
      ["hour", "rateTable"],
      ["errorCode", "deliveryStatus", "routeType"],
      ["businessCompany", "accountManager", "hlrProvider", "msgType"],
    ] as MasterReportQuery["groupBy"][]) {
      const [d, t] = await both({
        period: "custom",
        from: p.from.replace("00:00:00Z", "00:30:00Z"),
        to: p.to.replace("00:00:00Z", "00:30:00Z"),
        timezone: "Asia/Kolkata",
        groupBy,
        metrics: METRICS,
      } as MasterReportQuery);
      same(d, t);
    }
  });

  test("filters on fields before grouping and thresholds after", async () => {
    const p = await days();
    const [d, t] = await both({
      period: "custom",
      ...p,
      timezone: "UTC",
      groupBy: ["country"],
      metrics: ["attempts", "revenue", "asr"],
      filter: {
        logic: "and",
        conditions: [
          { field: "attempts", op: "gte", value: 50 },
          { field: "msgType", op: "eq", value: "MT" },
        ],
      },
    } as MasterReportQuery);
    same(d, t);
  });

  test("Sender IDs by UTC day", async () => {
    const p = await days();
    const [d, t] = await both({
      period: "custom",
      ...p,
      timezone: "UTC",
      groupBy: ["date", "senderGroup", "customer"],
      metrics: METRICS,
    } as MasterReportQuery);
    same(d, t);
  });

  test("what only the detailed EDRs hold is refused with a reason", async () => {
    setDetailHorizonForTests(new Date(Date.now() + 86_400_000));
    try {
      const w = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-02T00:00:00Z") };
      const base = { timezone: "UTC", metrics: ["attempts"], hourFrom: null, hourTo: null } as const;
      const src = (q: Partial<MasterReportQuery>, ws = [w]) =>
        masterSource({ ...base, groupBy: ["customer"], ...q } as MasterReportQuery, ws, null, Date.now());
      assert.equal(src({}), "edr_totals");
      assert.equal(src({ groupBy: ["senderId"] }), "edr_sender_daily");
      assert.throws(() => src({ groupBy: ["minute"] }), PastDetailError);
      assert.throws(() => src({ groupBy: ["customerIp"] }), PastDetailError);
      assert.throws(() => src({ metrics: ["tpsPeak"] }), PastDetailError);
      assert.throws(() => src({ groupBy: ["senderId", "routeRule"] }), /Route Rule|not among/);
      assert.throws(() => src({ groupBy: ["senderId"], timezone: "Asia/Kolkata" }), /UTC day/);
      assert.throws(
        () => src({}, [{ from: new Date("2026-01-01T00:05:00Z"), to: new Date("2026-01-02T00:00:00Z") }]),
        /quarter hour/,
      );
      setDetailHorizonForTests(new Date("2025-01-01T00:00:00Z"));
      assert.equal(src({ groupBy: ["minute"] }), "edr_all", "within the detailed months nothing changes");
    } finally {
      setDetailHorizonForTests(null);
    }
  });
});

describe("§3.7 the other reports and billing figures on the totals", { skip }, () => {
  test("Sales, Billing and NOC insights", async () => {
    const p = await days();
    const period = { period: "custom", from: p.from, to: p.to };
    for (const [url, body] of [
      ["/reports/sales/insights", { ...period, timezone: "UTC", thresholdPct: 0 }],
      ["/reports/billing/query", { params: period, query: { limit: 500, sort: [{ field: "customerAmount", dir: "desc" }] } }],
      ["/reports/noc/insights", { ...period, timezone: "UTC" }],
    ] as const) {
      const [d, t] = await twice(() => post(url, body));
      assert.deepEqual(t, d, url);
    }
  });

  test("Enterprise report in partner zones, both sides", async () => {
    const p = await days();
    for (const side of ["customer", "vendor"] as const) {
      const [d, t] = await twice(() =>
        runEnterpriseReport(
          {
            report: { side, from: p.from.slice(0, 16), to: p.to.slice(0, 16), reportBy: "daily", groupBy: ["enterprise"] },
          } as never,
          { all: true },
        ),
      );
      assert.ok(d.page.rows.length > 0, "the period has traffic");
      assert.deepEqual(t.page, d.page, side);
    }
  });

  test("invoice and reconciliation lines per destination and rate", async () => {
    const p = await days();
    const day = p.from.slice(0, 10);
    const r = await chRows<{ c: string; v: string }>(
      `SELECT toString(argMax(c_enterprise_id, n)) AS c, toString(argMax(v_enterprise_id, n)) AS v FROM
         (SELECT c_enterprise_id, v_enterprise_id, count() AS n FROM edr WHERE toDate(start_time) = '${day}' AND v_enterprise_id > 0
           GROUP BY c_enterprise_id, v_enterprise_id)`,
    );
    for (const [side, ent] of [
      ["customer", Number(r![0]!.c)],
      ["vendor", Number(r![0]!.v)],
    ] as const) {
      const [d, t] = await twice(() => usageLines(db(), side, ent, day, day, "Asia/Kolkata", "EUR", true));
      assert.ok(d && d.length > 0, `${side} has lines`);
      assert.deepEqual(t, d, side);
    }
  });
});
