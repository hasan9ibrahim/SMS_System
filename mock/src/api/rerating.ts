// Re-rating (§6.3, §12.2): recompute charges on past EDRs after a rate correction. A request
// is made by one user and approved or declined by another (maker-checker). On approval it is
// queued and processed in the background: EDRs billed with the rate table in the period are
// grouped by enterprise, destination, billed rate and hour, re-priced with the table's line
// valid at that time (a back-dated line counts from its stated date, §13.32), and each
// enterprise's difference becomes a Reprocess credit or debit note in Transactions, unless
// "no note" is set. EDRs keep the amounts they were billed at (§13.29).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ReratingDecline,
  ReratingDetail,
  ReratingInput,
  ReratingPreview,
  ReratingSummaryRow,
} from "@sms/contract";
import { withDb } from "../db.js";
import { chRows } from "../edr.js";
import { reratingList } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { recordChange, type DiffEntry } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;
const digits = (s: string) => s.replace(/\D/g, "");

interface Line {
  code: string;
  sender: string | null;
  rate: number;
  from: number; // stated date when back-dated, else valid from
  to: number | null;
  blocked: boolean;
}

/** The line that prices a message to `code` at time t: sender-specific first, then the code, then its country. */
function rateAt(lines: Map<string, Line[]>, code: string, sender: string | null, t: number): number | null {
  const keys = [
    ...(sender ? [`${sender}|${code}`, `${sender}|${code.slice(0, 3)}`] : []),
    `|${code}`,
    `|${code.slice(0, 3)}`,
  ];
  for (const k of keys) {
    const versions = lines.get(k);
    if (!versions) continue;
    // The latest version started by t (versions are sorted by start; a back-dated line starts
    // at its stated date, so it wins over the version it replaced). A closed one means no rate.
    let hit: Line | null = null;
    for (const v of versions) if (v.from <= t) hit = v;
    if (hit && (hit.to === null || hit.to > t)) return hit.blocked ? null : hit.rate;
  }
  return null;
}

/** Field errors for a request; returns the table's currency and kind when valid. */
async function checkInput(db: Db, input: ReratingInput) {
  const errors: { path: string; message: string }[] = [];
  if (input.endDate < input.startDate) errors.push({ path: "/endDate", message: "must be on or after the start date" });
  if (Date.parse(input.endDate) > Date.now()) errors.push({ path: "/endDate", message: "cannot be in the future" });
  const { rows: t } = await db.query("SELECT kind, currency, name FROM rate_tables WHERE id = $1", [input.rateTableId]);
  if (!t[0]) errors.push({ path: "/rateTableId", message: "unknown rate table" });
  else if (t[0].kind !== input.side)
    errors.push({ path: "/rateTableId", message: `a ${input.side} re-rating needs a ${input.side} rate table` });
  const { rows: ents } = await db.query("SELECT id FROM enterprises WHERE id = ANY($1)", [input.enterpriseIds]);
  if (ents.length !== new Set(input.enterpriseIds).size)
    errors.push({ path: "/enterpriseIds", message: "unknown enterprise" });
  return { errors, table: t[0] as { kind: string; currency: string; name: string } | undefined };
}

