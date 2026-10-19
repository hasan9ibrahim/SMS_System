// Vendor invoices and partner invoice reconciliation (§7, §13.31): add, import, edit, compare with
// our EDR figures for the same partner, period, currency and time zone, Accept / Reject / Keep
// pending with notes and e-mails, full history, monthly summary, and reconciliation rules (default
// plus per partner). A simulated billing mailbox "receives" weekly invoices from some vendors
// (§13.13 intake comes later). Every save is one undoable change (§13.10); delete archives (§13.29).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  ImportRequest,
  ReconRuleInput,
  ReconRuleValues,
  VendorInvoiceComparison,
  VendorInvoiceDecision,
  VendorInvoiceDetail,
  VendorInvoiceEmailInput,
  VendorInvoiceEvent,
  VendorInvoiceInput,
  VendorInvoiceNote,
  VendorInvoiceSummary,
  VendorInvoiceSummaryInput,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { PLATFORM_CURRENCY } from "../currency.js";
import {
  mapReconRule,
  RECON_RULE_FROM,
  RECON_RULE_SELECT,
  VENDOR_INVOICE_FROM,
  VENDOR_INVOICE_SELECT,
  mapVendorInvoice,
  vendorInvoiceList,
} from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import {
  coverageOf,
  destinationNames,
  edrCoverage,
  fmtDay,
  nextDay,
  sumLines,
  usageLines,
  type UsageLine,
} from "../billing/edrFigures.js";
import { dayWindow } from "../billing/zone.js";
import { evaluateRecon, flaggedDestinations, type DestinationFigure } from "../billing/recon.js";
import { archiveGate } from "./enterprises.js";
import { billingContacts } from "./finance.js";
import { exportList, ImportRun, notFound, parseCsv, setArchived } from "./masterData.js";
import { dependencies, isTimezone, recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";
import { companyMailbox, logEmail } from "./emailLog.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };

const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });
const money = (v: number) => Math.round(v * 100) / 100;
const ymd = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const fmt = (v: number, digits = 2) =>
  v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- rules

const RULE_FIELDS: [keyof ReconRuleValues, string][] = [
  ["amountPct", "amount_pct"],
  ["amountFixed", "amount_fixed"],
  ["amountCombine", "amount_combine"],
  ["countPct", "count_pct"],
  ["countFixed", "count_fixed"],
  ["countCombine", "count_combine"],
  ["destinationPct", "destination_pct"],
  ["autoSend", "auto_send"],
  ["disputedInSoa", "disputed_in_soa"],
];
const ruleValues = (r: Record<string, unknown>): ReconRuleValues => {
  const m = mapReconRule(r);
  return Object.fromEntries(RULE_FIELDS.map(([k]) => [k, m[k]])) as unknown as ReconRuleValues;
};

/** The partner's own rule, else the default rule (§13.31). */
async function effectiveRule(c: Db, enterpriseId: number): Promise<ReconRuleValues> {
  const { rows } = await c.query(
    `SELECT ${RECON_RULE_SELECT} FROM ${RECON_RULE_FROM}
      WHERE rr.deleted_at IS NULL AND (rr.enterprise_id = $1 OR rr.enterprise_id IS NULL)
      ORDER BY rr.enterprise_id IS NULL LIMIT 1`,
    [enterpriseId],
  );
  if (!rows[0]) throw new Error("No default reconciliation rule");
  return ruleValues(rows[0]);
}

async function loadRule(c: Db, id: number) {
  const { rows } = await c.query(`SELECT ${RECON_RULE_SELECT} FROM ${RECON_RULE_FROM} WHERE rr.id = $1`, [id]);
  return rows[0] ? mapReconRule(rows[0]) : null;
}

function checkRule(b: ReconRuleInput): FieldError[] {
  const errors: FieldError[] = [];
  if (b.amountPct === null && b.amountFixed === null)
    errors.push({ path: "/amountPct", message: "set a percentage, a fixed amount or both" });
  if (b.countPct === null && b.countFixed === null)
    errors.push({ path: "/countPct", message: "set a percentage, a fixed count or both" });
  return errors;
}

export function createReconRule(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as ReconRuleInput;
  if (b.enterpriseId === null)
    return badInput(reply, [
      { path: "/enterpriseId", message: "choose the partner (the default rule already exists)" },
    ]);
  const errors = checkRule(b);
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    const { rows: ent } = await pool.query("SELECT name, type FROM enterprises WHERE id = $1 AND deleted_at IS NULL", [
      b.enterpriseId,
    ]);
    if (!ent[0]) return notFound(reply, "Enterprise", b.enterpriseId!);
    if (ent[0].type === "customer")
      return badInput(reply, [
        { path: "/enterpriseId", message: `${ent[0].name} is a customer only; rules are for partners who invoice us` },
      ]);
    const { rows: has } = await pool.query(
      "SELECT 1 FROM recon_rules WHERE enterprise_id = $1 AND deleted_at IS NULL",
      [b.enterpriseId],
    );
    if (has[0]) return sendProblem(reply, 409, `${ent[0].name} already has its own rule`);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO recon_rules (enterprise_id, ${RULE_FIELDS.map(([, col]) => col).join(", ")}, updated_by_id)
         VALUES ($1, ${RULE_FIELDS.map((_, i) => `$${i + 2}`).join(", ")}, $${RULE_FIELDS.length + 2}) RETURNING id`,
        [b.enterpriseId, ...RULE_FIELDS.map(([k]) => b[k]), me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "recon_rule",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { enterprise: ent[0].name } }],
        note: `Added reconciliation rule for ${ent[0].name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadRule(pool, id), change });
  });
}

