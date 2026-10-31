// EDR rows stored twice (S-7.3, ClickHouse 010): the switch's writer used to store a batch again when the bus handed
// it out again, and the views counted it twice. Screens that list single rows show such a row once, and the nightly
// repair job removes the copy and puts the hourly figures and long-term totals right. Rows use a trunk ID and a day
// no other test reads, and are removed after with the figures the views took from them.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ListQuery } from "@sms/contract";
import { closeDb, db, dbReady } from "../src/db.js";
import { chQuery, chRows } from "../src/edr.js";
import { runChList } from "../src/lists/chEngine.js";
import { edrList, failedEdrList } from "../src/lists/edrDefs.js";
import { messageList } from "../src/api/portal.js";
import { edrsByIds } from "../src/api/observation.js";
import { repairEdrDuplicates, untilNextRun } from "../src/jobs/edrRepair.js";
import { deleteTestEdrs } from "./testEdrs.js";

const ready = await dbReady();
const keyed =
  ready &&
  Number(
    (
      await chRows<{ n: string }>(
        "SELECT count() AS n FROM system.columns WHERE database = currentDatabase() AND table = 'edr_receipt' AND name = 'row_key'",
      )
    )?.[0]?.n ?? 0,
  ) > 0;
const skip = keyed ? false : "seeded database and EDR store with ClickHouse 010 not available";

// The test marker: a customer trunk and enterprise ID of its own, on a day nothing else has.
const trunk = 4_100_000_000 + Math.floor(Math.random() * 100_000_000);
const day = "2003-03-03";
const at = (hms: string) => `${day} ${hms}`;
const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
const runs: string[] = [];

after(async () => {
  if (keyed) {
    await deleteTestEdrs(`c_trunk_id = ${trunk}`);
    if (runs.length)
      await chQuery(
        `ALTER TABLE edr_repair_runs DELETE WHERE run_id IN (${runs.map((r) => `'${r}'`).join(",")}) SETTINGS mutations_sync = 1`,
      );
  }
  await closeDb();
});

/** One INSERT per row; `copy`: stored again, as the old writer did with a batch delivered twice. */
const insert = async (table: string, r: Record<string, string | number>, copy = false) => {
  const v = (x: string | number) => (typeof x === "number" ? String(x) : `'${x}'`);
  await chQuery(
    `INSERT INTO ${table} (${Object.keys(r).join(", ")}) ${copy ? "SETTINGS insert_deduplicate = 0 " : ""}VALUES (${Object.values(r).map(v).join(", ")})`,
  );
};

const attempt = (id: string, extra: Record<string, string | number> = {}) => ({
  edr_id: id,
  row_key: `${id}:1`,
  start_time: at("10:00:00"),
  submit_time: at("10:00:00"),
  msg_type: "MT",
  business_company_id: 1,
  c_enterprise_id: trunk,
  c_trunk_id: trunk,
  v_enterprise_id: trunk + 1,
  v_trunk_id: 902,
  src_addr: "QA",
  c_mccmnc: "20601",
  c_country_iso: "BE",
  attempt_no: 1,
  is_final_attempt: 1,
  is_submit_success: 1,
  msg_count: 1,
  c_msg_status: "ACCEPTD",
  ...extra,
});

const outcome = {
  edr_id: a,
  row_key: `${a}:outcome:0:1046685603000:DELIVRD`,
  kind: "outcome",
  receipt_time: at("10:00:03"),
  start_time: at("10:00:00"),
  business_company_id: 1,
  c_enterprise_id: trunk,
  c_trunk_id: trunk,
  v_enterprise_id: trunk + 1,
  v_trunk_id: 902,
  src_addr: "QA",
  c_mccmnc: "20601",
  c_country_iso: "BE",
  attempt_no: 1,
  msg_count: 1,
  msg_status: "DELIVRD",
  c_msg_status: "DELIVRD",
  delivery_delay_ms: 3000,
  is_customer_billable: 1,
  revenue: 0.02,
  revenue_sys: 0.02,
};

/** The detailed rows and what the views summed from them, for the test trunk. */
async function figures() {
  const [r] = await chQuery<Record<string, string>>(
    `SELECT (SELECT count() FROM edr WHERE c_trunk_id = ${trunk}) AS attempts,
            (SELECT count() FROM edr_receipt WHERE c_trunk_id = ${trunk}) AS receipts,
            (SELECT sumIf(rows, kind = 'attempt') FROM edr_totals WHERE c_trunk_id = ${trunk}) AS totalAttempts,
            (SELECT sumIf(rows, kind = 'outcome') FROM edr_totals WHERE c_trunk_id = ${trunk}) AS totalOutcomes,
            (SELECT toString(sum(revenue_sys)) FROM edr_totals WHERE c_trunk_id = ${trunk}) AS totalRevenue,
            (SELECT sum(attempts) FROM edr_hourly WHERE c_trunk_id = ${trunk}) AS hourlyAttempts,
            (SELECT sum(delivered) FROM edr_hourly WHERE c_trunk_id = ${trunk}) AS hourlyDelivered,
            (SELECT toString(sum(revenue_sys)) FROM edr_hourly WHERE c_trunk_id = ${trunk}) AS hourlyRevenue,
            (SELECT sum(rows) FROM edr_sender_daily WHERE c_trunk_id = ${trunk}) AS senderRows`,
  );
  return Object.fromEntries(Object.entries(r!).map(([k, v]) => [k, Number(v)]));
}

const mine: ListQuery = {
  filter: { logic: "and", conditions: [{ field: "customerEnterpriseId", op: "eq", value: trunk }] },
  limit: 50,
  withTotal: true,
};

