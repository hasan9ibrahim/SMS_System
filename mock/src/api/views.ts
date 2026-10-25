// Saved views (§13.25, decided 2026-10-16): private to the owner, optionally shared
// read-only with chosen colleagues.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { ListId, ListQuery, SavedView, SavedViewInput } from "@sms/contract";
import { withDb } from "../db.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { currentUserId } from "./session.js";

const SELECT = `SELECT v.id, v.list, v.name, v.owner_id, o.first_name || ' ' || o.last_name AS owner_name, v.state, v.updated_at,
    COALESCE((SELECT array_agg(s.user_id ORDER BY s.user_id) FROM saved_view_shares s WHERE s.saved_view_id = v.id), '{}') AS shared
  FROM saved_views v JOIN users o ON o.id = v.owner_id`;

const toView = (r: Record<string, unknown>): SavedView => ({
  id: r.id as number,
  list: r.list as ListId,
  name: r.name as string,
  owner: { id: r.owner_id as number, displayName: r.owner_name as string },
  sharedWithUserIds: (r.shared as number[]).map(Number),
  readOnly: r.owner_id !== currentUserId(),
  state: r.state as SavedView["state"],
  updatedAt: (r.updated_at as Date).toISOString(),
});

/** The saved filter must be valid for the list, like any list query. */
function checkInput(input: SavedViewInput) {
  const { filter, sort } = input.state;
  const query = { ...(filter ? { filter } : {}), ...(sort ? { sort } : {}) } as ListQuery;
  const errors = checkListQuery(query, listFields[input.list]).map((e) => ({
    ...e,
    path: `/state${e.path}`,
  }));
  // Master Report views also keep the report settings (§13.15); their filter uses the report's fields.
  const report = input.state.report;
  if (report?.filter)
    errors.push(
      ...checkListQuery({ filter: report.filter } as ListQuery, listFields.master_report).map((e) => ({
        ...e,
        path: `/state/report${e.path}`,
      })),
    );
  if (report && input.list !== "master_report")
    errors.push({ path: "/state/report", message: "report settings belong to Master Report views" });
  return errors;
}

/** Unique name per owner and list, and shared users must exist. */
export function inputProblem(reply: FastifyReply, err: unknown) {
  const code = (err as { code?: string }).code;
  if (code === "23505")
    return sendProblem(reply, 400, "You already have a view with this name on this list", {
      errors: [{ path: "/name", message: "name already used" }],
    });
  if (code === "23503")
    return sendProblem(reply, 400, "Unknown user in sharedWithUserIds", {
      errors: [{ path: "/sharedWithUserIds", message: "unknown user" }],
    });
  throw err;
}

export async function writeShares(client: pg.PoolClient, viewId: number, userIds: number[]) {
  await client.query("DELETE FROM saved_view_shares WHERE saved_view_id = $1", [viewId]);
  const others = [...new Set(userIds)].filter((u) => u !== currentUserId());
  if (others.length) {
    await client.query("INSERT INTO saved_view_shares (saved_view_id, user_id) SELECT $1, unnest($2::bigint[])", [
      viewId,
      others,
    ]);
  }
}

async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function listViews(request: FastifyRequest, reply: FastifyReply) {
  const { list } = request.query as { list: ListId };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `${SELECT} WHERE v.list = $1 AND (v.owner_id = $2
         OR EXISTS (SELECT 1 FROM saved_view_shares s WHERE s.saved_view_id = v.id AND s.user_id = $2))
       ORDER BY (v.owner_id = $2) DESC, v.name`,
      [list, currentUserId()],
    );
    return rows.map(toView);
  });
}

export function createView(request: FastifyRequest, reply: FastifyReply) {
  const input = request.body as SavedViewInput;
  const errors = checkInput(input);
  if (errors.length) return sendProblem(reply, 400, "Invalid view", { errors });
  return withDb(reply, async (pool) => {
    try {
      const id = await inTransaction(pool, async (c) => {
        const { rows } = await c.query(
          "INSERT INTO saved_views (list, name, owner_id, state) VALUES ($1, $2, $3, $4) RETURNING id",
          [input.list, input.name.trim(), currentUserId(), JSON.stringify(input.state)],
        );
        await writeShares(c, rows[0].id, input.sharedWithUserIds ?? []);
        return rows[0].id as number;
      });
      const { rows } = await pool.query(`${SELECT} WHERE v.id = $1`, [id]);
      return reply.code(201).send(toView(rows[0]));
    } catch (err) {
      return inputProblem(reply, err);
    }
  });
}

export function updateView(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const input = request.body as SavedViewInput;
  const errors = checkInput(input);
  if (errors.length) return sendProblem(reply, 400, "Invalid view", { errors });
  return withDb(reply, async (pool) => {
    const { rows: found } = await pool.query("SELECT owner_id FROM saved_views WHERE id = $1", [id]);
    if (!found[0]) return sendProblem(reply, 404, `View ${id} not found`);
    if (found[0].owner_id !== currentUserId())
      return sendProblem(reply, 403, "Only the owner can change a view; it was shared with you read-only");
    try {
      await inTransaction(pool, async (c) => {
        await c.query("UPDATE saved_views SET list = $2, name = $3, state = $4, updated_at = now() WHERE id = $1", [
          id,
          input.list,
          input.name.trim(),
          JSON.stringify(input.state),
        ]);
        await writeShares(c, id, input.sharedWithUserIds ?? []);
      });
    } catch (err) {
      return inputProblem(reply, err);
    }
    const { rows } = await pool.query(`${SELECT} WHERE v.id = $1`, [id]);
    return toView(rows[0]);
  });
}

export function deleteView(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT owner_id FROM saved_views WHERE id = $1", [id]);
    if (!rows[0]) return sendProblem(reply, 404, `View ${id} not found`);
    if (rows[0].owner_id !== currentUserId()) return sendProblem(reply, 403, "Only the owner can delete a view");
    await pool.query("DELETE FROM saved_views WHERE id = $1", [id]);
    return reply.code(204).send();
  });
}

export { inTransaction };