/** Recomputes the scope; summary rows per enterprise (transaction status "pending"). */
export async function computeRerating(db: Db, input: ReratingInput): Promise<ReratingPreview | null> {
  const { rows: tableRows } = await db.query("SELECT currency FROM rate_tables WHERE id = $1", [input.rateTableId]);
  const currency = String(tableRows[0]?.currency ?? "");
  const { rows: ents } = await db.query("SELECT id, name FROM enterprises WHERE id = ANY($1) ORDER BY name", [
    input.enterpriseIds,
  ]);
  const codes = input.mccmncs.map(digits);
  const { rows: raw } = await db.query(
    `SELECT mccmnc, sender_id, rate, COALESCE(stated_valid_from, valid_from) AS eff_from, valid_to, is_blocked
       FROM rate_lines WHERE rate_table_id = $1
        AND ($2::text[] = '{}' OR mccmnc = ANY($2) OR left(mccmnc, 3) = ANY($2) OR mccmnc = ANY($3))
      ORDER BY eff_from`,
    [input.rateTableId, codes, codes.map((c) => c.slice(0, 3))],
  );
  const lines = new Map<string, Line[]>();
  for (const r of raw) {
    const key = `${r.sender_id ?? ""}|${r.mccmnc}`;
    lines.set(key, [
      ...(lines.get(key) ?? []),
      {
        code: r.mccmnc,
        sender: r.sender_id,
        rate: Number(r.rate),
        from: (r.eff_from as Date).getTime(),
        to: r.valid_to ? (r.valid_to as Date).getTime() : null,
        blocked: r.is_blocked,
      },
    ]);
  }
  const p = input.side === "customer" ? "c" : "v";
  const amountCol = input.side === "customer" ? "revenue" : "cost";
  const billable = input.side === "customer" ? "is_customer_billable" : "is_vendor_billable";
  const codeCol = input.side === "customer" ? "c_mccmnc" : "v_mccmnc";
  const list = (xs: string[]) => xs.map((x) => `'${digits(x)}'`).join(",");
  const where = [
    `${p}_rate_table_id = ${Number(input.rateTableId)}`,
    `${p}_enterprise_id IN (${input.enterpriseIds.map(Number).join(",")})`,
    `submit_time >= toDateTime64('${input.startDate} 00:00:00', 3)`,
    `submit_time < toDateTime64('${input.endDate} 00:00:00', 3) + INTERVAL 1 DAY`,
    ...(codes.length ? [`(${codeCol} IN (${list(codes)}) OR substring(${codeCol}, 1, 3) IN (${list(codes)}))`] : []),
    ...(input.senderId ? [`src_addr = '${input.senderId.replace(/'/g, "")}'`] : []),
  ];
  const groups = await chRows<{
    ent: number;
    code: string;
    sender: string;
    h: string;
    n: string;
    units: string;
    amt: number;
  }>(
    `SELECT ${p}_enterprise_id AS ent, ${codeCol} AS code, ${input.senderId ? "src_addr" : "''"} AS sender,
            toString(toStartOfHour(submit_time)) AS h, count() AS n,
            sum(msg_count * ${billable}) AS units, toFloat64(sum(${amountCol})) AS amt
       FROM edr WHERE ${where.join(" AND ")}
      GROUP BY ent, code, sender, h`,
    60_000,
  );
  if (!groups) return null;
  const per = new Map<number, { n: number; old: number; next: number }>();
  for (const g of groups) {
    const t = Date.parse(`${g.h.replace(" ", "T")}Z`) + 30 * 60_000;
    const rate = rateAt(lines, g.code, input.senderId, t);
    const old = Number(g.amt);
    const next = rate === null ? old : Number(g.units) * rate;
    const cur = per.get(Number(g.ent)) ?? { n: 0, old: 0, next: 0 };
    per.set(Number(g.ent), { n: cur.n + Number(g.n), old: cur.old + old, next: cur.next + next });
  }
  const rows: ReratingSummaryRow[] = ents.map((e) => {
    const x = per.get(Number(e.id)) ?? { n: 0, old: 0, next: 0 };
    const amount = r2(x.next - x.old);
    return {
      enterpriseId: Number(e.id),
      enterpriseName: e.name,
      side: input.side,
      totalEdrs: x.n,
      oldAmount: r6(x.old),
      newAmount: r6(x.next),
      amount,
      currency,
      paymentType: amount === 0 ? null : paymentType(input.side, amount),
      transactionStatus: amount === 0 ? "no_difference" : "pending",
      transactionId: null,
      startTime: null,
      endTime: null,
      updatedBy: null,
    };
  });
  return { totalEdrs: rows.reduce((s, r) => s + r.totalEdrs, 0), rows };
}

/** Customer: a lower amount is a credit to the customer. Vendor: a lower cost is a debit to the vendor. */
const paymentType = (side: string, amount: number): "credit" | "debit" =>
  side === "customer" ? (amount < 0 ? "credit" : "debit") : amount > 0 ? "credit" : "debit";

