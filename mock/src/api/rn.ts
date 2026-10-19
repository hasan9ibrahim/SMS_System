// Incoming vendor rate notifications (§13.13 A, §13.32). Each vendor rate e-mail or upload becomes an
// RN for one vendor trunk: the sheet is read (rn/parse.ts), every line is compared with the current
// rate, and increases or closes are checked against live traffic on that trunk. Accepting loads the
// lines into the trunk's rate table as one undoable change (§13.10), never back-dated (§13.32); the
// vendor gets a Successful, Failed or Rejected reply, sent at once or kept as a draft per vendor.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ListQuery,
  RateLineEdit,
  RnAssign,
  RnDecision,
  RnDetail,
  RnIntake,
  RnReplySend,
  RnRow,
  RnSettings,
  VendorRnSettings,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { chRows } from "../edr.js";
import { listFields } from "../lists/fields.js";
import { runList } from "../lists/engine.js";
import { mapRn, rnLineList, rnList, RN_FROM, RN_SELECT } from "../lists/rnDefs.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { mappingOf, matchTrunk, readSheet, trunkByUsername, type SheetRow, type TrunkRef } from "../rn/parse.js";
import { scheduleBestBuyRefresh } from "./bestbuy.js";
import { companyDetails, companyMailbox, companyPlaceholders, companyTemplate, logEmail } from "./emailLog.js";
import { applyLineEdits, checkLineEdits, type EditTable } from "./rates.js";
import { iso, recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
const DAY_MS = 86_400_000;
const notFound = (reply: FastifyReply, id: number) => sendProblem(reply, 404, `Rate notification ${id} not found`);
const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

// ---------------------------------------------------------------- settings

type Mode = "auto" | "confirm" | "off";
interface Effective {
  autoAccept: boolean;
  modes: Record<"successful" | "failed" | "rejected", Mode>;
  replyTo: string[];
  noticeDays: number;
  mapping: Record<string, string> | null;
}

async function globalSettings(db: Db) {
  const { rows } = await db.query(
    `SELECT s.*, u.username AS updated_by FROM rn_settings s LEFT JOIN users u ON u.id = s.updated_by_id WHERE s.id = 1`,
  );
  return rows[0];
}

const toSettings = (r: Record<string, unknown>): RnSettings => ({
  liveWindow: r.live_window as RnSettings["liveWindow"],
  minMessages: Number(r.min_messages),
  reminderDays: Number(r.reminder_days),
  autoAccept: r.auto_accept as boolean,
  replyModes: {
    successful: r.reply_successful as Mode,
    failed: r.reply_failed as Mode,
    rejected: r.reply_rejected as Mode,
  },
  updatedBy: (r.updated_by as string | null) ?? null,
  updatedAt: iso(r.updated_at),
});

/** A vendor's settings with the global defaults filled in. */
async function effectiveSettings(db: Db, vendorId: number | null): Promise<Effective> {
  const g = await globalSettings(db);
  const { rows } = vendorId
    ? await db.query(
        `SELECT v.*, e.rate_notice_days FROM enterprises e LEFT JOIN vendor_rn_settings v ON v.enterprise_id = e.id
          WHERE e.id = $1`,
        [vendorId],
      )
    : { rows: [] as Record<string, unknown>[] };
  const v = rows[0] ?? {};
  return {
    autoAccept: (v.auto_accept as boolean | null) ?? (g.auto_accept as boolean),
    modes: {
      successful: (v.reply_successful as Mode | null) ?? g.reply_successful,
      failed: (v.reply_failed as Mode | null) ?? g.reply_failed,
      rejected: (v.reply_rejected as Mode | null) ?? g.reply_rejected,
    },
    replyTo: (v.reply_to as string[] | null) ?? [],
    noticeDays: Number(v.rate_notice_days ?? 0),
    mapping: (v.mapping as Record<string, string> | null) ?? null,
  };
}

export function getRnSettings(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => toSettings(await globalSettings(pool)));
}

export function updateRnSettings(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as RnSettings;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    await pool.query(
      `UPDATE rn_settings SET live_window = $1, min_messages = $2, reminder_days = $3, auto_accept = $4,
         reply_successful = $5, reply_failed = $6, reply_rejected = $7, updated_by_id = $8, updated_at = now() WHERE id = 1`,
      [
        b.liveWindow,
        b.minMessages,
        b.reminderDays,
        b.autoAccept,
        b.replyModes.successful,
        b.replyModes.failed,
        b.replyModes.rejected,
        me.id,
      ],
    );
    return toSettings(await globalSettings(pool));
  });
}

