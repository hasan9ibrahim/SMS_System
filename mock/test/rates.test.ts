// Rate Manager (build step 4.2, §13.12): rate table list and record, the rate grid, rate
// edits with versions, notice check, undo and redo, CSV export and the best-buy view.
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

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return /json/.test(String(r.headers["content-type"])) ? r.json() : r.body;
}

const lines = (tableId: number, extra: object[] = [], more: object = {}) =>
  ok(
    "queryRateLines",
    call("POST", "/rate-lines/query", {
      filter: { logic: "and", conditions: [{ field: "rateTableId", op: "eq", value: tableId }, ...extra] },
      limit: 500,
      ...more,
    }),
  );

const undo = (changeId: number) => ok("undoChange", call("POST", `/changes/${changeId}/undo`, {}));
const run = Date.now().toString(36);

/** A live sell table used by a trunk whose clients have no notice period (edits apply at once). */
async function freeSellTable(): Promise<number> {
  const { rows } = await db().query(
    `SELECT rt.id FROM rate_tables rt
      WHERE rt.kind = 'customer' AND rt.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM rate_lines l WHERE l.rate_table_id = rt.id AND l.valid_from <= now() AND l.valid_to IS NULL AND l.sender_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM customer_trunk_rate_tables x JOIN customer_trunks t ON t.id = x.customer_trunk_id
                         JOIN enterprises e ON e.id = t.enterprise_id WHERE x.rate_table_id = rt.id AND e.rate_notice_days > 0)
      ORDER BY rt.id LIMIT 1`,
  );
  return rows[0].id;
}

describe("rate table list and record (§13.12)", { skip }, () => {
  test("list carries usage, counts and traffic figures; AM filter", async () => {
    const page = await ok("queryRateTables", call("POST", "/rate-tables/query", { limit: 50 }));
    assert.ok(page.total > 0);
    const used = page.rows.find(
      (r: { kind: string; trunkNames: string[] }) => r.kind === "customer" && r.trunkNames.length,
    );
    if (used) assert.ok(used.enterpriseNames.length > 0);
    const neg = await ok(
      "queryRateTables",
      call("POST", "/rate-tables/query", { sort: [{ field: "negativeMarginLines", dir: "desc" }], limit: 5 }),
    );
    assert.ok(neg.rows[0].negativeMarginLines >= (neg.rows[1].negativeMarginLines ?? 0));
    const { rows } = await db().query(
      "SELECT account_manager_id AS am FROM enterprises WHERE type = 'customer' AND deleted_at IS NULL AND account_manager_id IS NOT NULL LIMIT 1",
    );
    const mine = await ok(
      "queryRateTables",
      call("POST", "/rate-tables/query", {
        filter: { logic: "and", conditions: [{ field: "accountManagerId", op: "eq", value: rows[0].am }] },
      }),
    );
    assert.ok(mine.total > 0);
    const bad = await call("POST", "/rate-tables/query", { sort: [{ field: "moneyToday", dir: "desc" }] });
    assert.equal(bad.statusCode, 400, "traffic figures are not sortable");
  });

  test("record summary matches the rate grid", async () => {
    const id = await freeSellTable();
    const t = await ok("getRateTable", call("GET", `/rate-tables/${id}`));
    const current = await lines(id);
    assert.equal(t.summary.activeRates, current.total);
    assert.ok(
      current.rows.every((r: { validFrom: string; validTo: string | null }) => Date.parse(r.validFrom) <= Date.now()),
    );
    assert.equal((await call("GET", "/rate-tables/99999999")).statusCode, 404);
  });

  test("the grid needs a table; views and the negative-margin filter", async () => {
    const res = await call("POST", "/rate-lines/query", { limit: 5 });
    assert.equal(res.statusCode, 400);
    check("queryRateLines", res);
    const { rows } = await db().query("SELECT rate_table_id AS id FROM rate_lines WHERE valid_from > now() LIMIT 1");
    const scheduled = await lines(rows[0].id, [{ field: "view", op: "eq", value: "scheduled" }]);
    assert.ok(scheduled.total > 0);
    assert.ok(scheduled.rows.every((r: { validFrom: string }) => Date.parse(r.validFrom) > Date.now()));
    const { rows: neg } = await db().query(
      "SELECT rate_table_id AS id FROM rate_table_stats WHERE negative_lines > 0 ORDER BY negative_lines DESC LIMIT 1",
    );
    const negative = await lines(neg[0].id, [{ field: "negativeMargin", op: "eq", value: true }]);
    assert.ok(negative.total > 0);
    assert.ok(negative.rows.every((r: { margin: number }) => r.margin < 0));
  });

  test("destinations for the picker", async () => {
    const page = await ok("queryDestinations", call("POST", "/destinations/query", { search: "vodafone", limit: 20 }));
    assert.ok(page.rows.length > 0);
    assert.ok(page.rows.every((r: { network: string }) => /vodafone/i.test(r.network)));
  });

  test("CSV export of a view", async () => {
    const id = await freeSellTable();
    const res = await call("GET", `/rate-tables/${id}/export?view=current`);
    assert.equal(res.statusCode, 200);
    check("exportRateLines", res);
    const rows = res.body.trim().split("\r\n");
    assert.match(rows[0]!, /^Country,Network,MCCMNC/);
    assert.equal(rows.length - 1, (await lines(id)).total);
  });
});

