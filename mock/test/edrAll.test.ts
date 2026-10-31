// Backend step 11b: EDRs as the Elixir switch writes them. The attempt row stays as written at send time (no final
// status, ACCEPTD to the customer, money only for billing types decided at send time) and an edr_receipt row of kind
// 'outcome' carries the final status, delay and the money billed on the receipt. Reports, invoices, EDR search, EDR
// details and downloads must read both. Rows use enterprise IDs and a day no other test reads, and are removed after.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FilterCondition, ListQuery, MasterReportQuery } from "@sms/contract";
import { closeDb, db, dbReady } from "../src/db.js";
import { chQuery, chRows } from "../src/edr.js";
import { runMasterReport } from "../src/reports/engine.js";
import { usageLines } from "../src/billing/edrFigures.js";
import { chWhere, outcomeJoin, runChList, type ChListDef } from "../src/lists/chEngine.js";
import { edrList } from "../src/lists/edrDefs.js";
import { edrsByIds } from "../src/api/observation.js";
import { setDetailHorizonForTests } from "../src/reports/source.js";
import { deleteTestEdrs } from "./testEdrs.js";

const ready = await dbReady();
const edrStore = ready && (await chRows<{ n: string }>("SELECT count() FROM edr_all LIMIT 1")) !== null;
const skip = ready && edrStore ? false : "seeded database and EDR store with migration 006 not available";

const ent = 4_000_000 + Math.floor(Math.random() * 900_000);
const vendor = ent + 1;
const day = "2025-01-15";
const at = (hms: string) => `${day} ${hms}`;
const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];

after(async () => {
  setDetailHorizonForTests(null);
  // The EDRs with the hourly figures and long-term totals their views took (QA 2026-10-31: edr_hourly was left).
  if (edrStore) await deleteTestEdrs(`c_enterprise_id = ${ent}`);
  await closeDb();
});

/** One INSERT per row: rows carry different columns, the rest take their defaults. */
const insert = async (table: string, rows: Record<string, string | number>[]) => {
  const v = (x: string | number) => (typeof x === "number" ? String(x) : `'${x}'`);
  for (const r of rows)
    await chQuery(`INSERT INTO ${table} (${Object.keys(r).join(", ")}) VALUES (${Object.values(r).map(v).join(", ")})`);
};

const attempt = (id: string, time: string, extra: Record<string, string | number>) => ({
  edr_id: id,
  start_time: at(time),
  submit_time: at(time),
  msg_type: "MT",
  business_company_id: 1,
  c_enterprise_id: ent,
  c_trunk_id: 901,
  v_enterprise_id: vendor,
  v_trunk_id: 902,
  c_mccmnc: "20601",
  c_mcc: "206",
  c_country_iso: "BE",
  c_currency: "EUR",
  c_ex_rate: 1,
  v_currency: "EUR",
  v_ex_rate: 1,
  attempt_no: 1,
  is_final_attempt: 1,
  is_submit_success: 1,
  msg_count: 1,
  msg_status: "",
  c_msg_status: "ACCEPTD",
  delivery_delay_ms: 0,
  is_customer_billable: 0,
  is_vendor_billable: 0,
  revenue: 0,
  revenue_sys: 0,
  cost: 0,
  cost_sys: 0,
  ...extra,
});

const outcome = (id: string, time: string, extra: Record<string, string | number>) => ({
  edr_id: id,
  kind: "outcome",
  receipt_time: at(time),
  start_time: at("10:00:00"),
  business_company_id: 1,
  c_enterprise_id: ent,
  c_trunk_id: 901,
  v_enterprise_id: vendor,
  v_trunk_id: 902,
  c_mccmnc: "20601",
  c_country_iso: "BE",
  attempt_no: 1,
  c_currency: "EUR",
  c_ex_rate: 1,
  v_currency: "EUR",
  v_ex_rate: 1,
  source: "vendor",
  ...extra,
});

