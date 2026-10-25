// SOA and SOA report (build step 5.7, §7, §13.31, §13.33): the statement adds up, manual adds,
// removes and entries move lines as §13.31 says and are undoable, e-mail templates fill in, and
// exports and sends run as reports with files. Every response is checked against the contract;
// rows the tests create are removed afterwards.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change, SoaLine, SoaSide, SoaStatement } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { simplePdf, spreadsheetXml } from "../src/billing/files.js";

process.env.SOA_JOB_STEP_MS = "0";
const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const started = new Date();
after(async () => {
  if (ready) {
    await db().query("DELETE FROM soa_reports WHERE inserted_at >= $1 AND created_by_id IS NOT NULL", [started]);
    await db().query("DELETE FROM soa_adjustments WHERE inserted_at >= $1", [started]);
  }
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

const sum = (lines: SoaLine[]) => Math.round(lines.reduce((t, l) => t + l.amount, 0) * 100) / 100;
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.02, `${what}: ${a} vs ${b}`);
const period = { invoiceType: "all", from: "2026-01-01", to: "2026-10-16" };

/** A reciprocal partner with a disputed vendor invoice and a payment left off the SOA. */
async function partner() {
  const { rows } = await db().query(
    `SELECT e.id FROM enterprises e WHERE e.type = 'reciprocal' AND e.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM vendor_invoices v WHERE v.enterprise_id = e.id AND v.recon_status = 'disputed'
                     AND v.deleted_at IS NULL AND v.invoice_date >= '2026-01-01')
        AND EXISTS (SELECT 1 FROM transactions t WHERE t.enterprise_id = e.id AND NOT t.include_in_soa AND t.deleted_at IS NULL
                     AND t.payment_date >= '2026-01-01')
        AND EXISTS (SELECT 1 FROM enterprise_contacts c WHERE c.enterprise_id = e.id AND c.contact_type IN ('finance','commercial'))
      ORDER BY e.id LIMIT 1`,
  );
  return Number(rows[0].id);
}
const statement = (enterpriseId: number): Promise<SoaStatement> =>
  ok("getSoaStatement", call("POST", "/soa/statement", { enterpriseId, ...period }));

describe("SOA files (§13.31 export)", () => {
  test("PDF pages and Excel XML", () => {
    const pdf = simplePdf(Array.from({ length: 120 }, (_, i) => ({ text: `Line ${i}` }))).toString("latin1");
    assert.match(pdf, /\/Count 3 >>/, "120 lines need three A4 pages");
    const xml = spreadsheetXml("SOA <test>", [{ cells: ["A & B", 12.5, null], bold: true }]).toString("utf8");
    assert.ok(xml.includes('ss:Name="SOA &lt;test&gt;"'));
    assert.ok(xml.includes("A &amp; B") && xml.includes('<Data ss:Type="Number">12.5</Data>'));
  });

  test("a long PDF keeps every line and repeats the column headings on each page (backend step 12)", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ text: `Row ${i}`, size: 8 }));
    const pdf = simplePdf(rows, [{ text: "Destination | Messages", size: 8, bold: true }]).toString("latin1");
    assert.ok(pdf.includes("(Row 4999)"), "the last row is in the file");
    const pages = Number(/\/Count (\d+) >>/.exec(pdf)![1]);
    assert.ok(pages > 50);
    assert.equal(pdf.split("(Destination | Messages)").length - 1, pages - 1, "headings on every page after the first");
  });
});