async function loadDetail(db: Db, id: number): Promise<ReratingDetail | null> {
  const { rows } = await db.query(
    `SELECT ${reratingList.select} FROM ${reratingList.from as string} WHERE rr.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const { rows: res } = await db.query(
    `SELECT x.*, e.name AS enterprise_name, u.username AS updated_by, t.payment_type
       FROM rerating_results x JOIN enterprises e ON e.id = x.enterprise_id
       LEFT JOIN users u ON u.id = x.updated_by_id LEFT JOIN transactions t ON t.id = x.transaction_id
      WHERE x.request_id = $1 ORDER BY e.name`,
    [id],
  );
  const base = reratingList.mapRow(rows[0]);
  return {
    ...base,
    summary: res.map((r) => {
      const amount = r2(Number(r.new_amount) - Number(r.old_amount));
      return {
        enterpriseId: Number(r.enterprise_id),
        enterpriseName: r.enterprise_name,
        side: base.side,
        totalEdrs: Number(r.total_edrs),
        oldAmount: Number(r.old_amount),
        newAmount: Number(r.new_amount),
        amount,
        currency: String(r.currency),
        paymentType:
          amount === 0 ? null : ((r.payment_type as "credit" | "debit" | null) ?? paymentType(base.side, amount)),
        transactionStatus: r.transaction_status,
        transactionId: r.transaction_id === null ? null : Number(r.transaction_id),
        startTime: r.start_time ? (r.start_time as Date).toISOString() : null,
        endTime: r.end_time ? (r.end_time as Date).toISOString() : null,
        updatedBy: r.updated_by ?? null,
      };
    }),
  };
}

const INPUT_FIELDS = [
  "description",
  "startDate",
  "endDate",
  "side",
  "enterpriseIds",
  "rateTableId",
  "mccmncs",
  "senderId",
  "noNote",
  "priority",
] as const;
const normalise = (input: ReratingInput) => ({
  ...input,
  description: input.description?.trim() || null,
  senderId: input.senderId?.trim() || null,
  enterpriseIds: [...new Set(input.enterpriseIds)].sort((a, b) => a - b),
  mccmncs: [...new Set(input.mccmncs.map(digits))].sort(),
});
const asInput = (d: ReratingDetail) =>
  normalise({
    description: d.description,
    startDate: d.startDate,
    endDate: d.endDate,
    side: d.side,
    enterpriseIds: d.enterprises.map((e) => e.id),
    rateTableId: d.rateTableId,
    reason: d.reason,
    mccmncs: d.mccmncs,
    senderId: d.senderId,
    noNote: d.noNote,
    priority: d.priority,
  });

export function previewRerating(request: FastifyRequest, reply: FastifyReply) {
  const input = normalise(request.body as ReratingInput);
  return withDb(reply, async (pool) => {
    const { errors } = await checkInput(pool, input);
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    const result = await computeRerating(pool, input);
    if (!result) return sendProblem(reply, 503, "The EDR store is not available");
    return result;
  });
}

export function createReratingRequest(request: FastifyRequest, reply: FastifyReply) {
  const input = normalise(request.body as ReratingInput);
  return withDb(reply, async (pool) => {
    const { errors } = await checkInput(pool, input);
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO rerating_requests (side, description, start_date, end_date, enterprise_ids, rate_table_id, reason,
           mccmncs, sender_id, no_note, priority, requested_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'rate_correction', $7, $8, $9, $10, $11, $11) RETURNING id`,
        [
          input.side,
          input.description,
          input.startDate,
          input.endDate,
          input.enterpriseIds,
          input.rateTableId,
          input.mccmncs,
          input.senderId,
          input.noNote,
          input.priority,
          me.id,
        ],
      );
      const id = rows[0].id as number;
      const change = await recordChange(c, {
        entityType: "rerating_request",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: input }],
        note: `Requested re-rating #${id}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadDetail(pool, id), change });
  });
}

export function getReratingRequest(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(
    reply,
    async (pool) => (await loadDetail(pool, id)) ?? sendProblem(reply, 404, `Re-rating ${id} not found`),
  );
}

export function updateReratingRequest(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const input = normalise(request.body as ReratingInput);
  return withDb(reply, async (pool) => {
    const before = await loadDetail(pool, id);
    if (!before) return sendProblem(reply, 404, `Re-rating ${id} not found`);
    if (before.requestStatus !== "pending_approval")
      return sendProblem(
        reply,
        409,
        `Re-rating #${id} is ${before.requestStatus.replace("_", " ")}; it can no longer change`,
      );
    if (!before.canEdit) return sendProblem(reply, 403, "Only the requester can change a pending request");
    const { errors } = await checkInput(pool, input);
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    const was = asInput(before);
    const diff: DiffEntry[] = INPUT_FIELDS.filter((f) => JSON.stringify(was[f]) !== JSON.stringify(input[f])).map(
      (f) => ({ entity_id: id, field: f, before: was[f], after: input[f] }),
    );
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE rerating_requests SET side = $2, description = $3, start_date = $4, end_date = $5, enterprise_ids = $6,
                rate_table_id = $7, mccmncs = $8, sender_id = $9, no_note = $10, priority = $11, updated_by_id = $12,
                updated_at = now() WHERE id = $1`,
        [
          id,
          input.side,
          input.description,
          input.startDate,
          input.endDate,
          input.enterpriseIds,
          input.rateTableId,
          input.mccmncs,
          input.senderId,
          input.noNote,
          input.priority,
          me.id,
        ],
      );
      return recordChange(c, {
        entityType: "rerating_request",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed re-rating #${id}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadDetail(pool, id), change };
  });
}

/** Approve or decline: the checker must not be the requester (maker-checker). */
async function decide(request: FastifyRequest, reply: FastifyReply, approve: boolean, reason: string | null) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const before = await loadDetail(pool, id);
    if (!before) return sendProblem(reply, 404, `Re-rating ${id} not found`);
    if (before.requestStatus !== "pending_approval")
      return sendProblem(reply, 409, `Re-rating #${id} was already ${before.requestStatus.replace("_", " ")}`);
    if (!before.canDecide)
      return sendProblem(reply, 403, "Another user must approve or decline this request (maker-checker)");
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE rerating_requests SET request_status = $2, reprocess_status = $3, decided_by_id = $4, decided_at = now(),
                decline_reason = $5, updated_by_id = $4, updated_at = now() WHERE id = $1`,
        [id, approve ? "approved" : "declined", approve ? "in_queue" : "not_started", me.id, reason],
      );
      return recordChange(c, {
        entityType: "rerating_request",
        entityIds: [id],
        changeType: "edit",
        diff: [
          {
            entity_id: id,
            field: "requestStatus",
            before: "pending_approval",
            after: approve ? "approved" : "declined",
          },
        ],
        note: approve ? `Approved re-rating #${id}` : `Declined re-rating #${id}: ${reason}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    if (approve) scheduleProcessing(pool, id, me.id);
    return { record: await loadDetail(pool, id), change };
  });
}

