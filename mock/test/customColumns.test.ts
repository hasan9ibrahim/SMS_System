// List columns with their own SQL honour the operator (QA 2026-10-31, §13.25): the cleanup findings' Record ID, the
// market moves' account manager and the EDRs' Vendor Msg ID used to treat most operators as eq, or failed with 500.
// The catalogue advertises only the operators each one implements. EDR rows use an enterprise ID and a day no other
// test reads, and are removed after.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { chQuery, chRows } from "../src/edr.js";
import { deleteTestEdrs } from "./testEdrs.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const edrStore = ready && (await chRows<{ n: string }>("SELECT count() FROM edr LIMIT 1")) !== null;
const ent = 5_000_000 + Math.floor(Math.random() * 900_000);
const day = "2025-02-11";

after(async () => {
  if (edrStore) await deleteTestEdrs(`c_enterprise_id = ${ent}`);
  await app.close();
  await closeDb();
});

const post = (url: string, payload: object) => app.inject({ method: "POST", url: `${API_PREFIX}${url}`, payload });
const where = (...conditions: object[]) => ({ filter: { logic: "and", conditions }, limit: 500 });
const ids = async (url: string, body: object) => {
  const r = await post(url, body);
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  return new Set((r.json().rows as { id: number | string }[]).map((x) => x.id));
};

describe("columns with their own SQL (§13.25)", { skip }, () => {
  test("cleanup findings by Record ID: eq, neq, in, empty; others refused", async () => {
    const { rows } = await db().query(
      "SELECT entity_ids[1] AS id FROM cleanup_findings WHERE cardinality(entity_ids) > 0 ORDER BY id LIMIT 1",
    );
    if (!rows[0]) return;
    const id = Number(rows[0].id);
    const url = "/cleanup-findings/query";
    const eq = await ids(url, where({ field: "entityId", op: "eq", value: id }));
    const neq = await ids(url, where({ field: "entityId", op: "neq", value: id }));
    assert.ok(eq.size > 0);
    assert.ok(
      [...eq].every((x) => !neq.has(x)),
      "neq is not eq",
    );
    assert.deepEqual(
      await ids(url, where({ field: "entityId", op: "in", values: [id, 1] })),
      new Set([...eq, ...(await ids(url, where({ field: "entityId", op: "eq", value: 1 })))]),
    );
    for (const op of ["empty", "not_empty"]) await ids(url, where({ field: "entityId", op }));
    for (const body of [
      where({ field: "entityId", op: "gt", value: id }),
      { sort: [{ field: "entityId", dir: "asc" }] },
    ]) {
      const r = await post(url, body);
      assert.equal(r.statusCode, 400, r.body);
    }
  });

  test("market moves by account manager: neq is not eq; empty is refused", async () => {
    const url = "/market-moves/query";
    const { rows } = await db().query(
      "SELECT affected_am_ids[1] AS id FROM market_moves WHERE cardinality(affected_am_ids) > 0 LIMIT 1",
    );
    if (rows[0]) {
      const id = Number(rows[0].id);
      const eq = await ids(url, where({ field: "amUserId", op: "eq", value: id }));
      const neq = await ids(url, where({ field: "amUserId", op: "neq", value: id }));
      assert.ok(eq.size > 0 && [...eq].every((x) => !neq.has(x)));
    }
    for (const op of ["empty", "not_empty"]) {
      const r = await post(url, where({ field: "amUserId", op }));
      assert.equal(r.statusCode, 400, r.body);
    }
  });

  test("EDRs by Vendor Msg ID: any case, not_like and regex mean what they say", { skip: !edrStore }, async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await chQuery(
      `INSERT INTO edr (edr_id, start_time, submit_time, c_enterprise_id, v_message_id) VALUES
         ('${a}', '${day} 10:00:00', '${day} 10:00:00', ${ent}, 'AbC123,def456'),
         ('${b}', '${day} 10:00:01', '${day} 10:00:01', ${ent}, 'xyz789')`,
    );
    const period = { field: "startTime", op: "between", values: [`${day}T00:00:00Z`, `${day}T23:59:59Z`] };
    const mine = { field: "customerEnterpriseId", op: "eq", value: ent };
    const by = (c: object) => ids("/edrs/query", where(period, mine, c));
    assert.deepEqual(await by({ field: "vendorMsgId", op: "eq", value: "abc123" }), new Set([a]));
    assert.deepEqual(await by({ field: "vendorMsgId", op: "eq", value: "DEF456" }), new Set([a]));
    assert.deepEqual(await by({ field: "vendorMsgId", op: "like", value: "abc%" }), new Set([a]));
    assert.deepEqual(await by({ field: "vendorMsgId", op: "not_like", value: "abc%" }), new Set([b]));
    assert.deepEqual(await by({ field: "vendorMsgId", op: "regex", value: "^xy" }), new Set([b]));
    assert.deepEqual(await by({ field: "vendorMsgId", op: "neq", value: "XYZ789" }), new Set([a]));
  });
});
