// Route Rules page (build step 4.3, §15.4): grid filters and traffic window, record with
// labels, create with vendors / warm-up / whitelist, edit and undo, clone, bulk, safe
// delete, traffic breakdown, rule Test, Route Simulator and export. Every response is
// checked against the contract. Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { refreshRouteTraffic } from "../src/api/routeTraffic.js";
import { deleteTestRouteRules } from "./testRules.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
if (ready) await refreshRouteTraffic();
after(async () => {
  // Every rule this run made goes, live or archived (QA 2026-10-31): Test rule, Levels, Edit, Warm, Clone (copy) and
  // the others were left active and routed live traffic.
  if (ready) await deleteTestRouteRules(run);
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

const query = (body: object) => ok("queryRouteRules", call("POST", "/route-rules/query", body));
const and = (...conditions: object[]) => ({ filter: { logic: "and", conditions } });
const undo = (id: number) => ok("undoChange", call("POST", `/changes/${id}/undo`, {}));
const run = Date.now().toString(36);

async function fixtures() {
  const { rows: vt } = await db().query(
    "SELECT id FROM vendor_trunks WHERE deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 3",
  );
  const { rows: ct } = await db().query(
    "SELECT id FROM customer_trunks WHERE deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1",
  );
  return { vendors: vt.map((r) => r.id as number), trunk: ct[0].id as number };
}

const ruleInput = (f: { vendors: number[]; trunk: number }, over: object = {}) => ({
  name: `Test rule ${run}`,
  priority: 42,
  status: "active",
  routeType: "static",
  huntPolicy: "percentage",
  customerTrunkMode: "inclusive",
  customerTrunkIds: [f.trunk],
  mccmncMode: "inclusive",
  mccmncs: ["505"],
  senderPattern: "^(TEST|DEMO)",
  senderPatternNegate: true,
  tps: { op: ">", value: 50, scope: "customer_trunk", windowS: 5, holdS: 10, releasePct: 45 },
  revenue: { type: "per_message", op: ">=", value: 0.04 },
  vendors: [
    { level: 1, vendorTrunkId: f.vendors[0], sharePct: 60, warmupCount: 500, warmupReset: "day", warmupPer: "rule" },
    { level: 1, vendorTrunkId: f.vendors[1], sharePct: 40 },
  ],
  whitelists: [{ vendorTrunkId: f.vendors[1], numbers: ["61400000001", "61400000002"] }],
  ...over,
});

describe("route rules grid (§15.4)", { skip }, () => {
  test("filters, traffic window and sort", async () => {
    const all = await query({ limit: 50 });
    assert.ok(all.total > 0);
    const busiest = await query({ sort: [{ field: "messages", dir: "desc" }], limit: 5 });
    if (busiest.rows[0].messages !== null) assert.ok(busiest.rows[0].messages >= (busiest.rows[1].messages ?? 0));
    const week = await query({
      ...and({ field: "window", op: "eq", value: "7d" }),
      sort: [{ field: "messages", dir: "desc" }],
      limit: 1,
    });
    if (busiest.rows[0].messages !== null) assert.ok(week.rows[0].messages >= busiest.rows[0].messages);
    const au = await query({ ...and({ field: "destination", op: "like", value: "505%" }), limit: 500 });
    assert.ok(au.rows.every((r: { destinationLabel: string }) => /505|Australia|All but/.test(r.destinationLabel)));
    // Names work as well as codes (team trial round 1): "australia" finds the same rules as 505.
    const byName = await query({ ...and({ field: "destination", op: "like", value: "australia%" }), limit: 500 });
    assert.ok(byName.total > 0);
    assert.ok(
      byName.total >=
        au.total - au.rows.filter((r: { destinationLabel: string }) => /All but/.test(r.destinationLabel)).length,
    );
    assert.ok(
      byName.rows.every((r: { destinationNames: string[] }) =>
        r.destinationNames.some((n) => /^\d+-Australia-/.test(n)),
      ),
    );
    // Hover lists: every destination and vendor of the row.
    for (const r of byName.rows as {
      destinationNames: string[];
      destinationCount: number;
      vendorNames: string[];
      routeType: string;
    }[]) {
      assert.ok(r.destinationNames.length <= 100 && r.destinationNames.length > 0);
      assert.ok(r.destinationCount >= 1);
      if (r.routeType === "block") assert.deepEqual(r.vendorNames, []);
    }
    const off = await query({ ...and({ field: "status", op: "in", values: ["inactive"] }), limit: 500 });
    assert.ok(off.rows.every((r: { status: string }) => r.status === "inactive"));
    const bad = await call("POST", "/route-rules/query", and({ field: "window", op: "eq", value: "2h" }));
    assert.equal(bad.statusCode, 200, "an unknown window falls back to 24h");
  });

  test("DLR target filters and sorts agree with the target each row shows, at seeded volume (§13.8)", async () => {
    type R = { id: number; dlrTarget: number | null };
    const all = (await query({ limit: 4000, withTotal: true })) as { rows: R[]; total: number };
    const withTarget = all.rows.filter((r) => r.dlrTarget !== null);
    const set = (await query({ ...and({ field: "dlrTarget", op: "not_empty" }), limit: 4000 })) as { rows: R[]; total: number };
    assert.equal(set.total, withTarget.length);
    assert.deepEqual(new Set(set.rows.map((r) => r.id)), new Set(withTarget.map((r) => r.id)));
    const high = (await query({ ...and({ field: "dlrTarget", op: "gte", value: 80 }), limit: 4000 })) as { rows: R[] };
    assert.equal(high.rows.length, withTarget.filter((r) => r.dlrTarget! >= 80).length);
    for (const dir of ["asc", "desc"] as const) {
      const sorted = ((await query({ sort: [{ field: "dlrTarget", dir }], limit: 200 })) as { rows: R[] }).rows;
      const values = sorted.map((r) => r.dlrTarget).filter((v): v is number => v !== null);
      assert.deepEqual(values, [...values].sort((a, b) => (dir === "asc" ? a - b : b - a)), dir);
    }
    // A page of the grid: was 4–6 s with a subquery per rule, one aggregate pass now (QA 2026-10-31). Generous for a
    // shared database.
    const t0 = Date.now();
    await query({ ...and({ field: "dlrTarget", op: "not_empty" }), sort: [{ field: "dlrTarget", dir: "desc" }], limit: 100 });
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `filter and sort on the DLR target took ${ms} ms`);
  });

  test("the category filter lists categories from the database", async () => {
    const fields = await ok("getListFields", call("GET", "/meta/lists/route_rules/fields"));
    const category = fields.fields.find((f: { field: string }) => f.field === "category");
    assert.ok(category.enumValues.length > 2);
    const id = category.enumValues.find((v: { value: string }) => v.value !== "all").value;
    const page = await query({ ...and({ field: "category", op: "in", values: [id] }), limit: 5 });
    assert.ok(page.total > 0);
  });

  test("rules naming a customer trunk", async () => {
    const { rows } = await db().query(
      "SELECT customer_trunk_ids[1] AS id FROM route_rules WHERE customer_trunk_mode = 'inclusive' AND deleted_at IS NULL LIMIT 1",
    );
    const page = await query({ ...and({ field: "customerTrunkId", op: "eq", value: rows[0].id }), limit: 500 });
    assert.ok(page.total > 0);
  });

  test("CSV export follows the filter", async () => {
    const filter = and({ field: "routeType", op: "in", values: ["block"] });
    const res = await call("POST", "/route-rules/export", filter);
    assert.equal(res.statusCode, 200);
    check("exportRouteRules", res);
    const lines = res.body.trim().split("\r\n");
    assert.match(lines[0]!, /^ID,Rule,Priority/);
    assert.equal(lines.length - 1, (await query({ ...filter, limit: 1 })).total);
  });
});

describe("route rule record (§6.3, §13.8–13.10, §13.27)", { skip }, () => {
  test("add with vendors, warm-up and whitelist; validation errors point at fields", async () => {
    const f = await fixtures();
    const saved = await ok("createRouteRule", call("POST", "/route-rules", ruleInput(f)), 201);
    const r = saved.record;
    assert.equal(r.vendors.length, 2);
    assert.equal(r.vendors[0].warmupCount, 500);
    assert.equal(r.tps.releasePct, 45);
    assert.equal(r.labels.customerTrunks.length, 1);
    assert.equal(r.labels.vendorTrunks.length, 2);

    const bad = await call(
      "POST",
      "/route-rules",
      ruleInput(f, {
        vendors: [
          { level: 1, vendorTrunkId: f.vendors[0], sharePct: 50 },
          { level: 1, vendorTrunkId: f.vendors[1], sharePct: 40 },
        ],
        senderPattern: "([",
        stopsAt: "2000-01-01T00:00:00Z",
      }),
    );
    assert.equal(bad.statusCode, 400);
    check("createRouteRule", bad);
    const paths = bad.json().errors.map((e: { path: string }) => e.path);
    for (const p of ["/vendors", "/senderPattern", "/stopsAt"]) assert.ok(paths.includes(p), `${p} in ${paths}`);
  });

  test("a vendor alone on its level takes 100 %; the grid lists every level (team trial round 12)", async () => {
    const f = await fixtures();
    const saved = await ok(
      "createRouteRule",
      call(
        "POST",
        "/route-rules",
        ruleInput(f, {
          name: `Levels ${run}`,
          maxRouteLevel: 2,
          whitelists: [],
          vendors: [
            { level: 1, vendorTrunkId: f.vendors[0], sharePct: 60 },
            { level: 1, vendorTrunkId: f.vendors[1], sharePct: 40 },
            // No share given: alone on level 2.
            { level: 2, vendorTrunkId: f.vendors[2], sharePct: null },
          ],
        }),
      ),
      201,
    );
    const level2 = saved.record.vendors.find((v: { level: number }) => v.level === 2);
    assert.equal(level2.sharePct, 100);
    const list = await query({ ...and({ field: "id", op: "eq", value: saved.record.id }), limit: 1 });
    const label = list.rows[0].vendorsLabel as string;
    assert.match(label, /^L1 .+ 60 · .+ 40 \| L2 [^|]+$/, label);
    assert.doesNotMatch(label, /L2 .* 100/, "a sole vendor shows no share");
  });

  test("edit records only changed fields; undo restores vendors; status alone is enable/disable", async () => {
    const f = await fixtures();
    const created = (
      await ok("createRouteRule", call("POST", "/route-rules", ruleInput(f, { name: `Edit ${run}` })), 201)
    ).record;
    const input = {
      ...ruleInput(f, { name: `Edit ${run}` }),
      priority: 10,
      vendors: [
        {
          level: 1,
          vendorTrunkId: f.vendors[0],
          sharePct: 70,
          warmupCount: 500,
          warmupReset: "day",
          warmupPer: "rule",
        },
        { level: 1, vendorTrunkId: f.vendors[1], sharePct: 30 },
      ],
    };
    const edited = await ok("updateRouteRule", call("PUT", `/route-rules/${created.id}`, input));
    assert.deepEqual(edited.change.diff.map((d: { field: string }) => d.field).sort(), ["priority", "vendors"]);
    await undo(edited.change.id);
    const back = await ok("getRouteRule", call("GET", `/route-rules/${created.id}`));
    assert.equal(back.priority, 42);
    assert.equal(back.vendors[0].sharePct, 60);
    const off = await ok(
      "updateRouteRule",
      call("PUT", `/route-rules/${created.id}`, { ...ruleInput(f, { name: `Edit ${run}` }), status: "inactive" }),
    );
    assert.equal(off.change.changeType, "disable");
  });

  test("warm-up Reset restarts one vendor's count; saves keep it; backups keep their vendor (team trial round 6)", async () => {
    const f = await fixtures();
    const created = (
      await ok("createRouteRule", call("POST", "/route-rules", ruleInput(f, { name: `Warm ${run}` })), 201)
    ).record;
    assert.equal(created.vendors[0].warmupResetAt, null);
    const reset = await ok(
      "resetRouteRuleWarmup",
      call("POST", `/route-rules/${created.id}/warmup-reset`, { vendorTrunkId: f.vendors[0] }),
    );
    assert.equal(reset.change, null);
    const at = reset.record.vendors[0].warmupResetAt;
    assert.ok(at, "the reset time is shown");
    // No threshold on the second vendor: nothing to reset.
    const bad = await call("POST", `/route-rules/${created.id}/warmup-reset`, { vendorTrunkId: f.vendors[1] });
    assert.equal(bad.statusCode, 400);
    check("resetRouteRuleWarmup", bad);

    const input = {
      ...ruleInput(f, { name: `Warm ${run}` }),
      vendors: [
        { level: 1, vendorTrunkId: f.vendors[0], sharePct: 60, warmupCount: 900, warmupReset: "day", warmupPer: "rule" },
        { level: 1, vendorTrunkId: f.vendors[1], sharePct: 40 },
        { level: 1, vendorTrunkId: f.vendors[2], isBackup: true, backupForVendorTrunkId: f.vendors[0] },
      ],
    };
    const edited = await ok("updateRouteRule", call("PUT", `/route-rules/${created.id}`, input));
    assert.deepEqual(edited.change.diff.map((d: { field: string }) => d.field), ["vendors"]);
    assert.equal(edited.record.vendors[0].warmupResetAt, at, "a save keeps the count going");
    const backup = edited.record.vendors.find((v: { isBackup: boolean }) => v.isBackup);
    assert.equal(backup.backupForVendorTrunkId, f.vendors[0]);
    // Saving the same vendors again is no change at all.
    const again = await ok("updateRouteRule", call("PUT", `/route-rules/${created.id}`, input));
    assert.equal(again.change, null);
  });

  test("duplicate is an inactive copy; bulk is one change; archive and restore", async () => {
    const f = await fixtures();
    const created = (
      await ok("createRouteRule", call("POST", "/route-rules", ruleInput(f, { name: `Clone ${run}` })), 201)
    ).record;
    const copy = await ok("cloneRouteRule", call("POST", `/route-rules/${created.id}/clone`), 201);
    assert.equal(copy.record.status, "inactive");
    assert.equal(copy.change.changeType, "clone");
    assert.deepEqual(copy.record.vendors, created.vendors);

    const ids = [created.id, copy.record.id];
    const bulk = await ok(
      "bulkRouteRules",
      call("POST", "/route-rules/bulk", { ruleIds: ids, action: "set_priority", priority: 7 }),
    );
    assert.equal(bulk.affected, 2);
    assert.equal(bulk.change.changeType, "bulk");
    const swap = await ok(
      "bulkRouteRules",
      call("POST", "/route-rules/bulk", {
        ruleIds: ids,
        action: "replace_vendor",
        fromVendorTrunkId: f.vendors[1],
        toVendorTrunkId: f.vendors[2],
      }),
    );
    const swapped = await ok("getRouteRule", call("GET", `/route-rules/${created.id}`));
    assert.ok(swapped.vendors.some((v: { vendorTrunkId: number }) => v.vendorTrunkId === f.vendors[2]));
    assert.equal(swapped.whitelists[0].vendorTrunkId, f.vendors[2], "whitelists follow the vendor");
    await undo(swap.change.id);
    await undo(bulk.change.id);
    const restored = await ok("getRouteRule", call("GET", `/route-rules/${created.id}`));
    assert.equal(restored.priority, 42);
    assert.ok(restored.vendors.some((v: { vendorTrunkId: number }) => v.vendorTrunkId === f.vendors[1]));

    const deps = await ok("getRouteRuleDependencies", call("GET", `/route-rules/${created.id}/dependencies`));
    assert.equal(deps.blocked, false);
    const archived = await ok("archiveRouteRule", call("POST", `/route-rules/${created.id}/archive`, {}));
    assert.ok(archived.record.archived);
    const hidden = await query({ ...and({ field: "id", op: "eq", value: created.id }) });
    assert.equal(hidden.total, 0);
    await ok("restoreRouteRule", call("POST", `/route-rules/${created.id}/restore`));
  });

  test("a static draft may be saved without vendors, but not turned on", async () => {
    const draft = (
      await ok(
        "createRouteRule",
        call("POST", "/route-rules", { name: `Draft ${run}`, priority: 99, status: "inactive", routeType: "static" }),
        201,
      )
    ).record;
    assert.equal(draft.vendors.length, 0);
    const on = await call("POST", "/route-rules/bulk", { ruleIds: [draft.id], action: "enable" });
    assert.equal(on.statusCode, 400);
    check("bulkRouteRules", on);
    const put = await call("PUT", `/route-rules/${draft.id}`, {
      name: `Draft ${run}`,
      priority: 99,
      status: "active",
      routeType: "static",
    });
    assert.equal(put.statusCode, 400);
    assert.equal(put.json().errors[0].path, "/vendors");
    await ok("archiveRouteRule", call("POST", `/route-rules/${draft.id}/archive`, {}));
  });

  test("New rule draft: × discards it with its history; a rule once turned on cannot be discarded", async () => {
    const draft = (
      await ok(
        "createRouteRule",
        call("POST", "/route-rules", { name: `Discard ${run}`, priority: 90, status: "inactive", routeType: "block" }),
        201,
      )
    ).record;
    const edited = await call("PUT", `/route-rules/${draft.id}`, {
      name: `Discard ${run} b`,
      priority: 90,
      status: "inactive",
      routeType: "block",
    });
    assert.equal(edited.statusCode, 200);
    const gone = await call("POST", `/route-rules/${draft.id}/discard`, {});
    assert.equal(gone.statusCode, 204);
    assert.equal((await call("GET", `/route-rules/${draft.id}`)).statusCode, 404);
    const { rows } = await db().query(
      "SELECT count(*)::int AS n FROM changes WHERE entity_type = 'route_rule' AND $1 = ANY(entity_ids)",
      [draft.id],
    );
    assert.equal(rows[0].n, 0, "no history left");
    // Turned on once: Delete (archive) only.
    const live = (
      await ok(
        "createRouteRule",
        call("POST", "/route-rules", { name: `Kept ${run}`, priority: 90, status: "active", routeType: "block" }),
        201,
      )
    ).record;
    const refused = await call("POST", `/route-rules/${live.id}/discard`, {});
    assert.equal(refused.statusCode, 409);
    check("discardRouteRule", refused);
    await ok("archiveRouteRule", call("POST", `/route-rules/${live.id}/archive`, {}));
  });

  test("DLR target: the rule's own, else its destinations' lowest; block rules have none", async () => {
    const f = await fixtures();
    // Two networks of one country, the country with a target and one network with its own.
    const { rows } = await db().query(
      `SELECT n.id, n.mccmnc, c.id AS country_id, c.mccmnc AS country FROM mccmnc n JOIN mccmnc c ON c.mccmnc = n.mcc AND c.is_all_networks
        WHERE NOT n.is_all_networks ORDER BY n.id LIMIT 2`,
    );
    const [a, b] = rows;
    const set = (id: number, targetPct: number | null) =>
      ok("setDestinationDlrTarget", call("PUT", `/destinations/${id}/dlr-target`, { targetPct }));
    const saved = [await set(a.country_id, 70), await set(a.id, 62.5), await set(b.id, null)];
    const created = (
      await ok(
        "createRouteRule",
        call("POST", "/route-rules", ruleInput(f, { name: `DLR ${run}`, mccmncs: [a.mccmnc, b.mccmnc] })),
        201,
      )
    ).record;
    const row = async () =>
      (await query({ ...and({ field: "id", op: "eq", value: created.id }) })).rows[0] as {
        dlrTarget: number | null;
        dlrTargetSource: string | null;
      };
    assert.deepEqual(await row(), { ...(await row()), dlrTarget: 62.5, dlrTargetSource: "destination" });
    await ok(
      "updateRouteRule",
      call("PUT", `/route-rules/${created.id}`, {
        ...ruleInput(f, { name: `DLR ${run}`, mccmncs: [a.mccmnc, b.mccmnc] }),
        dlrTargetPct: 90,
      }),
    );
    assert.equal((await row()).dlrTarget, 90);
    assert.equal((await row()).dlrTargetSource, "rule");
    await ok(
      "updateRouteRule",
      call("PUT", `/route-rules/${created.id}`, {
        ...ruleInput(f, { name: `DLR ${run}`, mccmncs: [a.mccmnc] }),
        routeType: "block",
        vendors: [],
        whitelists: [],
      }),
    );
    assert.equal((await row()).dlrTarget, null, "block rules are not judged on delivery");
    const below = await query({ ...and({ field: "dlrBelowTarget", op: "eq", value: true }), limit: 50 });
    for (const r of below.rows) assert.ok(r.dlr !== null && r.dlrTarget !== null && r.dlr < r.dlrTarget);
    for (const s of saved.reverse()) if (s.change) await undo(s.change.id);
    await ok("archiveRouteRule", call("POST", `/route-rules/${created.id}/archive`, {}));
  });

  test("traffic per customer and vendor (§13.27)", async () => {
    const busiest = await query({ sort: [{ field: "messages", dir: "desc" }], limit: 1 });
    const t = await ok("getRouteRuleTraffic", call("GET", `/route-rules/${busiest.rows[0].id}/traffic?window=24h`));
    if (!t.available) return;
    // A running mock server writes live EDRs between the two reads (team trial round 1), so allow a few.
    assert.ok(Math.abs(t.total.messages - busiest.rows[0].messages) <= Math.max(5, busiest.rows[0].messages * 0.01));
    const sum = t.byCustomer.reduce((a: number, r: { messages: number }) => a + r.messages, 0);
    assert.ok(sum <= t.total.messages);
    assert.ok(t.series.length > 0);
  });

  // The day windows come from the 15-minute totals (QA 2026-10-31): the grid's figures, the rule's breakdown, and
  // no "Trunk 0" among the vendors (not routed is not a vendor).
  test("7 and 30 day traffic from the totals: grid and breakdown agree; no trunk 0 (§13.27)", async () => {
    await refreshRouteTraffic();
    for (const w of ["7d", "30d"]) {
      const busiest = await query({
        ...and({ field: "window", op: "eq", value: w }),
        sort: [{ field: "messages", dir: "desc" }],
        limit: 1,
      });
      const row = busiest.rows[0];
      const t = await ok("getRouteRuleTraffic", call("GET", `/route-rules/${row.id}/traffic?window=${w}`));
      if (!t.available) continue;
      assert.ok(row.messages > 0, w);
      assert.ok(Math.abs(t.total.messages - row.messages) <= Math.max(5, row.messages * 0.01), w);
      for (const v of t.byVendor) assert.ok(v.vendorTrunkId >= 1, `${w}: vendor trunk ${v.vendorTrunkId}`);
      for (const c of t.byCustomer) assert.ok(c.customerTrunkId >= 1, `${w}: customer trunk ${c.customerTrunkId}`);
    }
  });
});

describe("rule Test and Route Simulator", { skip }, () => {
  test("a sample number through one rule: conditions, whitelist, warm-up", async () => {
    const f = await fixtures();
    const { rows } = await db().query(
      "SELECT d.prefix FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id WHERE m.mcc = '505' ORDER BY length(d.prefix) DESC LIMIT 1",
    );
    const number = `${rows[0].prefix}0000001`.slice(0, 11);
    // The whole country is every code of it; "505" alone is only its All networks entry (team trial round 1).
    const au = await db().query(
      "SELECT array_agg(mccmnc) AS codes FROM mccmnc WHERE mcc = '505' AND deleted_at IS NULL",
    );
    const created = (
      await ok(
        "createRouteRule",
        call(
          "POST",
          "/route-rules",
          ruleInput(f, { name: `Test ${run}`, tps: null, revenue: null, mccmncs: au.rows[0].codes }),
        ),
        201,
      )
    ).record;
    const decision = await ok(
      "testRouteRule",
      call("POST", `/route-rules/${created.id}/test`, { receiver: number, customerTrunkId: f.trunk, sender: "BANK" }),
    );
    assert.equal(decision.matched, true, JSON.stringify(decision.checks));
    assert.equal(decision.vendor.decidedBy, "warmup");
    const after = await ok(
      "testRouteRule",
      call("POST", `/route-rules/${created.id}/test`, {
        receiver: number,
        customerTrunkId: f.trunk,
        sender: "BANK",
        warmupSent: 500,
      }),
    );
    assert.equal(after.vendor.decidedBy, "percentage");
    const blockedSender = await ok(
      "testRouteRule",
      call("POST", `/route-rules/${created.id}/test`, { receiver: number, customerTrunkId: f.trunk, sender: "TEST1" }),
    );
    assert.equal(blockedSender.outcome, "not_matched");
    assert.equal(blockedSender.checks.find((c: { ok: boolean }) => !c.ok).condition, "Sender");
    // Match case (team trial round 1): on by default, so "test1" is not TEST and passes the Not Match pattern.
    assert.equal(created.senderMatchCase, true);
    const lower = () =>
      ok(
        "testRouteRule",
        call("POST", `/route-rules/${created.id}/test`, {
          receiver: number,
          customerTrunkId: f.trunk,
          sender: "test1",
        }),
      );
    assert.equal((await lower()).matched, true);
    const anyCase = await ok(
      "updateRouteRule",
      call("PUT", `/route-rules/${created.id}`, {
        ...ruleInput(f, { name: `Test ${run}`, tps: null, revenue: null, mccmncs: au.rows[0].codes }),
        senderMatchCase: false,
      }),
    );
    assert.deepEqual(
      anyCase.change.diff.map((d: { field: string }) => d.field),
      ["senderMatchCase"],
    );
    assert.equal((await lower()).outcome, "not_matched", "any case: test1 is TEST");
    await undo(anyCase.change.id);
    assert.equal((await ok("getRouteRule", call("GET", `/route-rules/${created.id}`))).senderMatchCase, true);
    const pinned = (
      await ok(
        "updateRouteRule",
        call("PUT", `/route-rules/${created.id}`, {
          ...ruleInput(f, { name: `Test ${run}`, tps: null, revenue: null, mccmncs: au.rows[0].codes }),
          whitelists: [{ vendorTrunkId: f.vendors[1], numbers: [number] }],
        }),
      )
    ).record;
    const wl = await ok(
      "testRouteRule",
      call("POST", `/route-rules/${pinned.id}/test`, { receiver: number, customerTrunkId: f.trunk }),
    );
    assert.deepEqual([wl.vendor.vendorTrunkId, wl.vendor.decidedBy], [f.vendors[1], "whitelist"]);
    await ok("archiveRouteRule", call("POST", `/route-rules/${created.id}/archive`, {}));
  });

  test("the simulator tries rules by priority and reports the decision", async () => {
    const f = await fixtures();
    const sim = await ok(
      "simulateRoute",
      call("POST", "/route-rules/simulate", { receiver: "61400000009", customerTrunkId: f.trunk }),
    );
    assert.ok(sim.tried.length > 0);
    const priorities = sim.tried.map((t: { priority: number }) => t.priority);
    assert.deepEqual(
      priorities,
      // Highest priority first (team trial round 1).
      [...priorities].sort((a: number, b: number) => b - a),
    );
    const bad = await call("POST", "/route-rules/simulate", { receiver: "61400000009", customerTrunkId: 99999999 });
    assert.equal(bad.statusCode, 400);
    check("simulateRoute", bad);
  });
});
