// HLR providers, rules and policies (build step 5.4, §6.5, §13.24): policy entry choice and
// provider order on their own, then the API against the seeded database. Every response is
// checked against the contract; each test undoes its own changes (§13.10).
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { entryFor, normaliseEntries, orderProviders } from "../src/api/hlr.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
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

const undo = (change: Change | null) =>
  change ? ok("undoChange", call("POST", `/changes/${change.id}/undo`, {})) : Promise.resolve(null);
const run = Date.now().toString(36).slice(-5);

const ENTRY = { mode: "ordered" as const, minSuccessPct: null, cacheHoursPorted: 24, cacheHoursNotPorted: 48 };
const MAPPING = {
  mcc: "mcc",
  mnc: "mnc",
  mccmnc: "mccmnc",
  oldMcc: null,
  oldMnc: null,
  oldMccmnc: null,
  ported: "ported",
  errorCode: null,
  errorString: null,
  successCodes: "0",
  numberCheck: null,
  dnidScore: null,
};
const provider = (over: object = {}) => ({
  name: `Test HLR ${run}`,
  providerType: "hlr",
  url: "https://hlr.example/lookup?msisdn={DNID}",
  username: "user1",
  extraHeaders: "X-Key: abc",
  postData: null,
  currency: "USD",
  defaultRate: 0.002,
  cacheDays: 2,
  timeoutMs: 1500,
  dailyBudget: null,
  status: "active",
  responseMapping: MAPPING,
  password: "secret-1",
  ...over,
});

describe("HLR policy logic (§13.24)", () => {
  test("entry: the network's code, else its country, else the catch-all", () => {
    const entries = [
      { ...ENTRY, code: "23415", providerIds: [1] },
      { ...ENTRY, code: "234", providerIds: [2] },
      { ...ENTRY, code: null, providerIds: [3] },
    ];
    assert.equal(entryFor(entries, "23415")?.providerIds[0], 1);
    assert.equal(entryFor(entries, "23420")?.providerIds[0], 2);
    assert.equal(entryFor(entries, "26201")?.providerIds[0], 3);
    assert.equal(entryFor(entries, null)?.providerIds[0], 3);
    assert.equal(entryFor(entries.slice(0, 2), "26201"), null, "no catch-all, no HLR");
  });

  test("order: as listed, or auto = cheapest meeting the minimum first; skipped ones say why", () => {
    const ps = [
      { providerId: 1, rate: 0.003, successPct: 99, liveStatus: "up", deleted: false },
      { providerId: 2, rate: 0.001, successPct: 80, liveStatus: "up", deleted: false },
      { providerId: 3, rate: 0.002, successPct: 95, liveStatus: "up", deleted: false },
      { providerId: 4, rate: 0.0005, successPct: 10, liveStatus: "down", deleted: false },
    ];
    const ordered = orderProviders({ ...ENTRY, code: null, providerIds: [2, 1, 4] }, ps);
    assert.deepEqual(
      ordered.map((p) => [p.providerId, p.skipped]),
      [
        [2, null],
        [1, null],
        [4, "down"],
      ],
    );
    const auto = orderProviders({ ...ENTRY, code: null, mode: "auto", minSuccessPct: 90, providerIds: [1, 2, 3] }, ps);
    assert.deepEqual(
      auto.map((p) => p.providerId),
      [3, 1, 2],
    );
    assert.equal(auto[2]!.skipped, "success under 90 %");
  });

  test("entries are sorted with the catch-all last; ordered entries drop the minimum", () => {
    const n = normaliseEntries([
      { ...ENTRY, code: null, providerIds: [1], minSuccessPct: 90 },
      { ...ENTRY, code: "262", providerIds: [1] },
    ]);
    assert.deepEqual(
      n.map((e) => e.code),
      ["262", null],
    );
    assert.equal(n[1]!.minSuccessPct, null);
  });
});