describe("SOA statement (§7, §13.31, §13.33)", { skip }, () => {
  test("adds up and explains the difference from the system balance", async () => {
    const st = await statement(await partner());
    assert.equal(st.sides.length, 2, "reciprocal: customer and vendor side");
    assert.ok(st.net, "net balance for reciprocal partners");
    for (const s of st.sides as SoaSide[]) {
      near(s.closingBalance, s.openingBalance + sum(s.lines), `${s.side} closing = opening + lines`);
      if (s.lines.length) near(s.lines.at(-1)!.balance!, s.closingBalance, "running balance ends at the closing");
      const manual = sum(s.lines.filter((l) => l.source === "manual"));
      near(s.difference, manual - sum(s.excludedPayments) - sum(s.removed), `${s.side} difference`);
      assert.ok(
        s.lines.every((l, i) => i === 0 || s.lines[i - 1]!.date <= l.date),
        "lines by date",
      );
    }
    const vendor = st.sides.find((s) => s.side === "vendor")!;
    assert.ok(vendor.disputed.length > 0 && vendor.disputed.every((l) => l.status !== "accepted"));
    assert.ok(vendor.lines.filter((l) => l.kind === "vendor_invoice").every((l) => l.status === "accepted"));
    const customer = st.sides.find((s) => s.side === "customer")!;
    assert.ok(customer.excludedPayments.length > 0 && customer.excludedPayments.every((l) => l.note));
  });

  test("search summarises each enterprise", async () => {
    const id = await partner();
    const r = await ok("searchSoa", call("POST", "/soa/search", { enterpriseIds: [id, id], ...period }));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].sides.length, 2);
    const bad = await call("POST", "/soa/search", {
      enterpriseIds: [id],
      invoiceType: "all",
      from: "2026-10-16",
      to: "2026-01-01",
    });
    assert.equal(bad.statusCode, 400);
  });

  test("manual add, remove and entry move lines; undo takes them back", async () => {
    const id = await partner();
    const st = await statement(id);
    const customer = st.sides.find((s) => s.side === "customer")!;
    const vendor = st.sides.find((s) => s.side === "vendor")!;
    const inv = customer.lines.find((l) => l.kind === "invoice")!;
    const noReason = await call("POST", "/soa/adjustments", {
      enterpriseId: id,
      action: "exclude_invoice",
      invoiceId: inv.refId,
      note: null,
    });
    assert.equal(noReason.statusCode, 400);
    const removed = await ok(
      "createSoaAdjustment",
      call("POST", "/soa/adjustments", {
        enterpriseId: id,
        action: "exclude_invoice",
        invoiceId: inv.refId,
        note: "Billed twice",
      }),
      201,
    );
    let s2 = (await statement(id)).sides.find((s) => s.side === "customer")!;
    assert.ok(s2.removed.some((l) => l.key === inv.key && l.note === "Billed twice" && l.source === "manual"));
    near(s2.closingBalance, customer.closingBalance - inv.amount, "removing the invoice raises the closing balance");
    await undo(removed.change);
    s2 = (await statement(id)).sides.find((s) => s.side === "customer")!;
    assert.ok(
      s2.lines.some((l) => l.key === inv.key),
      "undo puts it back",
    );

    const disputed = vendor.disputed[0]!;
    const added = await ok(
      "createSoaAdjustment",
      call("POST", "/soa/adjustments", {
        enterpriseId: id,
        action: "include_vendor_invoice",
        vendorInvoiceId: disputed.refId,
        note: "Agreed to show it",
      }),
      201,
    );
    const v2 = (await statement(id)).sides.find((s) => s.side === "vendor")!;
    assert.ok(v2.lines.some((l) => l.key === disputed.key && l.source === "manual"));
    const vi = await ok("getVendorInvoice", call("GET", `/vendor-invoices/${disputed.refId}`));
    assert.equal(vi.inSoa, "included", "the vendor invoice screen shows the manual add");
    const twice = await call("POST", "/soa/adjustments", {
      enterpriseId: id,
      action: "include_vendor_invoice",
      vendorInvoiceId: disputed.refId,
      note: null,
    });
    assert.equal(twice.statusCode, 409);
    const back = await ok("archiveSoaAdjustment", call("POST", `/soa/adjustments/${added.record.id}/archive`, {}));
    assert.ok(back.record.archivedAt);

    const wrongCcy = await call("POST", "/soa/adjustments", {
      enterpriseId: id,
      action: "entry",
      entry: {
        side: "customer",
        kind: "credit_note",
        date: "2026-05-01",
        amount: 25,
        currency: customer.currency === "EUR" ? "GBP" : "EUR",
        description: "Goodwill",
      },
      note: null,
    });
    assert.equal(wrongCcy.statusCode, 400);
    const entry = await ok(
      "createSoaAdjustment",
      call("POST", "/soa/adjustments", {
        enterpriseId: id,
        action: "entry",
        entry: {
          side: "customer",
          kind: "credit_note",
          date: "2026-05-01",
          amount: 25,
          currency: null,
          description: "Goodwill",
        },
        note: "Agreed by phone",
      }),
      201,
    );
    s2 = (await statement(id)).sides.find((s) => s.side === "customer")!;
    const line = s2.lines.find((l) => l.key === `entry:${entry.record.id}`)!;
    assert.equal(line.kind, "manual_credit_note");
    near(s2.closingBalance, customer.closingBalance + 25, "a manual entry is on the SOA");
    near(s2.systemBalance, customer.systemBalance, "but not in the system balance");
    await undo(entry.change);

    // The other option (decided 2026-10-17): the entry records a real transaction and changes the balance.
    const real = await ok(
      "createSoaAdjustment",
      call("POST", "/soa/adjustments", {
        enterpriseId: id,
        action: "entry",
        entry: {
          side: "customer",
          kind: "payment",
          date: "2026-05-02",
          amount: 40,
          currency: null,
          description: "Cash received at the office",
          affectsBalance: true,
        },
        note: null,
      }),
      201,
    );
    assert.equal(real.record.affectsBalance, true);
    const txId = real.record.transactionId;
    assert.ok(txId, "a transaction was recorded");
    const tx = await ok("getTransaction", call("GET", `/transactions/${txId}`));
    assert.deepEqual([tx.transactionType, tx.paymentType, tx.amount, tx.side], ["receipt", "credit", 40, "customer"]);
    s2 = (await statement(id)).sides.find((s) => s.side === "customer")!;
    const realLines = s2.lines.filter((l) => l.adjustmentId === real.record.id);
    assert.equal(realLines.length, 1, "shown once, as the entry's line");
    assert.equal(realLines[0]!.source, "manual");
    near(s2.systemBalance, customer.systemBalance + 40, "the balance changes");
    near(s2.difference, customer.difference, "and the SOA agrees with it as before");
    await undo(real.change);
    const gone = await ok("getTransaction", call("GET", `/transactions/${txId}`));
    assert.ok(gone.archivedAt, "undo deletes the transaction too");
    s2 = (await statement(id)).sides.find((s) => s.side === "customer")!;
    near(s2.systemBalance, customer.systemBalance, "balance back");
  });
});

