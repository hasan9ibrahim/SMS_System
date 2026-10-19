// SOA and SOA report (§7, §13.31, §13.33): the statement of account per enterprise and side, with
// every line's source (Auto / Manual) and status and a running balance in the §7 sign (positive =
// the partner's credit); the disputed block for vendor invoices not accepted (as the partner's
// reconciliation rule says), payments left off the SOA, lines removed by hand, manual entries; Send
// Email and Queue SOA Export run as SOA reports in the background and keep the statement as sent.
import { fillBody, fillText } from "../email/html.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  SoaAdjustment,
  SoaAdjustmentInput,
  SoaEmailPreviewInput,
  SoaExportInput,
  SoaLine,
  SoaQuery,
  SoaReportRow,
  SoaReportSendInput,
  SoaSendInput,
  SoaSide,
  SoaStatement,
  SoaStatementQuery,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { mapSoaReport, SOA_REPORT_FROM, SOA_REPORT_SELECT } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { simplePdf, spreadsheetXml, type PdfLine } from "../billing/files.js";
import { billingContacts, convert } from "./finance.js";
import { notFound, setArchived } from "./masterData.js";
import { recordChange, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";
import { companyDetails, companyMailbox, companyPlaceholders, companyTemplate, logEmail } from "./emailLog.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };
type Side = "customer" | "vendor";
type InvoiceType = SoaQuery["invoiceType"];

const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });
const money = (v: number) => Math.round(v * 100) / 100;
const ymd = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const fmt = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const stepMs = () => Number(process.env.SOA_JOB_STEP_MS ?? 600);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function checkPeriod(from: string, to: string): FieldError[] {
  if (to < from) return [{ path: "/to", message: "must not be before the From date" }];
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 3 * 366) return [{ path: "/to", message: "at most 3 years" }];
  return [];
}

/** Balance words for a side (§7 sign, decided 2026-10-17). */
export function balanceWords(v: number, side: Side): string {
  if (Math.abs(v) < 0.005) return "settled";
  if (v > 0) return side === "customer" ? "in credit" : "vendor in credit";
  return side === "customer" ? "owes us" : "we owe";
}

// ---------------------------------------------------------------- statement

/** Effect on the balance of a transaction (§7): customer credit +, vendor debit (our payment) +. */
const txSign = (side: Side) =>
  side === "customer"
    ? "CASE payment_type WHEN 'credit' THEN amount ELSE -amount END"
    : "CASE payment_type WHEN 'debit' THEN amount ELSE -amount END";

/** System balance of a side just before `day` (exclusive): what every balance screen shows. */
async function systemBalance(c: Db, enterpriseId: number, side: Side, opening: number, day: string): Promise<number> {
  const usage =
    side === "customer"
      ? `SELECT COALESCE(sum(usage_charges), 0) FROM invoices WHERE enterprise_id = $1 AND deleted_at IS NULL
           AND status <> 'failed' AND kind = 'traffic' AND invoice_date < $3`
      : `SELECT COALESCE(sum(charge_amount), 0) FROM vendor_invoices WHERE enterprise_id = $1 AND deleted_at IS NULL
           AND recon_status = 'accepted' AND invoice_date < $3`;
  const { rows } = await c.query(
    `SELECT (SELECT COALESCE(sum(${txSign(side)}), 0) FROM transactions
              WHERE enterprise_id = $1 AND side = $2 AND deleted_at IS NULL AND payment_date < $3) AS tx,
            (${usage}) AS usage`,
    [enterpriseId, side, day],
  );
  return money(opening + Number(rows[0].tx) - Number(rows[0].usage));
}

const nextDay = (d: string) => new Date(Date.parse(d) + 86400_000).toISOString().slice(0, 10);
const KIND_ORDER: Record<string, number> = { manual_opening: 0, invoice: 1, vendor_invoice: 1 };

