// Route rules: each picked vendor's cost for the rule's destinations, in its currency and in EUR (team trial round 4).
// Checked against the contract and against the rate lines themselves. Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";

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

describe("vendor costs", { skip }, () => {
  test("min and max over the rule's destinations, in EUR too", async () => {
    // A vendor trunk with a few current rates, and two of its destinations.
    const { rows } = await db().query(
      `SELECT rt.vendor_trunk_id AS id, rt.currency, array_agg(l.mccmnc ORDER BY l.rate) AS codes,
              array_agg(l.rate ORDER BY l.rate) AS rates
         FROM rate_tables rt JOIN rate_lines l ON l.rate_table_id = rt.id AND l.sender_id IS NULL AND NOT l.is_blocked
              AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
        WHERE rt.kind = 'vendor' AND rt.deleted_at IS NULL AND rt.currency <> 'EUR'
        GROUP BY rt.vendor_trunk_id, rt.currency HAVING count(DISTINCT l.rate) > 1 LIMIT 1`,
    );
    assert.ok(rows[0], "a vendor table with different rates");
    const v = rows[0];
    const codes = [v.codes[0], v.codes[v.codes.length - 1]];
    const res = await call("POST", "/route-rules/vendor-costs", {
      vendorTrunkIds: [Number(v.id), 999999999],
      mccmncMode: "inclusive",
      mccmncs: codes,
    });
    check("routeVendorCosts", res);
    const [cost, none] = res.json();
    assert.equal(cost.currency, String(v.currency).trim());
    assert.equal(cost.min, Number(v.rates[0]));
    assert.equal(cost.max, Number(v.rates[v.rates.length - 1]));
    assert.equal(cost.destinations, 2);
    assert.ok(cost.minEur > 0 && cost.minEur <= cost.maxEur);
    assert.equal(none.min, null);
    // One destination: a flat figure.
    const one = (
      await call("POST", "/route-rules/vendor-costs", {
        vendorTrunkIds: [Number(v.id)],
        mccmncMode: "inclusive",
        mccmncs: [codes[0]],
      })
    ).json()[0];
    assert.equal(one.min, one.max);
  });
});
