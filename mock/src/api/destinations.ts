// MCCMNC master records (§6.1): the DLR target per destination (decided 2026-10-16). Route
// rules sending here show their DLR in amber below it, unless the rule has its own target.
// Each change is one undoable change on the destination (§13.10).
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Destination, DlrTargetInput } from "@sms/contract";
import { withDb } from "../db.js";
import { destinationList } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { recordChange } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

async function loadDestination(
  db: { query: (s: string, v: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  id: number,
) {
  const { rows } = await db.query(
    `SELECT ${destinationList.select} FROM ${destinationList.from as string} WHERE m.id = $1`,
    [id],
  );
  return rows[0] ? (destinationList.mapRow(rows[0]) as Destination) : null;
}

export function setDestinationDlrTarget(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const { targetPct } = request.body as DlrTargetInput;
  return withDb(reply, async (pool) => {
    const before = await loadDestination(pool, id);
    if (!before) return sendProblem(reply, 404, `Destination ${id} not found`);
    const next = targetPct === null ? null : Math.round(targetPct * 10) / 10;
    if (before.dlrTargetPct === next) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE mccmnc SET dlr_target_pct = $2, updated_at = now() WHERE id = $1", [id, next]);
      return recordChange(c, {
        entityType: "destination",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "dlrTargetPct", before: before.dlrTargetPct, after: next }],
        note: `DLR target ${before.mccmnc} ${before.country} · ${before.network}`,
        userId: me.id,
      });
    });
    return { record: (await loadDestination(pool, id))!, change };
  });
}