async function buildSide(
  c: Db,
  enterpriseId: number,
  b: { side: Side; currency: string; opening: number },
  invoiceType: InvoiceType,
  from: string,
  to: string,
  adj: Record<string, unknown>[],
  disputedBlock: boolean,
): Promise<SoaSide> {
  const { side, currency } = b;
  const end = nextDay(to);
  const opening = await systemBalance(c, enterpriseId, side, b.opening, from);
  const system = await systemBalance(c, enterpriseId, side, b.opening, end);
  const lines: SoaLine[] = [];
  const disputed: SoaLine[] = [];
  const excluded: SoaLine[] = [];
  const removed: SoaLine[] = [];
  const base = { balance: null, adjustmentId: null, note: null, status: null, source: "auto" as const };
  const adjFor = (action: string, key: "invoice_id" | "vendor_invoice_id", id: number) =>
    adj.find((a) => a.action === action && Number(a[key]) === id);

  if (side === "customer") {
    const { rows } = await c.query(
      `SELECT id, invoice_number, invoice_date, usage_start, usage_end, usage_charges, invoice_type, payment_status
         FROM invoices WHERE enterprise_id = $1 AND deleted_at IS NULL AND status <> 'failed' AND kind = 'traffic'
          AND invoice_date >= $2 AND invoice_date < $3 AND ($4 = 'all' OR invoice_type = $4)`,
      [enterpriseId, from, end, invoiceType],
    );
    for (const r of rows) {
      const id = Number(r.id);
      const line: SoaLine = {
        ...base,
        key: `invoice:${id}`,
        date: ymd(r.invoice_date),
        kind: "invoice",
        reference: r.invoice_number,
        description: `Invoice, usage ${ymd(r.usage_start)} to ${ymd(r.usage_end)}${r.invoice_type === "manual" ? " (manual)" : ""}`,
        amount: -money(Number(r.usage_charges)),
        status: r.payment_status,
        refType: "invoice",
        refId: id,
      };
      const ex = adjFor("exclude_invoice", "invoice_id", id);
      if (ex)
        removed.push({ ...line, source: "manual", note: (ex.note as string) ?? null, adjustmentId: Number(ex.id) });
      else lines.push(line);
    }
  } else {
    const { rows } = await c.query(
      `SELECT id, invoice_number, invoice_date, period_from, period_to, charge_amount, recon_status
         FROM vendor_invoices WHERE enterprise_id = $1 AND deleted_at IS NULL AND invoice_date >= $2 AND invoice_date < $3`,
      [enterpriseId, from, end],
    );
    for (const r of rows) {
      const id = Number(r.id);
      const line: SoaLine = {
        ...base,
        key: `vendor_invoice:${id}`,
        date: ymd(r.invoice_date),
        kind: "vendor_invoice",
        reference: r.invoice_number,
        description: `Your invoice, period ${ymd(r.period_from)} to ${ymd(r.period_to)}`,
        amount: -money(Number(r.charge_amount)),
        status: r.recon_status,
        refType: "vendor_invoice",
        refId: id,
      };
      if (r.recon_status === "accepted") {
        // §13.31: accepted invoices, including ones accepted later, are on the SOA automatically.
        const ex = adjFor("exclude_vendor_invoice", "vendor_invoice_id", id);
        if (ex)
          removed.push({ ...line, source: "manual", note: (ex.note as string) ?? null, adjustmentId: Number(ex.id) });
        else lines.push(line);
      } else {
        const inc = adjFor("include_vendor_invoice", "vendor_invoice_id", id);
        if (inc)
          lines.push({ ...line, source: "manual", note: (inc.note as string) ?? null, adjustmentId: Number(inc.id) });
        else disputed.push(line);
      }
    }
  }
  const { rows: txs } = await c.query(
    `SELECT t.id, t.payment_date, t.transaction_type, t.payment_type, t.amount, t.currency, t.description, t.include_in_soa,
            t.exclude_reason, i.invoice_number
       FROM transactions t LEFT JOIN invoices i ON i.id = t.invoice_id
      WHERE t.enterprise_id = $1 AND t.side = $2 AND t.deleted_at IS NULL AND t.payment_date >= $3 AND t.payment_date < $4`,
    [enterpriseId, side, from, end],
  );
  // Transactions recorded by balance-changing manual entries show as the entry's (manual) line.
  const byTx = new Map(adj.filter((a) => a.transaction_id !== null).map((a) => [Number(a.transaction_id), a]));
  for (const t of txs) {
    const raises = side === "customer" ? t.payment_type === "credit" : t.payment_type === "debit";
    const line: SoaLine = {
      ...base,
      key: `transaction:${t.id}`,
      date: ymd(t.payment_date),
      kind: t.transaction_type,
      reference: t.invoice_number ?? `TX-${t.id}`,
      description: t.description ?? t.transaction_type,
      amount: (raises ? 1 : -1) * money(Number(t.amount)),
      refType: "transaction",
      refId: Number(t.id),
    };
    if (String(t.currency).trim() !== currency)
      line.description += ` (${fmt(Number(t.amount))} ${String(t.currency).trim()})`;
    const entry = byTx.get(Number(t.id));
    if (entry) {
      line.kind = `manual_${entry.kind === "opening_balance" ? "opening" : entry.kind}` as SoaLine["kind"];
      line.source = "manual";
      line.adjustmentId = Number(entry.id);
      line.note = (entry.note as string) ?? null;
      line.description = `${entry.description} · recorded as TX-${t.id}`;
    }
    if (t.include_in_soa) lines.push(line);
    else excluded.push({ ...line, note: t.exclude_reason ?? null });
  }
  for (const a of adj.filter((x) => x.action === "entry" && x.side === side && x.transaction_id === null)) {
    const day = ymd(a.entry_date);
    if (day < from || day > to) continue;
    lines.push({
      ...base,
      key: `entry:${a.id}`,
      date: day,
      kind: `manual_${a.kind === "opening_balance" ? "opening" : a.kind}` as SoaLine["kind"],
      reference: null,
      description: a.description as string,
      amount: money(Number(a.amount)),
      source: "manual",
      note: (a.note as string) ?? null,
      refType: "entry",
      refId: Number(a.id),
      adjustmentId: Number(a.id),
    });
  }
  lines.sort(
    (x, y) =>
      x.date.localeCompare(y.date) ||
      (KIND_ORDER[x.kind] ?? 2) - (KIND_ORDER[y.kind] ?? 2) ||
      x.key.localeCompare(y.key),
  );
  let run = opening;
  for (const l of lines) {
    run = money(run + l.amount);
    l.balance = run;
  }
  const byDate = (x: SoaLine, y: SoaLine) => x.date.localeCompare(y.date);
  return {
    side,
    currency,
    openingBalance: opening,
    lines,
    closingBalance: run,
    systemBalance: system,
    difference: money(run - system),
    disputedBlock,
    disputed: disputed.sort(byDate),
    excludedPayments: excluded.sort(byDate),
    removed: removed.sort(byDate),
  };
}

