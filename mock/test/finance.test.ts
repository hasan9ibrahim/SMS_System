// Finance part 1 (build step 5.5, §7, §13.33): transactions with the confirmation and In SOA,
// currencies and rates, billing cycles, balances and charges, against the seeded database. Every
// response is checked against the contract; each test undoes its own changes (§13.10).
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change } from "@sms/contract";
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

async function customerWithInvoice() {
  const { rows } = await db().query(
    `SELECT i.id AS invoice_id, i.enterprise_id, i.currency FROM invoices i
       JOIN enterprises e ON e.id = i.enterprise_id AND e.deleted_at IS NULL
      WHERE i.deleted_at IS NULL ORDER BY i.id LIMIT 1`,
  );
  return {
    invoiceId: Number(rows[0].invoice_id),
    enterpriseId: Number(rows[0].enterprise_id),
    currency: String(rows[0].currency).trim(),
  };
}

const payment = (f: { enterpriseId: number; invoiceId: number | null; currency: string }, over: object = {}) => ({
  side: "customer",
  enterpriseId: f.enterpriseId,
  invoiceId: f.invoiceId,
  paymentMode: "bank_transfer",
  transactionType: "receipt",
  paymentType: "credit",
  paymentDate: "2026-10-15",
  amount: 123.45,
  currency: f.currency,
  description: `Test payment ${run}`,
  sendConfirmation: false,
  includeInSoa: true,
  excludeReason: null,
  ...over,
});

