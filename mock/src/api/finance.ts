// Finance part 1 (§7, §13.33): transactions with the payment confirmation and Include in SOA,
// currencies and exchange rates (history kept, so past amounts never move), billing cycles,
// enterprise balances and the Charges Calculator. Every save is one undoable change (§13.10);
// delete archives (§13.29).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  BillingCycleInput,
  ChargesInput,
  ChargesResult,
  ConfirmationPreview,
  ConvertInput,
  CurrencyInput,
  CurrencyUpdate,
  CurrencyRateInput,
  TransactionBulkInput,
  TransactionDetail,
  TransactionInput,
} from "@sms/contract";
import { refreshRates } from "./fx.js";
import { withDb } from "../db.js";
import { chRows } from "../edr.js";
import { fmtMoney, money, PLATFORM_CURRENCY, PLATFORM_PER_EUR, sysToPlatformFactor } from "../currency.js";
import {
  BALANCE_FROM,
  billingCycleList,
  currencyList,
  currencyRateList,
  enterpriseBalanceList,
  transactionList,
} from "../lists/defs.js";
import { archiveGate } from "./enterprises.js";
import { exportList, load, notFound, setArchived } from "./masterData.js";
import { dependencies, recordChange, same, type DiffEntry, type FieldError } from "./records.js";
import { sendProblem } from "../problem.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";
import { companyMailbox, logEmail } from "./emailLog.js";
import { beforeDetail, dec, decFactor } from "../reports/source.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };

const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

// ---------------------------------------------------------------- transactions

/** API field → column, for the diff and for undo (written together, see applyTransactionEntries). */
const TX_COLUMNS: [string, string][] = [
  ["side", "side"],
  ["enterpriseId", "enterprise_id"],
  ["invoiceId", "invoice_id"],
  ["paymentMode", "payment_mode"],
  ["transactionType", "transaction_type"],
  ["paymentType", "payment_type"],
  ["paymentDate", "payment_date"],
  ["amount", "amount"],
  ["currency", "currency"],
  ["description", "description"],
  ["sendConfirmation", "send_confirmation"],
  ["includeInSoa", "include_in_soa"],
  ["excludeReason", "exclude_reason"],
  ["amountBase", "amount_base"],
  ["baseCurrency", "base_currency"],
  ["exRate", "ex_rate"],
  ["confirmationStatus", "confirmation_status"],
];
const TX_COL = new Map(TX_COLUMNS);

export async function loadTransaction(db: Db, id: number): Promise<TransactionDetail | null> {
  const { rows } = await db.query(
    `SELECT ${transactionList.select}, tx.ex_rate, tx.confirmation_sent_at, tx.confirmation_recipients,
            cb.username AS created_by
       FROM ${transactionList.from as string} LEFT JOIN users cb ON cb.id = tx.created_by_id WHERE tx.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...transactionList.mapRow(r),
    exRate: Number(r.ex_rate ?? 1),
    confirmationSentAt: r.confirmation_sent_at ? new Date(r.confirmation_sent_at).toISOString() : null,
    confirmationRecipients: r.confirmation_recipients ?? [],
    createdBy: r.created_by ?? null,
  };
}

export function getTransaction(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadTransaction(pool, id)) ?? notFound(reply, "Transaction", id));
}

/** Final Amount (§7): base currency of the enterprise's business company at the payment date. */
/** Final Amount in the business company base currency at the date (§7 Transaction Conversion). */
export async function convert(db: Db, enterpriseId: number, amount: number, currency: string, date: string) {
  const { rows } = await db.query(
    `SELECT bc.base_currency,
            rate_per_eur_at(bc.base_currency, $3::date::timestamptz) / rate_per_eur_at($2, $3::date::timestamptz) AS rate
       FROM enterprises e JOIN business_companies bc ON bc.id = e.business_company_id WHERE e.id = $1`,
    [enterpriseId, currency, date],
  );
  if (!rows[0]) return null;
  const exRate = Number(Number(rows[0].rate).toFixed(8));
  return { baseCurrency: String(rows[0].base_currency).trim(), exRate, amountBase: money(amount * exRate) };
}

export function convertTransactionAmount(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as ConvertInput;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM currencies WHERE iso = $1", [body.currency]);
    if (!rows[0]) return badInput(reply, [{ path: "/currency", message: "unknown currency" }]);
    return (
      (await convert(pool, body.enterpriseId, body.amount, body.currency, body.date)) ??
      badInput(reply, [{ path: "/enterpriseId", message: "unknown enterprise" }])
    );
  });
}

async function checkTransaction(
  db: Db,
  t: TransactionInput,
  existing: TransactionDetail | null,
): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const { rows: e } = await db.query("SELECT deleted_at FROM enterprises WHERE id = $1", [t.enterpriseId]);
  if (!e[0]) err("/enterpriseId", "unknown enterprise");
  else if (e[0].deleted_at && existing?.enterpriseId !== t.enterpriseId)
    err("/enterpriseId", "the enterprise is deleted");
  const { rows: c } = await db.query("SELECT 1 FROM currencies WHERE iso = $1 AND deleted_at IS NULL", [t.currency]);
  if (!c[0]) err("/currency", "unknown currency");
  if (t.transactionType === "reprocess" && existing?.transactionType !== "reprocess")
    err("/transactionType", "reprocess notes are posted by approved re-rating requests (§12.2)");
  if (t.transactionType !== "reprocess" && t.paymentMode === null) err("/paymentMode", "required");
  if (!t.includeInSoa && !t.excludeReason?.trim()) err("/excludeReason", "say why it stays off the SOA (§13.33)");
  if (t.invoiceId !== null) {
    const { rows } = await db.query("SELECT enterprise_id FROM invoices WHERE id = $1 AND deleted_at IS NULL", [
      t.invoiceId,
    ]);
    if (!rows[0]) err("/invoiceId", "unknown invoice");
    else if (Number(rows[0].enterprise_id) !== t.enterpriseId)
      err("/invoiceId", "the invoice belongs to another enterprise");
    if (t.side === "vendor") err("/invoiceId", "vendor payments settle vendor invoices (Vendor Invoice screen)");
  }
  if (t.paymentDate > new Date(Date.now() + 366 * 86400_000).toISOString().slice(0, 10))
    err("/paymentDate", "more than a year ahead");
  return errors;
}

/** The side's billing contacts (finance, else commercial) for the confirmation. */
export async function billingContacts(db: Db, enterpriseId: number): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT emails FROM enterprise_contacts WHERE enterprise_id = $1 AND contact_type IN ('finance', 'commercial')
      ORDER BY contact_type = 'finance' DESC LIMIT 1`,
    [enterpriseId],
  );
  return (rows[0]?.emails as string[] | undefined) ?? [];
}