export async function buildStatement(
  c: Db,
  enterpriseId: number,
  invoiceType: InvoiceType,
  from: string,
  to: string,
): Promise<SoaStatement | null> {
  const { rows: ent } = await c.query(
    `SELECT e.id, e.name, e.billing_timezone, bc.name AS company FROM enterprises e
       JOIN business_companies bc ON bc.id = e.business_company_id WHERE e.id = $1`,
    [enterpriseId],
  );
  const e = ent[0];
  if (!e) return null;
  const { rows: billing } = await c.query(
    "SELECT side, currency, opening_balance FROM enterprise_billing WHERE enterprise_id = $1 ORDER BY side",
    [enterpriseId],
  );
  const { rows: adj } = await c.query("SELECT * FROM soa_adjustments WHERE enterprise_id = $1 AND deleted_at IS NULL", [
    enterpriseId,
  ]);
  const { rows: rule } = await c.query(
    `SELECT disputed_in_soa FROM recon_rules WHERE deleted_at IS NULL AND (enterprise_id = $1 OR enterprise_id IS NULL)
      ORDER BY enterprise_id IS NULL LIMIT 1`,
    [enterpriseId],
  );
  const disputedBlock = (rule[0]?.disputed_in_soa ?? "separate_block") === "separate_block";
  const sides: SoaSide[] = [];
  for (const b of billing)
    sides.push(
      await buildSide(
        c,
        enterpriseId,
        { side: b.side, currency: String(b.currency).trim(), opening: Number(b.opening_balance) },
        invoiceType,
        from,
        to,
        adj,
        disputedBlock,
      ),
    );
  const cust = sides.find((s) => s.side === "customer");
  const vend = sides.find((s) => s.side === "vendor");
  let net: SoaStatement["net"] = null;
  if (cust && vend) {
    const { rows: r } = await c.query("SELECT iso, rate_per_usd FROM currency_latest WHERE iso = ANY($1)", [
      [cust.currency, vend.currency],
    ]);
    const rate = (iso: string) =>
      iso === "USD" ? 1 : Number(r.find((x) => String(x.iso).trim() === iso)?.rate_per_usd ?? 1);
    net = {
      amount: money(cust.closingBalance - (vend.closingBalance * rate(cust.currency)) / rate(vend.currency)),
      currency: cust.currency,
    };
  }
  return {
    enterpriseId,
    enterprise: e.name,
    businessCompany: e.company,
    timezone: e.billing_timezone,
    from,
    to,
    invoiceType,
    recipients: await billingContacts(c, enterpriseId),
    sides,
    net,
  };
}

export function getSoaStatement(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SoaStatementQuery;
  const errors = checkPeriod(b.from, b.to);
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    const st = await buildStatement(pool, b.enterpriseId, b.invoiceType, b.from, b.to);
    return st ?? notFound(reply, "Enterprise", b.enterpriseId);
  });
}

export function searchSoa(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SoaQuery;
  const errors = checkPeriod(b.from, b.to);
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    const ids = [...new Set(b.enterpriseIds)];
    const { rows: ent } = await pool.query("SELECT id, type FROM enterprises WHERE id = ANY($1)", [ids]);
    const { rows: sent } = await pool.query(
      "SELECT enterprise_id, max(emailed_at) AS at FROM soa_reports WHERE enterprise_id = ANY($1) GROUP BY 1",
      [ids],
    );
    const rows = [];
    for (const id of ids) {
      const st = await buildStatement(pool, id, b.invoiceType, b.from, b.to);
      if (!st) continue;
      const last = sent.find((s) => Number(s.enterprise_id) === id)?.at as Date | null | undefined;
      rows.push({
        enterpriseId: id,
        enterprise: st.enterprise,
        enterpriseType: ent.find((x) => Number(x.id) === id)?.type ?? "customer",
        recipients: st.recipients,
        sides: st.sides.map((s) => ({
          side: s.side,
          currency: s.currency,
          openingBalance: s.openingBalance,
          closingBalance: s.closingBalance,
          systemBalance: s.systemBalance,
          lines: s.lines.length,
          excludedPayments: s.excludedPayments.length,
          disputed: s.disputed.length,
        })),
        lastSentAt: last ? last.toISOString() : null,
      });
    }
    rows.sort((x, y) => x.enterprise.localeCompare(y.enterprise));
    return { rows };
  });
}

