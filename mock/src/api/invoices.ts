// Invoices (§7, §12.3): Generate Request and Regenerate run as background invoice requests
// (pending → inprogress → completed / failed), Send Invoice, Mark, Charge Details from the EDR
// store, PDF, safe delete (§13.29). Balances use the §7 sign: positive = the client's credit,
// negative = owed; the due amount is the owed part of the closing balance.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  InvoiceCharges,
  InvoiceDetail,
  InvoiceIdsInput,
  InvoiceMarkInput,
  InvoiceRequestInput,
  InvoiceRequestRow,
  InvoiceUpdate,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { INVOICE_REQUEST_FROM, INVOICE_REQUEST_SELECT, invoiceList, mapInvoiceRequest } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { simplePdf } from "../billing/files.js";
import { coverageOf, destinationNames, edrCoverage, fmtDay, sumLines, usageLines } from "../billing/edrFigures.js";
import { archiveGate } from "./enterprises.js";
import { billingContacts } from "./finance.js";
import { exportList, load, notFound, setArchived } from "./masterData.js";
import { dependencies, isTimezone, recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { companyDetails, companyMailbox, companyPlaceholders, companyTemplate, logEmail } from "./emailLog.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };

const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });
const money = (v: number) => Math.round(v * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => ymd(new Date(Date.parse(day) + n * 86400_000));
/** Pause between job steps, so the grid shows each status (INVOICE_JOB_STEP_MS, default 700 ms). */
const stepMs = () => Number(process.env.INVOICE_JOB_STEP_MS ?? 700);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- read

export async function loadInvoice(db: Db, id: number): Promise<InvoiceDetail | null> {
  const row = await load(db, invoiceList, id);
  if (!row) return null;
  const { rows } = await db.query(
    `SELECT inv.email_recipients, inv.inserted_at, inv.updated_at, cu.username AS created_by, uu.username AS updated_by
       FROM invoices inv LEFT JOIN users cu ON cu.id = inv.created_by_id LEFT JOIN users uu ON uu.id = inv.updated_by_id
      WHERE inv.id = $1`,
    [id],
  );
  const { rows: pays } = await db.query(
    `SELECT id, payment_date, transaction_type, payment_type, amount, currency FROM transactions
      WHERE invoice_id = $1 AND deleted_at IS NULL ORDER BY payment_date, id`,
    [id],
  );
  const payments = pays.map((p) => ({
    id: Number(p.id),
    paymentDate: ymd(p.payment_date),
    transactionType: p.transaction_type,
    paymentType: p.payment_type,
    amount: Number(p.amount),
    currency: String(p.currency).trim(),
  }));
  const r = rows[0]!;
  return {
    ...row,
    emailRecipients: (r.email_recipients as string[]) ?? [],
    paidAmount: money(payments.reduce((t, p) => t + (p.paymentType === "credit" ? p.amount : -p.amount), 0)),
    payments,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: (r.inserted_at as Date).toISOString(),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}

export function getInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadInvoice(pool, id)) ?? notFound(reply, "Invoice", id));
}