async function vendorSettings(db: Db, id: number): Promise<VendorRnSettings | null> {
  const { rows } = await db.query(
    `SELECT e.rate_notice_days, v.* FROM enterprises e LEFT JOIN vendor_rn_settings v ON v.enterprise_id = e.id
      WHERE e.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const has = r.reply_successful || r.reply_failed || r.reply_rejected;
  return {
    autoAccept: r.auto_accept ?? null,
    replyModes: has
      ? {
          successful: r.reply_successful ?? "auto",
          failed: r.reply_failed ?? "auto",
          rejected: r.reply_rejected ?? "confirm",
        }
      : null,
    replyTo: r.reply_to ?? [],
    noticeDays: Number(r.rate_notice_days),
    mapping: r.mapping ?? null,
  };
}

export function getVendorRnSettings(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => (await vendorSettings(pool, id)) ?? sendProblem(reply, 404, "Vendor not found"));
}

export function updateVendorRnSettings(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const b = request.body as VendorRnSettings;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rowCount } = await pool.query("UPDATE enterprises SET rate_notice_days = $2 WHERE id = $1", [
      id,
      b.noticeDays,
    ]);
    if (!rowCount) return sendProblem(reply, 404, "Vendor not found");
    await pool.query(
      `INSERT INTO vendor_rn_settings (enterprise_id, auto_accept, reply_successful, reply_failed, reply_rejected, reply_to,
                                       mapping, updated_by_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (enterprise_id) DO UPDATE SET auto_accept = $2, reply_successful = $3, reply_failed = $4,
         reply_rejected = $5, reply_to = $6, mapping = $7, updated_by_id = $8, updated_at = now()`,
      [
        id,
        b.autoAccept,
        b.replyModes?.successful ?? null,
        b.replyModes?.failed ?? null,
        b.replyModes?.rejected ?? null,
        b.replyTo,
        b.mapping ? JSON.stringify(b.mapping) : null,
        me.id,
      ],
    );
    return vendorSettings(pool, id);
  });
}

// ---------------------------------------------------------------- lists and record

export function queryRns(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.rate_notifications);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, rnList, query));
}

export function queryRnLines(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.rate_notification_lines);
  const top = query.filter?.logic === "and" ? query.filter.conditions : [];
  if (!top.some((c) => !("logic" in c) && c.field === "rnId" && c.op === "eq"))
    errors.push({ path: "/filter", message: "the filter needs a top-level rnId eq condition" });
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, rnLineList, query));
}

async function loadRn(db: Db, id: number): Promise<RnDetail | null> {
  const { rows } = await db.query(`SELECT ${RN_SELECT} FROM ${RN_FROM} WHERE n.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  const [replies, log, flaggedCodes] = await Promise.all([
    db.query(
      `SELECT p.*, u.username AS sent_by FROM rate_notification_replies p LEFT JOIN users u ON u.id = p.sent_by_id
        WHERE p.rn_id = $1 ORDER BY p.id`,
      [id],
    ),
    db.query(
      `SELECT g.at, g.text, u.username FROM rate_notification_log g LEFT JOIN users u ON u.id = g.user_id
        WHERE g.rn_id = $1 ORDER BY g.id`,
      [id],
    ),
    db.query("SELECT DISTINCT mccmnc FROM rate_notification_lines WHERE rn_id = $1 AND flagged ORDER BY mccmnc", [id]),
  ]);
  return {
    ...mapRn(r),
    matchReason: r.match_reason ?? null,
    noticeDaysRequired: Number(r.notice_days),
    rejectReason: r.reject_reason ?? null,
    changeId: r.change_id === null ? null : Number(r.change_id),
    fileErrors: r.file_errors ?? [],
    columns: r.columns ?? [],
    replies: replies.rows.map((p) => ({
      id: Number(p.id),
      kind: p.kind,
      to: p.to_addresses,
      subject: p.subject,
      body: p.body,
      status: p.status,
      createdAt: iso(p.created_at)!,
      sentAt: iso(p.sent_at),
      sentBy: p.sent_by ?? null,
    })),
    log: log.rows.map((g) => ({ at: iso(g.at)!, user: g.username ?? null, text: g.text })),
    affectedRateTableIds: ((r.affected_rate_table_ids as string[]) ?? []).map(Number),
    affectedMccmncs: flaggedCodes.rows.map((x) => x.mccmnc as string),
  };
}

export function getRn(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => (await loadRn(pool, id)) ?? notFound(reply, id));
}

export function downloadRnFile(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT file_name, file_content FROM rate_notifications WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    const name = String(rows[0].file_name ?? `rn-${id}.csv`).replace(/[^\w.-]+/g, "_");
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`)
      .send(rows[0].file_content ?? "");
  });
}

const log = (c: Db, rnId: number, userId: number | null, text: string) =>
  c.query("INSERT INTO rate_notification_log (rn_id, user_id, text) VALUES ($1, $2, $3)", [rnId, userId, text]);

// ---------------------------------------------------------------- check (§13.32)

const WINDOW_COL = { "1h": "traffic_1h", "24h": "traffic_24h", "7d": "traffic_7d" } as const;

/**
 * Compares every pending line with the rate valid now, sets the applied date (never before the RN was
 * received), the notice check, and the live-traffic figures on the vendor trunk; then the RN counts.
 */
export async function checkRn(c: Db, rnId: number): Promise<void> {
  const { rows: rr } = await c.query(
    `SELECT n.*, rt.currency AS table_currency FROM rate_notifications n LEFT JOIN rate_tables rt ON rt.id = n.rate_table_id
      WHERE n.id = $1`,
    [rnId],
  );
  const rn = rr[0];
  if (!rn || !rn.rate_table_id) return;
  const settings = await globalSettings(c);
  const ef = await effectiveSettings(c, rn.vendor_id === null ? null : Number(rn.vendor_id));
  const received = (rn.received_at as Date).getTime();
  // Current rates of the trunk's table for the RN's destinations.
  await c.query(
    `UPDATE rate_notification_lines l SET current_line_id = cur.id, current_rate = cur.rate
       FROM (SELECT l2.id AS lid, x.id, x.rate FROM rate_notification_lines l2
               LEFT JOIN LATERAL (SELECT r.id, r.rate FROM rate_lines r
                                   WHERE r.rate_table_id = $2 AND r.mccmnc_id = l2.mccmnc_id
                                     AND r.sender_id IS NOT DISTINCT FROM l2.sender_id
                                     AND r.valid_from <= now() AND (r.valid_to IS NULL OR r.valid_to > now())
                                   LIMIT 1) x ON true
              WHERE l2.rn_id = $1 AND l2.decision = 'pending') cur
      WHERE l.id = cur.lid`,
    [rnId, rn.rate_table_id],
  );
  await c.query(
    `UPDATE rate_notification_lines SET
       change_type = CASE WHEN new_rate IS NULL THEN 'closed'
                          WHEN current_rate IS NULL THEN 'new'
                          WHEN new_rate > current_rate THEN 'increase'
                          WHEN new_rate < current_rate THEN 'decrease' ELSE 'unchanged' END,
       backdated = stated_from < $2,
       applied_from = greatest(stated_from, $2)
     WHERE rn_id = $1 AND decision = 'pending'`,
    [rnId, rn.received_at],
  );
  // A destination that is closed but was never priced is not a change.
  await c.query(
    `UPDATE rate_notification_lines SET change_type = 'unchanged'
      WHERE rn_id = $1 AND decision = 'pending' AND new_rate IS NULL AND current_rate IS NULL`,
    [rnId],
  );
  await c.query(
    `UPDATE rate_notification_lines SET notice_breach = (change_type = 'increase' AND stated_from < $2)
      WHERE rn_id = $1 AND decision = 'pending'`,
    [rnId, new Date(received + ef.noticeDays * DAY_MS)],
  );

  // Traffic on this vendor trunk per destination (EDR store; optional).
  const { rows: lines } = await c.query(
    `SELECT id, mccmnc, change_type, current_rate, new_rate, stated_from, backdated FROM rate_notification_lines
      WHERE rn_id = $1 AND decision = 'pending'`,
    [rnId],
  );
  const codes = [...new Set(lines.map((l) => String(l.mccmnc).replace(/\D/g, "")))].filter(Boolean);
  const trunk = Number(rn.vendor_trunk_id);
  const t = codes.length
    ? await chRows<{
        m: string;
        h1: string;
        h24: string;
        d7: string;
        rev: string;
        cost: string;
        ents: number[];
        tables: number[];
      }>(
        `SELECT v_mccmnc AS m,
                countIf(start_time >= now() - INTERVAL 1 HOUR) AS h1,
                countIf(start_time >= now() - INTERVAL 1 DAY) AS h24,
                count() AS d7,
                sum(revenue_sys) AS rev, sum(cost_sys) AS cost,
                groupUniqArray(50)(c_enterprise_id) AS ents, groupUniqArray(50)(c_rate_table_id) AS tables
           FROM edr
          WHERE v_trunk_id = ${trunk} AND start_time >= now() - INTERVAL 7 DAY
            AND v_mccmnc IN (${codes.map((x) => `'${x}'`).join(",")})
          GROUP BY m`,
        8000,
      )
    : [];
  const byCode = new Map((t ?? []).map((x) => [x.m, x]));
  const entIds = [...new Set((t ?? []).flatMap((x) => x.ents.map(Number)))];
  const { rows: ents } = entIds.length
    ? await c.query("SELECT id, name FROM enterprises WHERE id = ANY($1)", [entIds])
    : { rows: [] };
  const entName = new Map(ents.map((e) => [Number(e.id), e.name as string]));

  // Back-dated lines: what was sent between the stated date and receipt, at the old cost.
  const back = lines.filter((l) => l.backdated);
  const between = new Map<string, { n: number; cost: number }>();
  if (back.length) {
    const from = new Date(Math.min(...back.map((l) => (l.stated_from as Date).getTime())));
    const rowsB = await chRows<{ m: string; n: string; cost: string; s: string }>(
      `SELECT v_mccmnc AS m, toString(toStartOfDay(start_time)) AS s, count() AS n, sum(cost) AS cost FROM edr
        WHERE v_trunk_id = ${trunk} AND start_time >= toDateTime64('${from.toISOString().slice(0, 19)}', 3, 'UTC')
          AND start_time < toDateTime64('${(rn.received_at as Date).toISOString().slice(0, 19)}', 3, 'UTC')
          AND v_mccmnc IN (${[...new Set(back.map((l) => `'${String(l.mccmnc).replace(/\D/g, "")}'`))].join(",")})
        GROUP BY m, s`,
      8000,
    );
    for (const l of back) {
      const since = (l.stated_from as Date).getTime();
      const sum = (rowsB ?? [])
        .filter((x) => x.m === l.mccmnc && Date.parse(`${x.s.replace(" ", "T")}Z`) >= since - DAY_MS)
        .reduce((a, x) => ({ n: a.n + Number(x.n), cost: a.cost + Number(x.cost) }), { n: 0, cost: 0 });
      between.set(String(l.id), sum);
    }
  }

  const minMsgs = Number(settings.min_messages);
  const windowKey = WINDOW_COL[settings.live_window as keyof typeof WINDOW_COL];
  const affectedTables = new Set<number>();
  for (const l of lines) {
    const x = byCode.get(String(l.mccmnc));
    const counts = { traffic_1h: Number(x?.h1 ?? 0), traffic_24h: Number(x?.h24 ?? 0), traffic_7d: Number(x?.d7 ?? 0) };
    const live = counts[windowKey] >= minMsgs;
    const flagged = live && (l.change_type === "increase" || l.change_type === "closed");
    const rev = Number(x?.rev ?? 0);
    const cost = Number(x?.cost ?? 0);
    const cur = l.current_rate === null ? null : Number(l.current_rate);
    const next = l.new_rate === null ? null : Number(l.new_rate);
    const now = rev > 0 ? Math.round(((rev - cost) / rev) * 1000) / 10 : null;
    const newCost = cur && next !== null ? (cost * next) / cur : null;
    const after = rev > 0 && newCost !== null ? Math.round(((rev - newCost) / rev) * 1000) / 10 : null;
    if (flagged) for (const tb of x?.tables ?? []) if (Number(tb) > 0) affectedTables.add(Number(tb));
    const b = between.get(String(l.id));
    await c.query(
      `UPDATE rate_notification_lines SET traffic_1h = $2, traffic_24h = $3, traffic_7d = $4, live_traffic = $5,
         flagged = $6, affected_customers = $7, margin_now_pct = $8, margin_new_pct = $9, turns_negative = $10,
         sent_between = $11, cost_between = $12 WHERE id = $1`,
      [
        l.id,
        counts.traffic_1h,
        counts.traffic_24h,
        counts.traffic_7d,
        live,
        flagged,
        x?.ents.length
          ? x.ents
              .map((e) => entName.get(Number(e)))
              .filter(Boolean)
              .sort()
              .join(", ")
          : null,
        now,
        after,
        after !== null && after < 0 && (now === null || now >= 0),
        b?.n ?? 0,
        Math.round((b?.cost ?? 0) * 1e4) / 1e4,
      ],
    );
  }
  await c.query(
    `UPDATE rate_notifications n SET notice_days = $2, affected_rate_table_ids = $3, checked_at = now(), updated_at = now(),
       lines = s.lines, new_lines = s.new_lines, increases = s.increases, decreases = s.decreases, unchanged = s.unchanged,
       closed = s.closed, flagged = s.flagged, notice_breaches = s.notice_breaches, backdated = s.backdated,
       turns_negative = s.turns_negative, effective_from = s.effective_from
       FROM (SELECT count(*)::int AS lines,
                    count(*) FILTER (WHERE change_type = 'new')::int AS new_lines,
                    count(*) FILTER (WHERE change_type = 'increase')::int AS increases,
                    count(*) FILTER (WHERE change_type = 'decrease')::int AS decreases,
                    count(*) FILTER (WHERE change_type = 'unchanged')::int AS unchanged,
                    count(*) FILTER (WHERE change_type = 'closed')::int AS closed,
                    count(*) FILTER (WHERE flagged)::int AS flagged,
                    count(*) FILTER (WHERE notice_breach)::int AS notice_breaches,
                    count(*) FILTER (WHERE backdated)::int AS backdated,
                    count(*) FILTER (WHERE turns_negative)::int AS turns_negative,
                    min(stated_from) AS effective_from
               FROM rate_notification_lines WHERE rn_id = $1) s
      WHERE n.id = $1`,
    [rnId, ef.noticeDays, [...affectedTables]],
  );
}

// ---------------------------------------------------------------- replies

const fill = (t: string, v: Record<string, string>) => t.replace(/\{([a-z_]+)\}/g, (m, k: string) => v[k] ?? m);
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** The vendor's business company's template for a reply (§11), else a shared one. */
async function replyTemplate(
  c: Db,
  vendorId: number | null,
  type: "rate_upload_notification" | "auto_upload_rejected",
) {
  if (vendorId !== null) return companyTemplate(c, { enterpriseId: vendorId }, type);
  const { rows } = await c.query(
    `SELECT subject, body FROM email_templates WHERE email_type = $1 AND deleted_at IS NULL
      ORDER BY business_company_id NULLS FIRST, id LIMIT 1`,
    [type],
  );
  return rows[0] as { subject: string; body: string } | undefined;
}

/** Writes the vendor reply for an RN and sends it now or keeps it as a draft, per the vendor's mode. */
async function makeReply(c: Db, rnId: number, kind: "successful" | "failed" | "rejected", userId: number | null) {
  const { rows } = await c.query(
    `SELECT n.*, ve.name AS vendor, vt.name AS trunk FROM rate_notifications n
       LEFT JOIN enterprises ve ON ve.id = n.vendor_id LEFT JOIN vendor_trunks vt ON vt.id = n.vendor_trunk_id
      WHERE n.id = $1`,
    [rnId],
  );
  const rn = rows[0];
  const ef = await effectiveSettings(c, rn.vendor_id === null ? null : Number(rn.vendor_id));
  const mode = ef.modes[kind];
  if (mode === "off") return;
  const sender = (rn.from_address as string | null)?.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? null;
  let to = [...new Set([sender, ...ef.replyTo].filter(Boolean) as string[])];
  if (!to.length && rn.vendor_id) {
    const { rows: ct } = await c.query(
      `SELECT emails FROM enterprise_contacts WHERE enterprise_id = $1 ORDER BY (contact_type = 'rates') DESC LIMIT 1`,
      [rn.vendor_id],
    );
    to = ct[0]?.emails ?? [];
  }
  const { rows: ls } = await c.query(
    `SELECT line_no, mccmnc, new_rate, stated_from, applied_from, decision, reject_reason
       FROM rate_notification_lines WHERE rn_id = $1 ORDER BY line_no`,
    [rnId],
  );
  const accepted = ls.filter((l) => l.decision === "accepted");
  const rejected = ls.filter((l) => l.decision === "rejected");
  const moved = accepted.filter((l) => (l.applied_from as Date).getTime() > (l.stated_from as Date).getTime() + 60_000);
  const ref = rn.reference as string;
  let subject = "";
  let body = "";
  const vendorId = rn.vendor_id === null ? null : Number(rn.vendor_id);
  const tpl = await replyTemplate(
    c,
    vendorId,
    kind === "successful" ? "rate_upload_notification" : "auto_upload_rejected",
  );
  const vars = { reference: ref, vendor: rn.vendor ?? "", trunk: rn.trunk ?? "", file: rn.file_name ?? "" };
  if (kind === "successful") {
    subject = `Rates accepted – ${ref}${rn.trunk ? ` (${rn.trunk})` : ""}`;
    body =
      `Your rate notification ${ref}${rn.file_name ? ` (${rn.file_name})` : ""} was uploaded and accepted: ` +
      `${accepted.length} line${accepted.length === 1 ? "" : "s"}, effective ${rn.effective_from ? day(rn.effective_from) : "now"}.`;
    if (moved.length)
      body +=
        `\n\n${moved.length} line${moved.length === 1 ? " was" : "s were"} applied later than stated, because rates never change ` +
        `traffic already sent:\n` +
        moved
          .slice(0, 50)
          .map((l) => `  ${l.mccmnc}: stated ${day(l.stated_from)}, applied from ${day(l.applied_from)}`)
          .join("\n");
  } else if (kind === "rejected") {
    subject = `Rates ${accepted.length ? "partly " : ""}rejected – ${ref}`;
    body =
      `Your rate notification ${ref} was ${accepted.length ? "partly " : ""}rejected.\n\nRejected lines:\n` +
      rejected
        .slice(0, 200)
        .map((l) => `  line ${l.line_no} ${l.mccmnc} ${l.new_rate ?? "closed"}: ${l.reject_reason ?? ""}`)
        .join("\n") +
      (accepted.length
        ? `\n\n${accepted.length} other line${accepted.length === 1 ? " was" : "s were"} accepted` +
          (moved.length ? `; ${moved.length} applied from a later date than stated (no back-dating).` : ".")
        : "");
  } else {
    const errs = (rn.file_errors as { line: number; message: string }[]) ?? [];
    subject = `Rate file could not be processed – ${ref}`;
    body =
      `We could not process ${rn.file_name ?? "your rate file"} (${ref}). Please correct and resend:\n` +
      errs
        .slice(0, 200)
        .map((e) => `  line ${e.line}: ${e.message}`)
        .join("\n");
  }
  if (tpl) {
    // The vendor's e-mail template (Email Templates, §11) frames the generated details.
    const v = {
      ...companyPlaceholders(vendorId === null ? null : await companyDetails(c, { enterpriseId: vendorId })),
      ...vars,
      enterprise: rn.vendor ?? "",
      lines: String(accepted.length),
      rate_date: rn.effective_from ? day(rn.effective_from) : day(new Date()),
      reason: body,
    };
    subject = `${fill(tpl.subject, v)} (${ref})`;
    body = kind === "successful" ? `${fill(tpl.body, v)}\n\n${body}` : fill(tpl.body, v);
  }
  const { rows: ins } = await c.query(
    `INSERT INTO rate_notification_replies (rn_id, kind, to_addresses, subject, body) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [rnId, kind, to, subject, body],
  );
  if (mode === "auto") await sendReply(c, rnId, Number(ins[0].id), userId);
  else await log(c, rnId, userId, `${kind[0]!.toUpperCase()}${kind.slice(1)} reply drafted for confirmation`);
}

