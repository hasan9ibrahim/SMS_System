// Margin calculator (team trial round 3): saved swap deals, SMS version of the team's sheet. Totals are worked out on
// the server to 6 decimals; every response is checked against the contract. Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, dbReady } from "../src/db.js";
import { dealTotals } from "../src/api/marginDeals.js";

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
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

test("totals: margin both ways, netting tells who pays", () => {
  // The sheet's example, per SMS: we send 1,000,000 at cost 0.018 / sell 0.019; they send 1,400,000 at 0.0125 / 0.01185.
  const t = dealTotals({
    outbound: [{ destination: "Ethiopia", cost: 0.018, rate: 0.019, messages: 1_000_000 }],
    inbound: [{ destination: "Sudan Zain", cost: 0.01185, rate: 0.0125, messages: 1_400_000 }],
  });
  assert.equal(t.outbound.cost, 18_000);
  assert.equal(t.outbound.margin, 1_000);
  assert.equal(t.inbound.revenue, 17_500);
  assert.equal(t.inbound.margin, 910);
  assert.equal(t.totalMargin, 1_910);
  assert.equal(t.netting, 500, "we pay the carrier 500");
});

describe("margin deals", { skip }, () => {
  test("save, list, edit, delete", async () => {
    const input = {
      name: `Swap test ${Date.now()}`,
      carrierEnterpriseId: null,
      carrierName: "Fake Carrier",
      currency: "EUR",
      periodDays: 30,
      notes: null,
      outbound: [{ destination: "Ethiopia · All networks", mccmnc: "636", cost: 0.018, rate: 0.019, messages: 1000 }],
      inbound: [{ destination: "Sudan · Zain", mccmnc: "63401", cost: 0.01185, rate: 0.0125, messages: 1400 }],
    };
    const bad = await call("POST", "/margin-deals", { ...input, name: " " });
    assert.equal(bad.statusCode, 400);
    const created = await call("POST", "/margin-deals", input);
    assert.equal(created.statusCode, 201);
    check("createMarginDeal", created);
    const deal = created.json();
    assert.equal(deal.totals.totalMargin, 1.91);
    const list = await call("GET", `/margin-deals?search=${encodeURIComponent(input.name)}`);
    check("listMarginDeals", list);
    assert.equal(list.json()[0].id, deal.id);
    const edited = await call("PUT", `/margin-deals/${deal.id}`, { ...input, periodDays: 15 });
    check("updateMarginDeal", edited);
    assert.equal(edited.json().periodDays, 15);
    const got = await call("GET", `/margin-deals/${deal.id}`);
    check("getMarginDeal", got);
    const gone = await call("DELETE", `/margin-deals/${deal.id}`);
    assert.equal(gone.statusCode, 204);
    assert.equal((await call("GET", `/margin-deals/${deal.id}`)).statusCode, 404);
  });
});