export function updateInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as InvoiceUpdate;
  return withDb(reply, async (pool) => {
    const before = await loadInvoice(pool, id);
    if (!before) return notFound(reply, "Invoice", id);
    if (before.archivedAt) return sendProblem(reply, 400, "Restore the invoice before changing it");
    if (b.dueDate < before.invoiceDate)
      return badInput(reply, [{ path: "/dueDate", message: "must not be before the invoice date" }]);
    const after = { dueDate: b.dueDate, remarks: b.remarks?.trim() || null };
    const diff: DiffEntry[] = (["dueDate", "remarks"] as const)
      .filter((k) => (before[k] ?? null) !== after[k])
      .map((k) => ({ entity_id: id, field: k, before: before[k] ?? null, after: after[k] }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE invoices SET due_date = $2, remarks = $3, updated_by_id = $4, updated_at = now() WHERE id = $1",
        [id, after.dueDate, after.remarks, me.id],
      );
      return recordChange(c, {
        entityType: "invoice",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed invoice ${before.invoiceNumber}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadInvoice(pool, id), change };
  });
}

export const exportInvoices = (request: FastifyRequest, reply: FastifyReply) =>
  exportList(
    request,
    reply,
    "invoices",
    invoiceList,
    [
      ["invoice_no", (r) => r.invoiceNumber],
      ["enterprise", (r) => r.enterprise],
      ["enterprise_type", (r) => r.enterpriseType],
      ["invoice_type", (r) => r.invoiceType],
      ["kind", (r) => r.kind],
      ["billing_type", (r) => r.billingType],
      ["invoice_date", (r) => r.invoiceDate],
      ["usage_start", (r) => r.usageStart],
      ["usage_end", (r) => r.usageEnd],
      ["due_date", (r) => r.dueDate],
      ["currency", (r) => r.currency],
      ["opening_balance", (r) => r.openingBalance],
      ["usage_charges", (r) => r.usageCharges],
      ["closing_balance", (r) => r.closingBalance],
      ["due_amount", (r) => r.dueAmount],
      ["messages", (r) => r.messageCount],
      ["time_zone", (r) => r.timezone],
      ["status", (r) => r.status],
      ["payment_status", (r) => r.paymentStatus],
      ["email_status", (r) => r.emailStatus],
      ["remarks", (r) => r.remarks],
    ],
    "invoices.csv",
  );

// ---------------------------------------------------------------- charge details and PDF

async function chargeLines(db: Db, inv: InvoiceDetail): Promise<InvoiceCharges> {
  const base = {
    invoiceId: inv.id,
    currency: inv.currency,
    timezone: inv.timezone,
    from: inv.usageStart,
    to: inv.usageEnd,
  };
  if (inv.kind === "proforma")
    return {
      ...base,
      source: "proforma",
      note: "Proforma invoice: amount requested in advance, no traffic lines.",
      rows: [
        {
          mccmnc: "—",
          country: null,
          network: "Proforma",
          rate: null,
          messages: inv.messageCount,
          amount: inv.usageCharges ?? 0,
        },
      ],
      totalMessages: inv.messageCount,
      totalAmount: inv.usageCharges ?? 0,
    };
  const cov = await edrCoverage();
  const lines = cov
    ? await usageLines(db, "customer", inv.enterpriseId, inv.usageStart, inv.usageEnd, inv.timezone, inv.currency, true)
    : null;
  if (!cov || !lines)
    return {
      ...base,
      source: "none",
      note: "The EDR store is not reachable.",
      rows: [],
      totalMessages: 0,
      totalAmount: 0,
    };
  const coverage = coverageOf(cov, inv.usageStart, inv.usageEnd, inv.timezone);
  const names = await destinationNames(db, [...new Set(lines.map((l) => l.mccmnc))]);
  const t = sumLines(lines);
  return {
    ...base,
    source: lines.length ? "edr" : "none",
    note:
      coverage === "full"
        ? null
        : `EDRs in this environment cover ${fmtDay(cov.from)} to ${fmtDay(cov.to)}; ${
            coverage === "none" ? "none fall" : "only part of the period falls"
          } in the usage period, so the lines do not add up to the invoice.`,
    rows: lines.slice(0, 5000).map((l) => ({
      mccmnc: l.mccmnc,
      country: names.get(l.mccmnc)?.country ?? null,
      network: names.get(l.mccmnc)?.network ?? null,
      rate: l.rate,
      messages: l.messages,
      amount: money(l.amount),
    })),
    totalMessages: t.messages,
    totalAmount: t.amount,
  };
}

export function getInvoiceCharges(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const inv = await loadInvoice(pool, id);
    if (!inv) return notFound(reply, "Invoice", id);
    return chargeLines(pool, inv);
  });
}