/** Balance of one side now (§7: positive = the partner's credit, negative = owed). */
async function sideBalance(db: Db, enterpriseId: number, side: "customer" | "vendor") {
  const { rows } = await db.query(
    `SELECT bal.customer, bal.vendor, cb.currency AS ccur, vb.currency AS vcur FROM ${BALANCE_FROM} WHERE e.id = $1`,
    [enterpriseId],
  );
  const r = rows[0];
  return {
    balance: Number((side === "customer" ? r?.customer : r?.vendor) ?? 0),
    currency: String((side === "customer" ? r?.ccur : r?.vcur) ?? "").trim() || null,
  };
}

async function confirmationEmail(db: Db, t: TransactionInput, txId: number | null): Promise<ConfirmationPreview> {
  const [{ rows: e }, recipients, bal, inv] = await Promise.all([
    db.query("SELECT name FROM enterprises WHERE id = $1", [t.enterpriseId]),
    billingContacts(db, t.enterpriseId),
    sideBalance(db, t.enterpriseId, t.side),
    t.invoiceId ? db.query("SELECT invoice_number FROM invoices WHERE id = $1", [t.invoiceId]) : null,
  ]);
  // A saved payment is already in the balance; a new one is not yet.
  // Balance sign (decided 2026-10-17): a customer credit or a vendor debit raises the balance.
  const sign = (t.side === "customer") === (t.paymentType === "credit") ? 1 : -1;
  const currency = bal.currency ?? t.currency;
  const after = money(bal.balance + (txId === null && currency === t.currency ? sign * t.amount : 0));
  const invoice = inv?.rows[0]?.invoice_number as string | undefined;
  const mode = (t.paymentMode ?? "reprocess").replace(/_/g, " ");
  return {
    recipients,
    subject: `Payment confirmation · ${fmtMoney(t.amount)} ${t.currency} · ${t.paymentDate}`,
    body: [
      `Dear ${e[0]?.name ?? "partner"},`,
      "",
      `We confirm the ${t.paymentType === "credit" ? "payment received" : "payment sent"} below.`,
      "",
      `Amount: ${fmtMoney(t.amount)} ${t.currency}`,
      `Date: ${t.paymentDate}`,
      `Mode: ${mode}`,
      `Reference: ${txId ? `TX-${txId}` : "assigned on save"}`,
      ...(invoice ? [`Invoice: ${invoice}`] : []),
      `Balance after this payment: ${fmtMoney(after)} ${currency}`,
      "",
      "Regards,",
      "Billing team",
    ].join("\n"),
    balanceAfter: after,
    currency,
  };
}

