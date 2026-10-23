// Enterprise Rules tab (team trial round 4): one merged rule order over an enterprise's trunks; saving sets it on
// every trunk as one change, which undo takes back. Checked against the contract. Needs the seeded database.
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

describe("enterprise rules", { skip }, () => {
  test("merged order, reorder on every trunk, undo", async () => {
    // An enterprise whose customer trunks run at least two translation rules.
    const { rows } = await db().query(
      `SELECT e.id FROM enterprises e
        WHERE e.deleted_at IS NULL AND (SELECT count(*) FROM customer_trunks t WHERE t.enterprise_id = e.id AND t.deleted_at IS NULL) > 1
        ORDER BY e.id LIMIT 40`,
    );
    let id = 0;
    let before: { translation: { ruleId: number }[] } | null = null;
    for (const r of rows) {
      const res = await call("GET", `/enterprises/${r.id}/rules?kind=customer`);
      check("getEnterpriseRules", res);
      if (res.json().translation.length > 1) {
        id = Number(r.id);
        before = res.json();
        break;
      }
    }
    assert.ok(id && before, "an enterprise with two or more rules on its trunks");
    const ids = before.translation.map((x) => x.ruleId);
    const reversed = [...ids].reverse();
    const saved = await call("PUT", `/enterprises/${id}/rules`, { kind: "customer", translationRuleIds: reversed });
    check("updateEnterpriseRules", saved);
    const body = saved.json();
    assert.ok(body.change, "one change recorded");
    assert.deepEqual(
      body.record.translation.map((x: { ruleId: number }) => x.ruleId),
      reversed,
    );
    // Every trunk now runs them in that order.
    const { rows: trunks } = await db().query(
      "SELECT id FROM customer_trunks WHERE enterprise_id = $1 AND deleted_at IS NULL",
      [id],
    );
    for (const t of trunks) {
      const order = (await call("GET", `/customer-trunks/${t.id}/rules`)).json().translation.map(
        (x: { ruleId: number }) => x.ruleId,
      );
      const mine = reversed.filter((r) => order.includes(r));
      assert.deepEqual(
        order.filter((r: number) => mine.includes(r)),
        mine,
      );
    }
    // Bad input: a rule that does not run there.
    const bad = await call("PUT", `/enterprises/${id}/rules`, { kind: "customer", translationRuleIds: [999999999] });
    check("updateEnterpriseRules", bad);
    assert.equal(bad.statusCode, 400);
    // Undo puts the old order back.
    const undone = await call("POST", `/changes/${body.change.id}/undo`, {});
    assert.equal(undone.statusCode, 200, undone.body);
    const after = (await call("GET", `/enterprises/${id}/rules?kind=customer`)).json();
    assert.deepEqual(
      after.translation.map((x: { ruleId: number }) => x.ruleId),
      ids,
    );
  });
});