const amt = (v: number, ccy: string) =>
  `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;

export function downloadInvoicePdf(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const inv = await loadInvoice(pool, id);
    if (!inv) return notFound(reply, "Invoice", id);
    if (inv.status !== "completed")
      return sendProblem(
        reply,
        409,
        `Invoice ${inv.invoiceNumber} is ${inv.status}; the PDF exists once it is completed`,
      );
    const { rows } = await pool.query("SELECT name, address_line1, city, vat_number FROM enterprises WHERE id = $1", [
      inv.enterpriseId,
    ]);
    const p = rows[0]!;
    // The partner's business company issues the invoice: its name, address and bank account (§11).
    const bc = await companyDetails(pool, { enterpriseId: inv.enterpriseId });
    const charges = await chargeLines(pool, inv);
    const top = charges.rows.slice(0, 18);
    const pdf = simplePdf([
      { text: bc?.name ?? "", size: 16, bold: true, gap: 0 },
      { text: bc?.address ?? "" },
      { text: bc?.website ?? "" },
      { text: inv.kind === "proforma" ? "PROFORMA INVOICE" : "INVOICE", size: 14, bold: true, gap: 30 },
      { text: `Invoice No: ${inv.invoiceNumber}` },
      { text: `Invoice Date: ${inv.invoiceDate}    Payment Due Date: ${inv.dueDate}` },
      { text: `Usage period: ${inv.usageStart} to ${inv.usageEnd} (${inv.timezone})` },
      { text: "Bill to", bold: true, gap: 24 },
      { text: p.name },
      { text: [p.address_line1, p.city].filter(Boolean).join(", ") },
      { text: p.vat_number ? `VAT ${p.vat_number}` : "" },
      { text: "Summary", bold: true, gap: 24 },
      { text: `Messages: ${inv.messageCount.toLocaleString("en-US")}` },
      { text: `Opening Balance: ${amt(inv.openingBalance ?? 0, inv.currency)}` },
      { text: `Usage Charges: ${amt(inv.usageCharges ?? 0, inv.currency)}` },
      { text: `Closing Balance: ${amt(inv.closingBalance ?? 0, inv.currency)}` },
      { text: `Due Amount: ${amt(inv.dueAmount ?? 0, inv.currency)}`, bold: true },
      { text: "Balances: positive = your credit with us, negative = amount owed.", size: 8 },
      ...(top.length
        ? [
            { text: "Charge details (largest first)", bold: true, gap: 24 },
            ...top.map((r) => ({
              text: `${r.mccmnc}  ${r.country ?? ""} ${r.network ?? ""}  ${r.messages.toLocaleString("en-US")} msgs  ${amt(r.amount, inv.currency)}`,
              size: 9,
            })),
          ]
        : []),
      ...(charges.note ? [{ text: charges.note, size: 8, gap: 18 }] : []),
      ...(bc?.bank.length
        ? [
            { text: "Payment details", bold: true, gap: 24 },
            ...bc.bank.map((b) => ({ text: `${b.label}: ${b.value}`, size: 9 })),
            { text: `Please quote invoice ${inv.invoiceNumber} with your payment.`, size: 8, gap: 16 },
          ]
        : []),
    ]);
    return reply
      .type("application/pdf")
      .header("content-disposition", `attachment; filename="${inv.invoiceNumber}.pdf"`)
      .send(pdf);
  });
}

// ---------------------------------------------------------------- send and mark

/**
 * The invoice e-mail: the partner's business company's Invoice template (§11), filled with the invoice and
 * the company's placeholders, so each entity's invoices carry its own wording and bank details.
 */
const twoDp = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function invoiceMail(c: Db, id: number) {
  const inv = await loadInvoice(c, id);
  if (!inv) return null;
  const tpl = await companyTemplate(c, { enterpriseId: inv.enterpriseId }, "invoice");
  if (!tpl) return null;
  const { rows } = await c.query("SELECT name FROM enterprises WHERE id = $1", [inv.enterpriseId]);
  const vars: Record<string, string> = {
    ...companyPlaceholders(await companyDetails(c, { enterpriseId: inv.enterpriseId })),
    enterprise: (rows[0]?.name as string | undefined) ?? "",
    from: inv.usageStart,
    to: inv.usageEnd,
    invoice_no: inv.invoiceNumber,
    amount: twoDp(inv.usageCharges ?? 0),
    due_amount: twoDp(inv.dueAmount ?? 0),
    currency: inv.currency,
    due_date: inv.dueDate,
  };
  const fill = (t: string) => t.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  return { subject: fill(tpl.subject), body: fill(tpl.body) };
}

export function sendInvoices(request: FastifyRequest, reply: FastifyReply) {
  const { ids } = request.body as InvoiceIdsInput;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      "SELECT id, invoice_number, enterprise_id, status, email_status, deleted_at FROM invoices WHERE id = ANY($1)",
      [ids],
    );
    const skipped: { id: number; invoiceNumber: string; reason: string }[] = [];
    const send: { id: number; to: string[]; before: string; enterpriseId?: number; number?: string }[] = [];
    for (const id of ids) {
      const r = rows.find((x) => Number(x.id) === id);
      if (!r) {
        skipped.push({ id, invoiceNumber: `#${id}`, reason: "not found" });
        continue;
      }
      if (r.deleted_at) skipped.push({ id, invoiceNumber: r.invoice_number, reason: "deleted" });
      else if (r.status !== "completed")
        skipped.push({ id, invoiceNumber: r.invoice_number, reason: `status ${r.status}` });
      else {
        const to = await billingContacts(pool, Number(r.enterprise_id));
        if (!to.length) {
          skipped.push({ id, invoiceNumber: r.invoice_number, reason: "no billing contact" });
          await logEmail(pool, {
            type: "invoice",
            enterpriseId: Number(r.enterprise_id),
            to: [],
            subject: `Invoice ${r.invoice_number}`,
            file: `${r.invoice_number}.pdf`,
            error: "No billing contact",
          });
        } else
          send.push({
            id,
            to,
            before: r.email_status,
            enterpriseId: Number(r.enterprise_id),
            number: r.invoice_number,
          });
      }
    }
    if (!send.length) return { sent: 0, skipped, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      for (const s of send) {
        const mail = await invoiceMail(c, s.id);
        await logEmail(c, {
          type: "invoice",
          enterpriseId: s.enterpriseId,
          to: s.to,
          sender: await companyMailbox(c, s.enterpriseId!, "invoice"),
          subject: mail?.subject ?? `Invoice ${s.number}`,
          body: mail?.body ?? `Please find attached invoice ${s.number}.`,
          file: `${s.number}.pdf`,
          userId: me.id,
        });
      }
      for (const s of send)
        await c.query(
          `UPDATE invoices SET email_status = 'sent', email_sent_at = now(), email_recipients = $2,
                  updated_by_id = $3, updated_at = now() WHERE id = $1`,
          [s.id, s.to, me.id],
        );
      return recordChange(c, {
        entityType: "invoice",
        entityIds: send.map((s) => s.id),
        changeType: send.length > 1 ? "bulk" : "edit",
        diff: send.map((s) => ({ entity_id: s.id, field: "emailStatus", before: s.before, after: "sent" })),
        note: `Sent ${send.length} invoice${send.length === 1 ? "" : "s"} by e-mail`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { sent: send.length, skipped, change };
  });
}