export function previewTransactionConfirmation(request: FastifyRequest, reply: FastifyReply) {
  const t = request.body as TransactionInput;
  return withDb(reply, async (pool) => confirmationEmail(pool, t, null));
}

const txValues = (t: TransactionInput, conv: { baseCurrency: string; exRate: number; amountBase: number }) => ({
  ...t,
  description: t.description?.trim() || null,
  excludeReason: t.includeInSoa ? null : t.excludeReason!.trim(),
  ...conv,
});

export function createTransaction(request: FastifyRequest, reply: FastifyReply) {
  const t = request.body as TransactionInput;
  return withDb(reply, async (pool) => {
    const errors = await checkTransaction(pool, t, null);
    if (errors.length) return badInput(reply, errors);
    const conv = (await convert(pool, t.enterpriseId, t.amount, t.currency, t.paymentDate))!;
    const v = txValues(t, conv);
    const me = await getCurrentUser();
    const recipients = t.sendConfirmation ? await billingContacts(pool, t.enterpriseId) : [];
    const status = !t.sendConfirmation ? "not_sent" : recipients.length ? "sent" : "failed";
    const { id, change } = await inTransaction(pool, async (c) => {
      const cols = TX_COLUMNS.filter(([api]) => api !== "confirmationStatus");
      const { rows } = await c.query(
        `INSERT INTO transactions (${cols.map(([, col]) => col).join(", ")}, confirmation_status, confirmation_sent_at,
                                   confirmation_recipients, created_by_id, updated_by_id)
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3},
                 $${cols.length + 4}, $${cols.length + 4}) RETURNING id`,
        [
          ...cols.map(([api]) => v[api as keyof typeof v]),
          status,
          status === "sent" ? new Date() : null,
          recipients,
          me.id,
        ],
      );
      const id = Number(rows[0].id);
      if (t.sendConfirmation) await logConfirmation(c, id, t.enterpriseId, recipients, me.id);
      const change = await recordChange(c, {
        entityType: "transaction",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { amount: t.amount, currency: t.currency } }],
        note: `Added ${t.transactionType.replace("_", " ")} ${fmtMoney(t.amount)} ${t.currency}${
          status === "sent"
            ? " · confirmation sent"
            : status === "failed"
              ? " · confirmation failed (no billing contact)"
              : ""
        }`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadTransaction(pool, id), change });
  });
}

