// QBR stats (§6.3): ASR, DLR and ADD per customer or vendor trunk and destination, from the
// last 24 hours of EDRs (ending at the newest EDR), refreshed every 5 minutes into qbr_stats so
// the list stays server-side (rule 3). A vendor stat can be set by hand ("Add Vendor Stat"):
// the override wins until cleared, and QBR routing uses the effective DLR per destination.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { QbrOverrideInput, QbrStat } from "@sms/contract";
import { db, withDb } from "../db.js";
import { chRows, edrNowSql } from "../edr.js";
import { qbrStatList } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { recordChange, type DiffEntry } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
const REFRESH_MS = 5 * 60_000;

/** Pulls the last 24 hours of figures from the EDR store and upserts them. Returns rows written, or null. */
export async function refreshQbrStats(pool: Db = db()): Promise<number | null> {
  const side = (s: "customer" | "vendor", col: string) => `
    SELECT '${s}' AS side, ${col} AS trunk, c_mccmnc AS code, countIf(kind = 'attempt') AS n,
           round(countIf(is_submit_success = 1) / greatest(countIf(kind = 'attempt'), 1) * 100, 1) AS asr,
           if(countIf(is_submit_success = 1) = 0, NULL,
              round(countIf(msg_status = 'DELIVRD') / countIf(is_submit_success = 1) * 100, 1)) AS dlr,
           if(countIf(msg_status = 'DELIVRD') = 0, NULL,
              round(avgIf(delivery_delay_ms, msg_status = 'DELIVRD') / 1000, 1)) AS add_s
      FROM edr_all
     WHERE submit_time > ${edrNowSql()} - INTERVAL 24 HOUR AND ${col} > 0
     GROUP BY trunk, code
    HAVING n > 0`;
  const rows = await chRows<{
    side: string;
    trunk: number;
    code: string;
    n: string;
    asr: number | null;
    dlr: number | null;
    add_s: number | null;
  }>(`${side("vendor", "v_trunk_id")} UNION ALL ${side("customer", "c_trunk_id")}`, 30_000);
  if (!rows) return null;
  const { rows: codes } = await pool.query("SELECT id, mccmnc FROM mccmnc WHERE deleted_at IS NULL");
  const codeId = new Map(codes.map((c) => [c.mccmnc as string, Number(c.id)]));
  const cols: unknown[][] = [[], [], [], [], [], [], []];
  for (const r of rows) {
    const id = codeId.get(r.code);
    if (id === undefined) continue;
    [r.side, Number(r.trunk), id, Number(r.n), r.asr, r.dlr, r.add_s].forEach((v, i) => cols[i]!.push(v));
  }
  const started = new Date();
  await pool.query(
    `INSERT INTO qbr_stats (side, trunk_id, mccmnc_id, attempts, asr, dlr, add_s, refreshed_at, updated_at)
     SELECT s, t, m, n, a, d, x, now(), now()
       FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::int[], $5::numeric[], $6::numeric[], $7::numeric[])
            AS u(s, t, m, n, a, d, x)
     ON CONFLICT (side, trunk_id, mccmnc_id) DO UPDATE SET
       attempts = EXCLUDED.attempts, asr = EXCLUDED.asr, dlr = EXCLUDED.dlr, add_s = EXCLUDED.add_s,
       refreshed_at = now(),
       updated_at = CASE WHEN qbr_stats.overridden THEN qbr_stats.updated_at ELSE now() END`,
    cols,
  );
  // Pairs with no traffic in the window lose their traffic figures (overrides stay).
  await pool.query(
    `UPDATE qbr_stats SET attempts = 0, asr = NULL, dlr = NULL, add_s = NULL, refreshed_at = now()
      WHERE (refreshed_at IS NULL OR refreshed_at < $1) AND attempts > 0`,
    [started],
  );
  return cols[0]!.length;
}

let timer: NodeJS.Timeout | null = null;
export function startQbrRefresh() {
  if (timer) return;
  const run = () => void refreshQbrStats().catch(() => undefined);
  setTimeout(run, 5_000).unref();
  timer = setInterval(run, REFRESH_MS);
  timer.unref();
}

/** Effective vendor DLR per destination code and vendor trunk, for QBR ordering. */
export async function qbrDlrByCode(pool: Db, codes: string[]): Promise<Map<string, Map<number, number>>> {
  const out = new Map<string, Map<number, number>>();
  if (!codes.length) return out;
  const { rows } = await pool.query(
    `SELECT m.mccmnc, q.trunk_id,
            CASE WHEN q.overridden THEN COALESCE(q.override_dlr, q.dlr) ELSE q.dlr END AS dlr
       FROM qbr_stats q JOIN mccmnc m ON m.id = q.mccmnc_id
      WHERE q.side = 'vendor' AND m.mccmnc = ANY($1)`,
    [codes],
  );
  for (const r of rows) {
    if (r.dlr === null) continue;
    const m = out.get(r.mccmnc) ?? new Map<number, number>();
    m.set(Number(r.trunk_id), Number(r.dlr));
    out.set(r.mccmnc, m);
  }
  return out;
}