export function markInvoices(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as InvoiceMarkInput;
  if (!b.paymentStatus && !b.emailStatus)
    return badInput(reply, [{ path: "/paymentStatus", message: "choose a payment or e-mail status" }]);
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      "SELECT id, payment_status, email_status FROM invoices WHERE id = ANY($1) AND deleted_at IS NULL",
      [b.ids],
    );
    const diff: DiffEntry[] = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (b.paymentStatus && r.payment_status !== b.paymentStatus)
        diff.push({ entity_id: id, field: "paymentStatus", before: r.payment_status, after: b.paymentStatus });
      if (b.emailStatus && r.email_status !== b.emailStatus)
        diff.push({ entity_id: id, field: "emailStatus", before: r.email_status, after: b.emailStatus });
    }
    if (!diff.length) return { change: null };
    const me = await getCurrentUser();
    const ids = [...new Set(diff.map((d) => d.entity_id))];
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE invoices SET payment_status = COALESCE($2, payment_status), email_status = COALESCE($3, email_status),
                updated_by_id = $4, updated_at = now() WHERE id = ANY($1)`,
        [ids, b.paymentStatus ?? null, b.emailStatus ?? null, me.id],
      );
      const what = [b.paymentStatus && `payment ${b.paymentStatus}`, b.emailStatus && `e-mail ${b.emailStatus}`]
        .filter(Boolean)
        .join(", ");
      return recordChange(c, {
        entityType: "invoice",
        entityIds: ids,
        changeType: ids.length > 1 ? "bulk" : "edit",
        diff,
        note: `Marked ${ids.length} invoice${ids.length === 1 ? "" : "s"}: ${what}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { change };
  });
}

// ---------------------------------------------------------------- safe delete