// ---------------------------------------------------------------- manual adds, removes and entries

async function loadAdjustment(c: Db, id: number): Promise<SoaAdjustment | null> {
  const { rows } = await c.query(
    `SELECT a.*, u.username AS created_by FROM soa_adjustments a LEFT JOIN users u ON u.id = a.created_by_id WHERE a.id = $1`,
    [id],
  );
  const a = rows[0];
  if (!a) return null;
  return {
    id: Number(a.id),
    enterpriseId: Number(a.enterprise_id),
    action: a.action,
    invoiceId: a.invoice_id === null ? null : Number(a.invoice_id),
    vendorInvoiceId: a.vendor_invoice_id === null ? null : Number(a.vendor_invoice_id),
    side: a.side ?? null,
    kind: a.kind ?? null,
    date: a.entry_date === null ? null : ymd(a.entry_date),
    amount: a.amount === null ? null : Number(a.amount),
    currency: a.currency ? String(a.currency).trim() : null,
    description: a.description ?? null,
    affectsBalance: a.affects_balance === true,
    transactionId: a.transaction_id === null ? null : Number(a.transaction_id),
    note: a.note ?? null,
    createdBy: a.created_by ?? null,
    createdAt: (a.inserted_at as Date).toISOString(),
    archivedAt: a.deleted_at ? (a.deleted_at as Date).toISOString() : null,
  };
}

