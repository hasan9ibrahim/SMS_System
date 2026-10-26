// Credit Alert and Balance Alert e-mails (§5.1, §7, Q22; backend step 11) from the switch's `sms.billing.credit_alert`
// events (backend/apps/sms_switch/lib/sms/switch/pipeline/ledger/alerts.ex). The switch decides the level once per
// account; this sends the e-mail:
//   * a customer (credit limit reached a level, or prepaid used up): its finance contacts (else commercial), with its
//     business company's Low Balance template, when Credit Alert is on;
//   * a prepaid vendor (our funds with it used): our own billing mailbox (the business company's), with the vendor's
//     account manager in CC, so the team tops up the balance. It never goes to the vendor.
import type pg from "pg";
import { fillBody, fillText } from "../email/html.js";
import { companyDetails, companyMailbox, companyPlaceholders, companyTemplate, logEmail } from "../api/emailLog.js";
import { billingContacts } from "../api/finance.js";

type Db = pg.Pool | pg.PoolClient;

export interface CreditAlertData {
  enterprise_id?: number;
  side?: string;
  level?: string;
  balance?: string;
  credit_limit?: string;
  currency?: string;
}

const LEVEL_TEXT: Record<string, string> = {
  notice: "Notice",
  warning: "Warning",
  critical: "Critical",
  limit_reached: "Credit limit reached",
  used_up: "Balance used up",
};

const money = (v: string | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Sends (logs) the e-mail of one alert; returns its status, or null when the alert needs none. */
export async function sendCreditAlert(c: Db, raw: Record<string, unknown>): Promise<"sent" | "failed" | null> {
  const a = raw as CreditAlertData;
  const enterpriseId = Number(a.enterprise_id);
  if (!enterpriseId) return null;
  const vendor = a.side === "vendor";
  const { rows } = await c.query(
    `SELECT e.name, e.credit_alert FROM enterprises e WHERE e.id = $1`,
    [enterpriseId],
  );
  const e = rows[0];
  if (!e) return null;
  // Credit Alert off on the partner: the switch only alerts accounts that have it, but it may have been switched off
  // since.
  if (!vendor && e.credit_alert === false) return null;
  const level = LEVEL_TEXT[a.level ?? ""] ?? a.level ?? "";
  const vars: Record<string, string> = {
    ...companyPlaceholders(await companyDetails(c, { enterpriseId })),
    enterprise: String(e.name ?? ""),
    balance: money(a.balance),
    threshold: a.credit_limit && Number(a.credit_limit) > 0 ? money(a.credit_limit) : level,
    currency: a.currency ?? "",
    level,
  };
  const sender = await companyMailbox(c, enterpriseId, "invoice");
  if (vendor) {
    // Our own billing mailbox (business company); the AM is copied by logEmail (product owner 2026-10-26).
    const to = sender ? [sender] : [];
    const subject = `Vendor balance ${level.toLowerCase()} – ${vars.enterprise}`;
    const body =
      `<p>Our prepaid balance with <b>${escapeHtml(vars.enterprise!)}</b> reached <b>${escapeHtml(level)}</b>.</p>` +
      `<p>Balance now: ${vars.balance} ${escapeHtml(vars.currency!)}. Traffic is not stopped (Q22); top up the balance ` +
      `to keep sending.</p>`;
    return logEmail(c, { type: "balance_alert", enterpriseId, to, sender, subject, body });
  }
  const tpl = await companyTemplate(c, { enterpriseId }, "low_balance");
  const subject = tpl ? fillText(tpl.subject, vars) : `Credit alert (${level}) – ${vars.enterprise}`;
  const body = tpl
    ? fillBody(tpl.body, vars)
    : `<p>Your balance is ${vars.balance} ${escapeHtml(vars.currency!)} (${escapeHtml(level)}).</p>`;
  const to = await billingContacts(c, enterpriseId);
  return logEmail(c, { type: "credit_alert", enterpriseId, to, sender, subject, body });
}