async function sendReply(c: Db, rnId: number, replyId: number, userId: number | null, edit?: RnReplySend) {
  const { rows } = await c.query(
    `SELECT p.*, n.vendor_id, n.vendor_trunk_id, n.file_name, n.effective_from FROM rate_notification_replies p
       JOIN rate_notifications n ON n.id = p.rn_id WHERE p.id = $1 AND p.rn_id = $2`,
    [replyId, rnId],
  );
  const p = rows[0];
  const to = edit?.to?.length ? edit.to : (p.to_addresses as string[]);
  const subject = edit?.subject ?? p.subject;
  const body = edit?.body ?? p.body;
  const status = await logEmail(c, {
    type: p.kind === "successful" ? "auto_upload_rate" : "auto_upload_rejected",
    enterpriseId: p.vendor_id,
    vendorTrunkId: p.vendor_trunk_id,
    to,
    sender: p.vendor_id ? await companyMailbox(c, Number(p.vendor_id), "rnReply") : null,
    subject,
    body,
    file: p.file_name,
    rateDate: p.effective_from ? day(p.effective_from) : null,
    userId,
  });
  await c.query(
    `UPDATE rate_notification_replies SET to_addresses = $2, subject = $3, body = $4, status = $5, sent_at = now(),
       sent_by_id = $6 WHERE id = $1`,
    [replyId, to, subject, body, status, userId],
  );
  await log(
    c,
    rnId,
    userId,
    `${p.kind[0].toUpperCase()}${p.kind.slice(1)} reply ${status} to ${to.join(", ") || "nobody"}`,
  );
}

