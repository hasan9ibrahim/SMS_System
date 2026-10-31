// ClickHouse 009: edr_all counted every receipt as an outcome row, and the long-term totals (008) took their first
// fill from it. The migration repairs the totals on every run, and a second run changes nothing. Runs in a scratch
// database of its own (all migrations applied there), dropped after.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clickhouse } from "../src/generator/loaders.js";

const DIR = fileURLToPath(new URL("../../db/clickhouse/migrations/", import.meta.url));
const DB = `qa_totals_repair_${process.pid}`;

const ready = await clickhouse("SELECT 1", "", "default").then(
  () => true,
  () => false,
);
const skip = ready ? false : "ClickHouse not available";

after(async () => {
  if (ready) await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`, "", "default");
});

const q = (sql: string) => clickhouse(sql, "", DB);
const rows = async (sql: string) =>
  (await q(`${sql} FORMAT TabSeparated`))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));

/** Every statement of the migration files, as the mock and the release run them. */
async function migrate(only?: string) {
  for (const f of readdirSync(DIR)
    .filter((x) => x.endsWith(".sql") && (!only || x.startsWith(only)))
    .sort())
    for (const stmt of readFileSync(DIR + f, "utf8")
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean))
      await q(stmt);
}

/** Per day: outcome rows in a totals table, and in the receipts. */
const perDay = (table: string) =>
  rows(`SELECT toString(d), t, r FROM
          (SELECT toDate(start_time) AS d, sum(rows) AS t FROM ${table} WHERE kind = 'outcome' GROUP BY d) AS a
          FULL OUTER JOIN
          (SELECT toDate(start_time) AS d, count() AS r FROM edr_receipt AS x WHERE x.kind = 'outcome' GROUP BY d) AS b
          USING d ORDER BY d`);

const receipts = (kind: string, day: string, n: number, status: string) =>
  q(`INSERT INTO edr_receipt (edr_id, kind, receipt_time, start_time, c_enterprise_id, c_trunk_id, v_trunk_id,
                              src_addr, msg_status, c_msg_status, delivery_delay_ms, msg_count, revenue_sys, cost_sys)
     SELECT generateUUIDv4(), '${kind}', toDateTime64('${day} 10:00:05', 3, 'UTC'),
            toDateTime64('${day} 10:00:00', 3, 'UTC') + number, 7, 8, 9, 'QA', '${status}', '${status}', 5000, 1,
            if('${kind}' = 'outcome', 0.02, 0), if('${kind}' = 'outcome', 0.01, 0)
       FROM numbers(${n})`);

describe("ClickHouse 009: outcome rows of the long-term totals", { skip }, () => {
  test("receipts the first fill took as outcome rows are taken out again, once", async () => {
    await clickhouse(`DROP DATABASE IF EXISTS ${DB} SYNC`, "", "default");
    await clickhouse(`CREATE DATABASE ${DB}`, "", "default");
    await migrate();
    // Two months: outcome rows through the materialized views (right), then what 008's first fill added from the old
    // view: the vendor and customer receipts as outcome rows.
    for (const day of ["2026-09-20", "2026-10-21"]) {
      await receipts("outcome", day, 5, "DELIVRD");
      await receipts("vendor", day, 5, "DELIVRD");
      await receipts("customer", day, 4, "UNDELIV");
    }
    const asOutcome = (table: string, cols: string) =>
      q(`INSERT INTO ${table} (${cols}, kind, msg_type, rows, msg_count, delivery_delay_ms)
         SELECT ${cols.replace("start_time", table === "edr_totals" ? "toStartOfFifteenMinutes(r.start_time)" : "toStartOfDay(r.start_time)")},
                'outcome', 'MT', count(), sum(r.msg_count), sum(r.delivery_delay_ms)
           FROM edr_receipt AS r WHERE r.kind != 'outcome' GROUP BY ALL`);
    await asOutcome("edr_totals", "start_time, c_enterprise_id, c_trunk_id, v_trunk_id, msg_status, c_msg_status");
    await asOutcome(
      "edr_sender_daily",
      "start_time, src_addr, c_enterprise_id, c_trunk_id, v_trunk_id, msg_status, c_msg_status",
    );
    assert.deepEqual(await perDay("edr_totals"), [
      ["2026-09-20", "14", "5"],
      ["2026-10-21", "14", "5"],
    ]);

    await migrate("009");
    for (const t of ["edr_totals", "edr_sender_daily"]) {
      assert.deepEqual(
        await perDay(t),
        [
          ["2026-09-20", "5", "5"],
          ["2026-10-21", "5", "5"],
        ],
        t,
      );
      // The money and counters of the outcome rows are the receipts' again, and nothing is left to merge: no
      // negative row, and no group the receipts alone made.
      assert.deepEqual(
        await rows(`SELECT sum(msg_count), sum(delivery_delay_ms), toString(sum(revenue_sys)), countIf(rows < 0),
                           uniqExact(msg_status) FROM ${t} WHERE kind = 'outcome'`),
        [["10", "50000", "0.2", "0", "1"]],
        t,
      );
    }
    const before = await rows("SELECT count() FROM edr_totals");
    await migrate("009");
    assert.deepEqual(await rows("SELECT count() FROM edr_totals"), before, "a second run adds nothing");
  });
});
