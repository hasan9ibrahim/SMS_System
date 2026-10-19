// Server-side lists for incoming vendor rate notifications (§13.13 A, §13.32): the RN queue and the
// lines of one RN (flagged first). The SELECT / FROM / mapRow parts are shared with api/rn.ts.
import type { RnLineRow, RnRow } from "@sms/contract";
import type { ListDef } from "./engine.js";
import { listFields } from "./fields.js";
import { byEnterprise, lit, maskName, visCol } from "../visibility/sql.js";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const str = (v: unknown) => (v as string | null) ?? null;
const num = (v: unknown) => (v == null ? null : Number(v));

const DUE_SQL = `(n.status = 'pending' AND n.flagged > 0 AND n.effective_from IS NOT NULL
  AND n.effective_from < now() + make_interval(days => (SELECT s.reminder_days FROM rn_settings s WHERE s.id = 1)))`;

export const RN_FROM = `rate_notifications n
  LEFT JOIN enterprises ve ON ve.id = n.vendor_id
  LEFT JOIN vendor_trunks vt ON vt.id = n.vendor_trunk_id
  LEFT JOIN rate_tables rt ON rt.id = n.rate_table_id
  LEFT JOIN users du ON du.id = n.decided_by_id`;
export const RN_SELECT = `n.*, ve.name AS vendor, vt.name AS vendor_trunk, rt.name AS rate_table, du.username AS decided_by,
  ${DUE_SQL} AS due_soon`;

export function mapRn(r: Record<string, unknown>): RnRow {
  return {
    id: Number(r.id),
    reference: r.reference as string,
    vendorId: num(r.vendor_id),
    vendor: str(r.vendor),
    vendorTrunkId: num(r.vendor_trunk_id),
    vendorTrunk: str(r.vendor_trunk),
    rateTableId: num(r.rate_table_id),
    rateTable: str(r.rate_table),
    currency: str(r.currency),
    source: r.source as RnRow["source"],
    mailbox: str(r.mailbox),
    fromAddress: str(r.from_address),
    subject: str(r.subject),
    fileName: str(r.file_name),
    receivedAt: iso(r.received_at)!,
    effectiveFrom: iso(r.effective_from),
    lines: Number(r.lines),
    newLines: Number(r.new_lines),
    increases: Number(r.increases),
    decreases: Number(r.decreases),
    unchanged: Number(r.unchanged),
    closed: Number(r.closed),
    errors: Number(r.errors),
    flagged: Number(r.flagged),
    noticeBreaches: Number(r.notice_breaches),
    backdated: Number(r.backdated),
    turnsNegative: Number(r.turns_negative),
    status: r.status as RnRow["status"],
    autoAccepted: r.auto_accepted as boolean,
    dueSoon: !!r.due_soon,
    decidedBy: str(r.decided_by),
    decidedAt: iso(r.decided_at),
    updatedAt: iso(r.updated_at)!,
  };
}

export const rnList: ListDef<RnRow> = {
  fields: listFields.rate_notifications,
  from: RN_FROM,
  columns: {
    id: { sql: "n.id" },
    reference: { sql: "n.reference" },
    // AM visibility (§13.17): others' vendors appear as IDs.
    vendor: visCol(maskName("ve.name", "ve.id", byEnterprise("ve.id"), lit("Vendor"))),
    vendorTrunk: visCol(maskName("vt.name", "vt.id", byEnterprise("vt.enterprise_id"), lit("Vendor trunk"))),
    receivedAt: { sql: "n.received_at" },
    effectiveFrom: { sql: "n.effective_from" },
    lines: { sql: "n.lines" },
    flagged: { sql: "n.flagged" },
    noticeBreaches: { sql: "n.notice_breaches" },
    backdated: { sql: "n.backdated" },
    increases: { sql: "n.increases" },
    decreases: { sql: "n.decreases" },
    newLines: { sql: "n.new_lines" },
    closed: { sql: "n.closed" },
    errors: { sql: "n.errors" },
    turnsNegative: { sql: "n.turns_negative" },
    status: { sql: "n.status" },
    dueSoon: { sql: DUE_SQL },
    source: { sql: "n.source" },
    fromAddress: { sql: "n.from_address" },
    subject: { sql: "n.subject" },
    fileName: { sql: "n.file_name" },
    autoAccepted: { sql: "n.auto_accepted" },
    decidedBy: { sql: "du.username" },
    decidedAt: { sql: "n.decided_at" },
    vendorId: { sql: "n.vendor_id" },
    vendorTrunkId: { sql: "n.vendor_trunk_id" },
  },
  search: ["reference", "vendor", "vendorTrunk", "subject", "fileName", "fromAddress"],
  idSql: "n.id",
  select: RN_SELECT,
  mapRow: mapRn,
};

