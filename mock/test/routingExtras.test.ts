// Route map, Re-rating and QBR stats (build step 5.2, §6.3, §12.2). Every response is checked
// against the contract. Needs the seeded database; re-rating and QBR figures need ClickHouse.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change, ReratingDetail } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { chRows } from "../src/edr.js";
import { processRerating } from "../src/api/rerating.js";
import { refreshQbrStats } from "../src/api/qbr.js";
import { currentUserId } from "../src/api/session.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const edrs = ready ? (await chRows<{ n: string }>("SELECT count() AS n FROM edr", 5000)) !== null : false;
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const skipEdr = skip || (edrs ? false : "EDR store (ClickHouse) not available");
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f();
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
const trunkFilter = (id: number, ...more: object[]) => ({
  logic: "and",
  conditions: [{ field: "customerTrunkId", op: "eq", value: id }, ...more],
});

describe("route map", { skip }, () => {
  test("needs a trunk; routes every destination the trunk sells; filters and sorts on computed columns", async () => {
    const trunk = (
      await db().query(
        `SELECT x.customer_trunk_id AS id, count(DISTINCT l.mccmnc)::int AS n FROM customer_trunk_rate_tables x
           JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
           JOIN rate_lines l ON l.rate_table_id = x.rate_table_id AND l.valid_to IS NULL AND l.valid_from <= now()
          GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
      )
    ).rows[0];
    const bad = await call("POST", "/route-map/query", { limit: 5 });
    assert.equal(bad.statusCode, 400, "a route map is per customer trunk");
    const page = await ok(
      "queryRouteMap",
      call("POST", "/route-map/query", { limit: 50, filter: trunkFilter(trunk.id) }),
    );
    assert.ok(page.total >= Math.min(trunk.n, 1), "one row per destination sold");
    const statuses = new Set(page.rows.map((r: { status: string }) => r.status));
    assert.ok(statuses.size >= 1);
    for (const r of page.rows) {
      if (r.status === "routed") {
        assert.ok(r.vendor && r.ruleId, "a routed row names its rule and vendor");
        if (r.vendorCost !== null) assert.equal(r.margin, Math.round((r.sellRateConverted - r.vendorCost) * 1e6) / 1e6);
      } else assert.equal(r.vendor, null);
    }
    // Filter and sort on computed columns run on the server (§13.25).
    const routed = await ok(
      "queryRouteMap",
      call("POST", "/route-map/query", {
        limit: 20,
        sort: [{ field: "margin", dir: "asc" }],
        filter: trunkFilter(trunk.id, { field: "status", op: "in", values: ["routed"] }),
      }),
    );
    const margins = routed.rows
      .map((r: { margin: number | null }) => r.margin)
      .filter((m: number | null) => m !== null);
    assert.deepEqual(
      margins,
      [...margins].sort((a: number, b: number) => a - b),
    );
    assert.ok(routed.rows.every((r: { status: string }) => r.status === "routed"));
    const csv = String(
      await ok("exportRouteMap", call("POST", "/route-map/export", { filter: trunkFilter(trunk.id) })),
    );
    assert.match(csv, /^Country,Network,MCCMNC,Sell rate/);
    assert.equal(csv.trim().split("\r\n").length, page.total + 1);
  });
});

describe("re-rating", { skip: skipEdr }, () => {
  /** A customer table with traffic in the EDR store, its enterprise and a day with EDRs. */
  async function scope() {
    const rows = await chRows<{ t: number; e: number; d: string; n: string }>(
      `SELECT c_rate_table_id AS t, c_enterprise_id AS e, toString(toDate(submit_time)) AS d, count() AS n
         FROM edr WHERE c_rate_table_id > 0 GROUP BY t, e, d ORDER BY n DESC LIMIT 1`,
      15_000,
    );
    const r = rows![0]!;
    return { rateTableId: Number(r.t), enterpriseId: Number(r.e), day: r.d, n: Number(r.n) };
  }
  const input = (s: Awaited<ReturnType<typeof scope>>) => ({
    description: "Test re-rating",
    startDate: s.day,
    endDate: s.day,
    side: "customer" as const,
    enterpriseIds: [s.enterpriseId],
    rateTableId: s.rateTableId,
    reason: "rate_correction" as const,
    mccmncs: [],
    senderId: null,
    noNote: false,
    priority: "P2" as const,
  });

  test("preview counts the EDRs in scope; wrong side or dates are refused", async () => {
    const s = await scope();
    const preview = await ok("previewRerating", call("POST", "/rerating-requests/preview", input(s)));
    assert.equal(preview.totalEdrs, s.n, "every EDR of the day billed with the table");
    assert.equal(
      preview.rows[0].transactionStatus === "pending" || preview.rows[0].transactionStatus === "no_difference",
      true,
    );
    const wrongSide = await call("POST", "/rerating-requests/preview", { ...input(s), side: "vendor" });
    assert.equal(wrongSide.statusCode, 400, "a vendor re-rating needs a vendor table");
    const backwards = await call("POST", "/rerating-requests/preview", { ...input(s), endDate: "2026-01-01" });
    assert.equal(backwards.statusCode, 400);
  });

  test("maker-checker: the requester edits but cannot approve; another user's request is approved and processed", async () => {
    const s = await scope();
    const created = await ok("createReratingRequest", call("POST", "/rerating-requests", input(s)), 201);
    const id = created.record.id as number;
    cleanup.push(() => db().query("DELETE FROM rerating_requests WHERE id = $1", [id]));
    assert.equal(created.record.requestStatus, "pending_approval");
    assert.equal(created.record.canEdit, true);
    assert.equal(created.record.canDecide, false);
    const own = await call("POST", `/rerating-requests/${id}/approve`);
    assert.equal(own.statusCode, 403, "the requester never approves their own request");
    check("approveReratingRequest", own);
    const edited = await ok(
      "updateReratingRequest",
      call("PUT", `/rerating-requests/${id}`, { ...input(s), priority: "P1" }),
    );
    assert.deepEqual(
      edited.change.diff.map((d: { field: string }) => d.field),
      ["priority"],
    );
    const undo = await call("POST", `/changes/${(edited.change as Change).id}/undo`, {});
    assert.equal(undo.statusCode, 400, "re-rating requests are not undone");

    // A request made by someone else, approved by the signed-in user.
    const other = (await db().query("SELECT id FROM users WHERE id <> $1 ORDER BY id LIMIT 1", [currentUserId()]))
      .rows[0].id;
    const { rows } = await db().query(
      `INSERT INTO rerating_requests (side, start_date, end_date, enterprise_ids, rate_table_id, mccmncs, priority,
         requested_by_id, updated_by_id)
       VALUES ('customer', $1, $1, $2, $3, '{}', 'P2', $4, $4) RETURNING id`,
      [s.day, [s.enterpriseId], s.rateTableId, other],
    );
    const theirs = rows[0].id as number;
    cleanup.push(async () => {
      const { rows: tx } = await db().query("SELECT transaction_id FROM rerating_results WHERE request_id = $1", [
        theirs,
      ]);
      await db().query("DELETE FROM rerating_results WHERE request_id = $1", [theirs]);
      await db().query("DELETE FROM transactions WHERE id = ANY($1)", [
        tx.map((t) => t.transaction_id).filter(Boolean),
      ]);
      await db().query("DELETE FROM rerating_requests WHERE id = $1", [theirs]);
    });
    const approved = await ok("approveReratingRequest", call("POST", `/rerating-requests/${theirs}/approve`));
    assert.equal(approved.record.requestStatus, "approved");
    assert.equal(approved.record.reprocessStatus, "in_queue");
    await processRerating(db(), theirs, currentUserId());
    const done: ReratingDetail = await ok("getReratingRequest", call("GET", `/rerating-requests/${theirs}`));
    assert.equal(done.reprocessStatus, "completed", done.error ?? "");
    assert.equal(done.totalEdrs, s.n);
    assert.equal(done.summary.length, 1);
    const row = done.summary[0]!;
    if (row.amount !== 0) {
      assert.equal(row.transactionStatus, "posted");
      const { rows: tx } = await db().query("SELECT transaction_type, amount FROM transactions WHERE id = $1", [
        row.transactionId,
      ]);
      assert.equal(tx[0].transaction_type, "reprocess");
      // The difference is calculated to 6 decimals; the posted transaction keeps 4 (Q20, backend step 12).
      assert.equal(Number(tx[0].amount), Math.round(Math.abs(row.amount) * 10_000) / 10_000);
    } else assert.equal(row.transactionStatus, "no_difference");
    const again = await call("POST", `/rerating-requests/${theirs}/decline`, { reason: "late" });
    assert.equal(again.statusCode, 409, "a decided request cannot be decided again");
    const list = await ok(
      "queryReratingRequests",
      call("POST", "/rerating-requests/query", {
        limit: 5,
        filter: { logic: "and", conditions: [{ field: "requestStatus", op: "in", values: ["pending_approval"] }] },
      }),
    );
    assert.ok(list.rows.every((r: { requestStatus: string }) => r.requestStatus === "pending_approval"));
  });
});

describe("QBR stats", { skip: skipEdr }, () => {
  test("refresh from the EDR store; side required; vendor override wins until cleared; undo", async () => {
    assert.ok(((await refreshQbrStats()) ?? 0) > 100, "traffic figures for many trunk and destination pairs");
    const noSide = await call("POST", "/qbr-stats/query", { limit: 5 });
    assert.equal(noSide.statusCode, 400);
    const vendors = await ok(
      "queryQbrStats",
      call("POST", "/qbr-stats/query", {
        limit: 5,
        sort: [{ field: "attempts", dir: "desc" }],
        filter: {
          logic: "and",
          conditions: [
            { field: "side", op: "eq", value: "vendor" },
            { field: "overridden", op: "eq", value: false },
          ],
        },
      }),
    );
    const stat = vendors.rows[0];
    assert.ok(stat.attempts > 0 && stat.dlr !== null);
    const set = await ok(
      "setQbrVendorOverride",
      call("PUT", "/qbr-stats/vendor-override", {
        vendorTrunkId: stat.trunkId,
        destinationId: stat.destinationId,
        asr: null,
        dlr: 12.5,
        addSeconds: null,
      }),
    );
    assert.equal(set.record.dlr, 12.5, "the override wins");
    assert.equal(set.record.trafficDlr, stat.dlr, "the traffic figure is kept");
    assert.equal(set.record.asr, stat.asr, "a null override keeps the traffic ASR");
    const cleared = await ok("clearQbrOverride", call("POST", `/qbr-stats/${set.record.id}/clear-override`));
    assert.equal(cleared.record.dlr, stat.dlr);
    // Undo the clear (override back), then the override (gone again).
    await ok("undoChange", call("POST", `/changes/${cleared.change.id}/undo`, {}));
    const { rows } = await db().query("SELECT overridden, override_dlr FROM qbr_stats WHERE id = $1", [set.record.id]);
    assert.equal(rows[0].overridden, true);
    assert.equal(Number(rows[0].override_dlr), 12.5);
    await ok("undoChange", call("POST", `/changes/${set.change.id}/undo`, {}));
    const { rows: after } = await db().query("SELECT overridden FROM qbr_stats WHERE id = $1", [set.record.id]);
    assert.equal(after[0].overridden, false);
  });
});