describe("switch-shaped EDRs: attempt rows plus outcome rows (backend step 11b)", { skip }, () => {
  test("setup", async () => {
    await insert("edr", [
        // A: billed on delivery, 2 parts; the outcome carries DELIVRD and the money.
        attempt(a, "10:00:00", { msg_count: 2 }),
        // B: billed at submit; the outcome says UNDELIV and adds no money.
        attempt(b, "10:00:00", { is_customer_billable: 1, revenue: 0.01, revenue_sys: 0.01 }),
        // C: the vendor refused it; no outcome.
        attempt(c, "10:00:00", { is_submit_success: 0, c_msg_status: "REJECTD" }),
    ]);
    await insert("edr_receipt", [
        outcome(a, "10:00:03", {
          msg_status: "DELIVRD",
          c_msg_status: "DELIVRD",
          delivery_delay_ms: 3000,
          msg_count: 2,
          is_customer_billable: 1,
          is_vendor_billable: 1,
          revenue: 0.02,
          revenue_sys: 0.02,
          cost: 0.01,
          cost_sys: 0.01,
        }),
        outcome(b, "10:00:05", { msg_status: "UNDELIV", c_msg_status: "UNDELIV", delivery_error: "001", delivery_delay_ms: 5000, msg_count: 1 }),
        // The receipts themselves (003): per part from the vendor, and the one sent to the customer. They carry the
        // same report columns and statuses but are not outcome rows; edr_all must leave them out (ClickHouse 009).
        outcome(a, "10:00:02", { kind: "vendor", part_no: 1, msg_status: "DELIVRD", delivery_delay_ms: 2000, msg_count: 2 }),
        outcome(a, "10:00:03", { kind: "vendor", part_no: 2, msg_status: "DELIVRD", delivery_delay_ms: 3000, msg_count: 2 }),
        outcome(a, "10:00:03", { kind: "customer", c_msg_status: "DELIVRD", delivery_delay_ms: 3000, msg_count: 2 }),
        outcome(b, "10:00:05", { kind: "vendor", msg_status: "UNDELIV", delivery_delay_ms: 5000, revenue_sys: 0.01 }),
        outcome(b, "10:00:05", { kind: "customer", c_msg_status: "UNDELIV", delivery_delay_ms: 5000 }),
    ]);
  });

  test("edr_all holds one row per attempt and per outcome; vendor and customer receipts are not outcomes", async () => {
    const rows = await chQuery<{ kind: string; n: string }>(
      `SELECT kind, count() AS n FROM edr_all WHERE c_enterprise_id = ${ent} GROUP BY kind ORDER BY kind`,
    );
    assert.deepEqual(
      rows.map((r) => [r.kind, Number(r.n)]),
      [
        ["attempt", 3],
        ["outcome", 2],
      ],
    );
  });

  // The day is older than the detailed months, so by default these read the long-term totals (ClickHouse 008); with
  // the horizon moved before it they read edr_all, where the receipts must not count as outcome rows (009).
  for (const [source, horizon] of [
    ["edr_all", new Date("2025-01-01T00:00:00Z")],
    ["long-term totals", null],
  ] as const) {
    test(`Master Report counts attempts once and deliveries, delay and money from the outcome rows (${source})`, async () => {
      setDetailHorizonForTests(horizon);
      const q = {
        groupBy: ["customer"],
        metrics: ["attempts", "successful", "submitted", "delivered", "reportedVendor", "billableCustomer", "revenueBase", "deliveryDelayS", "dlrCustomer"],
        timezone: "UTC",
        period: "custom",
        from: `${day}T00:00:00Z`,
        to: "2025-01-16T00:00:00Z",
      } as unknown as MasterReportQuery;
      const r = await runMasterReport(db(), q, { from: new Date(`${day}T00:00:00Z`), to: new Date("2025-01-16T00:00:00Z") });
      const row = r.rows.find((x) => String(x.dims.customer?.id) === String(ent));
      assert.ok(row, JSON.stringify(r.rows));
      assert.deepEqual(
        { ...row.metrics },
        {
          ...row.metrics,
          attempts: 3,
          successful: 2,
          submitted: 3,
          delivered: 1,
          reportedVendor: 2,
          billableCustomer: 2,
          revenueBase: 0.03,
          deliveryDelayS: 3,
          dlrCustomer: 50,
        },
      );
    });

    test(`invoice usage lines bill the messages and money of both rows (${source})`, async () => {
      setDetailHorizonForTests(horizon);
      const lines = await usageLines(db(), "customer", ent, day, day, "UTC", "EUR", false);
      assert.ok(lines);
      const msgs = lines.reduce((s, l) => s + Number(l.messages), 0);
      const amount = lines.reduce((s, l) => s + Number(l.amount), 0);
      assert.equal(msgs, 3); // A's 2 parts on delivery + B's 1 at submit
      assert.equal(Math.round(amount * 1e6) / 1e6, 0.03);
    });
  }

  const mine = (more: FilterCondition[] = []): ListQuery => ({
    filter: { logic: "and", conditions: [{ field: "customerEnterpriseId", op: "eq", value: ent }, ...more] },
    limit: 50,
    withTotal: true,
  });

  test("EDR search shows the outcome's status, delay and money, and filters on the final status", async () => {
    const page = await runChList(db(), edrList, mine());
    const byId = new Map(page.rows.map((r) => [r.id, r]));
    assert.equal(page.rows.length, 3);
    assert.equal(byId.get(a)!.msgStatus, "DELIVRD");
    assert.equal(byId.get(a)!.customerMsgStatus, "DELIVRD");
    assert.equal(byId.get(a)!.revenue, 0.02);
    assert.equal(byId.get(a)!.isCustomerBillable, true);
    assert.equal(byId.get(a)!.deliveryDelaySeconds, 3);
    assert.equal(byId.get(b)!.msgStatus, "UNDELIV");
    assert.equal(byId.get(b)!.revenue, 0.01);
    assert.equal(byId.get(b)!.deliveryError, "001");
    assert.equal(byId.get(c)!.customerMsgStatus, "REJECTD");

    const delivered = await runChList(db(), edrList, mine([{ field: "msgStatus", op: "eq", value: "DELIVRD" }]));
    assert.deepEqual(delivered.rows.map((r) => r.id), [a]);
    const failed = await runChList(db(), edrList, mine([{ field: "customerMsgStatus", op: "in", values: ["UNDELIV", "REJECTD"] }]));
    assert.deepEqual(new Set(failed.rows.map((r) => r.id)), new Set([b, c]));
    // The attempt row's own ACCEPTD no longer matches once an outcome has a final status.
    const accepted = await runChList(db(), edrList, mine([{ field: "customerMsgStatus", op: "eq", value: "ACCEPTD" }]));
    assert.equal(accepted.rows.length, 0);
  });

  test("EDR details and downloads merge the outcome too", async () => {
    const [row] = await edrsByIds(db(), [a], ["msgStatus", "revenue"]);
    assert.equal(row!.msgStatus, "DELIVRD");
    assert.equal(row!.revenue, 0.02);

    const def = edrList as ChListDef<unknown>;
    const where = await chWhere(db(), def, mine());
    const j = outcomeJoin(def, ["id", "msgStatus", "revenue"], where);
    const rows = await chQuery<{ id: string; s: string; r: number }>(
      `SELECT ${j.expr("id")} AS id, ${j.expr("msgStatus")} AS s, ${j.expr("revenue")} AS r FROM ${j.from} WHERE ${where}`,
    );
    const got = new Map(rows.map((r) => [r.id, r]));
    assert.equal(got.get(a)!.s, "DELIVRD");
    assert.equal(Number(got.get(a)!.r), 0.02);
    assert.equal(got.get(c)!.s, "");
  });
});