export function updateReconRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as ReconRuleInput;
  const errors = checkRule(b);
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Reconciliation rule", id);
    if (before.archivedAt) return sendProblem(reply, 400, "Restore the rule before changing it");
    if (b.enterpriseId !== before.enterpriseId)
      return badInput(reply, [{ path: "/enterpriseId", message: "the partner of a rule cannot change" }]);
    const diff: DiffEntry[] = RULE_FIELDS.filter(([k]) => before[k] !== b[k]).map(([k]) => ({
      entity_id: id,
      field: k,
      before: before[k],
      after: b[k],
    }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE recon_rules SET ${RULE_FIELDS.map(([, col], i) => `${col} = $${i + 2}`).join(", ")},
                updated_by_id = $${RULE_FIELDS.length + 2}, updated_at = now() WHERE id = $1`,
        [id, ...RULE_FIELDS.map(([k]) => b[k]), me.id],
      );
      return recordChange(c, {
        entityType: "recon_rule",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed reconciliation rule: ${before.enterprise ?? "default"}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadRule(pool, id), change };
  });
}

export function archiveReconRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Reconciliation rule", id);
    if (before.enterpriseId === null) return sendProblem(reply, 400, "The default rule cannot be removed");
    if (before.archivedAt) return { record: before, change: null };
    const r = await setArchived(request, reply, pool, {
      table: "recon_rules",
      entityType: "recon_rule",
      archive: true,
      note: `Removed ${before.enterprise}'s own rule; the default applies`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadRule(pool, id), change: r.change };
  });
}

export function restoreReconRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Reconciliation rule", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This rule is not removed");
    const r = await setArchived(request, reply, pool, {
      table: "recon_rules",
      entityType: "recon_rule",
      archive: false,
      note: null,
      restoreClash: async (c) => {
        const { rows } = await c.query("SELECT 1 FROM recon_rules WHERE enterprise_id = $1 AND deleted_at IS NULL", [
          before.enterpriseId,
        ]);
        return rows[0] ? `${before.enterprise} has a newer rule` : null;
      },
    });
    if ("reply" in r) return r.reply;
    return { record: await loadRule(pool, id), change: r.change };
  });
}

// ---------------------------------------------------------------- read

