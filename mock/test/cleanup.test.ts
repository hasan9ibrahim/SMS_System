// Cleanup Center (build step 5.19, §13.19, §13.20): the scan's findings (the redundancy fixture gives
// every kind), the card with its records and preview, the 24-hour replay, apply as one undoable change
// (merge, reorder, archive), ignore and reopen, approval, the duplicate warning on save and the weekly
// summary. Every response is checked against the contract. Needs the seeded database with fixtures.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { sendWeeklySummary } from "../src/api/cleanup.js";
import { normName } from "../src/api/cleanup.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
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
  return r.json();
}
const findings = (kinds: string[], extra: object[] = []) =>
  ok(
    "queryCleanupFindings",
    call("POST", "/cleanup-findings/query", {
      filter: {
        logic: "and",
        conditions: [
          { field: "kind", op: "in", values: kinds },
          { field: "state", op: "in", values: ["open"] },
          ...extra,
        ],
      },
      sort: [{ field: "id", dir: "asc" }],
      limit: 100,
    }),
  );
const undo = (id: number) => ok("undoChange", call("POST", `/changes/${id}/undo`, {}));

describe("normalised names", () => {
  test("punctuation, case and legal form do not make a different company", () => {
    assert.equal(normName("Zarisria Mobile Ltd"), normName("ZARISRIA MOBILE LTD."));
    assert.notEqual(normName("Zarisria Mobile"), normName("Zarisria Media"));
  });
});

