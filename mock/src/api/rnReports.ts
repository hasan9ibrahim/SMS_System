// RN report (team trial round 7, §8, §13.10): every rate notification send, from a rate table save or a bulk rating
// (rateNotices.ts saveRnReport). A send with one e-mail shows that e-mail in its row; a bulk send shows its totals and
// opens as the report shown after the send, one line per enterprise and rate table.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateNoticeOutcome, RnReport, RnReportRow } from "@sms/contract";
import { withDb } from "../db.js";
import { listFields } from "../lists/fields.js";
import type { ListDef } from "../lists/engine.js";
import { notFound } from "./masterData.js";

const STATUS = "CASE WHEN r.failed_count = 0 THEN 'sent' WHEN r.sent_count = 0 THEN 'failed' ELSE 'partial' END";
const FROM = "rn_reports r LEFT JOIN users u ON u.id = r.user_id";
const SELECT = `r.id, r.sent_at, u.username AS sent_by, r.source, r.change_id, r.note, r.notice_count, r.sent_count,
  r.failed_count, ${STATUS} AS status, r.enterprise_names, r.rate_table_names, r.trunk_names, r.to_addresses,
  CASE WHEN r.notice_count = 1 THEN r.notices -> 0 ->> 'reason' END AS reason`;

/** A bulk send's row summarises: "12 enterprises", "4 rate tables". */
const count = (list: string, word: string) => {
  const n = list ? list.split(", ").length : 0;
  return n === 1 ? list : `${n} ${word}`;
};

function mapRow(r: Record<string, unknown>): RnReportRow {
  const single = Number(r.notice_count) === 1;
  const ents = String(r.enterprise_names ?? "");
  const tables = String(r.rate_table_names ?? "");
  const trunks = String(r.trunk_names ?? "");
  const to = String(r.to_addresses ?? "");
  return {
    id: Number(r.id),
    sentAt: new Date(r.sent_at as string).toISOString(),
    sentBy: (r.sent_by as string | null) ?? null,
    source: r.source as RnReportRow["source"],
    changeId: r.change_id === null ? null : Number(r.change_id),
    noticeCount: Number(r.notice_count),
    sent: Number(r.sent_count),
    failed: Number(r.failed_count),
    status: r.status as RnReportRow["status"],
    enterprise: single ? ents : count(ents, "enterprises"),
    rateTable: single ? tables : count(tables, "rate tables"),
    trunks: single ? trunks : count(trunks, "trunks"),
    to: single ? to : count(to, "addresses"),
    reason: (r.reason as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

export const rnReportList: ListDef<RnReportRow> = {
  fields: listFields.rn_reports,
  from: FROM,
  columns: {
    id: { sql: "r.id" },
    sentAt: { sql: "r.sent_at" },
    source: { sql: "r.source" },
    // Filters on names match any e-mail of the send (a bulk send is found by one of its enterprises).
    enterprise: { sql: "r.enterprise_names" },
    rateTable: { sql: "r.rate_table_names" },
    trunks: { sql: "r.trunk_names" },
    to: { sql: "r.to_addresses" },
    noticeCount: { sql: "r.notice_count" },
    sent: { sql: "r.sent_count" },
    failed: { sql: "r.failed_count" },
    status: { sql: STATUS },
    sentBy: { sql: "u.username" },
    changeId: { sql: "r.change_id" },
    note: { sql: "r.note" },
  },
  search: ["enterprise", "rateTable", "trunks", "to"],
  idSql: "r.id",
  select: SELECT,
  mapRow,
};

export function getRnReport(request: FastifyRequest, reply: FastifyReply) {
  const id = Number((request.params as { id: string }).id);
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(`SELECT ${SELECT}, r.notices FROM ${FROM} WHERE r.id = $1`, [id]);
    if (!rows[0]) return notFound(reply, "RN send", id);
    return { ...mapRow(rows[0]), notices: rows[0].notices as RateNoticeOutcome[] } satisfies RnReport;
  });
}