async function invoiceDependencies(db: Db, id: number) {
  const { rows } = await db.query(
    `SELECT (SELECT count(*)::int FROM transactions WHERE invoice_id = $1 AND deleted_at IS NULL) AS payments,
            (SELECT count(*)::int FROM invoice_requests WHERE invoice_id = $1 AND status IN ('pending','inprogress')) AS jobs,
            (SELECT (email_status = 'sent')::int FROM invoices WHERE id = $1) AS sent`,
    [id],
  );
  const r = rows[0]!;
  return dependencies([
    { key: "payments", label: "Payments linked to the invoice", count: r.payments, blocking: true, detail: null },
    { key: "requests", label: "Regenerate running", count: r.jobs, blocking: true, detail: null },
    {
      key: "sent",
      label: "Already e-mailed to the partner",
      count: r.sent,
      blocking: false,
      detail: "The partner keeps the copy they received",
    },
  ]);
}

export function getInvoiceDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadInvoice(pool, id))) return notFound(reply, "Invoice", id);
    return invoiceDependencies(pool, id);
  });
}

export function archiveInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadInvoice(pool, id);
    if (!before) return notFound(reply, "Invoice", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(reply, (request.body ?? {}) as ArchiveRequest, await invoiceDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "invoices",
      entityType: "invoice",
      archive: true,
      note: gate.note ?? `Deleted invoice ${before.invoiceNumber}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadInvoice(pool, id), change: r.change };
  });
}

/** A live traffic invoice of the enterprise whose usage period overlaps [from, to]. */
async function overlapping(db: Db, enterpriseId: number, from: string, to: string, exceptId: number) {
  const { rows } = await db.query(
    `SELECT invoice_number, usage_start, usage_end FROM invoices
      WHERE enterprise_id = $1 AND id <> $4 AND deleted_at IS NULL AND kind = 'traffic' AND status <> 'failed'
        AND usage_start <= $3 AND usage_end >= $2 ORDER BY usage_start LIMIT 1`,
    [enterpriseId, from, to, exceptId],
  );
  const r = rows[0];
  return r ? `${r.invoice_number} (${ymd(r.usage_start)} to ${ymd(r.usage_end)})` : null;
}

export function restoreInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadInvoice(pool, id);
    if (!before) return notFound(reply, "Invoice", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This invoice is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "invoices",
      entityType: "invoice",
      archive: false,
      note: null,
      restoreClash: async (db) => {
        if (before.kind !== "traffic" || before.status === "failed") return null;
        const other = await overlapping(db, before.enterpriseId, before.usageStart, before.usageEnd, id);
        return other ? `The period is invoiced again in ${other}` : null;
      },
    });
    if ("reply" in r) return r.reply;
    return { record: await loadInvoice(pool, id), change: r.change };
  });
}

// ---------------------------------------------------------------- invoice requests (§12.3)

async function loadRequest(db: Db, id: number): Promise<InvoiceRequestRow | null> {
  const { rows } = await db.query(`SELECT ${INVOICE_REQUEST_SELECT} FROM ${INVOICE_REQUEST_FROM} WHERE r.id = $1`, [
    id,
  ]);
  return rows[0] ? mapInvoiceRequest(rows[0]) : null;
}

export function getInvoiceRequest(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadRequest(pool, id)) ?? notFound(reply, "Invoice request", id));
}

export function createInvoiceRequest(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as InvoiceRequestInput;
  const errors: FieldError[] = [];
  const ids = [...new Set(b.enterpriseIds)];
  if (b.usageEnd < b.usageStart) errors.push({ path: "/usageEnd", message: "must not be before the start" });
  if ((Date.parse(b.usageEnd) - Date.parse(b.usageStart)) / 86400_000 > 366)
    errors.push({ path: "/usageEnd", message: "at most 366 days" });
  if (b.timezone && !isTimezone(b.timezone)) errors.push({ path: "/timezone", message: "unknown time zone" });
  if (b.dueDateType === "manual" && !b.dueDate)
    errors.push({ path: "/dueDate", message: "required for a manual due date" });
  const invoiceDate = b.invoiceDate ?? ymd(new Date());
  if (b.dueDateType === "manual" && b.dueDate && b.dueDate < invoiceDate)
    errors.push({ path: "/dueDate", message: "must not be before the invoice date" });
  if (b.invoiceNumber?.trim() && ids.length > 1)
    errors.push({ path: "/invoiceNumber", message: "only with one enterprise" });
  if (b.kind === "proforma" && (b.amount === null || b.amount <= 0))
    errors.push({ path: "/amount", message: "required for a proforma invoice" });
  if (b.kind === "traffic" && (b.amount !== null || b.volume !== null))
    errors.push({ path: "/amount", message: "traffic invoices take the usage from the EDRs" });
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    const { rows: ents } = await pool.query(
      `SELECT e.id, e.name, e.billing_timezone, cb.id AS billing_id FROM enterprises e
         LEFT JOIN enterprise_billing cb ON cb.enterprise_id = e.id AND cb.side = 'customer'
        WHERE e.id = ANY($1) AND e.deleted_at IS NULL`,
      [ids],
    );
    for (const id of ids) {
      const e = ents.find((x) => Number(x.id) === id);
      if (!e) errors.push({ path: "/enterpriseIds", message: `enterprise ${id} not found` });
      else if (!e.billing_id)
        errors.push({ path: "/enterpriseIds", message: `${e.name} has no customer billing settings` });
    }
    if (b.currency) {
      const { rows } = await pool.query("SELECT 1 FROM currencies WHERE iso = $1 AND deleted_at IS NULL", [b.currency]);
      if (!rows[0]) errors.push({ path: "/currency", message: "unknown currency" });
    }
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const created: number[] = [];
    for (const id of ids) {
      const e = ents.find((x) => Number(x.id) === id)!;
      const { rows } = await pool.query(
        `INSERT INTO invoice_requests (kind, invoice_type, enterprise_id, timezone, usage_start, usage_end, due_date_type,
                                       due_date, invoice_number, amount, volume, currency, invoice_date, remarks, status,
                                       created_by_id)
         VALUES ($1, 'manual', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', $14) RETURNING id`,
        [
          b.kind,
          id,
          b.timezone ?? e.billing_timezone,
          b.usageStart,
          b.usageEnd,
          b.dueDateType,
          b.dueDateType === "manual" ? b.dueDate : null,
          b.invoiceNumber?.trim() || null,
          b.amount,
          b.volume,
          b.currency,
          invoiceDate,
          b.remarks?.trim() || null,
          me.id,
        ],
      );
      created.push(Number(rows[0].id));
    }
    for (const id of created) void runInvoiceRequest(id);
    const requests = await Promise.all(created.map((id) => loadRequest(pool, id)));
    return reply.code(202).send({ requests });
  });
}