describe("SOA e-mail and reports (§7 SOA Report)", { skip }, () => {
  test("template placeholders; only SOA templates", async () => {
    const id = await partner();
    const preview = await ok(
      "previewSoaEmail",
      call("POST", "/soa/email-preview", { enterpriseId: id, ...period, templateId: 1 }),
    );
    assert.ok(preview.recipients.length > 0);
    assert.ok(!/\{\w+\}/.test(preview.subject + preview.body), "every placeholder filled");
    assert.ok(preview.subject.includes("2026-01-01"));
    const invoiceTemplate = await call("POST", "/soa/email-preview", { enterpriseId: id, ...period, templateId: 4 });
    assert.equal(invoiceTemplate.statusCode, 400);
    const templates = await ok("queryEmailTemplates", call("POST", "/email-templates/query", { limit: 10 }));
    assert.ok(templates.rows.length >= 3);
  });

  async function waitReport(id: number) {
    for (let i = 0; i < 200; i++) {
      const r = await ok("getSoaReport", call("GET", `/soa-reports/${id}`));
      if (r.status === "success" || r.status === "failed") return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`report ${id} did not finish`);
  }

  test("export Excel and PDF, send e-mail, send again from the report list", async () => {
    const id = await partner();
    const { rows } = await db().query(
      `SELECT e.id FROM enterprises e JOIN enterprise_billing b ON b.enterprise_id = e.id
        WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM enterprise_contacts c WHERE c.enterprise_id = e.id
              AND c.contact_type IN ('finance','commercial') AND cardinality(c.emails) > 0) LIMIT 1`,
    );
    for (const fileType of ["excel", "pdf"] as const) {
      const r = await ok("exportSoa", call("POST", "/soa/export", { enterpriseIds: [id], ...period, fileType }), 202);
      const done = await waitReport(r.reports[0].id);
      assert.equal(done.status, "success", done.error);
      assert.equal(done.purpose, "export");
      const file = await call("GET", `/soa-reports/${done.id}/file`);
      assert.equal(file.statusCode, 200);
      if (fileType === "pdf") assert.ok(file.rawPayload.subarray(0, 8).toString() === "%PDF-1.4");
      else assert.ok(file.body.includes("<Workbook") && file.body.includes("Closing balance"));
    }
    const ids = rows[0] ? [id, Number(rows[0].id)] : [id];
    const sent = await ok("sendSoa", call("POST", "/soa/send", { enterpriseIds: ids, ...period, templateId: 1 }), 202);
    const first = await waitReport(sent.reports[0].id);
    assert.equal(first.status, "success");
    assert.ok(first.emailedAt && first.emailTo.length > 0, "the sent copy keeps date and recipients");
    if (rows[0]) {
      const noContact = await waitReport(sent.reports[1].id);
      assert.equal(noContact.status, "failed");
      assert.match(noContact.error, /no billing contact/);
    }
    const again = await ok("sendSoaReport", call("POST", `/soa-reports/${first.id}/send`, { templateId: 2 }));
    assert.equal(again.template, "SOA Statement – payment reminder");
    const list = await ok("querySoaReports", call("POST", "/soa-reports/query", { limit: 5 }));
    assert.ok(list.rows.length > 0);
    const badTemplate = await call("POST", "/soa/send", { enterpriseIds: [id], ...period, templateId: 4 });
    assert.equal(badTemplate.statusCode, 400);
  });
});