export function createSoaAdjustment(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SoaAdjustmentInput;
  const note = b.note?.trim() || null;
  return withDb(reply, async (pool) => {
    const { rows: ent } = await pool.query("SELECT name FROM enterprises WHERE id = $1", [b.enterpriseId]);
    if (!ent[0]) return notFound(reply, "Enterprise", b.enterpriseId);
    const live = (where: string, id: number) =>
      pool.query(
        `SELECT 1 FROM soa_adjustments WHERE enterprise_id = $1 AND deleted_at IS NULL AND ${where} = $2 AND action = $3`,
        [b.enterpriseId, id, b.action],
      );
    let label: string;
    const values: Record<string, unknown> = {
      invoice_id: null,
      vendor_invoice_id: null,
      side: null,
      kind: null,
      entry_date: null,
      amount: null,
      currency: null,
      description: null,
    };
    if (b.action === "exclude_invoice") {
      if (!b.invoiceId) return badInput(reply, [{ path: "/invoiceId", message: "required" }]);
      if (!note) return badInput(reply, [{ path: "/note", message: "a reason is required to remove a line" }]);
      const { rows } = await pool.query("SELECT invoice_number FROM invoices WHERE id = $1 AND enterprise_id = $2", [
        b.invoiceId,
        b.enterpriseId,
      ]);
      if (!rows[0]) return badInput(reply, [{ path: "/invoiceId", message: "not an invoice of this enterprise" }]);
      if ((await live("invoice_id", b.invoiceId)).rows[0])
        return sendProblem(reply, 409, "Already removed from the SOA");
      values.invoice_id = b.invoiceId;
      label = `Removed invoice ${rows[0].invoice_number} from the SOA`;
    } else if (b.action === "include_vendor_invoice" || b.action === "exclude_vendor_invoice") {
      if (!b.vendorInvoiceId) return badInput(reply, [{ path: "/vendorInvoiceId", message: "required" }]);
      const { rows } = await pool.query(
        "SELECT invoice_number, recon_status FROM vendor_invoices WHERE id = $1 AND enterprise_id = $2 AND deleted_at IS NULL",
        [b.vendorInvoiceId, b.enterpriseId],
      );
      if (!rows[0])
        return badInput(reply, [{ path: "/vendorInvoiceId", message: "not a vendor invoice of this enterprise" }]);
      const accepted = rows[0].recon_status === "accepted";
      if (b.action === "include_vendor_invoice" && accepted)
        return sendProblem(reply, 409, `${rows[0].invoice_number} is accepted and already on the SOA`);
      if (b.action === "exclude_vendor_invoice" && !accepted)
        return sendProblem(reply, 409, `${rows[0].invoice_number} is not accepted, so it is not on the SOA`);
      if (b.action === "exclude_vendor_invoice" && !note)
        return badInput(reply, [{ path: "/note", message: "a reason is required to remove a line" }]);
      if ((await live("vendor_invoice_id", b.vendorInvoiceId)).rows[0]) return sendProblem(reply, 409, "Already done");
      values.vendor_invoice_id = b.vendorInvoiceId;
      label = `${b.action === "include_vendor_invoice" ? "Added" : "Removed"} vendor invoice ${rows[0].invoice_number} ${
        b.action === "include_vendor_invoice" ? "to" : "from"
      } the SOA`;
    } else {
      const e = b.entry;
      if (!e) return badInput(reply, [{ path: "/entry", message: "required for a manual entry" }]);
      if (e.amount === 0) return badInput(reply, [{ path: "/entry/amount", message: "must not be 0" }]);
      const { rows } = await pool.query(
        "SELECT currency FROM enterprise_billing WHERE enterprise_id = $1 AND side = $2",
        [b.enterpriseId, e.side],
      );
      if (!rows[0]) return badInput(reply, [{ path: "/entry/side", message: `no ${e.side} billing settings` }]);
      const ccy = String(rows[0].currency).trim();
      if (e.currency && e.currency !== ccy)
        return badInput(reply, [{ path: "/entry/currency", message: `the ${e.side} side is billed in ${ccy}` }]);
      Object.assign(values, {
        affects: e.affectsBalance === true,
        side: e.side,
        kind: e.kind,
        entry_date: e.date,
        amount: money(e.amount),
        currency: ccy,
        description: e.description.trim(),
      });
      label = `Manual SOA entry: ${e.description.trim()} ${fmt(e.amount)} ${ccy}${
        e.affectsBalance ? " (recorded as a transaction)" : " (SOA only)"
      }`;
    }
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO soa_adjustments (enterprise_id, action, invoice_id, vendor_invoice_id, side, kind, entry_date, amount,
                                      currency, description, note, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          b.enterpriseId,
          b.action,
          values.invoice_id,
          values.vendor_invoice_id,
          values.side,
          values.kind,
          values.entry_date,
          values.amount,
          values.currency,
          values.description,
          note,
          me.id,
        ],
      );
      const id = Number(rows[0].id);
      if (values.affects) {
        // Changes the balance (decided 2026-10-17): the entry records a real transaction.
        const txId = await entryTransaction(c, b.enterpriseId, values, me.id);
        await c.query("UPDATE soa_adjustments SET affects_balance = true, transaction_id = $2 WHERE id = $1", [
          id,
          txId,
        ]);
      }
      const change = await recordChange(c, {
        entityType: "soa_adjustment",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { action: b.action } }],
        note: `${label} (${ent[0].name})${note ? `: ${note}` : ""}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadAdjustment(pool, id), change });
  });
}

const ENTRY_TX_TYPE: Record<string, string> = {
  payment: "receipt",
  credit_note: "credit_note",
  adjustment: "adjustment",
  opening_balance: "adjustment",
};

/** The transaction behind a balance-changing manual entry, signed like the entry (§7). */
async function entryTransaction(c: pg.PoolClient, enterpriseId: number, v: Record<string, unknown>, userId: number) {
  const side = v.side as Side;
  const amount = Number(v.amount);
  const raises = amount > 0;
  const paymentType = side === "customer" ? (raises ? "credit" : "debit") : raises ? "debit" : "credit";
  let type = ENTRY_TX_TYPE[v.kind as string]!;
  if (v.kind === "payment" && side === "vendor") type = "bill_payment";
  const abs = Math.abs(amount);
  const conv = await convert(c, enterpriseId, abs, v.currency as string, v.entry_date as string);
  const { rows } = await c.query(
    `INSERT INTO transactions (enterprise_id, side, payment_mode, payment_type, transaction_type, amount, currency,
                               amount_base, base_currency, ex_rate, payment_date, description, send_confirmation,
                               confirmation_status, include_in_soa, created_by_id, updated_by_id)
     VALUES ($1, $2, 'bank_transfer', $3, $4, $5, $6, $7, $8, $9, $10, $11, false, 'not_sent', true, $12, $12) RETURNING id`,
    [
      enterpriseId,
      side,
      paymentType,
      type,
      abs,
      v.currency,
      conv?.amountBase ?? abs,
      conv?.baseCurrency ?? v.currency,
      conv?.exRate ?? 1,
      v.entry_date,
      `${v.description} (SOA entry)`,
      userId,
    ],
  );
  return Number(rows[0].id);
}

export function archiveSoaAdjustment(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadAdjustment(pool, id);
    if (!before) return notFound(reply, "SOA adjustment", id);
    if (before.archivedAt) return { record: before, change: null };
    const reason = ((request.body ?? {}) as ArchiveRequest).reason?.trim();
    const r = await setArchived(request, reply, pool, {
      table: "soa_adjustments",
      entityType: "soa_adjustment",
      archive: true,
      note: `Took back a manual SOA ${before.action === "entry" ? "entry" : "change"}${reason ? `: ${reason}` : ""}`,
    });
    if ("reply" in r) return r.reply;
    // A balance-changing entry takes its transaction with it (undo brings both back, changes.ts).
    if (before.transactionId)
      await pool.query("UPDATE transactions SET deleted_at = now(), updated_at = now() WHERE id = $1", [
        before.transactionId,
      ]);
    return { record: await loadAdjustment(pool, id), change: r.change };
  });
}

// ---------------------------------------------------------------- e-mail

async function emailFor(c: Db, st: SoaStatement, templateId: number) {
  const { rows } = await c.query(
    "SELECT name, email_type, subject, body FROM email_templates WHERE id = $1 AND deleted_at IS NULL",
    [templateId],
  );
  const t = rows[0];
  if (!t) return null;
  const main = st.sides.find((s) => s.side === "customer") ?? st.sides[0];
  const vars: Record<string, string> = {
    ...companyPlaceholders(await companyDetails(c, { enterpriseId: st.enterpriseId })),
    enterprise: st.enterprise,
    from: st.from,
    to: st.to,
    timezone: st.timezone,
    closing_balance: main ? fmt(main.closingBalance) : "0.00",
    currency: main?.currency ?? "",
    balance_words: main ? balanceWords(main.closingBalance, main.side) : "settled",
    company: st.businessCompany,
  };
  return {
    name: t.name as string,
    type: t.email_type as string,
    subject: fillText(t.subject, vars),
    body: fillBody(t.body, vars),
  };
}

const SOA_TEMPLATE_TYPES = new Set(["soa_statement", "send_soa"]);

export function previewSoaEmail(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SoaEmailPreviewInput;
  const errors = checkPeriod(b.from, b.to);
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    const st = await buildStatement(pool, b.enterpriseId, b.invoiceType, b.from, b.to);
    if (!st) return notFound(reply, "Enterprise", b.enterpriseId);
    const mail = await emailFor(pool, st, b.templateId);
    if (!mail || !SOA_TEMPLATE_TYPES.has(mail.type))
      return badInput(reply, [{ path: "/templateId", message: "choose an SOA Statement or Send SOA template" }]);
    return { recipients: st.recipients, subject: mail.subject, body: mail.body };
  });
}

// ---------------------------------------------------------------- reports

async function loadReport(c: Db, id: number): Promise<SoaReportRow | null> {
  const { rows } = await c.query(`SELECT ${SOA_REPORT_SELECT} FROM ${SOA_REPORT_FROM} WHERE s.id = $1`, [id]);
  return rows[0] ? mapSoaReport(rows[0]) : null;
}

export function getSoaReport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadReport(pool, id)) ?? notFound(reply, "SOA report", id));
}

async function createReports(
  request: FastifyRequest,
  reply: FastifyReply,
  b: { enterpriseIds: number[]; invoiceType: InvoiceType; from: string; to: string },
  purpose: "export" | "email",
  fileType: "excel" | "pdf",
  templateId: number | null,
) {
  const errors = checkPeriod(b.from, b.to);
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    if (templateId !== null) {
      const { rows } = await pool.query("SELECT email_type FROM email_templates WHERE id = $1 AND deleted_at IS NULL", [
        templateId,
      ]);
      if (!rows[0] || !SOA_TEMPLATE_TYPES.has(rows[0].email_type))
        return badInput(reply, [{ path: "/templateId", message: "choose an SOA Statement or Send SOA template" }]);
    }
    const ids = [...new Set(b.enterpriseIds)];
    const { rows: ents } = await pool.query("SELECT id FROM enterprises WHERE id = ANY($1)", [ids]);
    const missing = ids.filter((id) => !ents.some((e) => Number(e.id) === id));
    if (missing.length)
      return badInput(reply, [{ path: "/enterpriseIds", message: `enterprise ${missing[0]} not found` }]);
    const me = await getCurrentUser();
    const created: number[] = [];
    for (const id of ids) {
      const { rows } = await pool.query(
        `INSERT INTO soa_reports (enterprise_id, period_from, period_to, invoice_type, file_type, purpose, status, template_id,
                                  created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8) RETURNING id`,
        [id, b.from, b.to, b.invoiceType, fileType, purpose, templateId, me.id],
      );
      created.push(Number(rows[0].id));
    }
    void runReports(created);
    const reports = await Promise.all(created.map((id) => loadReport(pool, id)));
    return reply.code(202).send({ reports });
  });
}

export const sendSoa = (request: FastifyRequest, reply: FastifyReply) => {
  const b = request.body as SoaSendInput;
  return createReports(request, reply, b, "email", "pdf", b.templateId);
};

export const exportSoa = (request: FastifyRequest, reply: FastifyReply) => {
  const b = request.body as SoaExportInput;
  return createReports(request, reply, b, "export", b.fileType, null);
};

/** Runs reports one after another (background job, §14 "async jobs with status"). */
async function runReports(ids: number[]) {
  for (const id of ids) await runSoaReport(id);
}

export async function runSoaReport(id: number): Promise<void> {
  const pool = db();
  try {
    await sleep(stepMs());
    const { rows } = await pool.query("SELECT * FROM soa_reports WHERE id = $1", [id]);
    const r = rows[0];
    if (!r || r.status !== "pending") return;
    await pool.query("UPDATE soa_reports SET status = 'inprogress' WHERE id = $1", [id]);
    const st = await buildStatement(
      pool,
      Number(r.enterprise_id),
      r.invoice_type,
      ymd(r.period_from),
      ymd(r.period_to),
    );
    if (!st) throw new Error("The enterprise no longer exists");
    if (!st.sides.length) throw new Error("The enterprise has no billing settings");
    await sleep(stepMs());
    const main = st.sides.find((s) => s.side === "customer") ?? st.sides[0]!;
    let emailTo: string[] = [];
    if (r.purpose === "email") {
      emailTo = st.recipients;
      await logSoaEmail(
        pool,
        st,
        r.template_id === null ? null : Number(r.template_id),
        emailTo,
        r.created_by_id,
        r.file_type,
      );
      if (!emailTo.length) {
        await pool.query(
          `UPDATE soa_reports SET status = 'failed', error = $2, snapshot = $3, closing_balance = $4, currency = $5,
                  finished_at = now() WHERE id = $1`,
          [id, "The partner has no billing contact", JSON.stringify(st), main.closingBalance, main.currency],
        );
        return;
      }
    }
    await pool.query(
      `UPDATE soa_reports SET status = 'success', snapshot = $2, closing_balance = $3, currency = $4, email_to = $5,
              emailed_at = CASE WHEN purpose = 'email' THEN now() END, finished_at = now() WHERE id = $1`,
      [id, JSON.stringify(st), main.closingBalance, main.currency, emailTo],
    );
  } catch (err) {
    await pool
      .query("UPDATE soa_reports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [
        id,
        (err as Error).message,
      ])
      .catch(() => undefined);
  }
}

/** Email Logs (§8) entry for a sent SOA. */
async function logSoaEmail(
  c: Db,
  st: SoaStatement,
  templateId: number | null,
  to: string[],
  userId: unknown,
  fileType: string,
) {
  // No template picked: the partner's business company's SOA Statement template (§11).
  const tid = templateId ?? (await companyTemplate(c, { enterpriseId: st.enterpriseId }, "soa_statement"))?.id ?? null;
  const mail = tid === null ? null : await emailFor(c, st, tid);
  await logEmail(c, {
    type: "send_soa",
    enterpriseId: st.enterpriseId,
    to,
    sender: await companyMailbox(c, st.enterpriseId, "soa"),
    subject: mail?.subject ?? `Statement of account ${st.from} to ${st.to}`,
    body: mail?.body ?? "",
    file: `SOA_${st.from}_${st.to}.${fileType === "excel" ? "xls" : "pdf"}`,
    error: to.length ? null : "No billing contact",
    userId: userId === null || userId === undefined ? null : Number(userId),
  });
}

/** After a restart: run the reports users queued that never finished. */
export async function resumeSoaReports(): Promise<void> {
  try {
    const { rows } = await db().query(
      `SELECT id FROM soa_reports WHERE status IN ('pending','inprogress') AND inserted_at > now() - interval '2 days' ORDER BY id`,
    );
    if (!rows.length) return;
    await db().query("UPDATE soa_reports SET status = 'pending' WHERE id = ANY($1)", [rows.map((r) => r.id)]);
    void runReports(rows.map((r) => Number(r.id)));
  } catch {
    // The database may not be up yet.
  }
}

const KIND_LABEL: Record<string, string> = {
  opening: "Opening balance",
  invoice: "Invoice",
  vendor_invoice: "Vendor invoice",
  receipt: "Payment received",
  adjustment: "Adjustment",
  dispute: "Dispute",
  credit_note: "Credit note",
  bank_charges: "Bank charges",
  bill_payment: "Payment made",
  reprocess: "Re-rating",
  manual_payment: "Payment (manual)",
  manual_credit_note: "Credit note (manual)",
  manual_adjustment: "Adjustment (manual)",
  manual_opening: "Opening balance (manual)",
};
const SIDE_TITLE: Record<Side, string> = { customer: "Our invoices to you", vendor: "Your invoices to us" };

/** The statement as a PDF: header, then per side the lines with running balance, disputed block. */
export function soaPdf(st: SoaStatement): Buffer {
  const L: PdfLine[] = [
    { text: st.businessCompany, size: 15, bold: true, gap: 0 },
    { text: "STATEMENT OF ACCOUNT", size: 13, bold: true, gap: 26 },
    { text: `${st.enterprise}` },
    { text: `Period ${st.from} to ${st.to} (${st.timezone})` },
    { text: "Balances: positive = your credit with us, negative = amount owed.", size: 8 },
  ];
  const cols = (date: string, kind: string, ref: string, amount: string, bal: string, bold = false): PdfLine => ({
    text: date,
    size: 8.5,
    bold,
    cells: [
      { x: 110, text: kind.slice(0, 26) },
      { x: 230, text: ref.slice(0, 30) },
      { x: 470, text: amount, right: true },
      { x: 548, text: bal, right: true },
    ],
  });
  for (const s of st.sides) {
    L.push({ text: `${SIDE_TITLE[s.side]} (${s.currency})`, bold: true, size: 11, gap: 24 });
    L.push(cols("Date", "Type", "Reference", "Amount", "Balance", true));
    L.push(cols(st.from, "Opening balance", "", "", fmt(s.openingBalance)));
    for (const l of s.lines)
      L.push(
        cols(l.date, KIND_LABEL[l.kind] ?? l.kind, l.reference ?? l.description, fmt(l.amount), fmt(l.balance ?? 0)),
      );
    L.push(cols(st.to, "Closing balance", balanceWords(s.closingBalance, s.side), "", fmt(s.closingBalance), true));
    if (s.disputedBlock && s.disputed.length) {
      L.push({ text: "Disputed and pending invoices (not in the balance above)", bold: true, size: 9, gap: 16 });
      for (const l of s.disputed) L.push(cols(l.date, l.status ?? "", l.reference ?? "", fmt(l.amount), ""));
    }
  }
  if (st.net)
    L.push({ text: `Net balance (customer − vendor): ${fmt(st.net.amount)} ${st.net.currency}`, bold: true, gap: 22 });
  return simplePdf(L);
}

export function soaSheet(st: SoaStatement): Buffer {
  const rows: { cells: (string | number | null)[]; bold?: boolean }[] = [
    { cells: [st.businessCompany], bold: true },
    { cells: ["Statement of account", st.enterprise], bold: true },
    { cells: ["Period", `${st.from} to ${st.to}`, "Time zone", st.timezone] },
    { cells: ["Balances: positive = your credit with us, negative = amount owed"] },
    { cells: [] },
  ];
  for (const s of st.sides) {
    rows.push({ cells: [SIDE_TITLE[s.side], s.currency], bold: true });
    rows.push({
      cells: ["Date", "Type", "Reference", "Description", "Amount", "Balance", "Source", "Status"],
      bold: true,
    });
    rows.push({ cells: [st.from, "Opening balance", null, null, null, s.openingBalance] });
    for (const l of s.lines)
      rows.push({
        cells: [
          l.date,
          KIND_LABEL[l.kind] ?? l.kind,
          l.reference,
          l.description,
          l.amount,
          l.balance,
          l.source === "auto" ? "Auto" : "Manual",
          l.status,
        ],
      });
    rows.push({
      cells: [st.to, "Closing balance", balanceWords(s.closingBalance, s.side), null, null, s.closingBalance],
      bold: true,
    });
    if (s.disputedBlock && s.disputed.length) {
      rows.push({ cells: ["Disputed and pending invoices (not in the balance)"], bold: true });
      for (const l of s.disputed)
        rows.push({ cells: [l.date, "Vendor invoice", l.reference, l.description, l.amount, null, null, l.status] });
    }
    rows.push({ cells: [] });
  }
  if (st.net)
    rows.push({
      cells: ["Net balance (customer − vendor)", null, null, null, st.net.amount, st.net.currency],
      bold: true,
    });
  return spreadsheetXml(`SOA ${st.from}`, rows);
}

export function downloadSoaReport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      "SELECT s.*, e.alias FROM soa_reports s JOIN enterprises e ON e.id = s.enterprise_id WHERE s.id = $1",
      [id],
    );
    const r = rows[0];
    if (!r) return notFound(reply, "SOA report", id);
    if (r.status !== "success")
      return sendProblem(reply, 409, `The report is ${r.status}; download it once it succeeded`);
    // Seeded history has no snapshot: build it now from the same settings.
    const st =
      (r.snapshot as SoaStatement | null) ??
      (await buildStatement(pool, Number(r.enterprise_id), r.invoice_type, ymd(r.period_from), ymd(r.period_to)));
    if (!st) return notFound(reply, "Enterprise", Number(r.enterprise_id));
    const name = `SOA_${r.alias}_${ymd(r.period_from)}_${ymd(r.period_to)}`;
    if (r.file_type === "excel")
      return reply
        .type("application/vnd.ms-excel")
        .header("content-disposition", `attachment; filename="${name}.xls"`)
        .send(soaSheet(st));
    return reply
      .type("application/pdf")
      .header("content-disposition", `attachment; filename="${name}.pdf"`)
      .send(soaPdf(st));
  });
}

export function sendSoaReport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as SoaReportSendInput;
  return withDb(reply, async (pool) => {
    const before = await loadReport(pool, id);
    if (!before) return notFound(reply, "SOA report", id);
    if (before.status !== "success")
      return sendProblem(reply, 409, `The report is ${before.status}; it can be sent once it succeeded`);
    const { rows } = await pool.query("SELECT email_type FROM email_templates WHERE id = $1 AND deleted_at IS NULL", [
      b.templateId,
    ]);
    if (!rows[0] || !SOA_TEMPLATE_TYPES.has(rows[0].email_type))
      return badInput(reply, [{ path: "/templateId", message: "choose an SOA Statement or Send SOA template" }]);
    const to = await billingContacts(pool, before.enterpriseId);
    if (!to.length) return badInput(reply, [{ path: "/templateId", message: "the partner has no billing contact" }]);
    await pool.query("UPDATE soa_reports SET emailed_at = now(), email_to = $2, template_id = $3 WHERE id = $1", [
      id,
      to,
      b.templateId,
    ]);
    const { rows: snap } = await pool.query("SELECT snapshot, created_by_id FROM soa_reports WHERE id = $1", [id]);
    const st =
      (snap[0]?.snapshot as SoaStatement | null) ??
      (await buildStatement(pool, before.enterpriseId, before.invoiceType, before.from, before.to));
    const me = await getCurrentUser();
    if (st) await logSoaEmail(pool, st, b.templateId, to, me.id, before.fileType);
    return loadReport(pool, id);
  });
}
