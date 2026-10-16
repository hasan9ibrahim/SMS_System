// Enterprise report (build step 4.5, §10, §13.31): settings validation, the field catalogue,
// time zone cut per partner (a trunk's own zone wins), filters, sort, paging, totals and CSV
// export. Every response is checked against the contract. Traffic checks need ClickHouse.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { chRows } from "../src/edr.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const edrs = ready ? await chRows<{ t: string }>("SELECT toString(max(submit_time)) AS t FROM edr") : null;
const skipEdr = skip || (edrs?.[0] ? false : "EDR store (ClickHouse) not available");
after(async () => {
  await app.close();
  await closeDb();
});

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

const report = async (body: object, status = 200) => {
  const res = await app.inject({ method: "POST", url: `${API_PREFIX}/reports/enterprise/query`, payload: body });
  assert.equal(res.statusCode, status, res.body);
  check("queryEnterpriseReport", res);
  return res.json();
};

/** The last two days of fake traffic, as local dates. */
function period() {
  const end = new Date(`${edrs![0]!.t.replace(" ", "T")}Z`);
  const to = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
  const from = new Date(to.getTime() - 2 * 86_400_000);
  const f = (d: Date) => `${d.toISOString().slice(0, 10)}T00:00`;
  return { from: f(from), to: f(to) };
}

describe("Enterprise report settings (§13.31)", { skip }, () => {
  test("the field catalogue has the row keys and the §10 metrics", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/meta/lists/enterprise_report/fields` });
    const fields = res.json().fields.map((f: { field: string }) => f.field);
    for (const f of [
      "period",
      "enterpriseName",
      "currency",
      "attempts",
      "revenuePlatform",
      "margin",
      "hlrCostPlatform",
    ])
      assert.ok(fields.includes(f), f);
    assert.equal(fields.length, 11 + 27);
  });

  test("bad settings and filters point at the field", async () => {
    const bad = await report({ report: { side: "customer", from: "2026-10-17T00:00", to: "2026-10-01T00:00" } }, 400);
    assert.equal(bad.errors[0].path, "/report/to");
    const wide = await report({ report: { side: "customer", from: "2024-01-01T00:00", to: "2026-01-01T00:00" } }, 400);
    assert.match(wide.errors[0].message, /400 days/);
    const field = await report(
      {
        report: { side: "customer", ...{ from: "2026-10-01T00:00", to: "2026-10-02T00:00" } },
        filter: { logic: "and", conditions: [{ field: "nope", op: "eq", value: 1 }] },
      },
      400,
    );
    assert.match(field.errors[0].message, /unknown field/);
  });
});

describe("Enterprise report figures (§10, §13.31)", { skip: skipEdr }, () => {
  test("rows add up to the totals; filter, sort and paging run on the server", async () => {
    const p = { side: "customer", ...period(), reportBy: "daily", groupBy: ["enterprise"] };
    const all = await report({ report: p, limit: 4000 });
    assert.ok(all.total > 0 && all.rows.length === all.total);
    const sum = (k: string) => all.rows.reduce((s: number, r: Record<string, number>) => s + r[k]!, 0);
    assert.equal(sum("attempts"), all.totals.attempts);
    assert.ok(Math.abs(sum("revenuePlatform") - all.totals.revenuePlatform) < 0.05);

    const sorted = await report({ report: p, sort: [{ field: "revenuePlatform", dir: "desc" }], limit: 20 });
    const revs = sorted.rows.map((r: { revenuePlatform: number }) => r.revenuePlatform);
    assert.deepEqual(
      revs,
      [...revs].sort((a, b) => b - a),
    );

    const neg = await report({
      report: p,
      filter: { logic: "and", conditions: [{ field: "margin", op: "lt", value: 0 }] },
      limit: 50,
    });
    for (const r of neg.rows) assert.ok(r.margin < 0);

    const first = await report({ report: p, limit: 5 });
    const second = await report({ report: p, limit: 5, cursor: first.nextCursor });
    assert.equal(second.rows[0].id, 6);
    assert.notDeepEqual(second.rows[0], first.rows[0]);
  });

  test("days are cut in the partner's billing time zone; a trunk's own zone wins; UTC on request", async () => {
    const { rows: t } = await db().query(
      "SELECT t.id, t.enterprise_id, e.billing_timezone FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id WHERE t.billing_timezone IS NULL ORDER BY t.id LIMIT 1",
    );
    const trunk = t[0];
    const base = { side: "customer", ...period(), reportBy: "daily", groupBy: ["trunk"], trunkIds: [trunk.id] };
    const partner = await report({ report: base });
    assert.deepEqual(
      partner.timezones.map((z: { timezone: string }) => z.timezone),
      [trunk.billing_timezone],
    );
    for (const r of partner.rows) assert.equal(r.timezone, trunk.billing_timezone);
    const utc = await report({ report: { ...base, timezone: "utc" } });
    assert.deepEqual(
      utc.timezones.map((z: { timezone: string }) => z.timezone),
      ["UTC"],
    );

    const zone = trunk.billing_timezone === "Pacific/Auckland" ? "America/Los_Angeles" : "Pacific/Auckland";
    await db().query("UPDATE customer_trunks SET billing_timezone = $2 WHERE id = $1", [trunk.id, zone]);
    try {
      const own = await report({ report: base });
      assert.deepEqual(
        own.timezones.map((z: { timezone: string }) => z.timezone),
        [zone],
      );
    } finally {
      await db().query("UPDATE customer_trunks SET billing_timezone = NULL WHERE id = $1", [trunk.id]);
    }
  });

  test("partner-currency totals only when one currency; CSV prints the time zone", async () => {
    const mixed = await report({
      report: { side: "customer", ...period(), reportBy: "none", groupBy: ["country"] },
      limit: 500,
    });
    const currencies = new Set(mixed.rows.map((r: { currency: string }) => r.currency));
    if (currencies.size > 1) assert.equal(mixed.totals.revenue, null);
    assert.equal(typeof mixed.totals.revenuePlatform, "number");

    const res = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/reports/enterprise/export`,
      payload: {
        report: { side: "vendor", ...period(), reportBy: "daily", groupBy: ["enterprise"] },
        columns: ["period", "enterpriseName", "currency", "attempts", "cost"],
      },
    });
    assert.equal(res.statusCode, 200);
    const lines = res.body.split("\r\n");
    assert.match(lines[2]!, /^Time zone,partner billing time zone: /);
    assert.equal(lines[5], "Period,Enterprise,Currency,Attempts,Cost");
  });
});