describe("HLR providers API", { skip }, () => {
  test("add, password never returned, prices, import, delete blocked while used, undo", async () => {
    const created = await ok("createHlrProvider", call("POST", "/hlr-providers", provider()), 201);
    const id = created.record.id as number;
    assert.equal(created.record.passwordSet, true);
    assert.ok(!JSON.stringify(created).includes("secret-1"), "the password never comes back");
    const dup = await call("POST", "/hlr-providers", provider({ name: `test hlr ${run}` }));
    assert.equal(dup.statusCode, 409);
    const bad = await call("POST", "/hlr-providers", provider({ name: `X ${run}`, url: "https://x.example" }));
    assert.equal(bad.statusCode, 400);

    const edited = await ok(
      "updateHlrProvider",
      call("PUT", `/hlr-providers/${id}`, provider({ timeoutMs: 2500, password: "secret-2" })),
    );
    const fields = edited.change.diff.map((d: { field: string }) => d.field).sort();
    assert.deepEqual(fields, ["password", "timeoutMs"]);
    assert.ok(!JSON.stringify(edited.change).includes("secret-2"), "the change log hides the password");

    const { rows } = await db().query("SELECT id, mccmnc FROM mccmnc WHERE deleted_at IS NULL ORDER BY id LIMIT 2");
    const rate = await ok(
      "setHlrProviderRate",
      call("PUT", `/hlr-providers/${id}/rates`, { destinationId: rows[0].id, rate: 0.0015 }),
    );
    assert.equal(rate.record.rate, 0.0015);
    const imp = await ok(
      "importHlrProviderRates",
      call("POST", `/hlr-providers/${id}/rates/import`, {
        csv: `mccmnc,rate\n${rows[0].mccmnc},0.0016\n${rows[1].mccmnc},0.0009\n`,
        mode: "merge",
        dryRun: false,
      }),
    );
    assert.deepEqual([imp.added, imp.updated], [1, 1]);
    const page = await ok(
      "queryHlrProviderRates",
      call("POST", "/hlr-provider-rates/query", {
        limit: 10,
        filter: { logic: "and", conditions: [{ field: "providerId", op: "eq", value: id }] },
      }),
    );
    assert.equal(page.total, 2);
    const file = await call("GET", `/hlr-providers/${id}/rates/export`);
    assert.ok(file.body.startsWith("mccmnc,country,network,rate,currency"));

    const rule = await ok(
      "createHlrRule",
      call("POST", "/hlr-rules", {
        name: `HLR rule ${run}`,
        providerId: id,
        dnidPattern: "^44",
        status: "active",
        insertAt: "bottom",
        targets: [{ type: "all", id: null }],
      }),
      201,
    );
    const blocked = await call("POST", `/hlr-providers/${id}/archive`, {});
    assert.equal(blocked.statusCode, 409);
    check("archiveHlrProvider", blocked);
    await undo(rule.change);
    await undo(imp.change);
    await undo(rate.change);
    await undo(edited.change);
    const back = await ok("getHlrProvider", call("GET", `/hlr-providers/${id}`));
    assert.equal(back.timeoutMs, 1500);
    await undo(created.change);
  });

  test("provider list at full volume carries live status and stats", async () => {
    const page = await ok(
      "queryHlrProviders",
      call("POST", "/hlr-providers/query", { limit: 50, sort: [{ field: "successPct", dir: "asc" }] }),
    );
    assert.ok(page.rows.length >= 5);
    for (const r of page.rows) assert.ok(["up", "slow", "down", "inactive"].includes(r.liveStatus));
  });
});

describe("HLR rules API", { skip }, () => {
  test("create with targets, used by, bad pattern, edit, undo", async () => {
    const { rows } = await db().query("SELECT id FROM customer_trunks WHERE deleted_at IS NULL ORDER BY id LIMIT 1");
    const input = {
      name: `HLR UK ${run}`,
      providerId: 1,
      dnidPattern: "^44",
      status: "active",
      insertAt: "bottom",
      targets: [{ type: "trunk", id: Number(rows[0].id) }],
    };
    const created = await ok("createHlrRule", call("POST", "/hlr-rules", input), 201);
    const id = created.record.id;
    assert.equal(created.record.usedBy, 1);
    const usedBy = await ok("getHlrRuleUsedBy", call("GET", `/hlr-rules/${id}/used-by`));
    assert.equal(usedBy.trunks[0].id, Number(rows[0].id));
    const bad = await call("PUT", `/hlr-rules/${id}`, { ...input, dnidPattern: "([" });
    assert.equal(bad.statusCode, 400);
    const edited = await ok("updateHlrRule", call("PUT", `/hlr-rules/${id}`, { ...input, providerId: 2, targets: [] }));
    assert.deepEqual(edited.change.diff.map((d: { field: string }) => d.field).sort(), ["providerId", "targets"]);
    await undo(edited.change);
    const back = await ok("getHlrRule", call("GET", `/hlr-rules/${id}`));
    assert.equal(back.providerId, 1);
    assert.equal(back.targets.length, 1);
    await undo(created.change);
  });
});