describe("transactions (§7, §13.33)", { skip }, () => {
  test("add with conversion, confirmation, In SOA with reason, edit, delete, undo", async () => {
    const f = await customerWithInvoice();
    const preview = await ok(
      "previewTransactionConfirmation",
      call("POST", "/transactions/confirmation-preview", payment(f)),
    );
    assert.ok(preview.body.includes("123.45"));
    const created = await ok(
      "createTransaction",
      call("POST", "/transactions", payment(f, { sendConfirmation: true, currency: "EUR" })),
      201,
    );
    const r = created.record;
    assert.equal(r.currency, "EUR");
    assert.ok(r.amountBase > 0 && r.exRate > 0);
    assert.equal(r.amountBase, Math.round(123.45 * r.exRate * 10_000) / 10_000, "Final Amount = amount x rate");
    assert.ok(["sent", "failed"].includes(r.confirmationStatus));

    const noReason = await call("PUT", `/transactions/${r.id}`, payment(f, { currency: "EUR", includeInSoa: false }));
    assert.equal(noReason.statusCode, 400, "excluding from the SOA needs a reason");
    const excluded = await ok(
      "updateTransaction",
      call(
        "PUT",
        `/transactions/${r.id}`,
        payment(f, { currency: "EUR", sendConfirmation: true, includeInSoa: false, excludeReason: "Bank charges" }),
      ),
    );
    assert.ok(excluded.change.note.includes("Excluded from SOA"));
    assert.equal(excluded.record.includeInSoa, false);
    // Undoing the exclusion writes both fields at once (In SOA requires a reason when off).
    await undo(excluded.change);
    const back = await ok("getTransaction", call("GET", `/transactions/${r.id}`));
    assert.equal(back.includeInSoa, true);
    assert.equal(back.excludeReason, null);

    const moved = await ok(
      "updateTransaction",
      call("PUT", `/transactions/${r.id}`, payment(f, { currency: "USD", sendConfirmation: true, amount: 200 })),
    );
    assert.ok(
      moved.change.diff.some((d: { field: string }) => d.field === "amountBase"),
      "converted again",
    );
    await undo(moved.change);

    const gone = await ok("archiveTransaction", call("POST", `/transactions/${r.id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    await undo(gone.change);
    await undo(created.change);
    const archived = await ok("getTransaction", call("GET", `/transactions/${r.id}`));
    assert.ok(archived.archivedAt, "undoing the add archives the payment");
  });

  test("validation: invoice of another enterprise, reprocess by hand, payment mode", async () => {
    const f = await customerWithInvoice();
    const { rows } = await db().query("SELECT id FROM enterprises WHERE id <> $1 AND deleted_at IS NULL LIMIT 1", [
      f.enterpriseId,
    ]);
    const bad = await call("POST", "/transactions", payment({ ...f, enterpriseId: Number(rows[0].id) }));
    assert.equal(bad.statusCode, 400);
    assert.ok(bad.json().errors.some((e: { path: string }) => e.path === "/invoiceId"));
    const reprocess = await call("POST", "/transactions", payment(f, { transactionType: "reprocess" }));
    assert.ok(reprocess.json().errors.some((e: { path: string }) => e.path === "/transactionType"));
    const mode = await call("POST", "/transactions", payment(f, { paymentMode: null }));
    assert.ok(mode.json().errors.some((e: { path: string }) => e.path === "/paymentMode"));
  });

  test("bulk exclude and include, conversion helper, list filters at full volume", async () => {
    const page = await ok(
      "queryTransactions",
      call("POST", "/transactions/query", {
        limit: 3,
        filter: {
          logic: "and",
          conditions: [
            { field: "includeInSoa", op: "eq", value: true },
            { field: "transactionType", op: "in", values: ["receipt"] },
          ],
        },
      }),
    );
    const ids = page.rows.map((r: { id: number }) => r.id);
    const noReason = await call("POST", "/transactions/bulk", { ids, action: "exclude_from_soa" });
    assert.equal(noReason.statusCode, 400);
    const ex = await ok(
      "bulkUpdateTransactions",
      call("POST", "/transactions/bulk", { ids, action: "exclude_from_soa", reason: `Test ${run}` }),
    );
    assert.equal(ex.change.entityIds.length, ids.length);
    await undo(ex.change);
    const conv = await ok(
      "convertTransactionAmount",
      call("POST", "/transactions/convert", {
        enterpriseId: page.rows[0].enterpriseId,
        amount: 100,
        currency: "GBP",
        date: "2026-10-01",
      }),
    );
    assert.ok(conv.exRate > 0 && conv.amountBase > 0);
    const file = await call("POST", "/transactions/export", { limit: 10 });
    assert.ok(file.body.startsWith("id,enterprise,"));
  });
});

describe("currencies, rates, billing cycles (§7)", { skip }, () => {
  test("add a currency, edit its rate (history kept), undo", async () => {
    const iso = `X${run
      .slice(-2)
      .toUpperCase()
      .replace(/[^A-Z]/g, "Q")}`
      .padEnd(3, "Q")
      .slice(0, 3);
    await db().query("DELETE FROM currency_rates WHERE iso = $1", [iso]);
    await db().query("DELETE FROM currencies WHERE iso = $1", [iso]);
    const created = await ok(
      "createCurrency",
      call("POST", "/currencies", { iso, name: "Test Crown", symbol: "T$", ratePerEur: 2.5 }),
      201,
    );
    assert.equal(created.record.ratePerEur, 2.5);
    const dup = await call("POST", "/currencies", { iso, name: "Again", symbol: "A", ratePerEur: 1 });
    assert.equal(dup.statusCode, 409);
    const rate = await ok("setCurrencyRate", call("PUT", `/currency-rates/${iso}`, { ratePerEur: 2.75 }));
    assert.equal(rate.record.ratePerEur, 2.75);
    assert.equal(rate.record.previousRate, 2.5);
    const history = await ok(
      "queryCurrencyRateHistory",
      call("POST", "/currency-rate-history/query", {
        limit: 10,
        filter: { logic: "and", conditions: [{ field: "iso", op: "eq", value: iso }] },
      }),
    );
    assert.equal(history.total, 2, "both rates stay in the history");
    await undo(rate.change);
    const after = await ok(
      "queryCurrencyRates",
      call("POST", "/currency-rates/query", {
        limit: 1,
        filter: { logic: "and", conditions: [{ field: "iso", op: "eq", value: iso }] },
      }),
    );
    assert.equal(after.rows[0].ratePerEur, 2.5, "undo sets the earlier rate again");
    // EUR is the base currency (team trial round 2): its rate is always 1.
    const usd = await call("PUT", "/currency-rates/EUR", { ratePerEur: 2 });
    assert.equal(usd.statusCode, 400);
    await undo(created.change);
    const gone = await ok(
      "queryCurrencies",
      call("POST", "/currencies/query", {
        limit: 1,
        filter: { logic: "and", conditions: [{ field: "iso", op: "eq", value: iso }] },
      }),
    );
    assert.equal(gone.total, 0, "undoing the add archives the currency");
  });

  test("billing cycle add, rules per type, delete blocked while used, undo", async () => {
    const bad = await call("POST", "/billing-cycles", {
      name: `Weekly ${run}`,
      billingType: "weekly",
      weekDay: null,
      usageDays: 5,
      dueDays: 7,
    });
    assert.equal(bad.statusCode, 400);
    const created = await ok(
      "createBillingCycle",
      call("POST", "/billing-cycles", {
        name: `Weekly ${run}`,
        billingType: "weekly",
        weekDay: "MON",
        usageDays: 7,
        dueDays: 7,
      }),
      201,
    );
    const page = await ok(
      "queryBillingCycles",
      call("POST", "/billing-cycles/query", { limit: 1, sort: [{ field: "enterprises", dir: "desc" }] }),
    );
    const used = page.rows[0];
    const blocked = await call("POST", `/billing-cycles/${used.id}/archive`, {});
    assert.equal(blocked.statusCode, 409);
    check("archiveBillingCycle", blocked);
    const gone = await ok("archiveBillingCycle", call("POST", `/billing-cycles/${created.record.id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    await undo(gone.change);
    await undo(created.change);
  });
});

describe("balances and charges (§7)", { skip }, () => {
  test("balances list sorts by net balance; a payment raises the customer balance (positive = credit)", async () => {
    const f = await customerWithInvoice();
    const one = () =>
      ok(
        "queryEnterpriseBalances",
        call("POST", "/enterprise-balances/query", {
          limit: 1,
          filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: f.enterpriseId }] },
        }),
      ).then((p) => p.rows[0]);
    const before = await one();
    const pay = await ok(
      "createTransaction",
      call("POST", "/transactions", payment(f, { currency: before.customerCurrency, amount: 10 })),
      201,
    );
    const after = await one();
    assert.equal(Math.round((after.customerBalance - before.customerBalance) * 100) / 100, 10);
    await undo(pay.change);
    const sorted = await ok(
      "queryEnterpriseBalances",
      call("POST", "/enterprise-balances/query", { limit: 5, sort: [{ field: "netBalance", dir: "desc" }] }),
    );
    for (let i = 1; i < sorted.rows.length; i++) assert.ok(sorted.rows[i - 1].netBalance >= sorted.rows[i].netBalance);
  });

  test("charges calculator for one enterprise and for all", async () => {
    const all = await ok(
      "calculateCharges",
      call("POST", "/charges/calculate", { enterpriseId: null, from: "2026-10-14", to: "2026-10-15" }),
    );
    assert.ok(all.rows.length > 0);
    const first = all.rows[0];
    const one = await ok(
      "calculateCharges",
      call("POST", "/charges/calculate", { enterpriseId: first.enterpriseId, from: "2026-10-14", to: "2026-10-15" }),
    );
    assert.deepEqual(
      one.rows.find((r: { side: string }) => r.side === first.side),
      first,
    );
    const bad = await call("POST", "/charges/calculate", { enterpriseId: null, from: "2026-10-15", to: "2026-10-01" });
    assert.equal(bad.statusCode, 400);
  });
});