describe("EDR rows stored twice (S-7.3, ClickHouse 010)", { skip }, () => {
  test("setup: A and its outcome and the failed C stored twice, B once", async () => {
    await insert("edr", attempt(a));
    await insert("edr", attempt(b));
    await insert(
      "edr",
      attempt(c, { v_trunk_id: 0, v_enterprise_id: 0, is_submit_success: 0, c_msg_status: "REJECTD" }),
    );
    await insert("edr_receipt", outcome);
    await insert("edr", attempt(a), true);
    await insert(
      "edr",
      attempt(c, { v_trunk_id: 0, v_enterprise_id: 0, is_submit_success: 0, c_msg_status: "REJECTD" }),
      true,
    );
    await insert("edr_receipt", outcome, true);
    assert.deepEqual(await figures(), {
      attempts: 5,
      receipts: 2,
      totalAttempts: 5,
      totalOutcomes: 2,
      totalRevenue: 0.04,
      hourlyAttempts: 5,
      hourlyDelivered: 2,
      hourlyRevenue: 0.04,
      senderRows: 7,
    });
  });

  test("EDR details, EDR search, Failed EDRs and the portal show each row once, with its money once", async () => {
    const details = await edrsByIds(db(), [a, b, a], ["msgStatus", "revenue"]);
    assert.deepEqual(details.map((r) => r.id).sort(), [a, b].sort());
    assert.equal(details.find((r) => r.id === a)!.revenue, 0.02);
    assert.equal(details.find((r) => r.id === a)!.msgStatus, "DELIVRD");

    const page = await runChList(db(), edrList, mine);
    assert.deepEqual(page.rows.map((r) => r.id).sort(), [a, b, c].sort());
    assert.equal(page.rows.find((r) => r.id === a)!.revenue, 0.02);

    const failed = await runChList(db(), failedEdrList, mine);
    assert.deepEqual(
      failed.rows.map((r) => r.id),
      [c],
    );

    const portal = await runChList(db(), messageList(trunk), { limit: 50, withTotal: false });
    assert.deepEqual(portal.rows.map((r) => r.id).sort(), [a, b, c].sort());
    assert.equal(portal.rows.find((r) => r.id === a)!.amount, 0.02);

    // A page that ends in a copy: the next page starts after both copies.
    const first = await runChList(db(), edrList, { ...mine, limit: 1, sort: [{ field: "id", dir: "asc" }] });
    const ids: string[] = first.rows.map((r) => r.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await runChList(db(), edrList, { ...mine, limit: 1, sort: [{ field: "id", dir: "asc" }], cursor });
      ids.push(...next.rows.map((r) => r.id));
      cursor = next.nextCursor;
    }
    assert.deepEqual(ids, [a, b, c].sort());
  });

  test("the repair job removes the copies and the totals come back to the detailed rows", async () => {
    const r = await repairEdrDuplicates({ days: [day] });
    runs.push(r.runId);
    assert.equal(r.keysFound, 3);
    assert.equal(r.rowsRemoved, 3);
    assert.equal(r.keysLeft, 0);
    assert.ok(r.totalsRows > 0);
    assert.deepEqual(await figures(), {
      attempts: 3,
      receipts: 1,
      totalAttempts: 3,
      totalOutcomes: 1,
      totalRevenue: 0.02,
      hourlyAttempts: 3,
      hourlyDelivered: 1,
      hourlyRevenue: 0.02,
      senderRows: 4,
    });
    // Each kept row is whole, and no group of the totals is left below zero.
    const [kept] = await chQuery<{ n: string; rev: string }>(
      `SELECT count() AS n, toString(sum(revenue_sys)) AS rev FROM edr_receipt WHERE c_trunk_id = ${trunk} AND edr_id = '${a}'`,
    );
    assert.deepEqual(kept, { n: "1", rev: "0.02" });
    const [negative] = await chQuery<{ n: string }>(
      `SELECT count() AS n FROM (SELECT sum(rows) AS s FROM edr_totals WHERE c_trunk_id = ${trunk} GROUP BY ALL HAVING s < 0)`,
    );
    assert.equal(negative!.n, "0");

    // What it did is recorded: the keys before anything changed, and the outcome.
    const log = await chQuery<{ status: string; table_name: string; keys: string; removed: string }>(
      `SELECT status, table_name, toString(keys_found) AS keys, toString(rows_removed) AS removed FROM edr_repair_runs
        WHERE run_id = '${r.runId}' ORDER BY status, table_name`,
    );
    assert.deepEqual(log, [
      { status: "done", table_name: "", keys: "3", removed: "3" },
      { status: "started", table_name: "edr", keys: "2", removed: "0" },
      { status: "started", table_name: "edr_receipt", keys: "1", removed: "0" },
    ]);
  });

  test("a second run finds nothing and writes nothing", async () => {
    const before = await figures();
    const r = await repairEdrDuplicates({ days: [day] });
    runs.push(r.runId);
    assert.deepEqual([r.keysFound, r.rowsRemoved, r.totalsRows, r.keysLeft], [0, 0, 0, 0]);
    assert.deepEqual(await figures(), before);
  });
});

test("the job runs at night, once a day", () => {
  assert.equal(untilNextRun(new Date("2026-10-31T03:00:00Z")), 17 * 60_000);
  assert.equal(untilNextRun(new Date("2026-10-31T03:17:00Z")), 24 * 3_600_000);
  assert.equal(untilNextRun(new Date("2026-10-31T12:00:00Z")), (15 * 60 + 17) * 60_000);
});