export function regenerateInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const inv = await loadInvoice(pool, id);
    if (!inv) return notFound(reply, "Invoice", id);
    if (inv.archivedAt) return sendProblem(reply, 409, "Restore the invoice before regenerating it");
    if (inv.payments.length)
      return sendProblem(
        reply,
        409,
        `${inv.payments.length} payment(s) are linked to ${inv.invoiceNumber}; it cannot be regenerated`,
      );
    const { rows: busy } = await pool.query(
      "SELECT 1 FROM invoice_requests WHERE invoice_id = $1 AND status IN ('pending','inprogress')",
      [id],
    );
    if (busy[0]) return sendProblem(reply, 409, `${inv.invoiceNumber} is already being regenerated`);
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `INSERT INTO invoice_requests (kind, invoice_type, regenerate, enterprise_id, timezone, usage_start, usage_end,
                                     due_date_type, due_date, invoice_number, amount, volume, currency, invoice_date,
                                     remarks, status, invoice_id, created_by_id)
       VALUES ($1, 'manual', true, $2, $3, $4, $5, 'manual', $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14) RETURNING id`,
      [
        inv.kind,
        inv.enterpriseId,
        inv.timezone,
        inv.usageStart,
        inv.usageEnd,
        inv.dueDate,
        inv.invoiceNumber,
        inv.kind === "proforma" ? inv.usageCharges : null,
        inv.kind === "proforma" ? inv.messageCount : null,
        inv.currency,
        inv.invoiceDate,
        inv.remarks,
        id,
        me.id,
      ],
    );
    const reqId = Number(rows[0].id);
    void runInvoiceRequest(reqId);
    return reply.code(202).send(await loadRequest(pool, reqId));
  });
}

