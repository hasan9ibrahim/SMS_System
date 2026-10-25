// Audit Trail (§11): every contract call that changes something is recorded after its answer is sent,
// with the user, IP, module (the operation's tag), controller (path template), method, action (the
// operation), table and master ID. Reads (list queries, previews, checks, lookups) are not recorded.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ContractOperation } from "../contract.js";
import { db } from "../db.js";

const READS =
  /^(query|preview|check|lookup|evaluate|simulate|test|diagnose|salesInsights|nocInsights|runMasterReport|runTeamReport|getTeamMember|exportTeamReport|recordPageView)/;

/** Table a path writes to: its first segment (rate-tables -> rate_tables), with a few renames. */
const TABLE_RENAMES: Record<string, string> = {
  me: "users",
  "customer-portal-users": "customer_portal_users",
  network: "trunk_binds",
  views: "saved_views",
  "audit-log": "audit_log",
  changes: "changes",
};
export function tableOf(path: string): string | null {
  const first = path.split("/")[1] ?? "";
  if (!first || first === "reports") return null;
  return TABLE_RENAMES[first] ?? first.replaceAll("-", "_");
}

export const isAudited = (op: ContractOperation) =>
  op.method !== "GET" && !op.path.endsWith("/query") && !READS.test(op.operationId);

export function auditCall(op: ContractOperation, request: FastifyRequest, reply: FastifyReply): void {
  if (!isAudited(op) || reply.statusCode === 503) return;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const masterId = params.id ?? null;
  db()
    .query(
      `INSERT INTO audit_log (user_id, ip, module, controller, method, action, table_name, master_id, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        // Set by the request's sign-in (or the sign-in call itself); none for an unknown username.
        (request as unknown as { smsUserId?: number }).smsUserId ?? null,
        request.ip || null,
        op.tag,
        op.path,
        op.method,
        op.operationId,
        tableOf(op.path),
        masterId == null ? null : String(masterId),
        reply.statusCode,
        Math.round(reply.elapsedTime),
      ],
    )
    .catch(() => {
      // The audit row is best effort in the mock; the database may be down.
    });
}