describe("Cleanup Center (§13.19, §13.20)", { skip }, () => {
  before(async () => {
    await ok("scanCleanup", call("POST", "/cleanup/scan"));
  });

  test("the scan finds every kind, with counts by area", async () => {
    const s = await ok("getCleanupSummary", call("GET", "/cleanup/summary"));
    assert.ok(s.lastScanAt);
    assert.equal(
      s.open,
      Object.values(s.byArea as Record<string, number>).reduce((a, b) => a + b, 0),
    );
    const kinds = new Set(s.byKind.map((k: { kind: string }) => k.kind));
    for (const k of [
      "route_rule_identical",
      "route_rule_near_duplicate",
      "route_rule_conflict",
      "route_rule_shadowed",
      "route_rule_unused",
      "route_rule_expired",
      "route_rule_broken",
      "translation_rule_unassigned",
      "rate_table_identical",
      "enterprise_duplicate",
    ])
      assert.ok(kinds.has(k), `the scan finds ${k}`);
    const again = await ok("scanCleanup", call("POST", "/cleanup/scan"));
    assert.equal(again.created, 0, "a rescan updates the same findings");
  });

  test("merge identical and near-duplicate rules as one change, replayed first, and undo it", async () => {
    const ident = (await findings(["route_rule_identical"])).rows.sort(
      (a: { entityIds: number[] }, b: { entityIds: number[] }) => b.entityIds.length - a.entityIds.length,
    )[0];
    const near = (await findings(["route_rule_near_duplicate"])).rows[0];
    const card = await ok("getCleanupFinding", call("GET", `/cleanup-findings/${ident.id}`));
    assert.equal(card.entities.length, ident.entityIds.length);
    assert.equal(card.preview.length, ident.entityIds.length);
    const sim = await ok("simulateCleanup", call("POST", "/cleanup/simulate", { findingIds: [ident.id, near.id] }));
    assert.ok(sim.samples > 0);
    assert.equal(sim.unchanged, true, "identical and near-duplicate merges route the same");

    const { rows: trunks } = await db().query("SELECT id, customer_trunk_ids FROM route_rules WHERE id = ANY($1)", [
      near.entityIds,
    ]);
    const union = new Set(trunks.flatMap((r) => (r.customer_trunk_ids as string[]).map(Number)));
    const r = await ok("applyCleanup", call("POST", "/cleanup/apply", { findingIds: [ident.id, near.id] }));
    assert.equal(r.applied, 2);
    assert.equal(r.change.changeType, "cleanup");
    const { rows: after1 } = await db().query(
      "SELECT id, deleted_at, customer_trunk_ids FROM route_rules WHERE id = ANY($1)",
      [[...ident.entityIds, ...near.entityIds]],
    );
    const byId = new Map(after1.map((x) => [Number(x.id), x]));
    assert.equal(byId.get(ident.entityIds[0])!.deleted_at, null, "the first rule is kept");
    assert.ok(
      ident.entityIds.slice(1).every((id: number) => byId.get(id)!.deleted_at),
      "the copies are archived",
    );
    assert.equal(
      new Set((byId.get(near.entityIds[0])!.customer_trunk_ids as string[]).map(Number)).size,
      union.size,
      "the kept rule has every client trunk",
    );
    const applied = await ok("getCleanupFinding", call("GET", `/cleanup-findings/${ident.id}`));
    assert.equal(applied.state, "applied");
    assert.equal(applied.changeId, r.change.id);

    await undo(r.change.id);
    const { rows: back } = await db().query(
      "SELECT id, deleted_at, customer_trunk_ids FROM route_rules WHERE id = ANY($1)",
      [[...ident.entityIds, ...near.entityIds]],
    );
    assert.ok(
      back.every((x) => x.deleted_at === null),
      "undo restores the archived rules",
    );
    const first = back.find((x) => Number(x.id) === near.entityIds[0])!;
    assert.deepEqual(
      (first.customer_trunk_ids as string[]).map(Number).sort(),
      (trunks.find((x) => Number(x.id) === near.entityIds[0])!.customer_trunk_ids as string[]).map(Number).sort(),
    );
    const reopened = await ok("getCleanupFinding", call("GET", `/cleanup-findings/${ident.id}`));
    assert.equal(reopened.state, "open");
  });

  test("reorder a conflict and archive an unassigned translation rule, then undo", async () => {
    const conflict = (await findings(["route_rule_conflict"])).rows[0];
    const unassigned = (await findings(["translation_rule_unassigned"])).rows[0];
    const { rows: p } = await db().query("SELECT priority FROM route_rules WHERE id = $1", [conflict.entityIds[1]]);
    const r = await ok("applyCleanup", call("POST", "/cleanup/apply", { findingIds: [conflict.id, unassigned.id] }));
    assert.equal(r.applied, 2);
    const { rows: p2 } = await db().query("SELECT priority FROM route_rules WHERE id = $1", [conflict.entityIds[1]]);
    assert.equal(p2[0].priority, p[0].priority + 1);
    const { rows: tr } = await db().query("SELECT deleted_at FROM translation_rules WHERE id = $1", [
      unassigned.entityIds[0],
    ]);
    assert.ok(tr[0].deleted_at);
    await undo(r.change.id);
    const { rows: p3 } = await db().query("SELECT priority FROM route_rules WHERE id = $1", [conflict.entityIds[1]]);
    assert.equal(p3[0].priority, p[0].priority);
    const { rows: tr2 } = await db().query("SELECT deleted_at FROM translation_rules WHERE id = $1", [
      unassigned.entityIds[0],
    ]);
    assert.equal(tr2[0].deleted_at, null);
    // Review-only findings are skipped with the reason.
    const dup = (await findings(["enterprise_duplicate"])).rows[0];
    const skipped = await ok("applyCleanup", call("POST", "/cleanup/apply", { findingIds: [dup.id] }));
    assert.equal(skipped.applied, 0);
    assert.match(skipped.skipped[0].reason, /by hand/);
  });

  test("ignore with a reason survives a rescan; reopen", async () => {
    const f = (await findings(["hlr_rule_unassigned"])).rows[0];
    assert.equal((await call("POST", `/cleanup-findings/${f.id}/ignore`, { reason: "" })).statusCode, 400);
    const ig = await ok(
      "ignoreCleanupFinding",
      call("POST", `/cleanup-findings/${f.id}/ignore`, { reason: "Kept for the trial" }),
    );
    assert.equal(ig.state, "ignored");
    await ok("scanCleanup", call("POST", "/cleanup/scan"));
    const still = await ok("getCleanupFinding", call("GET", `/cleanup-findings/${f.id}`));
    assert.equal(still.state, "ignored");
    assert.equal(still.ignoreReason, "Kept for the trial");
    const back = await ok("reopenCleanupFinding", call("POST", `/cleanup-findings/${f.id}/reopen`));
    assert.equal(back.state, "open");
    assert.equal((await call("POST", `/cleanup-findings/${f.id}/reopen`)).statusCode, 409);
  });

  test("with approval required, a non-administrator's cleanup waits for an administrator", async () => {
    const s = await ok("getCleanupSettings", call("GET", "/cleanup/settings"));
    cleanup.push(() => call("PUT", "/cleanup/settings", s));
    await ok("updateCleanupSettings", call("PUT", "/cleanup/settings", { ...s, requireApproval: true }));
    const { rows: u } = await db().query(
      "SELECT id FROM users WHERE NOT is_admin AND deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    const f = (await findings(["route_rule_expired"])).rows[0];
    const w = await ok("applyCleanup", call("POST", "/cleanup/apply", { findingIds: [f.id] }, Number(u[0].id)));
    assert.equal(w.awaitingApproval, 1);
    assert.equal(w.change, null);
    const denied = await call("POST", "/cleanup/approve", { findingIds: [f.id] }, Number(u[0].id));
    assert.equal(denied.statusCode, 403);
    const a = await ok("approveCleanup", call("POST", "/cleanup/approve", { findingIds: [f.id] }));
    assert.equal(a.applied, 1);
    assert.match(a.change.note, /approved/);
    await undo(a.change.id);
  });

  test("duplicate warning on save: enterprise and route rule", async () => {
    const { rows: e } = await db().query(
      "SELECT id, name FROM enterprises WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    const d = await ok(
      "checkDuplicate",
      call("POST", "/cleanup/check-duplicate", {
        kind: "enterprise",
        enterprise: { name: `${e[0].name.toUpperCase()}.`, vatNumber: null, emails: [] },
      }),
    );
    assert.ok(
      d.matches.some((m: { id: number; reason: string }) => m.id === Number(e[0].id) && /same name/.test(m.reason)),
    );
    const none = await ok(
      "checkDuplicate",
      call("POST", "/cleanup/check-duplicate", {
        kind: "enterprise",
        excludeId: Number(e[0].id),
        enterprise: { name: e[0].name, vatNumber: null, emails: [] },
      }),
    );
    assert.ok(
      !none.matches.some((m: { id: number }) => m.id === Number(e[0].id)),
      "the record itself is not a duplicate",
    );

    const { rows: vt } = await db().query(
      "SELECT id FROM vendor_trunks WHERE deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1",
    );
    const { rows: ct } = await db().query(
      "SELECT id FROM customer_trunks WHERE deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1",
    );
    const input = {
      name: `Test duplicate ${Date.now()}`,
      priority: 77,
      status: "active",
      routeType: "static",
      huntPolicy: "percentage",
      customerTrunkMode: "inclusive",
      customerTrunkIds: [Number(ct[0].id)],
      mccmncMode: "inclusive",
      mccmncs: ["50501"],
      vendors: [{ level: 1, vendorTrunkId: Number(vt[0].id), sharePct: 100 }],
    };
    const created = await ok("createRouteRule", call("POST", "/route-rules", input), 201);
    cleanup.push(() => call("POST", `/route-rules/${created.record.id}/archive`, {}));
    const r = await ok(
      "checkDuplicate",
      call("POST", "/cleanup/check-duplicate", { kind: "route_rule", routeRule: { ...input, name: "Another name" } }),
    );
    assert.ok(
      r.matches.some(
        (m: { id: number; reason: string }) => m.id === created.record.id && m.reason === "same conditions and vendors",
      ),
    );
  });

  test("weekly summary to the rules owners", async () => {
    const before = await db().query("SELECT count(*)::int AS n FROM email_logs WHERE email_type = 'cleanup_summary'");
    assert.equal(await sendWeeklySummary(db(), true), true);
    const after2 = await db().query(
      "SELECT subject FROM email_logs WHERE email_type = 'cleanup_summary' ORDER BY id DESC LIMIT 1",
    );
    const count = await db().query("SELECT count(*)::int AS n FROM email_logs WHERE email_type = 'cleanup_summary'");
    assert.equal(count.rows[0].n, before.rows[0].n + 1);
    assert.match(after2.rows[0].subject, /^Cleanup Center: /);
  });
});