export function updateTransaction(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const t = request.body as TransactionInput;
  return withDb(reply, async (pool) => {
    const before = await loadTransaction(pool, id);
    if (!before) return notFound(reply, "Transaction", id);
    if (before.archivedAt) return sendProblem(reply, 400, "This transaction is deleted; restore it before editing");
    const errors = await checkTransaction(pool, t, before);
    if (errors.length) return badInput(reply, errors);
    const moneyMoved =
      before.amount !== t.amount ||
      before.currency !== t.currency ||
      before.paymentDate !== t.paymentDate ||
      before.enterpriseId !== t.enterpriseId;
    const conv = moneyMoved
      ? (await convert(pool, t.enterpriseId, t.amount, t.currency, t.paymentDate))!
      : { baseCurrency: before.baseCurrency, exRate: before.exRate, amountBase: before.amountBase ?? 0 };
    const v: Record<string, unknown> = { ...txValues(t, conv), confirmationStatus: before.confirmationStatus };
    const b = before as unknown as Record<string, unknown>;
    const diff: DiffEntry[] = TX_COLUMNS.filter(([api]) => !same(b[api] ?? null, v[api] ?? null)).map(([api]) => ({
      entity_id: id,
      field: api,
      before: b[api] ?? null,
      after: v[api] ?? null,
    }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const soa = diff.find((d) => d.field === "includeInSoa");
    const change = await inTransaction(pool, async (c) => {
      await writeTransaction(c, id, Object.fromEntries(diff.map((d) => [d.field, d.after])), me.id);
      return recordChange(c, {
        entityType: "transaction",
        entityIds: [id],
        changeType: "edit",
        diff,
        // §13.33: every change to In SOA is logged with its reason.
        note: soa
          ? soa.after
            ? "Included in SOA"
            : `Excluded from SOA: ${v.excludeReason as string}`
          : `Changed transaction TX-${id}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadTransaction(pool, id), change };
  });
}

/** One UPDATE for all fields, so the In SOA / reason check holds at every step (undo too). */
async function writeTransaction(c: pg.PoolClient, id: number, values: Record<string, unknown>, userId: number) {
  const sets: string[] = [];
  const params: unknown[] = [id, userId];
  for (const [field, value] of Object.entries(values)) {
    const col = TX_COL.get(field);
    if (!col) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return;
  await c.query(
    `UPDATE transactions SET ${sets.join(", ")}, updated_by_id = $2, updated_at = now() WHERE id = $1`,
    params,
  );
}

/** Undo (§13.10) of transaction changes: the record's fields are written in one statement. */
export async function applyTransactionEntries(c: pg.PoolClient, entries: DiffEntry[], userId: number) {
  const byId = new Map<number, Record<string, unknown>>();
  for (const e of entries) {
    if (e.field === "*" || e.field === "archived") {
      const archive = e.field === "*" ? e.before == null : e.before === true;
      await c.query(`UPDATE transactions SET deleted_at = ${archive ? "now()" : "NULL"} WHERE id = $1`, [e.entity_id]);
      continue;
    }
    byId.set(e.entity_id, { ...(byId.get(e.entity_id) ?? {}), [e.field]: e.before });
  }
  for (const [id, values] of byId) await writeTransaction(c, id, values, userId);
}

export function archiveTransaction(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadTransaction(pool, id);
    if (!before) return notFound(reply, "Transaction", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(reply, (request.body ?? {}) as ArchiveRequest, dependencies([]));
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "transactions",
      entityType: "transaction",
      archive: true,
      note:
        gate.note ?? `Deleted TX-${id} ${fmtMoney(before.amount ?? 0)} ${before.currency} (${before.enterprise})`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadTransaction(pool, id), change: r.change };
  });
}

export function restoreTransaction(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadTransaction(pool, id);
    if (!before) return notFound(reply, "Transaction", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This transaction is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "transactions",
      entityType: "transaction",
      archive: false,
      note: null,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadTransaction(pool, id), change: r.change };
  });
}

/** Sends confirmations for the given live transactions; returns the diff entries. */
async function sendConfirmations(c: pg.PoolClient, ids: number[], userId: number): Promise<DiffEntry[]> {
  const { rows } = await c.query(
    "SELECT id, enterprise_id, confirmation_status FROM transactions WHERE id = ANY($1) AND deleted_at IS NULL",
    [ids],
  );
  const diff: DiffEntry[] = [];
  for (const r of rows) {
    const recipients = await billingContacts(c, Number(r.enterprise_id));
    const status = recipients.length ? "sent" : "failed";
    await c.query(
      `UPDATE transactions SET confirmation_status = $2, confirmation_sent_at = CASE WHEN $2 = 'sent' THEN now() END,
              confirmation_recipients = $3, updated_by_id = $4, updated_at = now() WHERE id = $1`,
      [r.id, status, recipients, userId],
    );
    await logConfirmation(c, Number(r.id), Number(r.enterprise_id), recipients, userId);
    diff.push({ entity_id: Number(r.id), field: "confirmationStatus", before: r.confirmation_status, after: status });
  }
  return diff;
}

/** Email Logs (§8) entry for a payment confirmation (§13.33). */
async function logConfirmation(c: Db, txId: number, enterpriseId: number, to: string[], userId: number) {
  const { rows } = await c.query("SELECT amount, currency, payment_date FROM transactions WHERE id = $1", [txId]);
  const t = rows[0];
  await logEmail(c, {
    type: "payment_confirmation",
    enterpriseId,
    to,
    sender: await companyMailbox(c, enterpriseId, "paymentConfirmation"),
    subject: `Payment confirmation TX-${txId}: ${fmtMoney(Number(t.amount))} ${String(t.currency).trim()}`,
    body: `We confirm your payment of ${fmtMoney(Number(t.amount))} ${String(t.currency).trim()} dated ${
      t.payment_date instanceof Date ? t.payment_date.toISOString().slice(0, 10) : t.payment_date
    }.`,
    error: to.length ? null : "No billing contact",
    userId,
  });
}

export function sendTransactionConfirmation(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadTransaction(pool, id);
    if (!before) return notFound(reply, "Transaction", id);
    if (before.archivedAt) return sendProblem(reply, 400, "This transaction is deleted");
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      const diff = await sendConfirmations(c, [id], me.id);
      return recordChange(c, {
        entityType: "transaction",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Payment confirmation ${diff[0]?.after === "sent" ? "sent" : "failed (no billing contact)"} for TX-${id}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadTransaction(pool, id), change };
  });
}

export function bulkUpdateTransactions(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as TransactionBulkInput;
  if (body.action === "exclude_from_soa" && !body.reason?.trim())
    return badInput(reply, [{ path: "/reason", message: "say why they stay off the SOA (§13.33)" }]);
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      let diff: DiffEntry[];
      if (body.action === "send_confirmation") diff = await sendConfirmations(c, body.ids, me.id);
      else {
        const include = body.action === "include_in_soa";
        const { rows } = await c.query(
          `SELECT id, include_in_soa, exclude_reason FROM transactions
            WHERE id = ANY($1) AND deleted_at IS NULL AND include_in_soa <> $2`,
          [body.ids, include],
        );
        const reason = include ? null : body.reason!.trim();
        await c.query(
          `UPDATE transactions SET include_in_soa = $2, exclude_reason = $3, updated_by_id = $4, updated_at = now()
            WHERE id = ANY($1)`,
          [rows.map((r) => r.id), include, reason, me.id],
        );
        diff = rows.flatMap((r) => [
          { entity_id: Number(r.id), field: "excludeReason", before: r.exclude_reason, after: reason },
          { entity_id: Number(r.id), field: "includeInSoa", before: r.include_in_soa, after: include },
        ]);
      }
      if (!diff.length) return null;
      const n = new Set(diff.map((d) => d.entity_id)).size;
      return recordChange(c, {
        entityType: "transaction",
        entityIds: [...new Set(diff.map((d) => d.entity_id))],
        changeType: "edit",
        diff,
        note:
          body.action === "send_confirmation"
            ? `Payment confirmations sent for ${n} transactions`
            : body.action === "include_in_soa"
              ? `${n} transactions included in SOA`
              : `${n} transactions excluded from SOA: ${body.reason!.trim()}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { change };
  });
}

export const exportTransactions = (request: FastifyRequest, reply: FastifyReply) =>
  exportList(
    request,
    reply,
    "transactions",
    transactionList,
    [
      ["id", (r) => r.id],
      ["enterprise", (r) => r.enterprise],
      ["enterprise_type", (r) => r.side],
      ["payment_date", (r) => r.paymentDate],
      ["transaction_time", (r) => r.transactionTime],
      ["mode_of_payment", (r) => r.paymentMode],
      ["payment_type", (r) => r.paymentType],
      ["transaction_type", (r) => r.transactionType],
      ["amount", (r) => r.amount],
      ["currency", (r) => r.currency],
      ["final_amount", (r) => r.amountBase],
      ["base_currency", (r) => r.baseCurrency],
      ["invoice_number", (r) => r.invoiceNumber],
      ["description", (r) => r.description],
      ["confirmation", (r) => r.confirmationStatus],
      ["in_soa", (r) => (r.includeInSoa ? "yes" : "no")],
      ["exclude_reason", (r) => r.excludeReason],
      ["updated_by", (r) => r.updatedBy],
    ],
    "transactions.csv",
  );

// ---------------------------------------------------------------- currencies and rates

export function createCurrency(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as CurrencyInput;
  return withDb(reply, async (pool) => {
    const { rows: taken } = await pool.query("SELECT deleted_at FROM currencies WHERE iso = $1", [body.iso]);
    if (taken[0])
      return sendProblem(reply, 409, `${body.iso} exists${taken[0].deleted_at ? " (archived; undo restores it)" : ""}`);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        "INSERT INTO currencies (iso, name, symbol, updated_by_id) VALUES ($1, $2, $3, $4) RETURNING id",
        [body.iso, body.name.trim(), body.symbol.trim(), me.id],
      );
      // Rates are per 1 EUR, the base currency (team trial round 2): EUR itself has no rate rows.
      if (body.iso !== "EUR")
        await c.query(
          "INSERT INTO currency_rates (iso, rate_per_eur, valid_from, updated_by_id) VALUES ($1, $2, now(), $3)",
          [body.iso, body.ratePerEur, me.id],
        );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "currency",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { iso: body.iso, ratePerEur: body.ratePerEur } }],
        note: `Added currency ${body.iso}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await load(pool, currencyList, id), change });
  });
}

export function updateCurrency(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = request.body as CurrencyUpdate;
  return withDb(reply, async (pool) => {
    const before = await load(pool, currencyList, id);
    if (!before) return notFound(reply, "Currency", id);
    const after = { name: body.name.trim(), symbol: body.symbol.trim() };
    const diff: DiffEntry[] = (["name", "symbol"] as const)
      .filter((f) => before[f] !== after[f])
      .map((f) => ({ entity_id: id, field: f, before: before[f], after: after[f] }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE currencies SET name = $2, symbol = $3, updated_by_id = $4, updated_at = now() WHERE id = $1",
        [id, after.name, after.symbol, me.id],
      );
      return recordChange(c, {
        entityType: "currency",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed currency ${before.iso}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await load(pool, currencyList, id), change };
  });
}

export const exportCurrencies = (request: FastifyRequest, reply: FastifyReply) =>
  exportList(
    request,
    reply,
    "currencies",
    currencyList,
    [
      ["currency_id", (r) => r.id],
      ["currency", (r) => r.name],
      ["iso", (r) => r.iso],
      ["symbol", (r) => r.symbol],
      ["rate_per_eur", (r) => r.ratePerEur],
      ["updated_by", (r) => r.updatedBy],
    ],
    "currencies.csv",
  );

/** Undo of a rate (§13.10): the earlier rate becomes the rate from now on (history is never rewritten). */
export async function applyCurrencyRate(c: pg.PoolClient, currencyId: number, rate: unknown, userId: number) {
  await c.query(
    `INSERT INTO currency_rates (iso, rate_per_eur, valid_from, updated_by_id)
     SELECT iso, $2, clock_timestamp(), $3 FROM currencies WHERE id = $1`,
    [currencyId, rate, userId],
  );
}

export function setCurrencyRate(request: FastifyRequest, reply: FastifyReply) {
  const { iso } = request.params as { iso: string };
  const { ratePerEur } = request.body as CurrencyRateInput;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT id FROM currencies WHERE iso = $1 AND deleted_at IS NULL", [iso]);
    if (!rows[0]) return sendProblem(reply, 404, `Currency ${iso} not found`);
    if (iso === "EUR")
      return badInput(reply, [
        { path: "/ratePerEur", message: "rates are per EUR, the base currency; EUR is always 1" },
      ]);
    const id = Number(rows[0].id);
    const before = (await load(pool, currencyRateList, id))!;
    if (before.ratePerEur === ratePerEur) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await applyCurrencyRate(c, id, ratePerEur, me.id);
      return recordChange(c, {
        entityType: "currency",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "rate", before: before.ratePerEur, after: ratePerEur }],
        note: `${iso} rate ${before.ratePerEur} → ${ratePerEur} per EUR`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await load(pool, currencyRateList, id), change };
  });
}

/** Sync Rates: pulls the provider's rates now (the real source in production, simulated elsewhere) and checks the currency alerts. */
export function syncCurrencyRates(request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const r = await refreshRates(pool, {
      userId: me.id,
      ip: request.ip,
      note: "Synced {n} exchange rates (simulated feed)",
    });
    // Sync Rates takes every rate whatever the difference, like the daily update (team trial round 3).
    await pool.query(
      "UPDATE fx_provider SET last_run_at = now(), last_status = 'simulated', last_message = $1 WHERE id = 1",
      [`Sync: ${r.updated} of ${r.checked} rates updated by ${me.username} (simulated: no call to the rate API)`],
    );
    return { updated: r.updated, change: r.change };
  });
}

// ---------------------------------------------------------------- billing cycles

const loadCycle = (db: Db, id: number) => load(db, billingCycleList, id);

function checkCycle(b: BillingCycleInput): FieldError[] {
  const errors: FieldError[] = [];
  if (!b.name.trim()) errors.push({ path: "/name", message: "required" });
  if ((b.billingType === "weekly" || b.billingType === "fortnightly") && !b.weekDay)
    errors.push({ path: "/weekDay", message: `a ${b.billingType} cycle starts on a week day` });
  if (b.billingType === "weekly" && b.usageDays !== 7) errors.push({ path: "/usageDays", message: "a week is 7 days" });
  if (b.billingType === "fortnightly" && b.usageDays !== 14)
    errors.push({ path: "/usageDays", message: "a fortnight is 14 days" });
  if (b.billingType === "daily" && b.usageDays !== 1) errors.push({ path: "/usageDays", message: "a day is 1 day" });
  return errors;
}

async function cycleNameTaken(db: Db, name: string, exceptId: number) {
  const { rows } = await db.query("SELECT deleted_at FROM billing_cycles WHERE lower(name) = lower($1) AND id <> $2", [
    name,
    exceptId,
  ]);
  return rows[0] ? `A billing cycle named "${name}" exists${rows[0].deleted_at ? " (deleted)" : ""}` : null;
}

const CYCLE_COLUMNS: [keyof BillingCycleInput, string][] = [
  ["name", "name"],
  ["billingType", "billing_type"],
  ["weekDay", "week_day"],
  ["usageDays", "usage_days"],
  ["dueDays", "due_days"],
];

export function createBillingCycle(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as BillingCycleInput;
  const v = {
    ...b,
    name: b.name.trim(),
    weekDay: b.billingType === "weekly" || b.billingType === "fortnightly" ? b.weekDay : null,
  };
  return withDb(reply, async (pool) => {
    const errors = checkCycle(v);
    if (errors.length) return badInput(reply, errors);
    const taken = await cycleNameTaken(pool, v.name, 0);
    if (taken) return sendProblem(reply, 409, taken);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO billing_cycles (name, billing_type, week_day, usage_days, due_days, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [v.name, v.billingType, v.weekDay, v.usageDays, v.dueDays, me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "billing_cycle",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: v.name } }],
        note: `Added billing cycle ${v.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadCycle(pool, id), change });
  });
}

export function updateBillingCycle(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as BillingCycleInput;
  const v = {
    ...b,
    name: b.name.trim(),
    weekDay: b.billingType === "weekly" || b.billingType === "fortnightly" ? b.weekDay : null,
  };
  return withDb(reply, async (pool) => {
    const before = await loadCycle(pool, id);
    if (!before) return notFound(reply, "Billing cycle", id);
    if (before.archivedAt) return sendProblem(reply, 400, "This billing cycle is deleted; restore it before editing");
    const diff: DiffEntry[] = CYCLE_COLUMNS.filter(([api]) => before[api] !== v[api]).map(([api]) => ({
      entity_id: id,
      field: api,
      before: before[api],
      after: v[api],
    }));
    if (!diff.length) return { record: before, change: null };
    const errors = checkCycle(v);
    if (errors.length) return badInput(reply, errors);
    const taken = await cycleNameTaken(pool, v.name, id);
    if (taken) return sendProblem(reply, 409, taken);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE billing_cycles SET name = $2, billing_type = $3, week_day = $4, usage_days = $5, due_days = $6,
                updated_by_id = $7, updated_at = now() WHERE id = $1`,
        [id, v.name, v.billingType, v.weekDay, v.usageDays, v.dueDays, me.id],
      );
      return recordChange(c, {
        entityType: "billing_cycle",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed billing cycle ${v.name}${before.enterprises ? ` (used by ${before.enterprises} enterprises)` : ""}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadCycle(pool, id), change };
  });
}

export async function cycleDependencies(db: Db, id: number) {
  const { rows } = await db.query(
    "SELECT count(DISTINCT enterprise_id)::int AS n FROM enterprise_billing WHERE billing_cycle_id = $1",
    [id],
  );
  return dependencies([
    { key: "enterprise_billing", label: "Enterprises billed on it", count: rows[0].n, blocking: true, detail: null },
  ]);
}

export function getBillingCycleDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadCycle(pool, id))) return notFound(reply, "Billing cycle", id);
    return cycleDependencies(pool, id);
  });
}

export function archiveBillingCycle(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadCycle(pool, id);
    if (!before) return notFound(reply, "Billing cycle", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(reply, (request.body ?? {}) as ArchiveRequest, await cycleDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "billing_cycles",
      entityType: "billing_cycle",
      archive: true,
      note: gate.note ?? `Deleted billing cycle ${before.name}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadCycle(pool, id), change: r.change };
  });
}

export function restoreBillingCycle(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadCycle(pool, id);
    if (!before) return notFound(reply, "Billing cycle", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This billing cycle is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "billing_cycles",
      entityType: "billing_cycle",
      archive: false,
      note: null,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadCycle(pool, id), change: r.change };
  });
}

