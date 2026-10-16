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

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
if (ready) await refreshRouteTraffic();
after(async () => {
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
    assert.ok(au.rows.every((r: { destinationLabel: string }) => /505|All but/.test(r.destinationLabel)));
    const off = await query({ ...and({ field: "status", op: "in", values: ["inactive"] }), limit: 500 });
    assert.ok(off.rows.every((r: { status: string }) => r.status === "inactive"));
    const bad = await call("POST", "/route-rules/query", and({ field: "window", op: "eq", value: "2h" }));
    assert.equal(bad.statusCode, 200, "an unknown window falls back to 24h");
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

  test("traffic per customer and vendor (§13.27)", async () => {
    const busiest = await query({ sort: [{ field: "messages", dir: "desc" }], limit: 1 });
    const t = await ok("getRouteRuleTraffic", call("GET", `/route-rules/${busiest.rows[0].id}/traffic?window=24h`));
    if (!t.available) return;
    assert.equal(t.total.messages, busiest.rows[0].messages);
    const sum = t.byCustomer.reduce((a: number, r: { messages: number }) => a + r.messages, 0);
    assert.ok(sum <= t.total.messages);
    assert.ok(t.series.length > 0);
  });
});

describe("rule Test and Route Simulator", { skip }, () => {
  test("a sample number through one rule: conditions, whitelist, warm-up", async () => {
    const f = await fixtures();
    const { rows } = await db().query(
      "SELECT d.prefix FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id WHERE m.mcc = '505' ORDER BY length(d.prefix) DESC LIMIT 1",
    );
    const number = `${rows[0].prefix}0000001`.slice(0, 11);
    const created = (
      await ok(
        "createRouteRule",
        call("POST", "/route-rules", ruleInput(f, { name: `Test ${run}`, tps: null, revenue: null })),
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
    const pinned = (
      await ok(
        "updateRouteRule",
        call("PUT", `/route-rules/${created.id}`, {
          ...ruleInput(f, { name: `Test ${run}`, tps: null, revenue: null }),
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
      [...priorities].sort((a: number, b: number) => a - b),
    );
    const bad = await call("POST", "/route-rules/simulate", { receiver: "61400000009", customerTrunkId: 99999999 });
    assert.equal(bad.statusCode, 400);
    check("simulateRoute", bad);
  });
});
