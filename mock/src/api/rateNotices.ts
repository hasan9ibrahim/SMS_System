// Customer rate notifications on save (team trial round 1, "send RN" ticked by default): after a rating
// change on customer tables, each customer using a changed table gets one e-mail to its rates contact
// (commercial when it has none), from its business company's rates mailbox, listing the changed rates.
// E-mails are logged in Email logs (type send_rate) and, in production, sent with every change line attached (§8).
// Team trial round 2: dates and times in the platform time zone (24-hour), country rates written the
// client's "all networks" way, and the note typed on the save at the top.
import type pg from "pg";
import type { DiffEntry } from "./records.js";
import { companyMailbox, logEmail } from "./emailLog.js";
import { fromCountryCode, type AllNetworks } from "../rn/parse.js";
import { PLATFORM_TIMEZONE, platformDateTime } from "../platform.js";
import { fillFileName, nowValues } from "../billing/fileNames.js";

const csvLine = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

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

export interface NoticeLine {
  mccmnc: string;
  senderId: string | null;
  text: string;
}

/** One line per destination of the e-mail: the new rate and since when, or closed / blocked. */
export function noticeLines(diff: DiffEntry[]): Map<number, NoticeLine[]> {
  const out = new Map<number, NoticeLine[]>();
  for (const d of diff) {
    const a = d.after as Snap | null;
    const b = d.before as Snap | null;
    const s = a ?? b;
    if (!s) continue;
    let text: string | null = null;
    if (a && !b) text = `${a.rate} ${a.currency.trim()} from ${platformDateTime(a.from)}`;
    else if (a && b && a.blocked !== b.blocked) text = a.blocked ? "blocked" : "unblocked";
    else if (a && b && a.to && !b.to && a.to.slice(0, 16) !== a.from.slice(0, 16)) {
      // An old version ended because a new one starts: the new line says it.
      if (diff.some((x) => x !== d && !x.before && (x.after as Snap | null)?.mccmnc === a.mccmnc)) continue;
      text = `closed from ${platformDateTime(a.to)}`;
    } else if (!a && b) text = "scheduled rate withdrawn";
    if (!text) continue;
    out.set(s.tableId, [...(out.get(s.tableId) ?? []), { mccmnc: s.mccmnc, senderId: s.senderId, text }]);
  }
  return out;
}

/** The line as the client reads it: its own "all networks" code for country rates. */
export const noticeText = (l: NoticeLine, conv: AllNetworks | null) =>
  `${fromCountryCode(l.mccmnc, conv)}${l.senderId ? ` (sender ${l.senderId})` : ""}: ${l.text}`;

/** One notification e-mail and how it went (team trial round 6, §8): the page lists who got it and who did not. */
export type NoticeOutcome = {
  enterpriseId: number;
  enterprise: string;
  rateTable: string;
  trunks: string[];
  to: string[];
  status: "sent" | "failed";
  reason: string | null;
};

/**
 * Logs the notifications (customer tables only), one e-mail per enterprise and table; returns each e-mail's outcome.
 * The send is kept for the RN report (team trial round 7) when `report` says where it came from.
 */