const CHANGE_PCT_SQL = `(CASE WHEN l.current_rate > 0 AND l.new_rate IS NOT NULL
  THEN round((l.new_rate - l.current_rate) / l.current_rate * 100, 1) END)`;
const NOTICE_GIVEN_SQL = "greatest(0, floor(extract(epoch FROM (l.stated_from - n.received_at)) / 86400))::int";

export const RN_LINE_FROM = `rate_notification_lines l JOIN rate_notifications n ON n.id = l.rn_id
  LEFT JOIN mccmnc m ON m.id = l.mccmnc_id LEFT JOIN countries co ON co.id = m.country_id`;
export const RN_LINE_SELECT = `l.*, n.currency, m.network, co.name AS country, ${CHANGE_PCT_SQL} AS change_pct,
  ${NOTICE_GIVEN_SQL} AS notice_given`;

export function mapRnLine(r: Record<string, unknown>): RnLineRow {
  const cur = num(r.current_rate);
  const next = num(r.new_rate);
  return {
    id: Number(r.id),
    rnId: Number(r.rn_id),
    lineNo: Number(r.line_no),
    mccmnc: r.mccmnc as string,
    country: str(r.country),
    network: str(r.network),
    senderId: str(r.sender_id),
    currentRate: cur,
    newRate: next,
    currency: (r.currency as string | null) ?? "",
    change: r.change_type as RnLineRow["change"],
    changeAmount: cur !== null && next !== null ? Math.round((next - cur) * 1e6) / 1e6 : null,
    changePct: num(r.change_pct),
    statedFrom: iso(r.stated_from)!,
    appliedFrom: iso(r.applied_from)!,
    noticeDaysGiven: Number(r.notice_given ?? 0),
    liveTraffic: r.live_traffic as boolean,
    flagged: r.flagged as boolean,
    noticeBreach: r.notice_breach as boolean,
    backdated: r.backdated as boolean,
    traffic1h: Number(r.traffic_1h),
    traffic24h: Number(r.traffic_24h),
    traffic7d: Number(r.traffic_7d),
    sentBetween: Number(r.sent_between),
    costBetween: Number(r.cost_between),
    affectedCustomers: str(r.affected_customers),
    marginNowPct: num(r.margin_now_pct),
    marginNewPct: num(r.margin_new_pct),
    turnsNegative: r.turns_negative as boolean,
    decision: r.decision as RnLineRow["decision"],
    rejectReason: str(r.reject_reason),
  };
}

export const rnLineList: ListDef<RnLineRow> = {
  fields: listFields.rate_notification_lines,
  from: RN_LINE_FROM,
  columns: {
    id: { sql: "l.id" },
    rnId: { sql: "l.rn_id" },
    lineNo: { sql: "l.line_no" },
    country: { sql: "co.name" },
    network: { sql: "m.network" },
    mccmnc: { sql: "l.mccmnc" },
    senderId: { sql: "l.sender_id" },
    change: { sql: "l.change_type" },
    currentRate: { sql: "l.current_rate" },
    newRate: { sql: "l.new_rate" },
    changePct: { sql: CHANGE_PCT_SQL },
    statedFrom: { sql: "l.stated_from" },
    appliedFrom: { sql: "l.applied_from" },
    noticeDaysGiven: { sql: NOTICE_GIVEN_SQL },
    flagged: { sql: "l.flagged" },
    noticeBreach: { sql: "l.notice_breach" },
    backdated: { sql: "l.backdated" },
    liveTraffic: { sql: "l.live_traffic" },
    traffic1h: { sql: "l.traffic_1h" },
    traffic24h: { sql: "l.traffic_24h" },
    traffic7d: { sql: "l.traffic_7d" },
    affectedCustomers: { sql: "l.affected_customers" },
    marginNowPct: { sql: "l.margin_now_pct" },
    marginNewPct: { sql: "l.margin_new_pct" },
    turnsNegative: { sql: "l.turns_negative" },
    sentBetween: { sql: "l.sent_between" },
    decision: { sql: "l.decision" },
  },
  search: ["mccmnc", "country", "network", "affectedCustomers"],
  idSql: "l.id",
  select: RN_LINE_SELECT,
  mapRow: mapRnLine,
};
