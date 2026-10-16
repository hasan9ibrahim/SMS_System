// Generic handlers for POST /{list}/query and record lookups (§13.25).
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ListId, ListQuery } from "@sms/contract";
import { withDb } from "../db.js";
import { listFields } from "../lists/fields.js";
import { listDefs, enterpriseList } from "../lists/defs.js";
import { runList } from "../lists/engine.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";

/** PostgreSQL rejected a regular expression that JavaScript accepted (POSIX vs JS syntax). */
const isBadRegex = (err: unknown) => (err as { code?: string }).code === "2201B";

export function queryList(list: ListId) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.body as ListQuery;
    const errors = checkListQuery(query, listFields[list]);
    if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
    try {
      return await withDb(reply, (pool) => runList(pool, listDefs[list], query));
    } catch (err) {
      if (isBadRegex(err))
        return sendProblem(reply, 400, "Invalid list query", {
          errors: [{ path: "/filter", message: "invalid regular expression" }],
        });
      throw err;
    }
  };
}

export function getEnterprise(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    // Archived enterprises stay readable (§13.29: history and billing keep their names).
    const { rows } = await pool.query(`SELECT ${enterpriseList.select} FROM ${enterpriseList.from} WHERE e.id = $1`, [
      id,
    ]);
    return rows[0] ? enterpriseList.mapRow(rows[0]) : sendProblem(reply, 404, `Enterprise ${id} not found`);
  });
}