export async function sendRateNotices(
  db: Db,
  diff: DiffEntry[],
  userId: number,
  note?: string | null,
  report?: { source: "rate_table" | "bulk_rating"; changeId: number | null },
): Promise<NoticeOutcome[]> {
  const byTable = noticeLines(diff);
  if (!byTable.size) return [];
  const { rows } = await db.query(
    `SELECT rt.id AS table_id, rt.name AS table_name, rt.currency, e.id AS enterprise_id, e.name AS enterprise_name,
            e.all_networks_code, e.alias, e.billing_timezone, bc.name AS company, bc.customer_rate_file_name,
            array_agg(DISTINCT ct.name ORDER BY ct.name) AS trunks,
            string_agg(DISTINCT pc.name, '-' ORDER BY pc.name) AS categories,
            (SELECT c.emails FROM enterprise_contacts c WHERE c.enterprise_id = e.id AND c.contact_type IN ('rates', 'commercial')
              ORDER BY c.contact_type = 'rates' DESC LIMIT 1) AS emails
       FROM rate_tables rt
       JOIN customer_trunk_rate_tables ctr ON ctr.rate_table_id = rt.id
       JOIN customer_trunks ct ON ct.id = ctr.customer_trunk_id AND ct.deleted_at IS NULL AND ct.status = 'active'
       JOIN enterprises e ON e.id = ct.enterprise_id AND e.deleted_at IS NULL
       JOIN business_companies bc ON bc.id = e.business_company_id
       LEFT JOIN product_categories pc ON pc.id = ct.product_category_id
      WHERE rt.id = ANY($1) AND rt.kind = 'customer'
      GROUP BY rt.id, e.id, bc.id`,
    [[...byTable.keys()]],
  );
  const out: NoticeOutcome[] = [];
  const { rows: who } = await db.query("SELECT username FROM users WHERE id = $1", [userId]);
  for (const r of rows) {
    const lines = (byTable.get(Number(r.table_id)) ?? []).map((l) => noticeText(l, r.all_networks_code as AllNetworks));
    const extra = note?.trim();
    const sender = await companyMailbox(db, Number(r.enterprise_id), "rateSheet");
    // The business company's Customer Rate File Name (team trial round 12, src/billing/fileNames.ts).
    const file = fillFileName(
      r.customer_rate_file_name,
      {
        ...nowValues((who[0]?.username as string) ?? null),
        company: r.company,
        enterpriseName: r.enterprise_name,
        enterpriseAlias: r.alias,
        currency: String(r.currency ?? "").trim(),
        timezone: r.billing_timezone,
        trunk: (r.trunks as string[]).join("-"),
        productCategoryName: r.categories,
        rateTable: r.table_name,
      },
      `${String(r.table_name).replace(/[^\w.-]+/g, "_")}_rates`,
      "csv",
    );
    const to = (r.emails as string[] | null) ?? [];
    const status = await logEmail(db, {
      type: "send_rate",
      enterpriseId: Number(r.enterprise_id),
      to,
      sender,
      subject: `Rate notification – ${r.table_name} – ${lines.length} change${lines.length === 1 ? "" : "s"}`,
      body: [
        `Dear ${r.enterprise_name},`,
        "",
        `Please note the following rate changes for ${(r.trunks as string[]).join(", ")}:`,
        "",
        ...(extra ? [extra, ""] : []),
        ...lines.slice(0, 500),
        ...(lines.length > 500 ? [`… and ${lines.length - 500} more (see the attached sheet).`] : []),
        "",
        `Rates are per message submitted, in the table currency. Dates and times are ${PLATFORM_TIMEZONE} (24-hour).`,
      ].join("\n"),
      file,
      attachments: [{ fileName: file, contentType: "text/csv", content: `Change\n${lines.map(csvLine).join("\n")}\n` }],
      rateDate: new Date().toISOString().slice(0, 10),
      userId,
    });
    out.push({
      enterpriseId: Number(r.enterprise_id),
      enterprise: String(r.enterprise_name),
      rateTable: String(r.table_name),
      trunks: r.trunks as string[],
      to,
      status,
      reason: status === "failed" ? "No rates or commercial contact e-mail for this enterprise" : null,
    });
  }
  if (report && out.length) await saveRnReport(db, out, userId, report.source, report.changeId, note ?? null);
  return out;
}

const distinct = (xs: string[]) => [...new Set(xs)].join(", ");

/** One row of the RN report (team trial round 7): the send's e-mails and the summary its list filters on. */
export async function saveRnReport(
  db: Db,
  notices: NoticeOutcome[],
  userId: number | null,
  source: "rate_table" | "bulk_rating",
  changeId: number | null,
  note: string | null,
  sentAt: Date = new Date(),
): Promise<void> {
  const sent = notices.filter((n) => n.status === "sent").length;
  await db.query(
    `INSERT INTO rn_reports (sent_at, user_id, source, change_id, note, notices, notice_count, sent_count, failed_count,
                             enterprise_names, rate_table_names, trunk_names, to_addresses)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      sentAt,
      userId,
      source,
      changeId,
      note?.trim() || null,
      JSON.stringify(notices),
      notices.length,
      sent,
      notices.length - sent,
      distinct(notices.map((n) => n.enterprise)),
      distinct(notices.map((n) => n.rateTable)),
      distinct(notices.flatMap((n) => n.trunks)),
      distinct(notices.flatMap((n) => n.to)),
    ],
  );
}
