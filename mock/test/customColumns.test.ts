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

// What a row shows can be typed back into an equality filter (QA 2026-10-31): numbers shown rounded compare rounded,
// times shown to the millisecond match their whole millisecond.
describe("equality filters find the value the row shows (§13.25)", { skip }, () => {
  test("rate line change % and platform rate, as shown", async () => {
    // A table with a real rate change, so the change % has decimals underneath what it shows.
    const { rows: t } = await db().query(
      `SELECT l.rate_table_id AS id FROM rate_lines l JOIN rate_lines p ON p.rate_table_id = l.rate_table_id
        AND p.mccmnc = l.mccmnc AND p.sender_id IS NOT DISTINCT FROM l.sender_id AND p.valid_from < l.valid_from
        AND p.rate > 0 AND p.rate <> l.rate
        WHERE l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now()) LIMIT 1`,
    );
    if (!t[0]) return;
    const table = { field: "rateTableId", op: "eq", value: Number(t[0].id) };
    const r = await post("/rate-lines/query", where(table, { field: "changePct", op: "not_empty" }));
    assert.equal(r.statusCode, 200, r.body);
    const row = (r.json().rows as { id: number; changePct: number; sysRate: number }[])[0];
    assert.ok(row, "a rate line with a change");
    for (const c of [
      { field: "changePct", op: "eq", value: row.changePct },
      { field: "changePct", op: "between", values: [row.changePct, row.changePct] },
      { field: "sysRate", op: "eq", value: row.sysRate },
      { field: "sysRate", op: "between", values: [row.sysRate, row.sysRate] },
    ])
      assert.ok((await ids("/rate-lines/query", where(table, c))).has(row.id), JSON.stringify(c));
  });

  test("a time as shown, alone or as both ends of a period", async () => {
    const r = await post("/enterprises/query", { sort: [{ field: "updatedAt", dir: "desc" }], limit: 1 });
    const row = r.json().rows[0] as { id: number; updatedAt: string };
    // Stored to the microsecond, shown to the millisecond.
    assert.match(row.updatedAt, /\.\d{3}Z$/);
    for (const c of [
      { field: "updatedAt", op: "between", values: [row.updatedAt, row.updatedAt] },
      { field: "updatedAt", op: "lte", value: row.updatedAt },
    ])
      assert.ok((await ids("/enterprises/query", where(c))).has(row.id), JSON.stringify(c));
    assert.ok(
      !(await ids("/enterprises/query", where({ field: "updatedAt", op: "gt", value: row.updatedAt }))).has(row.id),
    );
  });
});