export const approveReratingRequest = (request: FastifyRequest, reply: FastifyReply) =>
  decide(request, reply, true, null);
export const declineReratingRequest = (request: FastifyRequest, reply: FastifyReply) =>
  decide(request, reply, false, (request.body as ReratingDecline).reason.trim());

/** Background job: In Queue, then In Process, then Completed (or Failed). */
function scheduleProcessing(pool: pg.Pool, id: number, userId: number, delayMs = 1500) {
  setTimeout(() => void processRerating(pool, id, userId), delayMs).unref();
}

export async function processRerating(pool: pg.Pool, id: number, userId: number): Promise<void> {
  const detail = await loadDetail(pool, id);
  if (!detail || detail.reprocessStatus !== "in_queue") return;
  await pool.query("UPDATE rerating_requests SET reprocess_status = 'in_process', started_at = now() WHERE id = $1", [
    id,
  ]);
  const started = new Date();
  try {
    const input = asInput(detail);
    const result = await computeRerating(pool, input);
    if (!result) throw new Error("The EDR store is not available; approve a new request later");
    await inTransaction(pool, async (c) => {
      for (const r of result.rows) {
        let txId: number | null = null;
        if (r.amount !== 0 && !input.noNote) {
          const { rows } = await c.query(
            `INSERT INTO transactions (enterprise_id, side, payment_mode, payment_type, transaction_type, amount, currency,
               amount_base, payment_date, description, created_by_id, updated_by_id)
             SELECT $1, $2, NULL, $3, 'reprocess', $4, $5, round($4 / cl.rate_per_usd, 2), current_date, $6, $7, $7
               FROM currency_latest cl WHERE cl.iso = $5
             RETURNING id`,
            [
              r.enterpriseId,
              input.side,
              r.paymentType,
              Math.abs(r.amount),
              r.currency,
              `Re-rating #${id}: ${detail.rateTableName} ${input.startDate} to ${input.endDate}`,
              userId,
            ],
          );
          txId = rows[0]?.id ?? null;
        }
        await c.query(
          `INSERT INTO rerating_results (request_id, enterprise_id, total_edrs, old_amount, new_amount, currency,
             transaction_id, transaction_status, start_time, end_time, updated_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)`,
          [
            id,
            r.enterpriseId,
            r.totalEdrs,
            r.oldAmount,
            r.newAmount,
            r.currency,
            txId,
            r.amount === 0 ? "no_difference" : input.noNote ? "not_posted" : "posted",
            started,
            userId,
          ],
        );
      }
      await c.query(
        `UPDATE rerating_requests SET reprocess_status = 'completed', finished_at = now(), total_edrs = $2 WHERE id = $1`,
        [id, result.totalEdrs],
      );
    });
  } catch (err) {
    await pool.query(
      "UPDATE rerating_requests SET reprocess_status = 'failed', finished_at = now(), error = $2 WHERE id = $1",
      [id, (err as Error).message.slice(0, 500)],
    );
  }
}
