// Market rate movements (build step 5.15, §13.14): the detection rules, a move created from real
// vendor rate changes, affected clients and suggested rates, actions and their log, auto-apply rules,
// settings, and Bulk rating pre-filled with suggested rates. Every response is checked against the
// contract. Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { bestBuySettled } from "../src/api/bestbuy.js";
import { findMoves, suggestRate } from "../src/market/detect.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
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
  return r.json();
}

const DAY = 86_400_000;
const ch = (vendorTrunkId: number, day: number, oldUsd: number, newUsd: number) => ({
  vendorTrunkId,
  at: Date.UTC(2026, 9, 1) + day * DAY,
  oldUsd,
  newUsd,
});

describe("detection rules (§13.14)", () => {
  const rule = { windowDays: 7, minVendors: 2, minChangePct: 3 };
  test("two vendors up within the window make one move", () => {
    const m = findMoves([ch(1, 0, 1, 1.08), ch(2, 5, 1, 1.05), ch(3, 20, 1, 1.1)], rule);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.direction, "up");
    assert.deepEqual(
      m[0]!.changes.map((c) => c.vendorTrunkId),
      [1, 2],
    );
    assert.equal(m[0]!.avgChangePct, 6.5);
  });
  test("too small, too far apart, opposite directions or one vendor: no move", () => {
    assert.equal(findMoves([ch(1, 0, 1, 1.02), ch(2, 1, 1, 1.02)], rule).length, 0);
    assert.equal(findMoves([ch(1, 0, 1, 1.1), ch(2, 8, 1, 1.1)], rule).length, 0);
    assert.equal(findMoves([ch(1, 0, 1, 1.1), ch(2, 1, 1, 0.9)], rule).length, 0);
    assert.equal(findMoves([ch(1, 0, 1, 1.1), ch(1, 2, 1.1, 1.2)], rule).length, 0);
    const down = findMoves([ch(1, 0, 1, 0.9), ch(2, 1, 1, 0.95), ch(3, 2, 1, 0.92)], rule);
    assert.equal(down[0]!.direction, "down");
    assert.equal(down[0]!.changes.length, 3);
  });
  test("suggested rate keeps the client's margin, or the target when higher", () => {
    assert.equal(suggestRate(0.1, 0.08, 0.088, null), 0.11, "20 % margin kept");
    assert.equal(suggestRate(0.1, 0.095, 0.1, 10), 0.111111, "target 10 % beats 5 %");
    assert.equal(suggestRate(0.1, null, null, null), null);
  });
});