async function loadStat(pool: Db, id: number): Promise<QbrStat | null> {
  const { rows } = await pool.query(`SELECT ${qbrStatList.select} FROM ${qbrStatList.from as string} WHERE q.id = $1`, [
    id,
  ]);
  return rows[0] ? qbrStatList.mapRow(rows[0]) : null;
}

const OVERRIDE_FIELDS = ["overridden", "overrideAsr", "overrideDlr", "overrideAddSeconds"] as const;
const overrideOf = (r: Record<string, unknown> | undefined) => ({
  overridden: (r?.overridden as boolean | undefined) ?? false,
  overrideAsr: r?.override_asr == null ? null : Number(r.override_asr),
  overrideDlr: r?.override_dlr == null ? null : Number(r.override_dlr),
  overrideAddSeconds: r?.override_add_s == null ? null : Number(r.override_add_s),
});

export function setQbrVendorOverride(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as QbrOverrideInput;
  return withDb(reply, async (pool) => {
    const [vt, m] = await Promise.all([
      pool.query("SELECT name FROM vendor_trunks WHERE id = $1 AND deleted_at IS NULL", [body.vendorTrunkId]),
      pool.query("SELECT mccmnc FROM mccmnc WHERE id = $1 AND deleted_at IS NULL", [body.destinationId]),
    ]);
    const errors = [
      ...(vt.rows[0] ? [] : [{ path: "/vendorTrunkId", message: "unknown vendor trunk" }]),
      ...(m.rows[0] ? [] : [{ path: "/destinationId", message: "unknown MCCMNC code" }]),
    ];
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    if (body.asr === null && body.dlr === null && body.addSeconds === null)
      return sendProblem(reply, 400, "Give at least one of ASR, DLR or ADD", {
        errors: [{ path: "/dlr", message: "required when ASR and ADD are empty" }],
      });
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows: old } = await c.query(
        "SELECT * FROM qbr_stats WHERE side = 'vendor' AND trunk_id = $1 AND mccmnc_id = $2",
        [body.vendorTrunkId, body.destinationId],
      );
      const { rows } = await c.query(
        `INSERT INTO qbr_stats (side, trunk_id, mccmnc_id, overridden, override_asr, override_dlr, override_add_s, updated_by_id, updated_at)
         VALUES ('vendor', $1, $2, true, $3, $4, $5, $6, now())
         ON CONFLICT (side, trunk_id, mccmnc_id) DO UPDATE SET overridden = true, override_asr = $3, override_dlr = $4,
           override_add_s = $5, updated_by_id = $6, updated_at = now()
         RETURNING id`,
        [body.vendorTrunkId, body.destinationId, body.asr, body.dlr, body.addSeconds, me.id],
      );
      const id = rows[0].id as number;
      const before = overrideOf(old[0]);
      const after = {
        overridden: true,
        overrideAsr: body.asr,
        overrideDlr: body.dlr,
        overrideAddSeconds: body.addSeconds,
      };
      const diff: DiffEntry[] = OVERRIDE_FIELDS.filter((f) => before[f] !== after[f]).map((f) => ({
        entity_id: id,
        field: f,
        before: before[f],
        after: after[f],
      }));
      const change = diff.length
        ? await recordChange(c, {
            entityType: "qbr_stat",
            entityIds: [id],
            changeType: old[0] ? "edit" : "create",
            diff,
            note: `QBR stat ${vt.rows[0].name} · ${m.rows[0].mccmnc}`,
            userId: me.id,
            ip: request.ip,
          })
        : null;
      return { id, change };
    });
    return { record: await loadStat(pool, id), change };
  });
}

export function clearQbrOverride(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT * FROM qbr_stats WHERE id = $1", [id]);
    if (!rows[0]) return sendProblem(reply, 404, `QBR stat ${id} not found`);
    const before = overrideOf(rows[0]);
    if (!before.overridden) return { record: await loadStat(pool, id), change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE qbr_stats SET overridden = false, override_asr = NULL, override_dlr = NULL, override_add_s = NULL,
                updated_by_id = $2, updated_at = now() WHERE id = $1`,
        [id, me.id],
      );
      return recordChange(c, {
        entityType: "qbr_stat",
        entityIds: [id],
        changeType: "edit",
        diff: OVERRIDE_FIELDS.filter((f) => before[f] !== (f === "overridden" ? false : null)).map((f) => ({
          entity_id: id,
          field: f,
          before: before[f],
          after: f === "overridden" ? false : null,
        })),
        note: "Cleared QBR override",
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadStat(pool, id), change };
  });
}