describe("HLR rules list", { skip }, () => {
  test("rows carry their targets by name for the hover list", async () => {
    const page = await ok("queryHlrRules", call("POST", "/hlr-rules/query", { limit: 500 }));
    assert.ok(page.rows.length > 0);
    for (const r of page.rows as { appliesTo: string; appliesToNames: string[]; appliesToCount: number }[]) {
      assert.equal(r.appliesToNames.length, Math.min(100, r.appliesToCount));
      if (r.appliesTo === "Not assigned") assert.equal(r.appliesToCount, 0);
      else
        assert.ok(
          r.appliesToNames.every((n) => /^(Customer trunk|Enterprise|Category) · |^All customer trunks$/.test(n)),
        );
    }
  });
});

describe("HLR policies API", { skip }, () => {
  test("create, validation, test a number, route rules block delete, undo", async () => {
    const input = {
      name: `Policy ${run}`,
      status: "active",
      entries: [
        { ...ENTRY, code: null, providerIds: [1, 2] },
        { ...ENTRY, code: "234", mode: "auto", minSuccessPct: 90, providerIds: [1, 2, 3] },
      ],
    };
    const created = await ok("createHlrPolicy", call("POST", "/hlr-policies", input), 201);
    const id = created.record.id;
    assert.equal(created.record.entries[1].code, null, "catch-all sorted last");
    const bad = await call("PUT", `/hlr-policies/${id}`, {
      ...input,
      entries: [...input.entries, { ...ENTRY, code: "999999", providerIds: [99999] }],
    });
    assert.equal(bad.statusCode, 400);
    const paths = bad.json().errors.map((e: { path: string }) => e.path);
    assert.ok(paths.includes("/entries/2/code") && paths.includes("/entries/2/providerIds"), paths.join());
    const uk = await ok("testHlrPolicy", call("POST", `/hlr-policies/${id}/test`, { receiver: "447700900123" }));
    assert.equal(uk.entry.code, "234");
    assert.equal(uk.providers.length, 3);
    const elsewhere = await ok(
      "testHlrPolicy",
      call("POST", `/hlr-policies/${id}/test`, { receiver: "4915112345678" }),
    );
    assert.equal(elsewhere.entry.code, null);
    assert.deepEqual(
      elsewhere.providers.map((p: { providerId: number }) => p.providerId),
      [1, 2],
    );

    // Policy 1 (Default) is used by route rules' HLR actions.
    const deps = await ok("getHlrPolicyDependencies", call("GET", "/hlr-policies/1/dependencies"));
    assert.equal(deps.blocked, true);
    const blocked = await call("POST", "/hlr-policies/1/archive", {});
    assert.equal(blocked.statusCode, 409);
    const gone = await ok("archiveHlrPolicy", call("POST", `/hlr-policies/${id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    await undo(gone.change);
    await undo(created.change);
  });

  test("route rule HLR action needs a live policy and is labelled", async () => {
    const { rows } = await db().query(
      "SELECT id FROM route_rules WHERE hlr_action IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    const detail = await ok("getRouteRule", call("GET", `/route-rules/${rows[0].id}`));
    assert.equal(detail.labels.hlrPolicies[0].name, "Default");
    const {
      id: _id,
      labels: _l,
      archived: _a,
      createdBy: _cb,
      createdAt: _ca,
      updatedBy: _ub,
      updatedAt: _ua,
      ...input
    } = detail;
    const bad = await call("PUT", `/route-rules/${rows[0].id}`, {
      ...input,
      hlrAction: { ...detail.hlrAction, policyId: 999999 },
    });
    assert.equal(bad.statusCode, 400);
    assert.ok(bad.json().errors.some((e: { path: string }) => e.path === "/hlrAction/policyId"));
  });
});
