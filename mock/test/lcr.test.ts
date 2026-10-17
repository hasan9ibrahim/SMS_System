// Advanced LCR (build step 5.16, §13.23): ranking rules, LCR profiles with undo and safe delete, the
// live LCR table (profile, quality score, point in time, what-if), Least cost route rules using a
// profile (rule Test and Bulk "Apply LCR"), the client view and change alerts. Every response is
// checked against the contract. Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { bestBuySettled } from "../src/api/bestbuy.js";
import { checkLcrChanges } from "../src/api/lcr.js";
import { rankLcr, scores, splitPick, type LcrCandidate } from "../src/lcr/rank.js";

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
const run = Date.now().toString(36);

const cand = (id: number, cost: number, dlr: number | null, over: Partial<LcrCandidate> = {}): LcrCandidate => ({
  vendorTrunkId: id,
  cost,
  asr: 90,
  dlr,
  delayS: 5,
  tier: "tier1",
  atLimit: false,
  ...over,
});
const profileInput = (over: object = {}) => ({
  name: `LCR test ${run}`,
  description: null,
  status: "active",
  vendorTrunkMode: "all",
  vendorTrunkIds: [],
  tiers: [],
  minAsr: null,
  minDlr: null,
  maxDelayS: null,
  maxRate: null,
  vendorCount: 2,
  split: "top_down",
  shares: [],
  tieBreaker: "quality",
  excludeAtTpsLimit: true,
  qualityWeighted: false,
  weights: { cost: 60, asr: 10, dlr: 25, delay: 5 },
  ...over,
});

describe("LCR ranking (§13.23)", () => {
  const list = [cand(1, 0.05, 70), cand(2, 0.04, 95), cand(3, 0.04, 99), cand(4, 0.03, 40, { tier: "tier3" })];
  test("by cost, quality as tie-breaker, profile filters and picks", () => {
    assert.deepEqual(
      rankLcr(list, null).map((r) => r.c.vendorTrunkId),
      [4, 3, 2, 1],
    );
    const p = { ...profileInput(), tiers: ["tier1"], minDlr: 80, vendorCount: 1 } as never;
    const r = rankLcr(list, p);
    assert.deepEqual(
      r.filter((x) => x.rank !== null).map((x) => x.c.vendorTrunkId),
      [3, 2],
    );
    assert.equal(r.find((x) => x.c.vendorTrunkId === 4)!.excluded, "tier3 not allowed");
    assert.equal(r.find((x) => x.c.vendorTrunkId === 1)!.excluded, "DLR below 80 %");
    assert.deepEqual(
      r.filter((x) => x.pick).map((x) => x.c.vendorTrunkId),
      [3],
    );
  });
  test("quality-weighted score lets a dearer, much better vendor rank first", () => {
    const s = scores(list, { cost: 30, asr: 0, dlr: 70, delay: 0 });
    assert.ok(s.get(list[2]!)! > s.get(list[3]!)!);
    assert.equal(
      rankLcr(list, null, { qualityWeighted: true, weights: { cost: 30, asr: 0, dlr: 70, delay: 0 } })[0]!.c
        .vendorTrunkId,
      3,
    );
  });
  test("percentage split", () => {
    const p = { ...profileInput(), vendorCount: 2, split: "percentage", shares: [70, 30] } as never;
    const picks = rankLcr(list, p).filter((x) => x.pick);
    assert.equal(splitPick(picks, 10)[0]!.c.vendorTrunkId, 4);
    assert.equal(splitPick(picks, 85)[0]!.c.vendorTrunkId, 3);
  });
});

