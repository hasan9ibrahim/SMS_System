// RN reminders (§13.13 A "Reminder alerts when a flagged RN is still pending near its effective date"; backend step
// 11): once a flagged RN that nobody decided yet comes within the RN settings' Reminder days of its effective date, one
// e-mail goes to the vendor's account manager and the vendor's business company's Rates mailbox, with the RN's
// reference, vendor, trunk, flags and date, so it is decided before the new rates apply. Once per RN.
import type pg from "pg";
import { db } from "../db.js";
import { companyMailbox, logEmail } from "../api/emailLog.js";
import { platformDateTime } from "../platform.js";

/** One round: e-mails every RN that just came due; returns how many. */
export async function sendRnReminders(pool: pg.Pool = db()): Promise<number> {
  const { rows } = await pool.query(
    `SELECT n.id, n.reference, n.vendor_id, n.effective_from, n.flagged, n.increases, n.notice_breaches, n.backdated,
            e.name AS vendor, t.name AS trunk, u.email AS am_email
       FROM rate_notifications n
       JOIN enterprises e ON e.id = n.vendor_id
       LEFT JOIN vendor_trunks t ON t.id = n.vendor_trunk_id
       LEFT JOIN users u ON u.id = e.account_manager_id
       CROSS JOIN (SELECT reminder_days FROM rn_settings LIMIT 1) g
      WHERE n.status = 'pending' AND n.flagged > 0 AND n.reminded_at IS NULL AND n.effective_from IS NOT NULL
        AND n.effective_from <= now() + make_interval(days => g.reminder_days)
      ORDER BY n.effective_from LIMIT 200`,
  );
  let sent = 0;
  for (const r of rows) {
    const enterpriseId = Number(r.vendor_id);
    const sender = await companyMailbox(pool, enterpriseId, "rnReply");
    const to = [...new Set([r.am_email as string | null, sender].filter((x): x is string => !!x))];
    const when = platformDateTime(r.effective_from as Date);
    const flags = [
      Number(r.increases) ? `${r.increases} increase(s) on live traffic` : null,
      Number(r.notice_breaches) ? `${r.notice_breaches} notice breach(es)` : null,
      Number(r.backdated) ? `${r.backdated} back-dated line(s)` : null,
    ].filter(Boolean);
    await logEmail(pool, {
      type: "rn_reminder",
      enterpriseId,
      to,
      sender,
      subject: `RN ${r.reference} from ${r.vendor} is still pending – effective ${when}`,
      body: [
        `The rate notification ${r.reference} from ${r.vendor}${r.trunk ? ` (${r.trunk})` : ""} has ${r.flagged} flagged line(s)`,
        flags.length ? ` (${flags.join(", ")})` : "",
        ` and nobody has accepted or rejected it yet. Its rates take effect on ${when}.`,
        "\n\nOpen Incoming RNs to review it.",
      ].join(""),
    });
    await pool.query("UPDATE rate_notifications SET reminded_at = now() WHERE id = $1", [r.id]);
    sent++;
  }
  return sent;
}

/** Every 15 minutes on the server that runs the jobs. */
export function startRnReminders() {
  const tick = () => void sendRnReminders().catch((err: Error) => console.warn(`RN reminders: ${err.message}`));
  setTimeout(tick, 90_000).unref();
  setInterval(tick, 15 * 60_000).unref();
}