/** Next number of the business company's sequence: INV-{company}-{n}, from Invoice Number start. */
async function nextInvoiceNumber(c: Db, businessCompanyId: number, start: number): Promise<string> {
  const { rows } = await c.query(
    `SELECT max((regexp_match(invoice_number, '^INV-' || $1 || '-([0-9]+)$'))[1]::bigint) AS n FROM invoices`,
    [businessCompanyId],
  );
  const n = Math.max(Number(rows[0].n ?? 0) + 1, start);
  return `INV-${businessCompanyId}-${n}`;
}

/** Customer balance just before `invoiceDate` (§7 sign), leaving out invoice `exceptId`. */
async function balanceBefore(c: Db, enterpriseId: number, invoiceDate: string, exceptId: number): Promise<number> {
  const { rows } = await c.query(
    `SELECT cb.opening_balance
       + COALESCE((SELECT sum(CASE payment_type WHEN 'credit' THEN amount ELSE -amount END) FROM transactions
                    WHERE enterprise_id = $1 AND side = 'customer' AND deleted_at IS NULL AND payment_date < $2), 0)
       - COALESCE((SELECT sum(usage_charges) FROM invoices WHERE enterprise_id = $1 AND deleted_at IS NULL
                    AND status <> 'failed' AND kind = 'traffic' AND invoice_date < $2 AND id <> $3), 0) AS bal
       FROM enterprise_billing cb WHERE cb.enterprise_id = $1 AND cb.side = 'customer'`,
    [enterpriseId, invoiceDate, exceptId],
  );
  return Number(rows[0]?.bal ?? 0);
}

class JobError extends Error {}

/**
 * Runs one invoice request in the background (§12.3): checks, then inprogress (the invoice row
 * shows Inprogress), usage from the EDR store, balances, then completed or failed with the error.
 */