describe("LCR profiles, table and rules (§13.23)", { skip }, () => {
  test("profile CRUD, validation, undo", async () => {
    const bad = await call("POST", "/lcr-profiles", profileInput({ split: "percentage", shares: [50, 20] }));
    assert.equal(bad.statusCode, 400);
    check("createLcrProfile", bad);
    const created = await ok("createLcrProfile", call("POST", "/lcr-profiles", profileInput()), 201);
    cleanup.push(() => call("POST", `/lcr-profiles/${created.record.id}/archive`, {}));
    const upd = await ok(
      "updateLcrProfile",
      call("PUT", `/lcr-profiles/${created.record.id}`, profileInput({ minDlr: 85, tiers: ["tier1", "tier2"] })),
    );
    assert.equal(upd.record.minDlr, 85);
    await ok("undoChange", call("POST", `/changes/${upd.change.id}/undo`, {}));
    const back = await ok("getLcrProfile", call("GET", `/lcr-profiles/${created.record.id}`));
    assert.equal(back.minDlr, null);
    assert.deepEqual(back.tiers, []);
    const page = await ok("queryLcrProfiles", call("POST", "/lcr-profiles/query", { search: run, limit: 10 }));
    assert.equal(page.rows[0].id, created.record.id);
  });

  test("LCR table: ranking, profile, point in time, what-if", async () => {
    const r = await call("POST", "/lcr/table", { mccmnc: "99999" });
    assert.equal(r.statusCode, 400);
    const t = await ok("lcrTable", call("POST", "/lcr/table", { mccmnc: "26201" }));
    const ranked = t.rows.filter((x: { rank: number | null }) => x.rank !== null);
    assert.ok(ranked.length > 3);
    for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i].cost >= ranked[i - 1].cost);
    const future = await ok(
      "lcrTable",
      call("POST", "/lcr/table", { mccmnc: "26201", at: new Date(Date.now() + 30 * 86_400_000).toISOString() }),
    );
    assert.ok(future.rows.length > 0);
    const p = await ok(
      "createLcrProfile",
      call("POST", "/lcr-profiles", profileInput({ name: `LCR tier ${run}`, tiers: ["tier1"], vendorCount: 2 })),
      201,
    );
    cleanup.push(() => call("POST", `/lcr-profiles/${p.record.id}/archive`, {}));
    const withP = await ok("lcrTable", call("POST", "/lcr/table", { mccmnc: "26201", profileId: p.record.id }));
    assert.ok(
      withP.rows
        .filter((x: { rank: number | null; tier: string }) => x.rank !== null)
        .every((x: { tier: string }) => x.tier === "tier1"),
    );
    assert.equal(withP.rows.filter((x: { pick: boolean }) => x.pick).length, 2);
    // What-if: without the cheapest vendor the second one leads.
    const top = ranked[0];
    const w = await ok(
      "lcrTable",
      call("POST", "/lcr/table", { mccmnc: "26201", whatIf: { remove: [top.vendorTrunkId], rates: [] } }),
    );
    const first = w.rows.find((x: { rank: number | null }) => x.rank === 1);
    assert.equal(first.vendorTrunkId, ranked[1].vendorTrunkId);
    assert.equal(first.baselineRank, 2);
    assert.equal(
      w.rows.find((x: { vendorTrunkId: number }) => x.vendorTrunkId === top.vendorTrunkId).whatIf,
      "removed",
    );
    assert.ok(w.impact);
    assert.ok(w.impact.clientLines >= w.impact.routesChanged);
  });

  test("a Least cost rule follows its profile; Bulk Apply LCR; safe delete", async () => {
    const { rows: dc } = await db().query(
      "SELECT d.prefix, m.mccmnc FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id WHERE m.mccmnc = '26201' ORDER BY length(d.prefix) DESC LIMIT 1",
    );
    const number = `${dc[0].prefix}1234567`.slice(0, 12);
    const t = await ok("lcrTable", call("POST", "/lcr/table", { mccmnc: "26201" }));
    const ranked = t.rows.filter((x: { rank: number | null; status: string }) => x.rank !== null);
    const { rows: ct } = await db().query(
      "SELECT id FROM customer_trunks WHERE deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1",
    );
    const p = await ok(
      "createLcrProfile",
      call(
        "POST",
        "/lcr-profiles",
        profileInput({
          name: `LCR skip ${run}`,
          vendorTrunkMode: "exclusive",
          vendorTrunkIds: [ranked[0].vendorTrunkId],
          vendorCount: 1,
        }),
      ),
      201,
    );
    const rule = (
      await ok(
        "createRouteRule",
        call("POST", "/route-rules", {
          name: `LCR rule ${run}`,
          priority: 99,
          status: "active",
          routeType: "dynamic",
          huntPolicy: "top_down",
          customerTrunkMode: "inclusive",
          customerTrunkIds: [ct[0].id],
          mccmncMode: "inclusive",
          mccmncs: ["26201"],
          margin: -10,
          lcrProfileId: p.record.id,
          vendors: [],
          whitelists: [],
        }),
        201,
      )
    ).record;
    cleanup.push(() => call("POST", `/route-rules/${rule.id}/archive`, {}));
    assert.equal(rule.lcrProfileId, p.record.id);
    const d = await ok(
      "testRouteRule",
      call("POST", `/route-rules/${rule.id}/test`, { receiver: number, mccmnc: "26201", customerTrunkId: ct[0].id }),
    );
    assert.ok(d.vendor, JSON.stringify({ outcome: d.outcome, checks: d.checks, candidates: d.candidates }));
    assert.equal(d.vendor.decidedBy, "lcr");
    assert.equal(d.vendor.vendorTrunkId, ranked[1].vendorTrunkId, "the profile skips the cheapest vendor");
    // A static rule can't carry a profile.
    const wrong = await call("PUT", `/route-rules/${rule.id}`, { ...rule, routeType: "static", vendors: [] });
    assert.equal(wrong.statusCode, 400);
    // Safe delete: the profile is in use.
    const blocked = await call("POST", `/lcr-profiles/${p.record.id}/archive`, {});
    assert.equal(blocked.statusCode, 409);
    // Bulk Apply LCR with another profile, undone as one.
    const p2 = await ok(
      "createLcrProfile",
      call("POST", "/lcr-profiles", profileInput({ name: `LCR bulk ${run}` })),
      201,
    );
    const bulk = await ok(
      "bulkRouteRules",
      call("POST", "/route-rules/bulk", { ruleIds: [rule.id], action: "set_lcr_profile", lcrProfileId: p2.record.id }),
    );
    assert.equal(bulk.affected, 1);
    assert.equal((await ok("getRouteRule", call("GET", `/route-rules/${rule.id}`))).lcrProfileId, p2.record.id);
    await ok("undoChange", call("POST", `/changes/${bulk.change.id}/undo`, {}));
    assert.equal((await ok("getRouteRule", call("GET", `/route-rules/${rule.id}`))).lcrProfileId, p.record.id);
    await ok("archiveRouteRule", call("POST", `/route-rules/${rule.id}/archive`, {}));
    await ok("archiveLcrProfile", call("POST", `/lcr-profiles/${p.record.id}/archive`, {}));
    await ok("archiveLcrProfile", call("POST", `/lcr-profiles/${p2.record.id}/archive`, {}));
  });

  test("client view and change alerts", async () => {
    assert.equal((await call("POST", "/lcr/client-view", {})).statusCode, 400);
    const { rows: am } = await db().query(
      `SELECT e.id FROM enterprises e JOIN customer_trunks t ON t.enterprise_id = e.id AND t.deleted_at IS NULL
         JOIN customer_trunk_rate_tables x ON x.customer_trunk_id = t.id
        WHERE e.deleted_at IS NULL GROUP BY e.id ORDER BY e.id LIMIT 1`,
    );
    const v = await ok("lcrClientView", call("POST", "/lcr/client-view", { enterpriseId: am[0].id, limit: 20 }));
    assert.ok(v.total > 0);
    for (const r of v.rows) {
      if (r.cost1 !== null) assert.equal(r.belowCost, r.sellRate < r.cost1);
      if (r.cost2 !== null) assert.ok(r.cost2 >= r.cost1);
    }
    for (let i = 1; i < v.rows.length; i++)
      assert.ok((v.rows[i].margin1Pct ?? Infinity) >= (v.rows[i - 1].margin1Pct ?? Infinity));
    const s = await ok("getLcrAlertSettings", call("GET", "/lcr/alert-settings"));
    await ok("updateLcrAlertSettings", call("PUT", "/lcr/alert-settings", { ...s, costMovePct: 4 }));
    await ok("updateLcrAlertSettings", call("PUT", "/lcr/alert-settings", s));
    await checkLcrChanges();
    const ch = await ok("queryLcrChanges", call("POST", "/lcr-changes/query", { limit: 5 }));
    assert.ok(ch.total >= 0);
  });
});