export async function loadVendorInvoice(c: Db, id: number): Promise<VendorInvoiceDetail | null> {
  const { rows } = await c.query(`SELECT ${VENDOR_INVOICE_SELECT} FROM ${VENDOR_INVOICE_FROM} WHERE v.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  const row = mapVendorInvoice(r);
  const { rows: ev } = await c.query(
    `SELECT x.*, u.username FROM vendor_invoice_events x LEFT JOIN users u ON u.id = x.user_id
      WHERE x.vendor_invoice_id = $1 ORDER BY x.inserted_at DESC, x.id DESC`,
    [id],
  );
  const events: VendorInvoiceEvent[] = ev.map((x) => ({
    id: Number(x.id),
    kind: x.kind,
    statusFrom: x.status_from ?? null,
    statusTo: x.status_to ?? null,
    note: x.note ?? null,
    emailTo: x.email_to ?? [],
    user: x.username ?? null,
    at: (x.inserted_at as Date).toISOString(),
  }));
  const rule = await effectiveRule(c, row.enterpriseId);
  const { rows: adj } = await c.query(
    "SELECT action FROM soa_adjustments WHERE vendor_invoice_id = $1 AND deleted_at IS NULL",
    [id],
  );
  const manual = adj[0]?.action as string | undefined;
  return {
    ...row,
    reasons: (r.check_reasons as string[]) ?? [],
    rule: (r.rule_snapshot as ReconRuleValues | null) ?? null,
    // §13.31: accepted invoices are on the SOA; the others are left off or shown as disputed.
    // Manual SOA adds and removes (§13.31) win over the automatic rule.
    inSoa:
      manual === "include_vendor_invoice"
        ? "included"
        : manual === "exclude_vendor_invoice"
          ? "excluded"
          : row.status === "accepted"
            ? "included"
            : rule.disputedInSoa === "separate_block"
              ? "disputed_block"
              : "excluded",
    events,
  };
}

export function getVendorInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadVendorInvoice(pool, id)) ?? notFound(reply, "Vendor invoice", id));
}

export const exportVendorInvoices = (request: FastifyRequest, reply: FastifyReply) =>
  exportList(
    request,
    reply,
    "vendor_invoices",
    vendorInvoiceList,
    [
      ["info_id", (r) => r.id],
      ["enterprise", (r) => r.enterprise],
      ["invoice_number", (r) => r.invoiceNumber],
      ["currency", (r) => r.currency],
      ["charge_volume", (r) => r.chargeVolume],
      ["charge_amount", (r) => r.chargeAmount],
      ["our_volume", (r) => r.ourVolume],
      ["our_amount", (r) => r.ourAmount],
      ["dispute_amount", (r) => r.disputeAmount],
      ["difference_pct", (r) => r.differencePct],
      ["invoice_date", (r) => r.invoiceDate],
      ["due_date", (r) => r.dueDate],
      ["period_from", (r) => r.periodFrom],
      ["period_to", (r) => r.periodTo],
      ["timezone", (r) => r.timezone],
      ["check", (r) => r.comparison],
      ["status", (r) => r.status],
      ["email", (r) => r.emailStatus],
      ["source", (r) => r.source],
      ["remarks", (r) => r.remarks],
      ["created_by", (r) => r.createdBy],
      ["created_at", (r) => r.createdAt],
    ],
    "vendor_invoices.csv",
  );

// ---------------------------------------------------------------- comparison

interface Figures {
  coverage: "full" | "partial" | "none";
  edrFrom: Date | null;
  edrTo: Date | null;
  lines: UsageLine[] | null;
}

async function ourFigures(c: Db, v: Record<string, unknown>): Promise<Figures | null> {
  const cov = await edrCoverage();
  if (!cov) return null;
  const from = ymd(v.period_from);
  const to = ymd(v.period_to);
  const tz = v.timezone as string;
  const coverage = coverageOf(cov, from, to, tz);
  const lines =
    coverage === "none"
      ? []
      : await usageLines(c, "vendor", Number(v.enterprise_id), from, to, tz, String(v.currency).trim(), false);
  return { coverage, edrFrom: cov.from, edrTo: cov.to, lines };
}

async function theirLines(c: Db, id: number): Promise<Map<string, { volume: number | null; amount: number }>> {
  const { rows } = await c.query(
    "SELECT mccmnc, volume, amount FROM vendor_invoice_lines WHERE vendor_invoice_id = $1",
    [id],
  );
  return new Map(
    rows.map((r) => [
      r.mccmnc as string,
      { volume: r.volume === null ? null : Number(r.volume), amount: Number(r.amount) },
    ]),
  );
}

function destinationFigures(
  ours: UsageLine[],
  theirs: Map<string, { volume: number | null; amount: number }>,
): DestinationFigure[] {
  const codes = new Set([...ours.map((l) => l.mccmnc), ...theirs.keys()]);
  return [...codes].map((m) => ({
    mccmnc: m,
    theirAmount: theirs.size ? (theirs.get(m)?.amount ?? 0) : null,
    ourAmount: ours.find((l) => l.mccmnc === m)?.amount ?? 0,
  }));
}

export function getVendorInvoiceComparison(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool): Promise<VendorInvoiceComparison | FastifyReply> => {
    const { rows } = await pool.query("SELECT * FROM vendor_invoices WHERE id = $1", [id]);
    const v = rows[0];
    if (!v) return notFound(reply, "Vendor invoice", id);
    const f = await ourFigures(pool, v);
    if (!f || !f.lines) return sendProblem(reply, 503, "The EDR store is not reachable");
    const theirs = await theirLines(pool, id);
    const rule = await effectiveRule(pool, Number(v.enterprise_id));
    const figures = destinationFigures(f.lines, theirs);
    const flagged = flaggedDestinations(rule, figures);
    const names = await destinationNames(
      pool,
      figures.map((x) => x.mccmnc),
    );
    const out = figures.map((x) => {
      const ours = f.lines!.find((l) => l.mccmnc === x.mccmnc);
      const diff = x.theirAmount === null ? null : money(x.theirAmount - x.ourAmount);
      return {
        mccmnc: x.mccmnc,
        country: names.get(x.mccmnc)?.country ?? null,
        network: names.get(x.mccmnc)?.network ?? null,
        theirVolume: theirs.size ? (theirs.get(x.mccmnc)?.volume ?? 0) : null,
        theirAmount: x.theirAmount === null ? null : money(x.theirAmount),
        ourVolume: ours?.messages ?? 0,
        ourAmount: money(x.ourAmount),
        difference: diff,
        differencePct: diff === null || x.ourAmount <= 0 ? null : Math.round((diff / x.ourAmount) * 10000) / 100,
        flagged: flagged.has(x.mccmnc),
      };
    });
    out.sort((a, b) =>
      a.difference === null || b.difference === null
        ? b.ourAmount - a.ourAmount
        : Math.abs(b.difference) - Math.abs(a.difference),
    );
    return {
      invoiceId: id,
      currency: String(v.currency).trim(),
      timezone: v.timezone,
      from: ymd(v.period_from),
      to: ymd(v.period_to),
      coverage: f.coverage,
      edrFrom: f.edrFrom?.toISOString() ?? null,
      edrTo: f.edrTo?.toISOString() ?? null,
      rows: out.slice(0, 2000),
    };
  });
}

// ---------------------------------------------------------------- e-mails

function emailText(kind: "acceptance" | "rejection", v: Record<string, unknown>, note: string | null) {
  const ccy = String(v.currency).trim();
  const period = `${ymd(v.period_from)} to ${ymd(v.period_to)} (${v.timezone})`;
  const theirs = `${fmt(Number(v.charge_amount))} ${ccy}${v.charge_volume === null ? "" : `, ${fmt(Number(v.charge_volume), 0)} messages`}`;
  if (kind === "acceptance")
    return {
      subject: `Invoice ${v.invoice_number} accepted`,
      body: [
        "Dear partner,",
        "",
        `We accept your invoice ${v.invoice_number} for ${period}: ${theirs}.`,
        "It is included in your next statement of account.",
        ...(note ? ["", `Note: ${note}`] : []),
        "",
        "Kind regards,",
        "Billing team",
      ].join("\n"),
    };
  const ours =
    v.our_amount === null
      ? "not available"
      : `${fmt(Number(v.our_amount))} ${ccy}${v.our_volume === null ? "" : `, ${fmt(Number(v.our_volume), 0)} messages`}`;
  return {
    subject: `Invoice ${v.invoice_number} disputed`,
    body: [
      "Dear partner,",
      "",
      `We cannot accept your invoice ${v.invoice_number} for ${period}.`,
      `Your figures: ${theirs}`,
      `Our figures: ${ours}`,
      ...(note ? ["", `Reason: ${note}`] : []),
      "",
      "Please review and send a corrected invoice or a credit note.",
      "",
      "Kind regards,",
      "Billing team",
    ].join("\n"),
  };
}

export function previewVendorInvoiceEmail(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as VendorInvoiceEmailInput;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT * FROM vendor_invoices WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, "Vendor invoice", id);
    return {
      recipients: await billingContacts(pool, Number(rows[0].enterprise_id)),
      ...emailText(b.kind, rows[0], b.note?.trim() || null),
    };
  });
}

async function addEvent(
  c: Db,
  id: number,
  kind: VendorInvoiceEvent["kind"],
  f: {
    statusFrom?: string | null;
    statusTo?: string | null;
    note?: string | null;
    emailTo?: string[];
    userId: number | null;
  },
) {
  await c.query(
    `INSERT INTO vendor_invoice_events (vendor_invoice_id, kind, status_from, status_to, note, email_to, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, kind, f.statusFrom ?? null, f.statusTo ?? null, f.note ?? null, f.emailTo ?? [], f.userId],
  );
}

// ---------------------------------------------------------------- check

/**
 * Runs the comparison for one invoice and moves its status (§13.31): a pending or disputed
 * invoice that matches is accepted (acceptance e-mail sent or queued by the rule's auto-send);
 * a pending one that does not match is disputed. Decided invoices keep their status. Returns
 * the diff entries for the change log.
 */
