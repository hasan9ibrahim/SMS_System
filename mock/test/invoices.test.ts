// Finance part 2 (build step 5.6, §7, §12.3, §13.31): invoices with invoice requests, vendor
// invoices with reconciliation, rules and the monthly summary. Rule evaluation and the time-zone
// helpers are unit-tested; the API runs against the seeded database and the EDR store, every
// response checked against the contract. Each test undoes its changes or removes its rows.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change, ReconRuleValues } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { evaluateRecon, flaggedDestinations, withinTolerance } from "../src/billing/recon.js";
import { coverageOf, edrCoverage, zonedMidnight } from "../src/billing/edrFigures.js";
import { simplePdf, spreadsheetXml } from "../src/billing/files.js";
import { dayWindow } from "../src/billing/zone.js";

process.env.INVOICE_JOB_STEP_MS = "0";
const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const run = Date.now().toString(36).slice(-5);
const tag = `test ${run}`;
after(async () => {
  if (ready) {
    // Invoices and vendor invoices are archived, never removed, by the API; drop the test rows.
    await db().query(
      "DELETE FROM invoice_requests WHERE remarks = $1 OR invoice_id IN (SELECT id FROM invoices WHERE remarks = $1)",
      [tag],
    );
    await db().query("DELETE FROM invoices WHERE remarks = $1", [tag]);
    await db().query("DELETE FROM vendor_invoices WHERE remarks = $1", [tag]);
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

// ---------------------------------------------------------------- units

const RULE: ReconRuleValues = {
  amountPct: 1,
  amountFixed: 50,
  amountCombine: "stricter",
  countPct: 1,
  countFixed: 1000,
  countCombine: "looser",
  destinationPct: null,
  autoSend: "auto",
  disputedInSoa: "separate_block",
};

describe("reconciliation rule (§13.31)", () => {
  test("percentage and fixed tolerance, stricter and looser", () => {
    assert.equal(withinTolerance(40, 10_000, 1, 50, "stricter"), true);
    assert.equal(withinTolerance(60, 10_000, 1, 50, "stricter"), false, "fixed amount fails");
    assert.equal(withinTolerance(60, 10_000, 1, 50, "looser"), true, "percentage is enough");
    assert.equal(withinTolerance(-5, 100, 1, null, "stricter"), false, "5 % off");
    assert.equal(withinTolerance(5, 100, null, null, "stricter"), true, "no check");
    assert.equal(withinTolerance(0, 0, 1, null, "stricter"), true, "nothing on either side");
  });

  test("amount, count and destinations", () => {
    const base = { theirAmount: 1005, ourAmount: 1000, theirVolume: 50_100, ourVolume: 50_000, currency: "USD" };
    const res = evaluateRecon(RULE, base);
    assert.equal(res.match, true);
    assert.match(res.reasons[0]!, /Amount within tolerance \(1 % and 50.00 USD\)/);
    assert.equal(evaluateRecon(RULE, { ...base, theirAmount: 1020 }).match, false, "2 % off");
    assert.equal(evaluateRecon(RULE, { ...base, theirVolume: 52_000 }).match, false, "count off by 2,000 and 4 %");
    const noCount = evaluateRecon(RULE, { ...base, theirVolume: null });
    assert.equal(noCount.match, true);
    assert.match(noCount.reasons[1]!, /not on the invoice/);
    const perDest = { ...RULE, destinationPct: 10 };
    const lines = [
      { mccmnc: "23410", theirAmount: 600, ourAmount: 500 },
      { mccmnc: "23415", theirAmount: 495, ourAmount: 500 },
    ];
    assert.deepEqual([...flaggedDestinations(perDest, lines)], ["23410"]);
    const flagged = evaluateRecon(perDest, base, lines);
    assert.equal(flagged.match, false, "total within tolerance, one destination off by 20 %");
    assert.match(flagged.reasons.at(-1)!, /1 destination off by more than 10 %: 23410/);
  });
});

describe("billing days in the partner's time zone (§13.31)", () => {
  test("midnight in a zone and coverage of a period", () => {
    assert.equal(zonedMidnight("2026-10-01", "Asia/Kolkata").toISOString(), "2026-09-30T18:30:00.000Z");
    assert.equal(zonedMidnight("2026-10-01", "America/New_York").toISOString(), "2026-10-01T04:00:00.000Z");
    const w = dayWindow("2026-09-21", "2026-09-27", "Asia/Dubai");
    assert.deepEqual(
      [w.from.toISOString(), w.to.toISOString()],
      ["2026-09-20T20:00:00.000Z", "2026-09-27T20:00:00.000Z"],
    );
    const cov = { from: new Date("2026-09-16T21:30:00Z"), to: new Date("2026-10-16T21:29:59Z") };
    assert.equal(coverageOf(cov, "2026-09-21", "2026-09-27", "UTC"), "full");
    assert.equal(coverageOf(cov, "2026-09-01", "2026-09-30", "UTC"), "partial");
    assert.equal(coverageOf(cov, "2026-08-01", "2026-08-31", "UTC"), "none");
    assert.equal(coverageOf({ from: null, to: null }, "2026-09-21", "2026-09-27", "UTC"), "none");
  });

  test("invoice PDF is a valid one-page document", () => {
    const pdf = simplePdf([{ text: "INVOICE (test)", bold: true }, { text: "Due Amount: 12.00 USD" }]).toString(
      "latin1",
    );
    assert.ok(pdf.startsWith("%PDF-1.4"));
    const xref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    assert.ok(pdf.slice(xref).startsWith("xref"), "startxref points at the table");
    assert.ok(pdf.includes("(INVOICE \\(test\\)) Tj"), "parentheses escaped");
  });
});

// ---------------------------------------------------------------- invoices

async function waitRequest(id: number) {
  for (let i = 0; i < 200; i++) {
    const r = await ok("getInvoiceRequest", call("GET", `/invoice-requests/${id}`));
    if (r.status === "completed" || r.status === "failed") return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`request ${id} did not finish`);
}

const request = (over: object) => ({
  kind: "traffic",
  enterpriseIds: [],
  timezone: null,
  usageStart: "2026-10-01",
  usageEnd: "2026-10-12",
  dueDateType: "auto",
  dueDate: null,
  invoiceNumber: null,
  amount: null,
  volume: null,
  currency: null,
  invoiceDate: "2026-10-17",
  remarks: tag,
  ...over,
});

/** A customer with billing settings and no invoice yet for October (the seed invoices up to September). */
async function customer() {
  const { rows } = await db().query(
    `SELECT e.id FROM enterprises e JOIN enterprise_billing cb ON cb.enterprise_id = e.id AND cb.side = 'customer'
      WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.enterprise_id = e.id
            AND i.deleted_at IS NULL AND i.usage_end >= '2026-10-01')
        AND EXISTS (SELECT 1 FROM enterprise_contacts c WHERE c.enterprise_id = e.id AND c.contact_type IN ('finance','commercial'))
      ORDER BY e.id LIMIT 1`,
  );
  return Number(rows[0].id);
}

describe("invoices and invoice requests (§7, §12.3)", { skip }, () => {
  test("lists answer with the new columns", async () => {
    for (const [list, op] of [
      ["invoices", "queryInvoices"],
      ["invoice-requests", "queryInvoiceRequests"],
    ] as const) {
      const page = await ok(op, call("POST", `/${list}/query`, { limit: 5 }));
      assert.ok(page.rows.length > 0, list);
    }
    const sent = await ok(
      "queryInvoices",
      call("POST", "/invoices/query", {
        limit: 3,
        filter: { logic: "and", conditions: [{ field: "emailStatus", op: "in", values: ["sent"] }] },
      }),
    );
    assert.ok(sent.rows.every((r: { emailStatus: string; emailSentAt: string | null }) => r.emailSentAt));
    const negative = await ok(
      "queryInvoices",
      call("POST", "/invoices/query", {
        limit: 50,
        filter: { logic: "and", conditions: [{ field: "dueAmount", op: "gt", value: 0 }] },
      }),
    );
    for (const r of negative.rows) {
      assert.ok(r.closingBalance < 0, "something is due only when the closing balance is owed (§7 sign)");
      assert.equal(r.dueAmount, Math.round(-r.closingBalance * 100) / 100);
    }
  });

  test("generate, overlap, edit, mark, send, charges, PDF, regenerate, delete", async () => {
    const enterpriseId = await customer();
    const created = await ok(
      "createInvoiceRequest",
      call("POST", "/invoice-requests", request({ enterpriseIds: [enterpriseId] })),
      202,
    );
    assert.equal(created.requests[0].status, "pending");
    const done = await waitRequest(created.requests[0].id);
    assert.equal(done.status, "completed", done.error);
    assert.match(done.requestNo, /^IR-\d{6}$/);
    const inv = await ok("getInvoice", call("GET", `/invoices/${done.invoiceId}`));
    assert.equal(inv.status, "completed");
    assert.equal(inv.invoiceType, "manual");
    assert.equal(inv.closingBalance, Math.round((inv.openingBalance - inv.usageCharges) * 100) / 100);
    assert.equal(inv.dueAmount, Math.max(0, Math.round(-inv.closingBalance * 100) / 100));

    const charges = await ok("getInvoiceCharges", call("GET", `/invoices/${inv.id}/charges`));
    assert.equal(charges.source, inv.messageCount > 0 ? "edr" : "none");
    assert.equal(charges.totalMessages, inv.messageCount, "lines add up to the invoice");
    assert.ok(Math.abs(charges.totalAmount - inv.usageCharges) < 0.02);

    const again = await ok(
      "createInvoiceRequest",
      call("POST", "/invoice-requests", request({ enterpriseIds: [enterpriseId], usageStart: "2026-10-05" })),
      202,
    );
    const overlap = await waitRequest(again.requests[0].id);
    assert.equal(overlap.status, "failed");
    assert.match(overlap.error, new RegExp(`Already invoiced in ${inv.invoiceNumber}`));

    const edited = await ok(
      "updateInvoice",
      call("PUT", `/invoices/${inv.id}`, { dueDate: "2026-12-31", remarks: tag }),
    );
    assert.equal(edited.record.dueDate, "2026-12-31");
    await undo(edited.change);
    assert.notEqual((await ok("getInvoice", call("GET", `/invoices/${inv.id}`))).dueDate, "2026-12-31");

    const marked = await ok(
      "markInvoices",
      call("POST", "/invoices/mark", { ids: [inv.id], paymentStatus: "partial" }),
    );
    assert.equal(marked.change.diff[0].after, "partial");
    await undo(marked.change);

    const sent = await ok("sendInvoices", call("POST", "/invoices/send", { ids: [inv.id, 999_999_999] }));
    assert.equal(sent.sent, 1);
    assert.equal(sent.skipped[0].reason, "not found");
    const mailed = await ok("getInvoice", call("GET", `/invoices/${inv.id}`));
    assert.equal(mailed.emailStatus, "sent");
    assert.ok(mailed.emailRecipients.length > 0);

    const pdf = await call("GET", `/invoices/${inv.id}/pdf`);
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.ok(pdf.rawPayload.subarray(0, 8).toString() === "%PDF-1.4");
    // The partner's business company issues it (§11): its mailbox, Invoice template and bank account.
    const { rows: bc } = await db().query(
      `SELECT bc.name, bc.bank_iban, mb.smtp_email FROM enterprises e JOIN business_companies bc ON bc.id = e.business_company_id
         LEFT JOIN business_company_mailboxes mb ON mb.business_company_id = bc.id AND mb.department = 'billing' WHERE e.id = $1`,
      [enterpriseId],
    );
    const { rows: mail } = await db().query(
      "SELECT sender, subject, body FROM email_logs WHERE email_type = 'invoice' AND subject LIKE $1 ORDER BY id DESC LIMIT 1",
      [`%${inv.invoiceNumber}%`],
    );
    assert.equal(mail[0]?.sender, bc[0].smtp_email);
    assert.ok(String(mail[0].body).includes(`IBAN: ${bc[0].bank_iban}`), "the e-mail carries the company's bank");
    assert.ok(String(mail[0].subject).includes(bc[0].name));
    assert.ok(pdf.rawPayload.toString("latin1").includes(`(IBAN: ${bc[0].bank_iban}) Tj`), "the PDF carries it too");

    const regen = await ok("regenerateInvoice", call("POST", `/invoices/${inv.id}/regenerate`), 202);
    assert.equal(regen.regenerate, true);
    const regenDone = await waitRequest(regen.id);
    assert.equal(regenDone.status, "completed", regenDone.error);
    const after = await ok("getInvoice", call("GET", `/invoices/${inv.id}`));
    assert.equal(after.invoiceNumber, inv.invoiceNumber, "same number");
    assert.equal(after.emailStatus, "unsent", "a regenerated invoice is sent again");

    const deps = await ok("getInvoiceDependencies", call("GET", `/invoices/${inv.id}/dependencies`));
    assert.equal(deps.blocked, false);
    const gone = await ok("archiveInvoice", call("POST", `/invoices/${inv.id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    const back = await ok("restoreInvoice", call("POST", `/invoices/${inv.id}/restore`));
    assert.equal(back.record.archivedAt, null);
  });

  test("proforma and validation; payments block delete and regenerate", async () => {
    const enterpriseId = await customer();
    const bad = await call("POST", "/invoice-requests", request({ enterpriseIds: [enterpriseId], kind: "proforma" }));
    assert.equal(bad.statusCode, 400);
    assert.ok(bad.json().errors.some((e: { path: string }) => e.path === "/amount"));
    const manual = await call(
      "POST",
      "/invoice-requests",
      request({ enterpriseIds: [enterpriseId], dueDateType: "manual" }),
    );
    assert.ok(manual.json().errors.some((e: { path: string }) => e.path === "/dueDate"));

    const pro = await ok(
      "createInvoiceRequest",
      call(
        "POST",
        "/invoice-requests",
        request({
          enterpriseIds: [enterpriseId],
          kind: "proforma",
          amount: 500,
          volume: 20000,
          usageStart: "2026-11-01",
          usageEnd: "2026-11-30",
        }),
      ),
      202,
    );
    const done = await waitRequest(pro.requests[0].id);
    assert.equal(done.status, "completed", done.error);
    const inv = await ok("getInvoice", call("GET", `/invoices/${done.invoiceId}`));
    assert.equal(inv.kind, "proforma");
    assert.equal(inv.dueAmount, 500);
    const charges = await ok("getInvoiceCharges", call("GET", `/invoices/${inv.id}/charges`));
    assert.equal(charges.source, "proforma");

    const { rows } = await db().query(
      `SELECT t.invoice_id FROM transactions t JOIN invoices i ON i.id = t.invoice_id
        WHERE t.deleted_at IS NULL AND i.deleted_at IS NULL LIMIT 1`,
    );
    const paid = Number(rows[0].invoice_id);
    const blocked = await call("POST", `/invoices/${paid}/archive`, {});
    assert.equal(blocked.statusCode, 409);
    check("archiveInvoice", blocked);
    const noRegen = await call("POST", `/invoices/${paid}/regenerate`);
    assert.equal(noRegen.statusCode, 409);
  });
});

// ---------------------------------------------------------------- vendor invoices

/** A vendor with billing settings and traffic in a week the EDR store fully holds. */
async function vendorWeek() {
  const cov = await edrCoverage();
  assert.ok(cov?.from, "EDR store with traffic");
  const { rows } = await db().query(
    `SELECT e.id, e.name FROM enterprises e JOIN enterprise_billing vb ON vb.enterprise_id = e.id AND vb.side = 'vendor'
      WHERE e.deleted_at IS NULL AND e.id % 10 >= 3 ORDER BY e.id`,
  );
  return { id: Number(rows[0].id), name: rows[0].name as string, from: "2026-09-21", to: "2026-09-27" };
}

const vInput = (v: { id: number; from: string; to: string }, over: object = {}) => ({
  enterpriseId: v.id,
  invoiceNumber: `T-${run}`,
  chargeVolume: null,
  chargeAmount: 1,
  currency: null,
  invoiceDate: "2026-09-29",
  dueDate: null,
  periodFrom: v.from,
  periodTo: v.to,
  timezone: "UTC",
  remarks: tag,
  ...over,
});

describe("vendor invoices and reconciliation (§13.31)", { skip }, () => {
  test("add is checked at once; result screen; decisions need notes; history; safe delete", async () => {
    const v = await vendorWeek();
    const created = await ok("createVendorInvoice", call("POST", "/vendor-invoices", vInput(v)), 201);
    const r = created.record;
    assert.ok(["match", "mismatch"].includes(r.comparison), r.reasons.join(" / "));
    assert.notEqual(r.ourAmount, null);
    assert.ok(r.rule, "the rule used is kept");
    // Input From/To (§7): the UTC window our figures were counted for, midnight to midnight in the invoice zone.
    assert.equal(r.inputFrom, "2026-09-21T00:00:00.000Z");
    assert.equal(r.inputTo, "2026-09-28T00:00:00.000Z");
    assert.deepEqual(
      r.events
        .map((e: { kind: string }) => e.kind)
        .reverse()
        .slice(0, 2),
      ["created", "checked"],
    );
    // Our figures are ours: an invoice for exactly our amount and count matches.
    const exact = await ok(
      "updateVendorInvoice",
      call("PUT", `/vendor-invoices/${r.id}`, vInput(v, { chargeAmount: r.ourAmount, chargeVolume: r.ourVolume })),
    );
    assert.equal(exact.record.comparison, "match");
    assert.equal(exact.record.status, "accepted", "a match is accepted");
    assert.ok(["sent", "waiting", "failed"].includes(exact.record.emailStatus));
    assert.equal(exact.record.inSoa, "included");

    const dup = await call("POST", "/vendor-invoices", vInput(v));
    assert.equal(dup.statusCode, 409);

    const cmp = await ok("getVendorInvoiceComparison", call("GET", `/vendor-invoices/${r.id}/comparison`));
    assert.equal(cmp.coverage, "full");
    const sum = cmp.rows.reduce((t: number, x: { ourAmount: number }) => t + x.ourAmount, 0);
    assert.ok(Math.abs(sum - r.ourAmount) < 0.05 * Math.max(1, cmp.rows.length), "destinations add up to our amount");

    const noNote = await call("POST", `/vendor-invoices/${r.id}/decide`, {
      action: "reject",
      note: null,
      sendEmail: false,
    });
    assert.equal(noNote.statusCode, 400);
    const preview = await ok(
      "previewVendorInvoiceEmail",
      call("POST", `/vendor-invoices/${r.id}/email-preview`, { kind: "rejection", note: "Count differs" }),
    );
    assert.match(preview.body, /Our figures/);
    const rejected = await ok(
      "decideVendorInvoice",
      call("POST", `/vendor-invoices/${r.id}/decide`, { action: "reject", note: "Count differs", sendEmail: true }),
    );
    assert.equal(rejected.record.status, "rejected");
    assert.equal(rejected.record.events[0].kind, "email");
    assert.notEqual(rejected.record.inSoa, "included");
    await undo(rejected.change);
    assert.equal((await ok("getVendorInvoice", call("GET", `/vendor-invoices/${r.id}`))).status, "accepted");

    const noted = await ok(
      "addVendorInvoiceNote",
      call("POST", `/vendor-invoices/${r.id}/notes`, { note: "Called the vendor" }),
    );
    assert.equal(noted.events[0].note, "Called the vendor");

    const deps = await ok("getVendorInvoiceDependencies", call("GET", `/vendor-invoices/${r.id}/dependencies`));
    assert.equal(deps.blocked, true, "accepted invoices count in the balance");
    const blocked = await call("POST", `/vendor-invoices/${r.id}/archive`, {});
    assert.equal(blocked.statusCode, 409);
    const kept = await ok(
      "decideVendorInvoice",
      call("POST", `/vendor-invoices/${r.id}/decide`, {
        action: "keep_pending",
        note: "Waiting for credit note",
        sendEmail: false,
      }),
    );
    assert.equal(kept.record.status, "disputed");
    const gone = await ok("archiveVendorInvoice", call("POST", `/vendor-invoices/${r.id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    await undo(gone.change);
    const later = await ok(
      "decideVendorInvoice",
      call("POST", `/vendor-invoices/${r.id}/decide`, {
        action: "accept",
        note: "Agreed after discussion",
        sendEmail: false,
      }),
    );
    assert.equal(later.record.status, "accepted");
    const rechecked = await ok("recheckVendorInvoice", call("POST", `/vendor-invoices/${r.id}/recheck`));
    assert.equal(rechecked.record.status, "accepted", "decided invoices keep their status");
  });

  test("an old period is not compared (no EDR data); import dry run; summary", async () => {
    const v = await vendorWeek();
    const old = await ok(
      "createVendorInvoice",
      call(
        "POST",
        "/vendor-invoices",
        vInput({ ...v, from: "2026-06-01", to: "2026-06-30" }, { invoiceNumber: `TO-${run}` }),
      ),
      201,
    );
    assert.equal(old.record.comparison, "no_data");
    assert.equal(old.record.status, "pending");
    assert.equal(old.record.inputFrom, null, "not counted");
    assert.match(old.record.reasons[0], /not fully covered/);

    const csv = [
      "enterprise,invoice_number,charge_volume,charge_amount,currency,invoice_date,due_date,period_from,period_to,timezone,remarks",
      `"${v.name}",TI-${run},1000,12.5,,2026-09-29,,2026-09-21,2026-09-27,UTC,${tag}`,
      `Nobody Ltd,TI2-${run},1,1,,2026-09-29,,2026-09-21,2026-09-27,UTC,${tag}`,
      `"${v.name}",TI3-${run},x,1,,2026-09-29,,2026-09-21,2026-09-27,UTC,${tag}`,
    ].join("\n");
    const dry = await ok("importVendorInvoices", call("POST", "/vendor-invoices/import", { csv, dryRun: true }));
    assert.equal(dry.applied, false);
    assert.equal(dry.added, 1);
    assert.equal(dry.errors.length, 2);
    const good = csv.split("\n").slice(0, 2).join("\n");
    const applied = await ok(
      "importVendorInvoices",
      call("POST", "/vendor-invoices/import", { csv: good, dryRun: false }),
    );
    assert.equal(applied.applied, true);
    const again = await ok(
      "importVendorInvoices",
      call("POST", "/vendor-invoices/import", { csv: good, dryRun: true }),
    );
    assert.equal(again.unchanged, 1, "already on file");

    const summary = await ok(
      "summariseVendorInvoices",
      call("POST", "/vendor-invoices/summary", {
        fromMonth: "2026-01",
        toMonth: "2026-10",
        enterpriseId: null,
        accountManagerId: null,
      }),
    );
    assert.equal(summary.rows[0].month, "2026-10");
    for (const m of summary.rows) assert.equal(m.accepted + m.pending + m.disputed + m.rejected, m.invoices);
    const page = await ok(
      "queryVendorInvoices",
      call("POST", "/vendor-invoices/query", {
        limit: 5,
        filter: { logic: "and", conditions: [{ field: "status", op: "in", values: ["disputed"] }] },
      }),
    );
    assert.ok(page.rows.every((x: { status: string }) => x.status === "disputed"));
  });

  test("reconciliation rules: default plus per partner, undoable", async () => {
    const list = await ok("queryReconRules", call("POST", "/recon-rules/query", { limit: 5 }));
    const def = list.rows[0];
    assert.equal(def.enterpriseId, null, "the default rule comes first");
    const noDefault = await call("POST", `/recon-rules/${def.id}/archive`, {});
    assert.equal(noDefault.statusCode, 400);
    const { rows } = await db().query(
      `SELECT e.id FROM enterprises e JOIN enterprise_billing vb ON vb.enterprise_id = e.id AND vb.side = 'vendor'
        WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM recon_rules r WHERE r.enterprise_id = e.id) LIMIT 1`,
    );
    const input = {
      ...RULE,
      enterpriseId: Number(rows[0].id),
      amountPct: 2,
      amountFixed: null,
      destinationPct: 15,
      autoSend: "confirm",
    };
    const created = await ok("createReconRule", call("POST", "/recon-rules", input), 201);
    assert.equal(created.record.destinationPct, 15);
    const twice = await call("POST", "/recon-rules", input);
    assert.equal(twice.statusCode, 409);
    const bad = await call("PUT", `/recon-rules/${created.record.id}`, { ...input, amountPct: null });
    assert.equal(bad.statusCode, 400, "amount needs a percentage or a fixed amount");
    const edited = await ok(
      "updateReconRule",
      call("PUT", `/recon-rules/${created.record.id}`, { ...input, amountPct: 3 }),
    );
    assert.equal(edited.record.amountPct, 3);
    await undo(edited.change);
    await undo(created.change);
    const gone = await db().query("SELECT deleted_at FROM recon_rules WHERE id = $1", [created.record.id]);
    assert.ok(gone.rows[0].deleted_at, "undoing the add removes the rule");
  });
});