export function sendRnReply(request: FastifyRequest, reply: FastifyReply) {
  const { id, replyId } = request.params as { id: number; replyId: number };
  const body = (request.body ?? {}) as RnReplySend;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query("SELECT status FROM rate_notification_replies WHERE id = $1 AND rn_id = $2", [
      replyId,
      id,
    ]);
    if (!rows[0]) return sendProblem(reply, 404, `Reply ${replyId} not found`);
    if (rows[0].status === "sent") return sendProblem(reply, 409, "This reply was already sent");
    await sendReply(pool, id, replyId, me.id, body);
    return loadRn(pool, id);
  });
}

// ---------------------------------------------------------------- decisions

/** Status from the line decisions: pending lines keep it pending. */
async function settleStatus(c: Db, rnId: number): Promise<"pending" | "accepted" | "rejected" | "partly_accepted"> {
  const { rows } = await c.query(
    `SELECT count(*) FILTER (WHERE decision = 'pending')::int AS p, count(*) FILTER (WHERE decision = 'accepted')::int AS a,
            count(*) FILTER (WHERE decision = 'rejected')::int AS r FROM rate_notification_lines WHERE rn_id = $1`,
    [rnId],
  );
  const { p, a, r } = rows[0];
  const status = p > 0 ? "pending" : r === 0 ? "accepted" : a === 0 ? "rejected" : "partly_accepted";
  await c.query("UPDATE rate_notifications SET status = $2, updated_at = now() WHERE id = $1", [rnId, status]);
  return status;
}

class DecisionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Accepts pending lines: loads them into the trunk's rate table from max(stated date, now) — never
 * back-dated (§13.32) — closes the closed ones, and records one change. Answers the change and how many
 * lines were loaded.
 */
export async function acceptLines(
  c: pg.PoolClient,
  rnId: number,
  lineIds: number[] | null,
  userId: number,
  ip: string | null,
  auto = false,
  note?: string | null,
) {
  const { rows: rr } = await c.query(
    `SELECT n.*, rt.name AS table_name, rt.kind, rt.currency AS table_currency, rt.deleted_at AS table_deleted
       FROM rate_notifications n LEFT JOIN rate_tables rt ON rt.id = n.rate_table_id WHERE n.id = $1 FOR UPDATE OF n`,
    [rnId],
  );
  const rn = rr[0];
  if (!rn.rate_table_id || rn.table_deleted) throw new DecisionError(409, "The RN has no live vendor rate table");
  const { rows: lines } = await c.query(
    `SELECT * FROM rate_notification_lines WHERE rn_id = $1 AND decision = 'pending' ${lineIds?.length ? "AND id = ANY($2)" : ""}
      ORDER BY line_no`,
    lineIds?.length ? [rnId, lineIds] : [rnId],
  );
  if (!lines.length) throw new DecisionError(409, "No pending lines to accept");
  const now = new Date();
  const edits: RateLineEdit[] = [];
  for (const l of lines) {
    const from = new Date(Math.max((l.stated_from as Date).getTime(), now.getTime()));
    if (l.change_type === "closed") {
      if (l.current_line_id) edits.push({ action: "close", lineId: Number(l.current_line_id), at: from.toISOString() });
    } else if (l.change_type !== "unchanged" && l.new_rate !== null) {
      edits.push({
        action: "set",
        mccmnc: l.mccmnc,
        senderId: l.sender_id,
        rate: Number(l.new_rate),
        effectiveFrom: from.toISOString(),
      });
    }
  }
  const mccmncIds = new Map<string, number>(lines.map((l) => [l.mccmnc as string, Number(l.mccmnc_id)]));
  const errors = await checkLineEdits(
    c,
    Number(rn.rate_table_id),
    edits.map((it, i) => ({ it, at: `/lines/${i}` })),
    mccmncIds,
    now.getTime(),
  );
  if (errors.length) throw new DecisionError(400, errors.map((e) => e.message).join("; "));
  const table: EditTable = {
    id: Number(rn.rate_table_id),
    name: rn.table_name,
    kind: rn.kind,
    currency: rn.table_currency,
    notice: null,
  };
  const diff: DiffEntry[] = [];
  await applyLineEdits(c, table, edits, mccmncIds, userId, now, diff, []);
  let change = null;
  if (diff.length) {
    await c.query("UPDATE rate_tables SET updated_by_id = $2, updated_at = now() WHERE id = $1", [table.id, userId]);
    await c.query("SELECT refresh_rate_table_stats($1::bigint[])", [[table.id]]);
    change = await recordChange(c, {
      entityType: "rate_table",
      entityIds: [table.id],
      changeType: edits.length > 1 ? "bulk" : "edit",
      diff,
      note: note?.trim() || `${rn.reference} ${auto ? "auto-accepted" : "accepted"} (${lines.length} lines)`,
      userId,
      ip,
    });
  }
  await c.query(
    `UPDATE rate_notification_lines SET decision = 'accepted', applied_from = greatest(stated_from, $2)
      WHERE id = ANY($1)`,
    [lines.map((l) => l.id), now],
  );
  await c.query(
    `UPDATE rate_notifications SET decided_by_id = $2, decided_at = now(), auto_accepted = auto_accepted OR $3,
       change_id = coalesce($4, change_id) WHERE id = $1`,
    [rnId, auto ? null : userId, auto, change?.id ?? null],
  );
  await log(
    c,
    rnId,
    auto ? null : userId,
    `${auto ? "Auto-accepted" : "Accepted"} ${lines.length} line${lines.length === 1 ? "" : "s"}` +
      (change ? ` (change #${change.id})` : " (nothing to load)") +
      (note?.trim() ? `: ${note.trim()}` : ""),
  );
  if (rn.kind === "vendor" && change) scheduleBestBuyRefresh();
  return { change, applied: lines.length };
}

