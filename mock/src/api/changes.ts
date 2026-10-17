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
import { applyEnterpriseField } from "./enterprises.js";
import { applyTrunkField } from "./trunks.js";
import { applyRateTableEntries } from "./rates.js";
import { applyRouteRuleField } from "./routeRules.js";

interface DiffEntry {
  entity_id: number;
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Record fields that are plain columns, for records whose screens don't have their own field
 * map yet. Other fields (e.g. a vendor share inside a route) are history-only until then.
 */
const ENTITY_COLUMNS: Record<string, { table: string; columns: Record<string, string> }> = {
  translation_rule: { table: "translation_rules", columns: { status: "status", name: "name" } },
  hlr_rule: { table: "hlr_rules", columns: { status: "status", name: "name" } },
  enterprise_doc: { table: "enterprise_docs", columns: {} },
  // MCCMNC master (§6.1); DLR targets live here too (decided 2026-10-16).
  destination: {
    table: "mccmnc",
    columns: {
      dlrTargetPct: "dlr_target_pct",
      mcc: "mcc",
      mnc: "mnc",
      mccmnc: "mccmnc",
      allNetworks: "is_all_networks",
      originalMnc: "original_mnc",
      countryId: "country_id",
      network: "network",
    },
  },
  // QBR vendor stat overrides (§6.3)
  qbr_stat: {
    table: "qbr_stats",
    columns: {
      overridden: "overridden",
      overrideAsr: "override_asr",
      overrideDlr: "override_dlr",
      overrideAddSeconds: "override_add_s",
    },
  },
  // Product reference data (§6.1)
  product_category: { table: "product_categories", columns: { name: "name" } },
  country: { table: "countries", columns: { name: "name", iso: "iso", dialCode: "dial_code", region: "region" } },
  dial_code_profile: { table: "dial_code_profiles", columns: { name: "name" } },
  dial_code: { table: "dial_codes", columns: { prefix: "prefix", destinationId: "mccmnc_id" } },
  mo_number: {
    table: "mo_numbers",
    columns: {
      customerTrunkId: "customer_trunk_id",
      number: "number",
      keyword: "keyword",
      rate: "rate",
      vendorRate: "vendor_rate",
      destinationId: "mccmnc_id",
      setupCharge: "setup_charge",
      fixCharge: "fix_charge",
    },
  },
};

/** Workflow records logged for the history but not undone (§12.2 maker-checker). */
const NOT_UNDOABLE = new Set(["rerating_request"]);

const TABLES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ENTITY_COLUMNS).map(([k, v]) => [k, v.table])),
  enterprise: "enterprises",
  rate_table: "rate_tables",
  route_rule: "route_rules",
  customer_trunk: "customer_trunks",
  vendor_trunk: "vendor_trunks",
};

/** Puts each entry's `before` value back (undo restores what the change replaced). */
async function applyFields(c: pg.PoolClient, entityType: string, entries: DiffEntry[], userId: number) {
  if (entityType === "rate_table") {
    // Rate lines need ordered writes (no overlapping versions at any step).
    const rest = entries.filter((e) => e.field === "*");
    await applyRateTableEntries(
      c,
      entries.filter((e) => e.field !== "*"),
      "before",
      userId,
    );
    entries = rest;
  }
  for (const e of entries) {
    // "*" = the record itself: no value before means it was created, so undo archives it;
    // a value before means it was deleted, so undo restores it (§13.10, §13.29).
    if (e.field === "*" || (e.field === "archived" && entityType in ENTITY_COLUMNS)) {
      const table = TABLES[entityType];
      const archive = e.field === "*" ? e.before == null : e.before === true;
      if (table)
        await c.query(`UPDATE ${table} SET deleted_at = ${archive ? "now()" : "NULL"} WHERE id = $1`, [e.entity_id]);
      continue;
    }
    if (entityType === "enterprise") {
      await applyEnterpriseField(c, e.entity_id, e.field, e.before, e.after, userId);
      continue;
    }
    if (entityType === "route_rule") {
      await applyRouteRuleField(c, e.entity_id, e.field, e.before, userId);
      continue;
    }
    if (entityType === "customer_trunk" || entityType === "vendor_trunk") {
      await applyTrunkField(
        c,
        entityType === "customer_trunk" ? "customer" : "vendor",
        e.entity_id,
        e.field,
        e.before,
        e.after,
        userId,
      );
      continue;
    }
    const target = ENTITY_COLUMNS[entityType];
    const column = target?.columns[e.field];
    if (target && column)
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
    if (NOT_UNDOABLE.has(target.entity_type))
      return sendProblem(reply, 400, "Re-rating requests are not undone: edit or decline a pending request instead");
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
      await applyFields(c, target.entity_type, revert, me.id);
      const { rows: ins } = await c.query(
        `INSERT INTO changes (entity_type, entity_ids, change_type, diff, note, undo_of_id, user_id, ip)
         VALUES ($1, $2, 'undo', $3, $4, $5, $6, $7) RETURNING id`,
        [
          target.entity_type,
          // Same records as the change it undoes (rate edits list line ids in the diff only).
          target.entity_ids,
          // The inverse runs the entries backwards, so undoing this undo replays them in order.
          JSON.stringify(
            [...revert]
              .reverse()
              .map((d) => ({ entity_id: d.entity_id, field: d.field, before: d.after, after: d.before })),
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