describe("market moves (§13.14)", { skip }, () => {
  test("settings, scan, list, summary", async () => {
    const s = await ok("getMarketMoveSettings", call("GET", "/market-moves/settings"));
    assert.equal(s.cheapestN, 3);
    const back = await ok("updateMarketMoveSettings", call("PUT", "/market-moves/settings", { ...s, urgentDays: 5 }));
    assert.equal(back.urgentDays, 5);
    await ok("updateMarketMoveSettings", call("PUT", "/market-moves/settings", s));
    const r = await ok("scanMarketMoves", call("POST", "/market-moves/scan"));
    assert.ok(r.created + r.updated >= 0);
    const page = await ok(
      "queryMarketMoves",
      call("POST", "/market-moves/query", {
        filter: { logic: "and", conditions: [{ field: "state", op: "in", values: ["open", "snoozed"] }] },
        limit: 20,
      }),
    );
    assert.ok(page.total > 0, "the seeded vendor rates contain moves");
    const sum = await ok("getMarketMoveSummary", call("GET", "/market-moves/summary"));
    assert.equal(sum.open, sum.up + sum.down);
    const { rows: am } = await db().query(
      "SELECT unnest(affected_am_ids) AS id FROM market_moves WHERE state = 'open' LIMIT 1",
    );
    if (am[0]) {
      const mine = await ok(
        "queryMarketMoves",
        call("POST", "/market-moves/query", {
          filter: { logic: "and", conditions: [{ field: "amUserId", op: "eq", value: Number(am[0].id) }] },
          limit: 5,
        }),
      );
      assert.ok(mine.total > 0 && mine.total <= page.total + 100000);
    }
  });

  test("a move from two cheapest vendors' increases, with auto-apply and Bulk rating suggestions", async () => {
    // A destination sold by a client, and its two cheapest live vendors.
    const { rows: d } = await db().query(
      `SELECT l.mccmnc_id, l.mccmnc, rt.id AS table_id, rt.currency, l.rate, t.enterprise_id
         FROM rate_lines l JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'customer' AND rt.deleted_at IS NULL
         JOIN customer_trunk_rate_tables x ON x.rate_table_id = rt.id
         JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
        WHERE l.sender_id IS NULL AND l.valid_from <= now() AND l.valid_to IS NULL AND length(l.mccmnc) = 5
        ORDER BY l.id LIMIT 1`,
    );
    const dest = d[0];
    const { rows: v } = await db().query(
      `SELECT rt.id AS table_id, l.id AS line_id, l.rate FROM rate_lines l
         JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
         JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id AND vt.deleted_at IS NULL AND vt.status = 'active'
         JOIN currency_latest cl ON cl.iso = l.currency
        WHERE l.mccmnc_id = $1 AND l.sender_id IS NULL AND NOT l.is_blocked AND l.valid_from <= now()
          AND (l.valid_to IS NULL OR l.valid_to > now())
        ORDER BY l.rate / cl.rate_per_eur LIMIT 2`,
      [dest.mccmnc_id],
    );
    assert.equal(v.length, 2);
    const rule = await ok(
      "createMarketAutoRule",
      call("POST", "/market-moves/auto-rules", {
        enterpriseId: dest.enterprise_id,
        categoryId: null,
        direction: "increases",
        minMarginPct: 80,
        status: "active",
      }),
      201,
    );
    cleanup.push(() => call("POST", `/market-moves/auto-rules/${rule.id}/archive`));
    const bad = await call("POST", "/market-moves/auto-rules", {
      enterpriseId: null,
      categoryId: null,
      direction: "both",
      minMarginPct: 5,
      status: "active",
    });
    assert.equal(bad.statusCode, 400);
    // Two increases an hour apart, at a time of day that differs per run so the move is new.
    const at = new Date(Math.ceil(Date.now() / DAY) * DAY + 2 * DAY + Math.floor((Date.now() % DAY) / 1000) * 1000);
    for (const [i, x] of v.entries()) {
      const saved = await ok(
        "changeRateLines",
        call("POST", `/rate-tables/${x.table_id}/lines/changes`, {
          items: [
            {
              action: "set",
              lineId: Number(x.line_id),
              rate: Math.round(Number(x.rate) * 1.09 * 1e6) / 1e6,
              effectiveFrom: new Date(at.getTime() + i * 3600_000).toISOString(),
            },
          ],
        }),
      );
      cleanup.push(() => call("POST", `/changes/${saved.change.id}/undo`, {}));
    }
    const scan = await ok("scanMarketMoves", call("POST", "/market-moves/scan"));
    assert.ok(scan.created >= 1);
    const { rows: mv } = await db().query(
      "SELECT id FROM market_moves WHERE mccmnc_id = $1 AND direction = 'up' AND first_effective = $2",
      [dest.mccmnc_id, at],
    );
    assert.equal(mv.length, 1, "the move is recorded");
    const id = Number(mv[0].id);
    const move = await ok("getMarketMove", call("GET", `/market-moves/${id}`));
    assert.ok(move.movedCount >= 2);
    assert.ok(move.newCost > move.oldCost, "the market cost rises");
    assert.ok(move.vendors.filter((x: { moved: boolean }) => x.moved).length >= 2);
    const client = move.clients.find((c: { rateTableId: number }) => c.rateTableId === Number(dest.table_id));
    assert.ok(client);
    assert.ok(client.suggestedRate > 0);
    assert.ok(Date.parse(client.suggestedFrom) >= Date.parse(move.lastEffective) - 1000);
    assert.match(client.autoRule, /keep margin ≥ 80/);
    assert.ok(move.autoApplied >= 1, "the rule re-priced the client");
    const { rows: auto } = await db().query("SELECT id FROM changes WHERE note LIKE $1 ORDER BY id", [
      `Auto-apply after market move #${id} %`,
    ]);
    assert.ok(auto.length >= 1);
    for (const a of auto) cleanup.push(() => call("POST", `/changes/${a.id}/undo`, {}));

    // Actions are logged; dismiss needs a note.
    assert.equal((await call("POST", `/market-moves/${id}/action`, { action: "dismiss" })).statusCode, 400);
    const sn = await ok("actOnMarketMove", call("POST", `/market-moves/${id}/action`, { action: "snooze", days: 3 }));
    assert.equal(sn.state, "snoozed");
    const ho = await ok(
      "actOnMarketMove",
      call("POST", `/market-moves/${id}/action`, { action: "handled", note: "Clients re-priced" }),
    );
    assert.equal(ho.state, "handled");
    assert.equal(ho.handledBy !== null, true);
    assert.deepEqual(
      ho.log.slice(-2).map((g: { text: string }) => g.text),
      ["Snoozed for 3 days", "Marked handled: Clients re-priced"],
    );

    // Bulk rating pre-filled with the suggestion (action none + overrides).
    const pre = await ok(
      "previewRateBulk",
      call("POST", "/rate-bulk/preview", {
        rateTableIds: [Number(dest.table_id)],
        mccmncs: [dest.mccmnc],
        action: { type: "none" },
        respectNotice: true,
        overrides: [
          {
            rateTableId: Number(dest.table_id),
            mccmnc: dest.mccmnc,
            rate: client.suggestedRate,
            effectiveFrom: client.suggestedFrom,
          },
        ],
      }),
    );
    const row = pre.rows.find((r: { senderId: string | null }) => r.senderId === null);
    assert.equal(row.newRate, client.suggestedRate);
    assert.ok(Date.parse(row.effectiveFrom) >= Date.parse(client.suggestedFrom) - 1000);
  });

  test("hand-picked top vendors per destination (team trial round 5)", async () => {
    // A destination priced by at least four live vendor trunks.
    const { rows: d } = await db().query(
      `SELECT l.mccmnc_id, l.mccmnc FROM rate_lines l
         JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
         JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id AND vt.deleted_at IS NULL AND vt.status = 'active'
        WHERE l.sender_id IS NULL AND NOT l.is_blocked AND l.valid_from <= now() AND l.valid_to IS NULL
          AND length(l.mccmnc) = 5
        GROUP BY 1, 2 HAVING count(DISTINCT vt.id) >= 4 ORDER BY 1 LIMIT 1`,
    );
    const code = String(d[0].mccmnc);
    const cand = await ok(
      "marketTopVendorCandidates",
      call("GET", `/market-moves/top-vendors/candidates?mccmnc=${code}`),
    );
    assert.ok(cand.vendors.length >= 4);
    const rates = cand.vendors.map((v: { rateEur: number }) => v.rateEur);
    assert.deepEqual(
      rates,
      [...rates].sort((a, b) => a - b),
      "cheapest first",
    );
    // Pick the 3rd and 4th cheapest, without Tier 1: only they count.
    const picked = cand.vendors.slice(2, 4).map((v: { vendorTrunkId: number }) => v.vendorTrunkId);
    const bad = await call("PUT", "/market-moves/top-vendors", {
      mccmncs: [code],
      vendorTrunkIds: [],
      includeTier1: false,
    });
    assert.equal(bad.statusCode, 400, "a list needs vendors or Tier 1");
    await ok(
      "saveMarketTopVendors",
      call("PUT", "/market-moves/top-vendors", { mccmncs: [code], vendorTrunkIds: picked, includeTier1: false }),
    );
    cleanup.push(() => call("POST", "/market-moves/top-vendors/remove", { mccmncs: [code] }));
    const list = await ok("listMarketTopVendors", call("GET", `/market-moves/top-vendors?search=${code}`));
    const row = list.rows.find((r: { mccmnc: string }) => r.mccmnc === code);
    assert.deepEqual(row.vendors.map((v: { vendorTrunkId: number }) => v.vendorTrunkId).sort(), [...picked].sort());
    assert.equal(row.includeTier1, false);
    // Both picked vendors raise their rate: one move, counting only the two picked trunks.
    const at = new Date(Math.ceil(Date.now() / DAY) * DAY + 3 * DAY + Math.floor((Date.now() % DAY) / 1000) * 1000);
    for (const [i, vt] of picked.entries()) {
      const { rows: l } = await db().query(
        `SELECT l.id, l.rate, rt.id AS table_id FROM rate_lines l JOIN rate_tables rt ON rt.id = l.rate_table_id
          WHERE rt.vendor_trunk_id = $1 AND rt.kind = 'vendor' AND rt.deleted_at IS NULL AND l.mccmnc_id = $2
            AND l.sender_id IS NULL AND l.valid_from <= now() AND l.valid_to IS NULL LIMIT 1`,
        [vt, d[0].mccmnc_id],
      );
      const saved = await ok(
        "changeRateLines",
        call("POST", `/rate-tables/${l[0].table_id}/lines/changes`, {
          items: [
            {
              action: "set",
              lineId: Number(l[0].id),
              rate: Math.round(Number(l[0].rate) * 1.09 * 1e6) / 1e6,
              effectiveFrom: new Date(at.getTime() + i * 3600_000).toISOString(),
            },
          ],
        }),
      );
      cleanup.push(() => call("POST", `/changes/${saved.change.id}/undo`, {}));
    }
    await ok("scanMarketMoves", call("POST", "/market-moves/scan"));
    const { rows: mv } = await db().query(
      "SELECT top_count, moved_count FROM market_moves WHERE mccmnc_id = $1 AND direction = 'up' AND first_effective = $2",
      [d[0].mccmnc_id, at],
    );
    assert.equal(mv.length, 1, "the move is recorded");
    assert.equal(Number(mv[0].top_count), 2, "only the hand-picked trunks count");
    assert.equal(Number(mv[0].moved_count), 2);
    const gone = await ok(
      "removeMarketTopVendors",
      call("POST", "/market-moves/top-vendors/remove", { mccmncs: [code] }),
    );
    assert.equal(gone.sent, 1);
  });

  test("digest e-mail per account manager", async () => {
    const r = await ok("sendMarketMoveDigest", call("POST", "/market-moves/digest"));
    assert.ok(r.sent >= 0);
    const again = await ok("sendMarketMoveDigest", call("POST", "/market-moves/digest"));
    assert.equal(again.sent, 0, "each move is in one digest only");
  });
});