async function afterDecision(c: pg.PoolClient, rnId: number, userId: number | null) {
  const status = await settleStatus(c, rnId);
  if (status === "accepted") await makeReply(c, rnId, "successful", userId);
  else if (status === "rejected" || status === "partly_accepted") await makeReply(c, rnId, "rejected", userId);
}

function decide(kind: "accept" | "reject") {
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: number };
    const body = (request.body ?? {}) as RnDecision;
    if (kind === "reject" && !body.reason?.trim())
      return badInput(reply, [{ path: "/reason", message: "a reason is required to reject" }]);
    return withDb(reply, async (pool) => {
      const me = await getCurrentUser();
      const { rows } = await pool.query("SELECT status FROM rate_notifications WHERE id = $1", [id]);
      if (!rows[0]) return notFound(reply, id);
      if (!["pending", "partly_accepted"].includes(rows[0].status))
        return sendProblem(reply, 409, `This RN is ${String(rows[0].status).replace("_", " ")}; nothing to decide`);
      try {
        const out = await inTransaction(pool, async (c) => {
          if (kind === "accept") {
            const r = await acceptLines(c, id, body.lineIds ?? null, me.id, request.ip, false, body.note);
            await afterDecision(c, id, me.id);
            return r;
          }
          const { rows: ls } = await c.query(
            `UPDATE rate_notification_lines SET decision = 'rejected', reject_reason = $3
              WHERE rn_id = $1 AND decision = 'pending' ${body.lineIds?.length ? "AND id = ANY($2)" : "AND $2::bigint[] IS NULL"}
              RETURNING id`,
            [id, body.lineIds?.length ? body.lineIds : null, body.reason!.trim()],
          );
          if (!ls.length) throw new DecisionError(409, "No pending lines to reject");
          await c.query(
            "UPDATE rate_notifications SET decided_by_id = $2, decided_at = now(), reject_reason = $3 WHERE id = $1",
            [id, me.id, body.reason!.trim()],
          );
          await log(c, id, me.id, `Rejected ${ls.length} line${ls.length === 1 ? "" : "s"}: ${body.reason!.trim()}`);
          await afterDecision(c, id, me.id);
          return { change: null, applied: ls.length };
        });
        return { record: await loadRn(pool, id), change: out.change, applied: out.applied };
      } catch (err) {
        if (err instanceof DecisionError)
          return err.status === 400
            ? badInput(reply, [{ path: "/lineIds", message: err.message }])
            : sendProblem(reply, err.status, err.message);
        throw err;
      }
    });
  };
}
export const acceptRn = decide("accept");
export const rejectRn = decide("reject");

export function recheckRn(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query("SELECT id FROM rate_notifications WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    await inTransaction(pool, async (c) => {
      await checkRn(c, id);
      await log(c, id, me.id, "Live-traffic check re-run");
    });
    return loadRn(pool, id);
  });
}

// ---------------------------------------------------------------- intake (§13.13 A)

async function liveTrunks(db: Db): Promise<(TrunkRef & { tableId: number | null })[]> {
  const { rows } = await db.query(
    `SELECT vt.id, vt.name, vt.username, vt.enterprise_id,
            (SELECT rt.id FROM rate_tables rt WHERE rt.vendor_trunk_id = vt.id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
              ORDER BY rt.id LIMIT 1) AS table_id
       FROM vendor_trunks vt WHERE vt.deleted_at IS NULL`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    username: r.username,
    enterpriseId: Number(r.enterprise_id),
    tableId: r.table_id === null ? null : Number(r.table_id),
  }));
}