export async function runCheck(c: pg.PoolClient, id: number, userId: number | null): Promise<DiffEntry[]> {
  const { rows } = await c.query("SELECT * FROM vendor_invoices WHERE id = $1 FOR UPDATE", [id]);
  const v = rows[0];
  const rule = await effectiveRule(c, Number(v.enterprise_id));
  const f = await ourFigures(c, v);
  let comparison: "match" | "mismatch" | "no_data";
  let reasons: string[];
  let ourVolume = v.our_volume === null ? null : Number(v.our_volume);
  let ourAmount = v.our_amount === null ? null : Number(v.our_amount);
  // Input From/To (§7, decided 2026-10-17): the window our figures were counted for; null = not counted.
  let input: { from: Date; to: Date } | null = null;
  if (!f || !f.lines) {
    comparison = "no_data";
    reasons = ["The EDR store did not answer; not compared"];
  } else if (f.coverage !== "full") {
    comparison = "no_data";
    reasons = [
      `EDRs in this environment cover ${fmtDay(f.edrFrom)} to ${fmtDay(f.edrTo)}; the invoice period ${ymd(v.period_from)} to ${ymd(
        v.period_to,
      )} (${v.timezone}) is not fully covered, so it was not compared`,
    ];
  } else {
    const t = sumLines(f.lines);
    input = dayWindow(ymd(v.period_from), ymd(v.period_to), v.timezone as string);
    ourVolume = t.messages;
    ourAmount = t.amount;
    const theirs = await theirLines(c, id);
    const res = evaluateRecon(
      rule,
      {
        theirAmount: Number(v.charge_amount),
        ourAmount: t.amount,
        theirVolume: v.charge_volume === null ? null : Number(v.charge_volume),
        ourVolume: t.messages,
        currency: String(v.currency).trim(),
      },
      destinationFigures(f.lines, theirs),
    );
    comparison = res.match ? "match" : "mismatch";
    reasons = res.reasons;
  }
  const current = v.recon_status as string;
  let next = current;
  if (comparison === "match" && (current === "pending" || current === "disputed")) next = "accepted";
  if (comparison === "mismatch" && current === "pending") next = "disputed";
  let emailStatus = v.email_status as string;
  let emailTo: string[] = [];
  if (next === "accepted" && current !== "accepted") {
    if (rule.autoSend === "confirm") emailStatus = "waiting";
    else {
      emailTo = await billingContacts(c, Number(v.enterprise_id));
      emailStatus = emailTo.length ? "sent" : "failed";
    }
  }
  await c.query(
    `UPDATE vendor_invoices SET comparison = $2, our_volume = $3, our_amount = $4, check_reasons = $5, rule_snapshot = $6,
            checked_at = now(), recon_status = $7, email_status = $8, input_from = $9, input_to = $10,
            email_sent_at = CASE WHEN $8 = 'sent' AND email_status <> 'sent' THEN now() ELSE email_sent_at END,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      comparison,
      ourVolume,
      ourAmount,
      reasons,
      JSON.stringify(rule),
      next,
      emailStatus,
      input?.from ?? null,
      input?.to ?? null,
    ],
  );
  await addEvent(c, id, "checked", {
    statusFrom: next !== current ? current : null,
    statusTo: next !== current ? next : null,
    note: reasons.join("\n"),
    userId,
  });
  if (emailStatus !== v.email_status && (emailStatus === "sent" || emailStatus === "failed")) {
    const mail = emailText("acceptance", { ...v, our_amount: ourAmount, our_volume: ourVolume }, null);
    await logEmail(c, {
      type: "invoice_acceptance",
      enterpriseId: Number(v.enterprise_id),
      to: emailTo,
      sender: await companyMailbox(c, Number(v.enterprise_id), "vendorInvoiceReply"),
      subject: mail.subject,
      body: mail.body,
      error: emailStatus === "failed" ? "No billing contact" : null,
    });
  }
  if (emailStatus !== v.email_status && emailStatus === "sent")
    await addEvent(c, id, "email", { note: "Acceptance sent automatically", emailTo, userId: null });
  if (emailStatus !== v.email_status && emailStatus === "failed")
    await addEvent(c, id, "email", { note: "Acceptance not sent: the partner has no billing contact", userId: null });
  const before = {
    comparison: v.comparison ?? null,
    ourVolume: v.our_volume === null ? null : Number(v.our_volume),
    ourAmount: v.our_amount === null ? null : Number(v.our_amount),
    status: current,
    emailStatus: v.email_status,
  };
  const after = { comparison, ourVolume, ourAmount, status: next, emailStatus };
  return (Object.keys(after) as (keyof typeof after)[])
    .filter((k) => before[k] !== after[k])
    .map((k) => ({ entity_id: id, field: k, before: before[k], after: after[k] }));
}

export function recheckVendorInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadVendorInvoice(pool, id);
    if (!before) return notFound(reply, "Vendor invoice", id);
    if (before.archivedAt) return sendProblem(reply, 400, "Restore the invoice before checking it");
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      const diff = await runCheck(c, id, me.id);
      if (!diff.length) return null;
      return recordChange(c, {
        entityType: "vendor_invoice",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Checked vendor invoice ${before.invoiceNumber} again`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadVendorInvoice(pool, id), change };
  });
}

// ---------------------------------------------------------------- add, edit, import

/** API field → column, for the diff and for undo (§13.10). */
const VI_FIELDS: [string, string][] = [
  ["enterpriseId", "enterprise_id"],
  ["invoiceNumber", "invoice_number"],
  ["chargeVolume", "charge_volume"],
  ["chargeAmount", "charge_amount"],
  ["currency", "currency"],
  ["invoiceDate", "invoice_date"],
  ["dueDate", "due_date"],
  ["periodFrom", "period_from"],
  ["periodTo", "period_to"],
  ["timezone", "timezone"],
  ["remarks", "remarks"],
];
/** Fields that change our figures or the comparison. */
const FIGURE_FIELDS = new Set([
  "enterpriseId",
  "chargeVolume",
  "chargeAmount",
  "currency",
  "periodFrom",
  "periodTo",
  "timezone",
]);

type Resolved = Omit<VendorInvoiceInput, "currency" | "timezone" | "lines"> & { currency: string; timezone: string };

