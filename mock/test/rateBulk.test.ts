// Bulk rating workspace (§13.11, rating part): preview across several rate tables and
// destinations, apply as ONE undoable change, cost + margin, notice periods (§13.14).
// Every response is checked against the contract. Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { bestBuySettled } from "../src/api/bestbuy.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
after(async () => {
  await bestBuySettled();
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

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url: `${API_PREFIX}${url}`, payload: payload as object });

async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return r.json();
}

type Row = {
  rateTableId: number;
  lineId: number | null;
  mccmnc: string;
  currentRate: number | null;
  newRate: number | null;
  edit: string;
  change: string;
  cost: number | null;
  belowCost: boolean;
  noticeBreach: boolean;
  noticeAdjusted: boolean;
  effectiveFrom: string;
};

const NO_NOTICE = `NOT EXISTS (SELECT 1 FROM customer_trunk_rate_tables x JOIN customer_trunks t ON t.id = x.customer_trunk_id
                    JOIN enterprises e ON e.id = t.enterprise_id WHERE x.rate_table_id = rt.id AND e.rate_notice_days > 0)`;

/** Two live sell tables without notice periods that both price one destination (a generic line). */
let free: Promise<{ ids: [number, number]; mccmnc: string }> | null = null;
const twoFreeTables = () => (free ??= findTwoFreeTables());
async function findTwoFreeTables(): Promise<{ ids: [number, number]; mccmnc: string }> {
  const { rows } = await db().query(
    `SELECT a.rate_table_id AS a, b.rate_table_id AS b, a.mccmnc
       FROM rate_lines a JOIN rate_lines b ON b.mccmnc_id = a.mccmnc_id AND b.rate_table_id > a.rate_table_id
      WHERE a.sender_id IS NULL AND b.sender_id IS NULL AND a.valid_to IS NULL AND b.valid_to IS NULL
        AND a.valid_from <= now() AND b.valid_from <= now()
        AND a.rate_table_id IN (SELECT rt.id FROM rate_tables rt WHERE rt.kind = 'customer' AND rt.deleted_at IS NULL AND ${NO_NOTICE})
        AND b.rate_table_id IN (SELECT rt.id FROM rate_tables rt WHERE rt.kind = 'customer' AND rt.deleted_at IS NULL AND ${NO_NOTICE})
      ORDER BY a.rate_table_id, b.rate_table_id LIMIT 1`,
  );
  return { ids: [rows[0].a, rows[0].b], mccmnc: rows[0].mccmnc };
}

describe("bulk rating preview (§13.11)", { skip }, () => {
  test("rejects incomplete jobs", async () => {
    const { ids } = await twoFreeTables();
    const bad = async (body: object, path: string) => {
      const r = await post("/rate-bulk/preview", body);
      assert.equal(r.statusCode, 400, r.body);
      check("previewRateBulk", r);
      assert.ok(
        r.json().errors.some((e: { path: string }) => e.path === path),
        `${path} in ${r.body}`,
      );
    };
    await bad({ rateTableIds: ids, action: { type: "set" } }, "/action/value");
    await bad({ rateTableIds: ids, action: { type: "set", value: 0.01 }, onlyExisting: false }, "/onlyExisting");
    await bad(
      { rateTableIds: ids, action: { type: "close" }, effectiveFrom: "2020-01-01T00:00:00Z" },
      "/effectiveFrom",
    );
    await bad({ rateTableIds: [99_999_999], action: { type: "close" } }, "/rateTableIds/0");
    await bad({ rateTableIds: ids, mccmncs: ["99999"], action: { type: "close" } }, "/mccmncs/0");
    await bad(
      { rateTableIds: ids, action: { type: "cost_plus_pct", value: 10, costSource: "vendor_trunk" } },
      "/action/vendorTrunkId",
    );
  });

  test("several clients × one destination; new lines when asked", async () => {
    const { ids, mccmnc } = await twoFreeTables();
    const p = await ok(
      "previewRateBulk",
      post("/rate-bulk/preview", { rateTableIds: ids, mccmncs: [mccmnc], action: { type: "set", value: 0.0421 } }),
    );
    const generic = p.rows.filter((r: Row & { senderId: string | null }) => r.senderId === null);
    assert.deepEqual(new Set(generic.map((r: Row) => r.rateTableId)), new Set(ids));
    assert.ok(p.rows.every((r: Row) => r.mccmnc === mccmnc && r.newRate === 0.0421));
    assert.equal(p.summary.tables, 2);
    assert.equal(p.summary.lines, p.rows.length);
    // One client, a whole country, adding what the table lacks.
    const { rows } = await db().query(
      "SELECT co.iso FROM mccmnc m JOIN countries co ON co.id = m.country_id WHERE m.mccmnc = $1",
      [mccmnc],
    );
    const q = await ok(
      "previewRateBulk",
      post("/rate-bulk/preview", {
        rateTableIds: [ids[0]],
        countryIsos: [rows[0].iso.trim()],
        onlyExisting: false,
        action: { type: "set", value: 0.05 },
      }),
    );
    const { rows: n } = await db().query(
      "SELECT count(*)::int AS n FROM mccmnc m JOIN countries co ON co.id = m.country_id WHERE co.iso = $1 AND m.deleted_at IS NULL",
      [rows[0].iso],
    );
    const genericQ = q.rows.filter((r: Row & { senderId: string | null }) => r.senderId === null);
    assert.equal(genericQ.length, n[0].n, "every network of the country, existing or new");
    assert.equal(q.summary.new, genericQ.filter((r: Row) => r.lineId === null).length);
  });

  test("cost + margin, rounding and below-cost flags", async () => {
    const { ids } = await twoFreeTables();
    const p = await ok(
      "previewRateBulk",
      post("/rate-bulk/preview", { rateTableIds: ids, action: { type: "cost_plus_pct", value: 10, round: 4 } }),
    );
    const priced = p.rows.filter((r: Row) => r.cost !== null);
    assert.ok(priced.length > 0);
    for (const r of priced.slice(0, 50)) {
      assert.ok(Math.abs(r.newRate! - Math.round(r.cost! * 1.1 * 1e4) / 1e4) < 1e-9, JSON.stringify(r));
      assert.equal(r.belowCost, false);
    }
    assert.ok(p.rows.filter((r: Row) => r.cost === null).every((r: Row) => r.edit === "none"));
    const below = await ok(
      "previewRateBulk",
      post("/rate-bulk/preview", { rateTableIds: ids, action: { type: "cost_plus_amount", value: -0.5 } }),
    );
    assert.ok(below.rows.filter((r: Row) => r.cost !== null && r.cost > 0).every((r: Row) => r.belowCost));
    assert.equal(below.summary.belowCost, below.rows.filter((r: Row) => r.belowCost).length);
  });
});