/** Enterprises whose contact e-mails (or domain) match the sender. */
async function senderEnterprises(db: Db, from: string | null | undefined): Promise<number[]> {
  const addr = from?.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase();
  if (!addr) return [];
  const domain = addr.split("@")[1]!;
  const { rows } = await db.query(
    `SELECT DISTINCT c.enterprise_id FROM enterprise_contacts c JOIN enterprises e ON e.id = c.enterprise_id
      WHERE e.deleted_at IS NULL AND e.type <> 'customer'
        AND EXISTS (SELECT 1 FROM unnest(c.emails) x WHERE lower(x) = $1 OR lower(x) LIKE '%@' || $2)`,
    [addr, domain],
  );
  return rows.map((r) => Number(r.enterprise_id));
}

async function nextReference(c: Db): Promise<{ id: number; reference: string }> {
  const { rows } = await c.query("SELECT nextval(pg_get_serial_sequence('rate_notifications', 'id')) AS id");
  const id = Number(rows[0].id);
  return { id, reference: `RN-${new Date().getUTCFullYear()}-${String(id).padStart(6, "0")}` };
}

/** Destinations of sheet rows: MCCMNC from the master, else the longest dial-code prefix. */
async function resolveDestinations(db: Db, rows: SheetRow[]) {
  const codes = [...new Set(rows.flatMap((r) => (r.mccmnc ? [r.mccmnc] : [])))];
  const byCode = new Map<string, { id: number; mccmnc: string }>();
  if (codes.length) {
    const { rows: m } = await db.query("SELECT id, mccmnc FROM mccmnc WHERE mccmnc = ANY($1) AND deleted_at IS NULL", [
      codes,
    ]);
    for (const x of m) byCode.set(x.mccmnc, { id: Number(x.id), mccmnc: x.mccmnc });
  }
  const dials = [...new Set(rows.flatMap((r) => (!r.mccmnc && r.dialCode ? [r.dialCode] : [])))];
  const byDial = new Map<string, { id: number; mccmnc: string }>();
  if (dials.length) {
    const { rows: d } = await db.query(
      `SELECT DISTINCT ON (q.code) q.code, m.id, m.mccmnc FROM unnest($1::text[]) q(code)
         JOIN dial_codes dc ON q.code LIKE dc.prefix || '%' AND dc.profile = 'All' AND dc.deleted_at IS NULL
         JOIN mccmnc m ON m.id = dc.mccmnc_id AND m.deleted_at IS NULL
        ORDER BY q.code, length(dc.prefix) DESC`,
      [dials],
    );
    for (const x of d) byDial.set(x.code, { id: Number(x.id), mccmnc: x.mccmnc });
  }
  return (r: SheetRow) => (r.mccmnc ? byCode.get(r.mccmnc) : r.dialCode ? byDial.get(r.dialCode) : undefined) ?? null;
}

interface Draft {
  trunk: (TrunkRef & { tableId: number | null }) | null;
  reason: string | null;
  rows: SheetRow[];
  errors: { line: number; message: string }[];
  fileName: string;
  content: string;
  columns: { header: string; field: string | null }[];
  fatal: boolean;
}

/** Creates one RN (and its lines), runs the check and, when allowed, accepts it at once. */
async function createRn(
  c: pg.PoolClient,
  d: Draft,
  mail: RnIntake,
  userId: number,
  ip: string | null,
): Promise<{ id: number; auto: boolean }> {
  const { id, reference } = await nextReference(c);
  const resolve = await resolveDestinations(c, d.rows);
  const errors = [...d.errors];
  const lines: { row: SheetRow; dest: { id: number; mccmnc: string } }[] = [];
  const seen = new Set<string>();
  for (const row of d.rows) {
    const dest = resolve(row);
    if (!dest) {
      errors.push({ line: row.lineNo, message: `unknown destination ${row.mccmnc ?? row.dialCode}` });
      continue;
    }
    const key = `${dest.mccmnc}:${row.senderId ?? ""}`;
    if (seen.has(key)) {
      errors.push({ line: row.lineNo, message: `${dest.mccmnc} appears twice; the first line is used` });
      continue;
    }
    seen.add(key);
    lines.push({ row, dest });
  }
  const fatal = d.fatal || lines.length === 0;
  const status = fatal ? "failed" : !d.trunk || !d.trunk.tableId ? "unmatched" : "pending";
  const { rows: tb } = d.trunk?.tableId
    ? await c.query("SELECT currency FROM rate_tables WHERE id = $1", [d.trunk.tableId])
    : { rows: [] };
  const received = new Date();
  await c.query(
    `INSERT INTO rate_notifications (id, reference, vendor_id, vendor_trunk_id, rate_table_id, currency, source, mailbox,
       from_address, subject, body, file_name, file_content, received_at, status, match_reason, columns, file_errors, errors)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      id,
      reference,
      d.trunk?.enterpriseId ?? null,
      d.trunk?.id ?? null,
      d.trunk?.tableId ?? null,
      tb[0]?.currency ?? null,
      mail.source,
      mail.mailbox ?? null,
      mail.fromAddress ?? null,
      mail.subject ?? null,
      mail.body ?? null,
      d.fileName,
      d.content,
      received,
      status,
      d.reason,
      JSON.stringify(d.columns),
      JSON.stringify(errors.slice(0, 2000)),
      errors.length,
    ],
  );
  for (const [i, { row, dest }] of lines.entries()) {
    const stated = row.effective ? new Date(row.effective) : received;
    await c.query(
      `INSERT INTO rate_notification_lines (rn_id, line_no, mccmnc_id, mccmnc, sender_id, new_rate, change_type,
         stated_from, applied_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        id,
        row.lineNo || i + 1,
        dest.id,
        dest.mccmnc,
        row.senderId,
        row.closed ? null : row.rate,
        row.closed ? "closed" : "new",
        stated,
      ],
    );
  }
  await log(
    c,
    id,
    mail.source === "upload" ? userId : null,
    `${mail.source === "upload" ? "Uploaded" : `Received from ${mail.fromAddress ?? "unknown sender"}`}: ` +
      `${lines.length} line${lines.length === 1 ? "" : "s"}${errors.length ? `, ${errors.length} error${errors.length === 1 ? "" : "s"}` : ""}` +
      (d.reason ? `; trunk found by ${d.reason}` : status === "unmatched" ? "; no vendor trunk found" : ""),
  );
  if (status === "failed") {
    await makeReply(c, id, "failed", null);
    return { id, auto: false };
  }
  if (status !== "pending") return { id, auto: false };
  await checkRn(c, id);
  // Remember the column mapping for the vendor's next file (§13.13 A step 3).
  await c.query(
    `INSERT INTO vendor_rn_settings (enterprise_id, mapping) VALUES ($1, $2)
     ON CONFLICT (enterprise_id) DO UPDATE SET mapping = $2`,
    [d.trunk!.enterpriseId, JSON.stringify(mappingOf(d.columns as never))],
  );
  const ef = await effectiveSettings(c, d.trunk!.enterpriseId);
  const { rows: n } = await c.query("SELECT flagged, notice_breaches, errors FROM rate_notifications WHERE id = $1", [
    id,
  ]);
  if (ef.autoAccept && n[0].flagged === 0 && n[0].notice_breaches === 0 && n[0].errors === 0) {
    await acceptLines(c, id, null, userId, ip, true);
    await afterDecision(c, id, null);
    return { id, auto: true };
  }
  return { id, auto: false };
}