describe("rate edits (§13.12, §13.10)", { skip }, () => {
  test("a new rate opens a version and closes the old one; undo and redo", async () => {
    const id = await freeSellTable();
    const before = (await lines(id)).rows.find(
      (r: { senderId: string | null; validTo: string | null }) => r.senderId === null && !r.validTo,
    );
    const newRate = Math.round((before.rate + 0.0011) * 1e6) / 1e6;
    const saved = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, {
        items: [{ action: "set", lineId: before.id, rate: newRate }],
      }),
    );
    assert.equal(saved.applied, 1);
    const after = (await lines(id, [{ field: "mccmnc", op: "eq", value: before.mccmnc }])).rows.find(
      (r: { senderId: string | null }) => r.senderId === null,
    );
    assert.equal(after.rate, newRate);
    assert.equal(after.changeType, "increase");
    assert.notEqual(after.id, before.id, "a new version, not an edit in place");
    const { rows: old } = await db().query("SELECT valid_to FROM rate_lines WHERE id = $1", [before.id]);
    assert.ok(old[0].valid_to, "the old version is closed");

    const same = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, { items: [{ action: "set", lineId: after.id, rate: newRate }] }),
    );
    assert.equal(same.change, null);
    assert.equal(same.skipped, 1);

    const undone = await undo(saved.change.id);
    const history = await ok(
      "queryChanges",
      call("POST", "/changes/query", {
        filter: {
          logic: "and",
          conditions: [
            { field: "entityType", op: "eq", value: "rate_table" },
            { field: "entityId", op: "eq", value: id },
          ],
        },
        limit: 5,
      }),
    );
    assert.equal(history.rows[0].id, undone.id, "the undo is in the table's change log");
    const { rows: back } = await db().query("SELECT valid_to FROM rate_lines WHERE id = $1", [before.id]);
    assert.equal(back[0].valid_to, null, "undo reopens the old version");
    const { rows: gone } = await db().query("SELECT 1 FROM rate_lines WHERE id = $1", [after.id]);
    assert.equal(gone.length, 0, "and removes the new one");
    await undo(undone.id);
    const { rows: redo } = await db().query("SELECT rate FROM rate_lines WHERE id = $1", [after.id]);
    assert.equal(Number(redo[0].rate), newRate, "undoing the undo applies the rate again");
  });

  test("setting a destination twice in one batch undoes cleanly", async () => {
    const id = await freeSellTable();
    const before = (await lines(id)).rows.find((r: { senderId: string | null }) => r.senderId === null);
    const saved = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, {
        items: [
          { action: "set", lineId: before.id, rate: before.rate + 0.001 },
          { action: "set", lineId: before.id, rate: before.rate + 0.002 },
        ],
      }),
    );
    assert.equal(saved.change.changeType, "bulk");
    await undo(saved.change.id);
    const now = (await lines(id, [{ field: "mccmnc", op: "eq", value: before.mccmnc }])).rows.filter(
      (r: { senderId: string | null }) => r.senderId === null,
    );
    assert.equal(now.length, 1);
    assert.equal(now[0].id, before.id);
    assert.equal(now[0].rate, before.rate);
  });

  test("scheduled rates, closing, blocking and new destinations", async () => {
    const id = await freeSellTable();
    const current = await lines(id);
    const line = current.rows.find(
      (r: { senderId: string | null; nextRate: number | null }) => !r.senderId && !r.nextRate,
    );
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const sched = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, {
        items: [{ action: "set", lineId: line.id, rate: line.rate + 0.0005, effectiveFrom: later }],
      }),
    );
    const row = (await lines(id, [{ field: "id", op: "eq", value: line.id }])).rows[0];
    assert.equal(row.nextRate, Math.round((line.rate + 0.0005) * 1e6) / 1e6, "the current line shows the next rate");
    const scheduledLine = sched.change.diff.find((d: { before: unknown }) => d.before === null).entityId;
    // Closing a scheduled line withdraws it; closing the current one ends it now.
    await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, { items: [{ action: "close", lineId: scheduledLine }] }),
    );
    const { rows: withdrawn } = await db().query("SELECT 1 FROM rate_lines WHERE id = $1", [scheduledLine]);
    assert.equal(withdrawn.length, 0);
    const { rows: reopened } = await db().query("SELECT valid_to FROM rate_lines WHERE id = $1", [line.id]);
    assert.equal(reopened[0].valid_to, null, "the current rate runs on after the scheduled one is withdrawn");
    const blocked = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, {
        items: [{ action: "block", lineId: line.id, blocked: true }],
      }),
    );
    assert.equal((await lines(id, [{ field: "id", op: "eq", value: line.id }])).rows[0].isBlocked, true);
    await undo(blocked.change.id);

    const { rows: free } = await db().query(
      `SELECT m.mccmnc FROM mccmnc m WHERE NOT EXISTS (SELECT 1 FROM rate_lines l WHERE l.rate_table_id = $1 AND l.mccmnc_id = m.id) LIMIT 1`,
      [id],
    );
    const added = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, {
        items: [{ action: "set", mccmnc: free[0].mccmnc, rate: 0.0123, rateNote: `test ${run}` }],
      }),
    );
    const newRow = (await lines(id, [{ field: "mccmnc", op: "eq", value: free[0].mccmnc }])).rows[0];
    assert.equal(newRow.changeType, "new");
    await undo(added.change.id);

    const bad = await call("POST", `/rate-tables/${id}/lines/changes`, {
      items: [
        { action: "set", lineId: line.id, rate: 1, effectiveFrom: "2020-01-01T00:00:00Z" },
        { action: "set", mccmnc: "999999", rate: 1 },
        { action: "close" },
      ],
    });
    assert.equal(bad.statusCode, 400);
    check("changeRateLines", bad);
    const paths = bad.json().errors.map((e: { path: string }) => e.path);
    assert.ok(paths.includes("/items/0/effectiveFrom"));
    assert.ok(paths.includes("/items/1/mccmnc"));
    assert.ok(paths.includes("/items/2/lineId"));
  });

  test("increases sooner than a client's notice period answer 409 until accepted (§13.14)", async () => {
    const { rows } = await db().query(
      `SELECT x.rate_table_id AS id, max(e.rate_notice_days) AS days FROM customer_trunk_rate_tables x
         JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
         JOIN enterprises e ON e.id = t.enterprise_id
         JOIN rate_tables rt ON rt.id = x.rate_table_id AND rt.deleted_at IS NULL
        WHERE e.rate_notice_days > 0 GROUP BY 1 LIMIT 1`,
    );
    const id = rows[0].id;
    const line = (await lines(id)).rows.find((r: { senderId: string | null }) => !r.senderId);
    const body = { items: [{ action: "set", lineId: line.id, rate: line.rate + 0.01 }] };
    const res = await call("POST", `/rate-tables/${id}/lines/changes`, body);
    assert.equal(res.statusCode, 409);
    check("changeRateLines", res);
    assert.equal(res.json().breaches[0].noticeDays, rows[0].days);
    const { rows: still } = await db().query("SELECT valid_to FROM rate_lines WHERE id = $1", [line.id]);
    assert.equal(still[0].valid_to, null, "nothing was applied");
    const later = new Date(Date.now() + (rows[0].days + 1) * 86_400_000).toISOString();
    const onTime = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, { items: [{ ...body.items[0], effectiveFrom: later }] }),
    );
    await undo(onTime.change.id);
    const accepted = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${id}/lines/changes`, { ...body, acceptNoticeBreach: true }),
    );
    assert.match(accepted.change.note, /Short notice accepted/);
    await undo(accepted.change.id);
  });

  test("a cheaper vendor rate becomes the best buy after the background refresh", async () => {
    const { rows } = await db().query(
      `SELECT bb.rate_line_id, bb.mccmnc_id, bb.product_category_id, l.rate, l.rate_table_id
         FROM best_buy_rates bb JOIN rate_lines l ON l.id = bb.rate_line_id
        WHERE EXISTS (SELECT 1 FROM rate_lines c JOIN rate_tables ct ON ct.id = c.rate_table_id AND ct.kind = 'customer'
                       AND ct.product_category_id = bb.product_category_id
                      WHERE c.mccmnc_id = bb.mccmnc_id AND c.valid_from <= now() AND c.valid_to IS NULL)
        LIMIT 1`,
    );
    const b = rows[0];
    const cheaper = Math.round(Number(b.rate) * 0.5 * 1e6) / 1e6;
    const saved = await ok(
      "changeRateLines",
      call("POST", `/rate-tables/${b.rate_table_id}/lines/changes`, {
        items: [{ action: "set", lineId: b.rate_line_id, rate: cheaper }],
      }),
    );
    await bestBuySettled();
    const { rows: now } = await db().query(
      "SELECT l.rate FROM best_buy_rates bb JOIN rate_lines l ON l.id = bb.rate_line_id WHERE bb.mccmnc_id = $1 AND bb.product_category_id = $2",
      [b.mccmnc_id, b.product_category_id],
    );
    assert.equal(Number(now[0].rate), cheaper);
    await undo(saved.change.id);
    await bestBuySettled();
  });
});

describe("rate table records and safe delete (§6.2, §13.29)", { skip }, () => {
  test("add from a vendor's rates plus margin, rename, archive and restore", async () => {
    const { rows } = await db().query(
      `SELECT vt.id, rt.id AS table_id, rt.product_category_id AS cat FROM vendor_trunks vt JOIN rate_tables rt ON rt.vendor_trunk_id = vt.id
        WHERE vt.deleted_at IS NULL AND rt.currency = 'USD'
          AND EXISTS (SELECT 1 FROM rate_lines l WHERE l.rate_table_id = rt.id AND l.valid_to IS NULL AND l.valid_from <= now())
        LIMIT 1`,
    );
    const v = rows[0];
    const created = await ok(
      "createRateTable",
      call("POST", "/rate-tables", {
        name: `Test_Sell_${run}`,
        categoryId: v.cat,
        currency: "USD",
        copyFrom: { vendorTrunkId: v.id, marginPct: 10 },
      }),
      201,
    );
    const id = created.record.id;
    const { rows: src } = await db().query(
      "SELECT count(*)::int AS n FROM rate_lines WHERE rate_table_id = $1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())",
      [v.table_id],
    );
    assert.equal(created.record.summary.activeRates, src[0].n);
    const listed = await ok(
      "queryRateTables",
      call("POST", "/rate-tables/query", {
        filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: id }] },
      }),
    );
    assert.equal(listed.rows[0].activeLines, src[0].n, "the list counts are refreshed with the save");

    const dup = await call("POST", "/rate-tables", { name: `test_sell_${run}`, categoryId: v.cat, currency: "USD" });
    assert.equal(dup.statusCode, 400);
    check("createRateTable", dup);
    const renamed = await ok("updateRateTable", call("PUT", `/rate-tables/${id}`, { name: `Test_Sell_${run}_B` }));
    assert.equal(renamed.change.diff[0].field, "name");

    const archived = await ok("archiveRateTable", call("POST", `/rate-tables/${id}/archive`, {}));
    assert.ok(archived.record.archived);
    await ok("restoreRateTable", call("POST", `/rate-tables/${id}/restore`));
    const vendorArchive = await call("POST", `/rate-tables/${v.table_id}/archive`, {});
    assert.equal(vendorArchive.statusCode, 403, "a buy table goes with its vendor trunk");
    check("archiveRateTable", vendorArchive);
  });

  test("a table that prices trunks can't be deleted until detached", async () => {
    const { rows } = await db().query(
      `SELECT x.rate_table_id AS id FROM customer_trunk_rate_tables x JOIN customer_trunks t ON t.id = x.customer_trunk_id
        JOIN rate_tables rt ON rt.id = x.rate_table_id WHERE t.deleted_at IS NULL AND rt.deleted_at IS NULL LIMIT 1`,
    );
    const deps = await ok("getRateTableDependencies", call("GET", `/rate-tables/${rows[0].id}/dependencies`));
    assert.equal(deps.blocked, true);
    const res = await call("POST", `/rate-tables/${rows[0].id}/archive`, {});
    assert.equal(res.statusCode, 409);
    check("archiveRateTable", res);
  });
});