export async function runInvoiceRequest(requestId: number): Promise<void> {
  const pool = db();
  let invoiceId: number | null = null;
  let previousStatus: string | null = null;
  try {
    await sleep(stepMs());
    const { rows } = await pool.query(
      `SELECT r.*, e.business_company_id, bc.invoice_number_start, cb.currency AS billing_currency,
              cb.billing_type, cy.due_days
         FROM invoice_requests r JOIN enterprises e ON e.id = r.enterprise_id
         JOIN business_companies bc ON bc.id = e.business_company_id
         LEFT JOIN enterprise_billing cb ON cb.enterprise_id = r.enterprise_id AND cb.side = 'customer'
         LEFT JOIN billing_cycles cy ON cy.id = cb.billing_cycle_id
        WHERE r.id = $1`,
      [requestId],
    );
    const r = rows[0];
    if (!r || r.status !== "pending") return;
    await pool.query("UPDATE invoice_requests SET status = 'inprogress', started_at = now() WHERE id = $1", [
      requestId,
    ]);
    if (!r.billing_currency) throw new JobError("The enterprise has no customer billing settings");
    const enterpriseId = Number(r.enterprise_id);
    const from = ymd(r.usage_start);
    const to = ymd(r.usage_end);
    const invoiceDate = ymd(r.invoice_date);
    const regenerate = r.regenerate as boolean;
    if (regenerate) {
      invoiceId = Number(r.invoice_id);
      const { rows: cur } = await pool.query("SELECT status FROM invoices WHERE id = $1", [invoiceId]);
      previousStatus = cur[0]?.status === "inprogress" ? "completed" : (cur[0]?.status ?? null);
    } else if (r.kind === "traffic") {
      const other = await overlapping(pool, enterpriseId, from, to, 0);
      if (other) throw new JobError(`Already invoiced in ${other}; use Regenerate on that invoice`);
    }
    const currency =
      r.kind === "proforma" ? String(r.currency ?? r.billing_currency).trim() : String(r.billing_currency).trim();
    let usage: number;
    let messages: number;
    if (r.kind === "proforma") {
      usage = Number(r.amount);
      messages = Number(r.volume ?? 0);
    } else {
      const cov = await edrCoverage();
      if (!cov) throw new JobError("The EDR store is not reachable");
      const coverage = coverageOf(cov, from, to, r.timezone);
      if (coverage !== "full")
        throw new JobError(
          `EDRs in this environment cover ${fmtDay(cov.from)} to ${fmtDay(cov.to)}; the usage period ${from} to ${to} is not fully covered`,
        );
      const lines = await usageLines(pool, "customer", enterpriseId, from, to, r.timezone, currency, false);
      if (!lines) throw new JobError("The EDR store did not answer in time");
      const t = sumLines(lines);
      usage = t.amount;
      messages = t.messages;
    }
    const number = (r.invoice_number as string | null) ?? null;
    const due =
      r.due_date_type === "manual" && r.due_date ? ymd(r.due_date) : addDays(invoiceDate, Number(r.due_days ?? 0));
    await inTransaction(pool, async (c) => {
      if (!regenerate) {
        const invNo =
          number ?? (await nextInvoiceNumber(c, Number(r.business_company_id), Number(r.invoice_number_start)));
        const { rows: taken } = await c.query("SELECT 1 FROM invoices WHERE invoice_number = $1", [invNo]);
        if (taken[0]) throw new JobError(`Invoice number ${invNo} is already used`);
        const { rows: ins } = await c.query(
          `INSERT INTO invoices (invoice_number, enterprise_id, invoice_type, kind, billing_type, currency, timezone,
                                 invoice_date, usage_start, usage_end, due_date, opening_balance, usage_charges,
                                 closing_balance, due_amount, message_count, status, payment_status, email_status,
                                 remarks, created_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, 0, 0, 0, 'inprogress', 'unpaid', 'unsent', $12, $13)
           RETURNING id`,
          [
            invNo,
            enterpriseId,
            r.invoice_type,
            r.kind,
            r.billing_type ?? "postpaid",
            currency,
            r.timezone,
            invoiceDate,
            from,
            to,
            due,
            r.remarks,
            r.created_by_id,
          ],
        );
        invoiceId = Number(ins[0].id);
        await c.query("UPDATE invoice_requests SET invoice_id = $2 WHERE id = $1", [requestId, invoiceId]);
      } else {
        await c.query("UPDATE invoices SET status = 'inprogress', updated_at = now() WHERE id = $1", [invoiceId]);
      }
    });
    await sleep(stepMs());
    const opening = money(await balanceBefore(pool, enterpriseId, invoiceDate, invoiceId!));
    const closing = money(opening - usage);
    // Proforma invoices ask for the amount itself; traffic invoices for what the closing balance owes.
    const dueAmount = r.kind === "proforma" ? money(usage) : money(Math.max(0, -closing));
    await pool.query(
      `UPDATE invoices SET opening_balance = $2, usage_charges = $3, closing_balance = $4, due_amount = $5::numeric,
              message_count = $6, due_date = $7, status = 'completed',
              payment_status = CASE WHEN $5::numeric = 0 THEN 'paid' ELSE payment_status END,
              email_status = CASE WHEN $8::boolean THEN 'unsent' ELSE email_status END,
              updated_by_id = $9, updated_at = now()
        WHERE id = $1`,
      [invoiceId, opening, money(usage), closing, dueAmount, messages, due, regenerate, r.created_by_id],
    );
    await pool.query("UPDATE invoice_requests SET status = 'completed', finished_at = now() WHERE id = $1", [
      requestId,
    ]);
  } catch (err) {
    const message = err instanceof JobError ? err.message : `Unexpected error: ${(err as Error).message}`;
    await pool
      .query("UPDATE invoice_requests SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [
        requestId,
        message,
      ])
      .catch(() => undefined);
    if (invoiceId !== null)
      await pool
        .query("UPDATE invoices SET status = $2, updated_at = now() WHERE id = $1", [
          invoiceId,
          previousStatus ?? "failed",
        ])
        .catch(() => undefined);
  }
}

/** After a restart: run the requests users started that never finished. */
export async function resumeInvoiceRequests(): Promise<void> {
  try {
    const pool = db();
    const { rows } = await pool.query(
      `SELECT id FROM invoice_requests WHERE status IN ('pending','inprogress') AND created_by_id IS NOT NULL
          AND inserted_at > now() - interval '2 days' ORDER BY id`,
    );
    for (const r of rows) {
      await pool.query("UPDATE invoice_requests SET status = 'pending' WHERE id = $1", [r.id]);
      void runInvoiceRequest(Number(r.id));
    }
  } catch {
    // The database may not be up yet; nothing to resume then.
  }
}