export function intakeRn(request: FastifyRequest, reply: FastifyReply) {
  const mail = request.body as RnIntake;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const trunks = await liveTrunks(pool);
    let chosen: (typeof trunks)[number] | null = null;
    if (mail.vendorTrunkId) {
      chosen = trunks.find((t) => t.id === mail.vendorTrunkId) ?? null;
      if (!chosen) return badInput(reply, [{ path: "/vendorTrunkId", message: "no live vendor trunk with this ID" }]);
      if (!chosen.tableId)
        return badInput(reply, [{ path: "/vendorTrunkId", message: "this trunk has no vendor rate table yet" }]);
    }
    const senders = await senderEnterprises(pool, mail.fromAddress);
    const drafts: Draft[] = [];
    for (const att of mail.attachments) {
      const found = chosen
        ? { trunk: chosen, reason: "chosen on upload" }
        : matchTrunk(trunks, { subject: mail.subject, body: mail.body, fileName: att.fileName }, senders);
      const ent = (found?.trunk as { enterpriseId?: number } | undefined)?.enterpriseId ?? senders[0] ?? null;
      const mapping = ent ? (await effectiveSettings(pool, ent)).mapping : null;
      const sheet = readSheet(att.content, mapping);
      const base = { fileName: att.fileName, content: att.content, columns: sheet.columns, fatal: sheet.fatal };
      const withUser = sheet.rows.filter((r) => r.username);
      if (!chosen && withUser.length && sheet.columns.some((x) => x.field === "username")) {
        // One file, many trunks: split by the username column (§13.13 A step 2).
        const groups = new Map<string, SheetRow[]>();
        for (const r of sheet.rows) groups.set(r.username ?? "", [...(groups.get(r.username ?? "") ?? []), r]);
        for (const [u, rows] of groups) {
          const t = u ? trunkByUsername(trunks, u) : null;
          drafts.push({
            ...base,
            trunk: t,
            reason: t ? `username ${u} in the sheet` : null,
            rows,
            errors: groups.size === 1 ? sheet.errors : [],
          });
        }
        if (groups.size > 1 && sheet.errors.length) drafts[0]!.errors = sheet.errors;
      } else
        drafts.push({
          ...base,
          trunk: (found?.trunk as Draft["trunk"]) ?? null,
          reason: found?.reason ?? null,
          rows: sheet.rows,
          errors: sheet.errors,
        });
    }
    const created = await inTransaction(pool, async (c) => {
      const out: { id: number; auto: boolean }[] = [];
      for (const d of drafts) out.push(await createRn(c, d, mail, me.id, request.ip));
      return out;
    });
    const { rows } = await pool.query(`SELECT ${RN_SELECT} FROM ${RN_FROM} WHERE n.id = ANY($1) ORDER BY n.id`, [
      created.map((x) => x.id),
    ]);
    const list: RnRow[] = rows.map(mapRn);
    return reply.code(201).send({
      created: list,
      autoAccepted: created.filter((x) => x.auto).length,
      unmatched: list.filter((r) => r.status === "unmatched").length,
      failed: list.filter((r) => r.status === "failed").length,
    });
  });
}

export function assignRn(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const { vendorTrunkId } = request.body as RnAssign;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query("SELECT status FROM rate_notifications WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    if (rows[0].status !== "unmatched" && rows[0].status !== "pending")
      return sendProblem(reply, 409, "Only an unmatched or pending RN can be assigned");
    const t = (await liveTrunks(pool)).find((x) => x.id === vendorTrunkId);
    if (!t) return badInput(reply, [{ path: "/vendorTrunkId", message: "no live vendor trunk with this ID" }]);
    if (!t.tableId)
      return badInput(reply, [{ path: "/vendorTrunkId", message: "this trunk has no vendor rate table yet" }]);
    await inTransaction(pool, async (c) => {
      const { rows: tb } = await c.query("SELECT currency FROM rate_tables WHERE id = $1", [t.tableId]);
      await c.query(
        `UPDATE rate_notifications SET vendor_id = $2, vendor_trunk_id = $3, rate_table_id = $4, currency = $5,
           status = 'pending', match_reason = 'assigned by hand', updated_at = now() WHERE id = $1`,
        [id, t.enterpriseId, t.id, t.tableId, tb[0]?.currency ?? null],
      );
      await log(c, id, me.id, `Assigned to trunk ${t.name}`);
      await checkRn(c, id);
    });
    return loadRn(pool, id);
  });
}

/** Checks pending RNs that were never checked (seeded ones), in the background at start. */
export async function checkPendingRns(): Promise<void> {
  try {
    const { rows } = await db().query(
      "SELECT id FROM rate_notifications WHERE status = 'pending' AND checked_at IS NULL AND rate_table_id IS NOT NULL ORDER BY id",
    );
    for (const r of rows) await checkRn(db(), Number(r.id));
  } catch (err) {
    console.error("rate notification check failed:", err);
  }
}