async function resolveInput(
  c: Db,
  b: VendorInvoiceInput,
  exceptId: number,
): Promise<{ errors: FieldError[]; conflict: string | null; v: Resolved | null; partner: string | null }> {
  const errors: FieldError[] = [];
  const { rows } = await c.query(
    `SELECT e.name, e.billing_timezone, vb.currency FROM enterprises e
       LEFT JOIN enterprise_billing vb ON vb.enterprise_id = e.id AND vb.side = 'vendor'
      WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [b.enterpriseId],
  );
  const e = rows[0];
  if (!e) errors.push({ path: "/enterpriseId", message: "enterprise not found" });
  else if (!e.currency) errors.push({ path: "/enterpriseId", message: `${e.name} has no vendor billing settings` });
  const currency = b.currency ?? (e?.currency ? String(e.currency).trim() : null);
  if (b.currency) {
    const { rows: cur } = await c.query("SELECT 1 FROM currencies WHERE iso = $1 AND deleted_at IS NULL", [b.currency]);
    if (!cur[0]) errors.push({ path: "/currency", message: "unknown currency" });
  }
  const timezone = b.timezone ?? (e?.billing_timezone as string | undefined) ?? "UTC";
  if (!isTimezone(timezone)) errors.push({ path: "/timezone", message: "unknown time zone" });
  if (b.periodTo < b.periodFrom) errors.push({ path: "/periodTo", message: "must not be before the From date" });
  if ((Date.parse(b.periodTo) - Date.parse(b.periodFrom)) / 86400_000 > 366)
    errors.push({ path: "/periodTo", message: "at most 366 days" });
  if (b.dueDate && b.dueDate < b.invoiceDate)
    errors.push({ path: "/dueDate", message: "must not be before the invoice date" });
  const seen = new Set<string>();
  (b.lines ?? []).forEach((l, i) => {
    if (seen.has(l.mccmnc)) errors.push({ path: `/lines/${i}/mccmnc`, message: `${l.mccmnc} is listed twice` });
    seen.add(l.mccmnc);
  });
  const number = b.invoiceNumber.trim();
  if (!number) errors.push({ path: "/invoiceNumber", message: "required" });
  let conflict: string | null = null;
  if (e && number) {
    const { rows: dup } = await c.query(
      "SELECT id, deleted_at FROM vendor_invoices WHERE enterprise_id = $1 AND lower(invoice_number) = lower($2) AND id <> $3",
      [b.enterpriseId, number, exceptId],
    );
    if (dup[0])
      conflict = `${e.name} already has invoice ${number} (Info ID ${dup[0].id}${dup[0].deleted_at ? ", deleted" : ""})`;
  }
  if (errors.length || conflict) return { errors, conflict, v: null, partner: e?.name ?? null };
  return {
    errors,
    conflict,
    partner: e.name,
    v: {
      enterpriseId: b.enterpriseId,
      invoiceNumber: number,
      chargeVolume: b.chargeVolume,
      chargeAmount: money(b.chargeAmount),
      currency: currency!,
      invoiceDate: b.invoiceDate,
      dueDate: b.dueDate,
      periodFrom: b.periodFrom,
      periodTo: b.periodTo,
      timezone,
      remarks: b.remarks?.trim() || null,
    },
  };
}

async function insertVendorInvoice(
  c: pg.PoolClient,
  v: Resolved,
  lines: VendorInvoiceInput["lines"],
  source: "manual" | "import" | "email",
  userId: number | null,
): Promise<number> {
  const { rows } = await c.query(
    `INSERT INTO vendor_invoices (${VI_FIELDS.map(([, col]) => col).join(", ")}, recon_status, source, created_by_id, updated_by_id)
     VALUES (${VI_FIELDS.map((_, i) => `$${i + 1}`).join(", ")}, 'pending', $${VI_FIELDS.length + 1}, $${VI_FIELDS.length + 2}, $${
       VI_FIELDS.length + 2
     }) RETURNING id`,
    [...VI_FIELDS.map(([k]) => (v as unknown as Record<string, unknown>)[k]), source, userId],
  );
  const id = Number(rows[0].id);
  await writeLines(c, id, lines ?? []);
  await addEvent(c, id, "created", {
    note:
      source === "email"
        ? "Received at the billing mailbox"
        : source === "import"
          ? "Imported from CSV"
          : "Added by hand",
    userId,
  });
  return id;
}

async function writeLines(c: pg.PoolClient, id: number, lines: NonNullable<VendorInvoiceInput["lines"]>) {
  await c.query("DELETE FROM vendor_invoice_lines WHERE vendor_invoice_id = $1", [id]);
  if (!lines.length) return;
  await c.query(
    `INSERT INTO vendor_invoice_lines (vendor_invoice_id, mccmnc, volume, amount)
     SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::numeric[])`,
    [id, lines.map((l) => l.mccmnc), lines.map((l) => l.volume), lines.map((l) => l.amount)],
  );
}

export function createVendorInvoice(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as VendorInvoiceInput;
  return withDb(reply, async (pool) => {
    const r = await resolveInput(pool, b, 0);
    if (r.errors.some((e) => e.path === "/enterpriseId" && e.message === "enterprise not found"))
      return notFound(reply, "Enterprise", b.enterpriseId);
    if (r.errors.length) return badInput(reply, r.errors);
    if (r.conflict) return sendProblem(reply, 409, r.conflict);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const id = await insertVendorInvoice(c, r.v!, b.lines, "manual", me.id);
      await runCheck(c, id, null);
      const change = await recordChange(c, {
        entityType: "vendor_invoice",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { invoiceNumber: r.v!.invoiceNumber } }],
        note: `Added vendor invoice ${r.v!.invoiceNumber} (${r.partner})`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadVendorInvoice(pool, id), change });
  });
}

export function updateVendorInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as VendorInvoiceInput;
  return withDb(reply, async (pool) => {
    const before = await loadVendorInvoice(pool, id);
    if (!before) return notFound(reply, "Vendor invoice", id);
    if (before.archivedAt) return sendProblem(reply, 400, "Restore the invoice before changing it");
    const r = await resolveInput(pool, b, id);
    if (r.errors.length) return badInput(reply, r.errors);
    if (r.conflict) return sendProblem(reply, 409, r.conflict);
    const v = r.v!;
    const diff: DiffEntry[] = VI_FIELDS.filter(
      ([k]) =>
        ((before as unknown as Record<string, unknown>)[k] ?? null) !==
        ((v as unknown as Record<string, unknown>)[k] ?? null),
    ).map(([k]) => ({
      entity_id: id,
      field: k,
      before: (before as unknown as Record<string, unknown>)[k] ?? null,
      after: (v as unknown as Record<string, unknown>)[k] ?? null,
    }));
    let linesChanged = false;
    if (b.lines) {
      const old = await theirLines(pool, id);
      const next = new Map(b.lines.map((l) => [l.mccmnc, { volume: l.volume, amount: l.amount }]));
      linesChanged =
        old.size !== next.size ||
        [...next].some(([m, l]) => old.get(m)?.amount !== l.amount || (old.get(m)?.volume ?? null) !== l.volume);
      if (linesChanged) diff.push({ entity_id: id, field: "lines", before: old.size, after: next.size }); // history only
    }
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE vendor_invoices SET ${VI_FIELDS.map(([, col], i) => `${col} = $${i + 2}`).join(", ")},
                updated_by_id = $${VI_FIELDS.length + 2}, updated_at = now() WHERE id = $1`,
        [id, ...VI_FIELDS.map(([k]) => (v as unknown as Record<string, unknown>)[k]), me.id],
      );
      if (linesChanged) await writeLines(c, id, b.lines!);
      await addEvent(c, id, "edited", { note: `Changed ${diff.map((d) => d.field).join(", ")}`, userId: me.id });
      const recheck = linesChanged || diff.some((d) => FIGURE_FIELDS.has(d.field));
      const checkDiff = recheck ? await runCheck(c, id, null) : [];
      return recordChange(c, {
        entityType: "vendor_invoice",
        entityIds: [id],
        changeType: "edit",
        diff: [...diff, ...checkDiff],
        note: `Changed vendor invoice ${v.invoiceNumber}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadVendorInvoice(pool, id), change };
  });
}

const IMPORT_COLUMNS = ["enterprise", "invoice_number", "charge_amount", "invoice_date", "period_from", "period_to"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function importVendorInvoices(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as ImportRequest;
  const { header, rows } = parseCsv(body.csv);
  const missing = IMPORT_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length)
    return sendProblem(reply, 400, `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  return withDb(reply, async (pool) => {
    const run = new ImportRun(rows.length);
    const { rows: ents } = await pool.query("SELECT id, name, alias FROM enterprises WHERE deleted_at IS NULL");
    const byKey = new Map<string, number>();
    for (const e of ents) {
      byKey.set(String(e.name).toLowerCase(), Number(e.id));
      byKey.set(String(e.alias).toLowerCase(), Number(e.id));
    }
    const seen = new Map<string, number>();
    const add: Resolved[] = [];
    for (const { line, values } of rows) {
      const key = `${values.enterprise ?? ""} ${values.invoice_number ?? ""}`.trim();
      const enterpriseId = byKey.get((values.enterprise ?? "").trim().toLowerCase());
      if (!enterpriseId) {
        run.error(line, key, `Enterprise "${values.enterprise ?? ""}" not found (name or alias)`);
        continue;
      }
      const amount = Number(values.charge_amount);
      const volume = values.charge_volume?.trim() ? Number(values.charge_volume) : null;
      if (!values.charge_amount?.trim() || !Number.isFinite(amount) || amount < 0) {
        run.error(line, key, "charge_amount must be a number of 0 or more");
        continue;
      }
      if (volume !== null && (!Number.isInteger(volume) || volume < 0)) {
        run.error(line, key, "charge_volume must be a whole number");
        continue;
      }
      const dates = ["invoice_date", "period_from", "period_to", "due_date"] as const;
      const bad = dates.find((d) => values[d]?.trim() && !DATE.test(values[d]!.trim()));
      if (bad || !values.invoice_date?.trim() || !values.period_from?.trim() || !values.period_to?.trim()) {
        run.error(line, key, `${bad ?? "invoice_date, period_from and period_to"}: dates as YYYY-MM-DD`);
        continue;
      }
      const dupKey = `${enterpriseId}:${(values.invoice_number ?? "").trim().toLowerCase()}`;
      if (seen.has(dupKey)) {
        run.error(line, key, `Also on line ${seen.get(dupKey)}`);
        continue;
      }
      seen.set(dupKey, line);
      const r = await resolveInput(
        pool,
        {
          enterpriseId,
          invoiceNumber: values.invoice_number ?? "",
          chargeVolume: volume,
          chargeAmount: amount,
          currency: values.currency?.trim().toUpperCase() || null,
          invoiceDate: values.invoice_date!.trim(),
          dueDate: values.due_date?.trim() || null,
          periodFrom: values.period_from!.trim(),
          periodTo: values.period_to!.trim(),
          timezone: values.timezone?.trim() || null,
          remarks: values.remarks?.trim() || null,
        },
        0,
      );
      if (r.conflict) {
        run.unchanged++;
        run.warn(line, key, `${r.conflict}; left as it is`);
        continue;
      }
      if (r.errors.length) {
        run.error(line, key, r.errors.map((e) => `${e.path.slice(1)} ${e.message}`).join("; "));
        continue;
      }
      add.push(r.v!);
      run.added++;
    }
    const apply = !body.dryRun && run.errors.length === 0 && add.length > 0;
    if (!apply) return run.result(false, body.dryRun, null);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      const ids: number[] = [];
      for (const v of add) {
        const id = await insertVendorInvoice(c, v, [], "import", me.id);
        await runCheck(c, id, null);
        ids.push(id);
      }
      return recordChange(c, {
        entityType: "vendor_invoice",
        entityIds: ids,
        changeType: ids.length > 1 ? "bulk" : "create",
        diff: ids.map((id, i) => ({
          entity_id: id,
          field: "*",
          before: null,
          after: { invoiceNumber: add[i]!.invoiceNumber },
        })),
        note: `Imported ${ids.length} vendor invoice${ids.length === 1 ? "" : "s"}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return run.result(true, false, change);
  });
}

// ---------------------------------------------------------------- decisions and notes

export function decideVendorInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as VendorInvoiceDecision;
  const note = b.note?.trim() || null;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT * FROM vendor_invoices WHERE id = $1", [id]);
    const v = rows[0];
    if (!v) return notFound(reply, "Vendor invoice", id);
    if (v.deleted_at) return sendProblem(reply, 400, "Restore the invoice first");
    const status = v.recon_status as string;
    let next = status;
    let emailKind: "acceptance" | "rejection" | null = null;
    switch (b.action) {
      case "accept":
        if (status === "accepted") return sendProblem(reply, 409, "The invoice is already accepted");
        if (!note && v.comparison !== "match")
          return badInput(reply, [{ path: "/note", message: "say why an invoice that did not match is accepted" }]);
        next = "accepted";
        if (b.sendEmail) emailKind = "acceptance";
        break;
      case "reject":
        if (status === "rejected") return sendProblem(reply, 409, "The invoice is already rejected");
        if (!note) return badInput(reply, [{ path: "/note", message: "a reason is required to reject" }]);
        next = "rejected";
        if (b.sendEmail) emailKind = "rejection";
        break;
      case "keep_pending":
        if (status === "disputed")
          return sendProblem(reply, 409, "The invoice is already kept pending; add a note instead");
        if (!note) return badInput(reply, [{ path: "/note", message: "a note is required to keep it pending" }]);
        next = "disputed";
        break;
      case "send_acceptance":
        if (status !== "accepted")
          return sendProblem(reply, 409, "Only an accepted invoice gets the acceptance e-mail");
        if (v.email_status === "sent") return sendProblem(reply, 409, "The acceptance e-mail was already sent");
        emailKind = "acceptance";
        break;
    }
    const to = emailKind ? await billingContacts(pool, Number(v.enterprise_id)) : [];
    if (emailKind && !to.length)
      return badInput(reply, [
        { path: "/sendEmail", message: "the partner has no billing contact; untick the e-mail" },
      ]);
    const emailStatus = emailKind
      ? "sent"
      : next === "disputed"
        ? v.email_status === "waiting"
          ? "none"
          : v.email_status
        : v.email_status;
    const me = await getCurrentUser();
    const diff: DiffEntry[] = [];
    if (next !== status) diff.push({ entity_id: id, field: "status", before: status, after: next });
    if (emailStatus !== v.email_status)
      diff.push({ entity_id: id, field: "emailStatus", before: v.email_status, after: emailStatus });
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE vendor_invoices SET recon_status = $2, email_status = $3,
                email_sent_at = CASE WHEN $4 THEN now() ELSE email_sent_at END, updated_by_id = $5, updated_at = now()
          WHERE id = $1`,
        [id, next, emailStatus, !!emailKind, me.id],
      );
      if (next !== status) await addEvent(c, id, "status", { statusFrom: status, statusTo: next, note, userId: me.id });
      if (emailKind) {
        const mail = emailText(emailKind, v, note);
        await addEvent(c, id, "email", { note: `${mail.subject}`, emailTo: to, userId: me.id });
        await logEmail(c, {
          type: emailKind === "acceptance" ? "invoice_acceptance" : "invoice_rejection",
          enterpriseId: Number(v.enterprise_id),
          to,
          sender: await companyMailbox(c, Number(v.enterprise_id), "vendorInvoiceReply"),
          subject: mail.subject,
          body: mail.body,
          userId: me.id,
        });
      }
      if (!diff.length) return null;
      const label = {
        accept: "Accepted",
        reject: "Rejected",
        keep_pending: "Kept pending",
        send_acceptance: "Sent acceptance for",
      }[b.action];
      return recordChange(c, {
        entityType: "vendor_invoice",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `${label} vendor invoice ${v.invoice_number}${note ? `: ${note}` : ""}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadVendorInvoice(pool, id), change };
  });
}

export function addVendorInvoiceNote(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { note } = request.body as VendorInvoiceNote;
  if (!note.trim()) return badInput(reply, [{ path: "/note", message: "required" }]);
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM vendor_invoices WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, "Vendor invoice", id);
    const me = await getCurrentUser();
    await addEvent(pool, id, "note", { note: note.trim(), userId: me.id });
    return loadVendorInvoice(pool, id);
  });
}

// ---------------------------------------------------------------- safe delete

async function vendorInvoiceDependencies(c: Db, id: number) {
  const { rows } = await c.query("SELECT recon_status FROM vendor_invoices WHERE id = $1", [id]);
  const accepted = rows[0]?.recon_status === "accepted" ? 1 : 0;
  return dependencies([
    {
      key: "accepted",
      label: "Accepted: counts in the partner's balance and SOA",
      count: accepted,
      blocking: true,
      detail: accepted ? "Reject it or keep it pending first, or override with a reason" : null,
    },
  ]);
}

export function getVendorInvoiceDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM vendor_invoices WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, "Vendor invoice", id);
    return vendorInvoiceDependencies(pool, id);
  });
}

export function archiveVendorInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadVendorInvoice(pool, id);
    if (!before) return notFound(reply, "Vendor invoice", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(
      reply,
      (request.body ?? {}) as ArchiveRequest,
      await vendorInvoiceDependencies(pool, id),
    );
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "vendor_invoices",
      entityType: "vendor_invoice",
      archive: true,
      note: gate.note ?? `Deleted vendor invoice ${before.invoiceNumber}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadVendorInvoice(pool, id), change: r.change };
  });
}

export function restoreVendorInvoice(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadVendorInvoice(pool, id);
    if (!before) return notFound(reply, "Vendor invoice", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This vendor invoice is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "vendor_invoices",
      entityType: "vendor_invoice",
      archive: false,
      note: null,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadVendorInvoice(pool, id), change: r.change };
  });
}

// ---------------------------------------------------------------- monthly summary

export function summariseVendorInvoices(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as VendorInvoiceSummaryInput;
  const months = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
  if (months(b.toMonth) < months(b.fromMonth))
    return badInput(reply, [{ path: "/toMonth", message: "must not be before the From month" }]);
  if (months(b.toMonth) - months(b.fromMonth) >= 36)
    return badInput(reply, [{ path: "/toMonth", message: "at most 36 months" }]);
  const end = months(b.toMonth) + 1;
  const endDay = `${Math.floor(end / 12)}-${String((end % 12) + 1).padStart(2, "0")}-01`;
  return withDb(reply, async (pool): Promise<VendorInvoiceSummary> => {
    const conv = (amount: string) =>
      `${amount} / rate_per_usd_at(v.currency, v.invoice_date::timestamptz) * rate_per_usd_at('${PLATFORM_CURRENCY}', v.invoice_date::timestamptz)`;
    const { rows } = await pool.query(
      `SELECT to_char(v.invoice_date, 'YYYY-MM') AS month, count(*)::int AS invoices,
              count(*) FILTER (WHERE v.comparison = 'match')::int AS match,
              count(*) FILTER (WHERE v.comparison = 'mismatch')::int AS mismatch,
              count(*) FILTER (WHERE v.comparison = 'no_data')::int AS no_data,
              count(*) FILTER (WHERE v.comparison IS NULL)::int AS unchecked,
              count(*) FILTER (WHERE v.recon_status = 'pending')::int AS pending,
              count(*) FILTER (WHERE v.recon_status = 'accepted')::int AS accepted,
              count(*) FILTER (WHERE v.recon_status = 'disputed')::int AS disputed,
              count(*) FILTER (WHERE v.recon_status = 'rejected')::int AS rejected,
              COALESCE(sum(${conv("v.charge_amount")}), 0) AS theirs,
              COALESCE(sum(${conv("v.our_amount")}) FILTER (WHERE v.our_amount IS NOT NULL), 0) AS ours,
              COALESCE(sum(${conv("(v.charge_amount - v.our_amount)")}) FILTER (WHERE v.our_amount IS NOT NULL), 0) AS diff
         FROM vendor_invoices v JOIN enterprises e ON e.id = v.enterprise_id
        WHERE v.deleted_at IS NULL AND v.invoice_date >= $1::date AND v.invoice_date < $2::date
          AND ($3::bigint IS NULL OR v.enterprise_id = $3) AND ($4::bigint IS NULL OR e.account_manager_id = $4)
        GROUP BY 1 ORDER BY 1 DESC`,
      [`${b.fromMonth}-01`, endDay, b.enterpriseId, b.accountManagerId],
    );
    return {
      platformCurrency: PLATFORM_CURRENCY,
      rows: rows.map((r) => ({
        month: r.month,
        invoices: r.invoices,
        match: r.match,
        mismatch: r.mismatch,
        noData: r.no_data,
        unchecked: r.unchecked,
        pending: r.pending,
        accepted: r.accepted,
        disputed: r.disputed,
        rejected: r.rejected,
        theirAmount: money(Number(r.theirs)),
        ourAmount: money(Number(r.ours)),
        difference: money(Number(r.diff)),
      })),
    };
  });
}

// ---------------------------------------------------------------- simulated billing mailbox

/** Deterministic 0..1 from a string, so the simulated invoices are the same on every run. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

function isoWeek(day: string): { year: number; week: number } {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { year, week };
}

/**
 * Simulates invoices arriving at the billing mailbox (§13.31 "Receiving invoices"): about 30 % of
 * vendors invoice weekly (Monday to Sunday in their billing time zone). For every week the EDR
 * store fully holds, the partner's figures are ours with a small, seeded difference (one in five
 * off by 2–8 %); a third of them come with per-destination lines. Each is then checked like any
 * other invoice. Returns how many arrived.
 */
export async function receiveSimulatedInvoices(): Promise<number> {
  const pool = db();
  const cov = await edrCoverage();
  if (!cov?.from || !cov.to) return 0;
  const { rows: vendors } = await pool.query(
    `SELECT e.id, e.alias, e.billing_timezone, vb.currency FROM enterprises e
       JOIN enterprise_billing vb ON vb.enterprise_id = e.id AND vb.side = 'vendor'
      WHERE e.deleted_at IS NULL AND e.id % 10 < 3 ORDER BY e.id`,
  );
  const first = new Date(cov.from.getTime() - 7 * 86400_000);
  const monday = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  let received = 0;
  for (const ven of vendors) {
    const tz = ven.billing_timezone as string;
    const currency = String(ven.currency).trim();
    for (let m = new Date(monday); m.getTime() < cov.to.getTime(); m.setUTCDate(m.getUTCDate() + 7)) {
      const from = m.toISOString().slice(0, 10);
      const to = new Date(m.getTime() + 6 * 86400_000).toISOString().slice(0, 10);
      const invoiceDate = nextDay(nextDay(to));
      if (invoiceDate > today() || coverageOf(cov, from, to, tz) !== "full") continue;
      const { rows: has } = await pool.query(
        "SELECT 1 FROM vendor_invoices WHERE enterprise_id = $1 AND period_from = $2 AND period_to = $3",
        [ven.id, from, to],
      );
      if (has[0]) continue;
      const lines = await usageLines(pool, "vendor", Number(ven.id), from, to, tz, currency, false);
      if (!lines) return received;
      const total = sumLines(lines);
      if (total.messages === 0) continue;
      const h = hash01(`${ven.id}:${from}`);
      const off =
        h < 0.8
          ? (hash01(`${ven.id}:${from}:a`) - 0.5) * 0.006
          : (0.02 + hash01(`${ven.id}:${from}:b`) * 0.06) * (h < 0.95 ? 1 : -1);
      const withLines = Number(ven.id) % 3 === 0;
      const { week, year } = isoWeek(from);
      const number = `${String(ven.alias).slice(0, 3).toUpperCase()}-${year}W${String(week).padStart(2, "0")}`;
      await inTransaction(pool, async (c) => {
        const id = await insertVendorInvoice(
          c,
          {
            enterpriseId: Number(ven.id),
            invoiceNumber: number,
            chargeVolume: Math.round(total.messages * (1 + off * 0.8)),
            chargeAmount: money(total.amount * (1 + off)),
            currency,
            invoiceDate,
            dueDate: nextDay(new Date(Date.parse(invoiceDate) + 14 * 86400_000).toISOString().slice(0, 10)),
            periodFrom: from,
            periodTo: to,
            timezone: tz,
            remarks: null,
          },
          withLines
            ? lines.map((l) => ({
                mccmnc: l.mccmnc,
                volume: Math.round(l.messages * (1 + off * 0.8)),
                amount: Math.round(l.amount * (1 + off) * 10000) / 10000,
              }))
            : [],
          "email",
          null,
        );
        await runCheck(c, id, null);
      });
      received++;
    }
  }
  return received;
}

/** Checks the mailbox shortly after start and every six hours. */
export function startReconIntake() {
  const tick = () => void receiveSimulatedInvoices().catch(() => undefined);
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 6 * 3600_000).unref();
}
