// Per-user undo (§13.10). Undo restores only the fields the change touched; if someone
// else changed one of them since, the caller gets 409 with both values and decides.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { UndoRequest } from "@sms/contract";
import { withDb } from "../db.js";
import { changeSelect, mapChange } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { CURRENT_USER_ID, canUndoOthers, getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

interface DiffEntry {
  entity_id: number;
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Record fields that are real columns, so undo also restores the record itself. Other
 * fields (e.g. a vendor share inside a route) are recorded in the history only until
 * their screens exist.
 */
const ENTITY_COLUMNS: Record<string, { table: string; columns: Record<string, string> }> = {
  route_rule: {
    table: "route_rules",
    columns: { priority: "priority", status: "status", margin: "margin", name: "name" },
  },
  customer_trunk: { table: "customer_trunks", columns: { tps: "tps", status: "status", name: "name" } },
  vendor_trunk: { table: "vendor_trunks", columns: { tps: "tps", status: "status", name: "name" } },
  translation_rule: { table: "translation_rules", columns: { status: "status", name: "name" } },
  hlr_rule: { table: "hlr_rules", columns: { status: "status", name: "name" } },
};

async function applyFields(c: pg.PoolClient, entityType: string, entries: DiffEntry[], changeType: string) {
  const target = ENTITY_COLUMNS[entityType];
  if (!target) return;
  for (const e of entries) {
    // Undoing a create archives the record; undoing a delete restores it (§13.10, §13.29).
    if (e.field === "*") {
      if (changeType === "create")
        await c.query(`UPDATE ${target.table} SET deleted_at = now() WHERE id = $1`, [e.entity_id]);
      if (changeType === "delete")
        await c.query(`UPDATE ${target.table} SET deleted_at = NULL WHERE id = $1`, [e.entity_id]);
      continue;
    }
    const column = target.columns[e.field];
    if (column)
      await c.query(`UPDATE ${target.table} SET ${column} = $2, updated_at = now() WHERE id = $1`, [
        e.entity_id,
        e.before,
      ]);
  }
}

export function undoChange(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const body = (request.body ?? {}) as UndoRequest;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `SELECT ${changeSelect} FROM changes c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [id],
    );
    const target = rows[0];
    if (!target) return sendProblem(reply, 404, `Change ${id} not found`);
    if (target.undone_by_id)
      return sendProblem(reply, 400, `Change #${id} was already undone by #${target.undone_by_id}`);
    const me = await getCurrentUser();
    if (target.user_id !== me.id && !canUndoOthers(me)) {
      return sendProblem(
        reply,
        403,
        "You can undo your own changes only; undoing others' needs the \"Undo others' changes\" permission",
      );
    }

    // Later changes by other users to the same record and field, still in force.
    const diff = target.diff as DiffEntry[];
    const { rows: later } = await pool.query(
      `SELECT c.id, c.diff, c.inserted_at, u.first_name || ' ' || u.last_name AS user_name
         FROM changes c JOIN users u ON u.id = c.user_id
        WHERE c.id > $1 AND c.user_id <> $2 AND c.entity_type = $3 AND c.entity_ids && $4::bigint[]
          AND c.change_type <> 'undo' AND NOT EXISTS (SELECT 1 FROM changes x WHERE x.undo_of_id = c.id)
        ORDER BY c.id DESC`,
      [id, target.user_id, target.entity_type, target.entity_ids],
    );
    const conflicts: {
      entityId: number;
      field: string;
      mine: unknown;
      current: unknown;
      changedBy: string;
      changedAt: string;
    }[] = [];
    for (const d of diff) {
      for (const l of later) {
        const hit = (l.diff as DiffEntry[]).find((x) => x.entity_id === d.entity_id && x.field === d.field);
        if (hit) {
          conflicts.push({
            entityId: d.entity_id,
            field: d.field,
            mine: d.after,
            current: hit.after,
            changedBy: l.user_name,
            changedAt: l.inserted_at.toISOString(),
          });
          break;
        }
      }
    }
    if (conflicts.length && !body.resolution) {
      return reply
        .code(409)
        .type("application/problem+json")
        .send({
          type: "about:blank",
          title: "Someone changed the same field since",
          status: 409,
          detail: conflicts
            .map((c) => `you set ${JSON.stringify(c.mine)}, ${c.changedBy} later set ${JSON.stringify(c.current)}`)
            .join("; "),
          conflicts,
        });
    }
    const conflicted = new Set(conflicts.map((c) => `${c.entityId}:${c.field}`));
    const revert =
      body.resolution === "keep_current" ? diff.filter((d) => !conflicted.has(`${d.entity_id}:${d.field}`)) : diff;
    if (revert.length === 0)
      return sendProblem(reply, 400, "Nothing left to undo: every field was changed by someone else since");

    const newId = await inTransaction(pool, async (c) => {
      await applyFields(c, target.entity_type, revert, target.change_type);
      const { rows: ins } = await c.query(
        `INSERT INTO changes (entity_type, entity_ids, change_type, diff, note, undo_of_id, user_id, ip)
         VALUES ($1, $2, 'undo', $3, $4, $5, $6, $7) RETURNING id`,
        [
          target.entity_type,
          [...new Set(revert.map((d) => d.entity_id))],
          JSON.stringify(
            revert.map((d) => ({ entity_id: d.entity_id, field: d.field, before: d.after, after: d.before })),
          ),
          body.note ?? `Undo of #${id} by ${me.displayName}`,
          id,
          CURRENT_USER_ID,
          request.ip,
        ],
      );
      return ins[0].id as number;
    });
    const { rows: out } = await pool.query(
      `SELECT ${changeSelect} FROM changes c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [newId],
    );
    return mapChange(out[0]);
  });
}