describe("bulk rating apply (§13.11 Step 5, §13.10)", { skip }, () => {
  test("one change across tables, undone as one", async () => {
    const { ids, mccmnc } = await twoFreeTables();
    const p = await ok(
      "previewRateBulk",
      post("/rate-bulk/preview", { rateTableIds: ids, mccmncs: [mccmnc], action: { type: "change_pct", value: -3 } }),
    );
    const rows: Row[] = p.rows.filter((r: Row) => r.edit === "set");
    assert.ok(rows.length >= 2);
    const saved = await ok(
      "applyRateBulk",
      post("/rate-bulk/apply", {
        items: rows.map((r) => ({ rateTableId: r.rateTableId, action: "set", lineId: r.lineId, rate: r.newRate })),
      }),
    );
    assert.equal(saved.applied, rows.length);
    assert.equal(saved.tables, 2);
    assert.deepEqual(new Set(saved.change.entityIds), new Set(ids));
    assert.equal(saved.change.changeType, "bulk");
    const now = await db().query(
      `SELECT rate_table_id, rate FROM rate_lines WHERE rate_table_id = ANY($1) AND mccmnc = $2 AND sender_id IS NULL
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
      [ids, mccmnc],
    );
    for (const r of rows.filter((x) => x.lineId !== null && (x as Row & { senderId: string | null }).senderId === null))
      assert.equal(Number(now.rows.find((x) => x.rate_table_id === r.rateTableId)!.rate), r.newRate);
    const u = await ok(
      "undoChange",
      app.inject({ method: "POST", url: `${API_PREFIX}/changes/${saved.change.id}/undo`, payload: {} }),
    );
    assert.deepEqual(new Set(u.entityIds), new Set(ids));
    const back = await ok(
      "previewRateBulk",
      post("/rate-bulk/preview", { rateTableIds: ids, mccmncs: [mccmnc], action: { type: "change_pct", value: -3 } }),
    );
    assert.deepEqual(
      back.rows.map((r: Row) => r.currentRate),
      p.rows.map((r: Row) => r.currentRate),
    );
  });

  test("notice periods: flagged, moved, or 409 on apply", async () => {
    const { rows } = await db().query(
      `SELECT rt.id FROM rate_tables rt WHERE rt.kind = 'customer' AND rt.deleted_at IS NULL AND NOT ${NO_NOTICE}
          AND EXISTS (SELECT 1 FROM rate_lines l WHERE l.rate_table_id = rt.id AND l.valid_to IS NULL AND l.valid_from <= now())
        ORDER BY rt.id LIMIT 1`,
    );
    const id = rows[0].id;
    const body = { rateTableIds: [id], action: { type: "change_pct", value: 10 } };
    const p = await ok("previewRateBulk", post("/rate-bulk/preview", body));
    const up = p.rows.filter((r: Row) => r.change === "increase");
    assert.ok(up.length && up.every((r: Row) => r.noticeBreach));
    const moved = await ok("previewRateBulk", post("/rate-bulk/preview", { ...body, respectNotice: true }));
    const m = moved.rows.find((r: Row) => r.change === "increase");
    assert.ok(m.noticeAdjusted && !m.noticeBreach);
    assert.ok(Date.parse(m.effectiveFrom) > Date.now() + 86_400_000 - 120_000);
    const r = up[0] as Row;
    const res = await post("/rate-bulk/apply", {
      items: [{ rateTableId: id, action: "set", lineId: r.lineId, rate: r.newRate }],
    });
    assert.equal(res.statusCode, 409, res.body);
    check("applyRateBulk", res);
    assert.equal(res.json().breaches[0].rateTableId, id);
  });

  test("apply rejects rows of unknown tables or lines", async () => {
    const { ids } = await twoFreeTables();
    const r = await post("/rate-bulk/apply", {
      items: [
        { rateTableId: 99_999_999, action: "close", lineId: 1 },
        { rateTableId: ids[0], action: "set", mccmnc: "99999", rate: 0.01 },
      ],
    });
    assert.equal(r.statusCode, 400, r.body);
    check("applyRateBulk", r);
    const r2 = await post("/rate-bulk/apply", { items: [{ rateTableId: ids[0], action: "close", lineId: 1 }] });
    assert.equal(r2.statusCode, 400);
    assert.match(r2.body, /not in this table/);
  });
});