// ---------------------------------------------------------------- balances and charges

export const exportEnterpriseBalances = (request: FastifyRequest, reply: FastifyReply) =>
  exportList(
    request,
    reply,
    "enterprise_balances",
    enterpriseBalanceList,
    [
      ["enterprise", (r) => r.enterprise],
      ["customer_balance", (r) => r.customerBalance],
      ["customer_reserved", (r) => r.customerReserved],
      ["customer_currency", (r) => r.customerCurrency],
      ["vendor_balance", (r) => r.vendorBalance],
      ["vendor_currency", (r) => r.vendorCurrency],
      ["net_balance", (r) => r.netBalance],
      ["net_currency", (r) => r.currency],
      ["account_manager", (r) => r.accountManager],
      ["customer_credit", (r) => r.creditLimit],
      ["credit_used_pct", (r) => r.creditUsedPct],
      ["billing_cycle", (r) => r.billingCycle],
    ],
    "enterprise_balances.csv",
  );

const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function calculateCharges(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as ChargesInput;
  if (body.to < body.from) return badInput(reply, [{ path: "/to", message: "must not be before the start" }]);
  if ((Date.parse(body.to) - Date.parse(body.from)) / 86400_000 > 366)
    return badInput(reply, [{ path: "/to", message: "at most 366 days" }]);
  return withDb(reply, async (pool): Promise<ChargesResult | FastifyReply> => {
    // Each enterprise's charges are in its billing currency, the currency of its invoices (team trial round 2):
    // traffic rated in another currency is converted at the latest rate, through the platform currency.
    const { rows: ents } = await pool.query(
      `SELECT e.id, e.name, COALESCE(e.billing_timezone, 'UTC') AS tz,
              COALESCE(b.currency, '${PLATFORM_CURRENCY}') AS cur,
              COALESCE(cl.rate_per_eur / ${PLATFORM_PER_EUR}, 1) AS per_platform
         FROM enterprises e
         LEFT JOIN enterprise_billing b ON b.enterprise_id = e.id
         LEFT JOIN currency_latest cl ON cl.iso = COALESCE(b.currency, '${PLATFORM_CURRENCY}')
        WHERE ($1::bigint IS NULL OR e.id = $1)`,
      [body.enterpriseId],
    );
    if (body.enterpriseId !== null && !ents[0]) return notFound(reply, "Enterprise", body.enterpriseId);
    const groups = new Map<string, number[]>();
    for (const e of ents) groups.set(e.tz, [...(groups.get(e.tz) ?? []), Number(e.id)]);
    const name = new Map(ents.map((e) => [Number(e.id), e.name as string]));
    const tzOf = new Map(ents.map((e) => [Number(e.id), e.tz as string]));
    const billing = new Map(ents.map((e) => [Number(e.id), { cur: e.cur as string, per: Number(e.per_platform) }]));
    const factor = await sysToPlatformFactor();
    const to = new Date(Date.parse(body.to) + 86400_000).toISOString().slice(0, 10);
    // Days start at midnight in each zone (whole quarter hours): the long-term totals answer older periods exactly
    // (docs/BACKEND_PLAN.md §3.7); 14 hours covers the zones' offsets.
    const src = beforeDetail(new Date(Date.parse(`${body.from}T00:00:00Z`) - 14 * 3_600_000)) ? "edr_totals" : "edr_all";
    const side = (s: "c" | "v", ids: number[], tz: string) => `
      SELECT '${s}' AS side, ${s}_enterprise_id AS e, ${s}_currency AS cur,
             sum(msg_count * is_${s === "c" ? "customer" : "vendor"}_billable) AS msgs,
             toFloat64(sum(${s === "c" ? "revenue" : "cost"})) AS amount,
             toFloat64(sum(${dec(s === "c" ? "revenue_sys" : "cost_sys")} * ${decFactor(factor)})) AS platform
        FROM ${src}
       WHERE ${s}_enterprise_id IN (${ids.join(",")})
         AND submit_time >= toDateTime64(${lit(`${body.from} 00:00:00`)}, 3, ${lit(tz)})
         AND submit_time < toDateTime64(${lit(`${to} 00:00:00`)}, 3, ${lit(tz)})
       GROUP BY e, cur`;
    const parts = [...groups].flatMap(([tz, ids]) => [side("c", ids, tz), side("v", ids, tz)]);
    const rows = parts.length
      ? await chRows<{ side: string; e: number; cur: string; msgs: string; amount: number; platform: number }>(
          parts.join(" UNION ALL "),
          30_000,
        )
      : [];
    if (rows === null) return sendProblem(reply, 503, "The EDR store is not reachable");
    // One row per enterprise and side, in its billing currency: an amount rated in that currency counts as is.
    const merged = new Map<string, { e: number; side: string; msgs: number; amount: number; platform: number }>();
    for (const r of rows) {
      const e = Number(r.e);
      const b = billing.get(e) ?? { cur: PLATFORM_CURRENCY, per: 1 };
      const key = `${e}:${r.side}`;
      const m = merged.get(key) ?? { e, side: r.side, msgs: 0, amount: 0, platform: 0 };
      m.msgs += Number(r.msgs);
      m.amount += r.cur === b.cur ? r.amount : r.platform * b.per;
      m.platform += r.platform;
      merged.set(key, m);
    }
    const out = [...merged.values()]
      .filter((r) => r.msgs > 0 || r.amount !== 0)
      .map((r) => ({
        enterpriseId: r.e,
        enterprise: name.get(r.e) ?? `#${r.e}`,
        side: (r.side === "c" ? "customer" : "vendor") as "customer" | "vendor",
        currency: billing.get(r.e)?.cur ?? PLATFORM_CURRENCY,
        timezone: tzOf.get(r.e) ?? "UTC",
        messages: r.msgs,
        amount: money(r.amount),
        amountPlatform: money(r.platform),
      }))
      .sort((a, b) => a.enterprise.localeCompare(b.enterprise) || a.side.localeCompare(b.side));
    const total = (s: string) => money(out.filter((r) => r.side === s).reduce((t, r) => t + r.amountPlatform, 0));
    return {
      from: body.from,
      to: body.to,
      rows: out,
      totalPlatform: { customer: total("customer"), vendor: total("vendor") },
      platformCurrency: PLATFORM_CURRENCY,
    };
  });
}
