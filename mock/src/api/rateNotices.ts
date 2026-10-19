// Customer rate notifications on save (team trial round 1, "send RN" ticked by default): after a rating
// change on customer tables, each customer using a changed table gets one e-mail to its rates contact
// (commercial when it has none), from its business company's rates mailbox, listing the changed lines.
// E-mails are logged in Email logs (type send_rate), never sent, in this phase (§8).
import type pg from "pg";
import type { DiffEntry } from "./records.js";
import { companyMailbox, logEmail } from "./emailLog.js";

type Db = pg.Pool | pg.PoolClient;
interface Snap {
  tableId: number;
  mccmnc: string;
  senderId: string | null;
  rate: number;
  currency: string;
  from: string;
  to: string | null;
  blocked: boolean;
}

/** One line per destination of the e-mail: the new rate and since when, or closed / blocked. */
export function noticeLines(diff: DiffEntry[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const d of diff) {
    const a = d.after as Snap | null;
    const b = d.before as Snap | null;
    const s = a ?? b;
    if (!s) continue;
    let text: string | null = null;
    if (a && !b) text = `${a.rate} ${a.currency.trim()} from ${a.from.slice(0, 10)}`;
    else if (a && b && a.blocked !== b.blocked) text = a.blocked ? "blocked" : "unblocked";
    else if (a && b && a.to && !b.to && a.to.slice(0, 16) !== a.from.slice(0, 16)) {
      // An old version ended because a new one starts: the new line says it.
      if (diff.some((x) => x !== d && !x.before && (x.after as Snap | null)?.mccmnc === a.mccmnc)) continue;
      text = `closed from ${a.to.slice(0, 10)}`;
    } else if (!a && b) text = "scheduled rate withdrawn";
    if (!text) continue;
    const line = `${s.mccmnc}${s.senderId ? ` (sender ${s.senderId})` : ""}: ${text}`;
    out.set(s.tableId, [...(out.get(s.tableId) ?? []), line]);
  }
  return out;
}

/** Logs the notifications; returns how many e-mails were written (customer tables only). */
export async function sendRateNotices(db: Db, diff: DiffEntry[], userId: number): Promise<number> {
  const byTable = noticeLines(diff);
  if (!byTable.size) return 0;
  const { rows } = await db.query(
    `SELECT rt.id AS table_id, rt.name AS table_name, e.id AS enterprise_id, e.name AS enterprise_name,
            array_agg(DISTINCT ct.name ORDER BY ct.name) AS trunks,
            (SELECT c.emails FROM enterprise_contacts c WHERE c.enterprise_id = e.id AND c.contact_type IN ('rates', 'commercial')
              ORDER BY c.contact_type = 'rates' DESC LIMIT 1) AS emails
       FROM rate_tables rt
       JOIN customer_trunk_rate_tables ctr ON ctr.rate_table_id = rt.id
       JOIN customer_trunks ct ON ct.id = ctr.customer_trunk_id AND ct.deleted_at IS NULL AND ct.status = 'active'
       JOIN enterprises e ON e.id = ct.enterprise_id AND e.deleted_at IS NULL
      WHERE rt.id = ANY($1) AND rt.kind = 'customer'
      GROUP BY rt.id, e.id`,
    [[...byTable.keys()]],
  );
  let sent = 0;
  for (const r of rows) {
    const lines = byTable.get(Number(r.table_id)) ?? [];
    const sender = await companyMailbox(db, Number(r.enterprise_id), "rateSheet");
    await logEmail(db, {
      type: "send_rate",
      enterpriseId: Number(r.enterprise_id),
      to: (r.emails as string[] | null) ?? [],
      sender,
      subject: `Rate notification – ${r.table_name} – ${lines.length} change${lines.length === 1 ? "" : "s"}`,
      body: [
        `Dear ${r.enterprise_name},`,
        "",
        `Please note the following rate changes for ${(r.trunks as string[]).join(", ")}:`,
        "",
        ...lines.slice(0, 500),
        ...(lines.length > 500 ? [`… and ${lines.length - 500} more (see the attached sheet).`] : []),
        "",
        "Rates are per message submitted, in the table currency.",
      ].join("\n"),
      file: `${String(r.table_name).replace(/[^\w.-]+/g, "_")}_rates.xlsx`,
      rateDate: new Date().toISOString().slice(0, 10),
      userId,
    });
    sent++;
  }
  return sent;
}
