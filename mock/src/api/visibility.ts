// Admin › Visibility policies (§13.17): policies with presets, assignment to all account managers, a
// department or a user, lasting shares and temporary access to an enterprise, and a user's effective
// policy. Every write is in the Audit Trail (api/audit.ts) and clears the viewer cache.
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  ListQuery,
  VisibilityAssignment,
  VisibilityAssignmentInput,
  VisibilityGrantInput,
  VisibilityPolicyInput,
  VisibilityPolicyRow,
} from "@sms/contract";
import type pg from "pg";
import { withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import type { ListDef } from "../lists/engine.js";
import { runList } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { records } from "./admin.js";
import { dependencies, iso, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import {
  GRANT_FROM,
  GRANT_SELECT,
  ITEMS,
  POLICY_FROM,
  POLICY_SELECT,
  PRESETS,
  clearVisibilityCache,
  effective,
  loadViewer,
  mapGrant,
  mapPolicy,
} from "../visibility/policy.js";
import { currentViewer } from "../visibility/context.js";

type Db = pg.Pool | pg.PoolClient;
const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

// ---------------------------------------------------------------- policies

const loadPolicy = async (c: Db, id: number) => {
  const { rows } = await c.query(`SELECT ${POLICY_SELECT} FROM ${POLICY_FROM} WHERE p.id = $1`, [id]);
  return rows[0] ? mapPolicy(rows[0]) : null;
};

export const visibilityPolicyList: ListDef<VisibilityPolicyRow> = {
  fields: listFields.visibility_policies,
  from: POLICY_FROM,
  baseWhere: "p.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "p.id" },
    name: { sql: "p.name" },
    status: { sql: "p.status" },
    maskOthers: { sql: "p.mask_others" },
    includeTeam: { sql: "p.include_team" },
    assignments: { sql: "(SELECT count(*)::int FROM visibility_assignments a WHERE a.policy_id = p.id)" },
    description: { sql: "p.description" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "p.updated_at" },
    archived: { sql: "(p.deleted_at IS NOT NULL)" },
  },
  search: ["name", "description"],
  idSql: "p.id",
  select: POLICY_SELECT,
  mapRow: mapPolicy,
};

const policies = records<VisibilityPolicyInput, VisibilityPolicyRow>({
  table: "visibility_policies",
  entityType: "visibility_policy",
  label: "Visibility policy",
  fields: [
    ["name", "name"],
    ["description", "description"],
    ["status", "status"],
    ["maskOthers", "mask_others"],
    ["includeTeam", "include_team"],
    ["items", "items"],
    ["thresholds", "thresholds"],
  ],
  load: loadPolicy,
  values: (b) => ({
    ...b,
    name: b.name.trim(),
    description: b.description?.trim() || null,
    // Fixed key order, so saving the same settings is not a change.
    items: Object.fromEntries(ITEMS.map((k) => [k, { others: b.items[k].others, own: b.items[k].own }])) as never,
    thresholds: {
      marginLowPct: b.thresholds.marginLowPct,
      marginHighPct: b.thresholds.marginHighPct,
      revenueHideAbove: b.thresholds.revenueHideAbove,
      costTrafficDays: b.thresholds.costTrafficDays,
    },
  }),
  check: async (c, b, id) => {
    const errors: FieldError[] = [];
    for (const k of ITEMS)
      for (const side of ["others", "own"] as const)
        if (b.items[k][side] === "band" && k !== "margin")
          errors.push({ path: `/items/${k}/${side}`, message: "bands are for margin only" });
    if (b.thresholds.marginLowPct > b.thresholds.marginHighPct)
      errors.push({ path: "/thresholds/marginLowPct", message: "Low must not be above High" });
    const { rows } = await c.query(
      "SELECT deleted_at FROM visibility_policies WHERE lower(name) = lower($1) AND id <> coalesce($2, 0)",
      [b.name, id],
    );
    if (rows[0])
      errors.push({
        path: "/name",
        message: rows[0].deleted_at ? "a deleted policy has this name" : "another policy has this name",
      });
    return errors;
  },
  nameOf: (b) => b.name,
  deps: async (c, id) => {
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM visibility_assignments WHERE policy_id = $1`, [id]);
    return dependencies([
      {
        key: "assignments",
        label: "Assignments using it",
        count: rows[0].n,
        blocking: true,
        detail: rows[0].n ? "Assign another policy to those users first" : null,
      },
    ]);
  },
});

/** Runs a write and forgets cached viewers, so the change applies to the next request. */
const clearing =
  (h: (request: FastifyRequest, reply: FastifyReply) => unknown) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await h(request, reply);
    } finally {
      clearVisibilityCache();
    }
  };

export const getVisibilityPolicy = policies.get;
export const createVisibilityPolicy = clearing(policies.create);
export const updateVisibilityPolicy = clearing(policies.update);
export const archiveVisibilityPolicy = clearing(policies.archive);
export const restoreVisibilityPolicy = clearing(policies.restore);

function listHandler<Row>(
  list: "visibility_policies" | "visibility_assignments" | "visibility_grants",
  def: ListDef<Row>,
) {
  return (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.body as ListQuery;
    const errors = checkListQuery(query, listFields[list]);
    if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
    return withDb(reply, (pool) => runList(pool, def, query));
  };
}
export const queryVisibilityPolicies = listHandler("visibility_policies", visibilityPolicyList);

export function getVisibilityPresets() {
  return PRESETS;
}

// ---------------------------------------------------------------- assignments

const TARGET_NAME = `CASE a.target_type WHEN 'all_ams' THEN 'All account managers'
    WHEN 'department' THEN 'Department ' || (SELECT d.name FROM departments d WHERE d.id = a.target_id)
    ELSE (SELECT u.first_name || ' ' || u.last_name FROM users u WHERE u.id = a.target_id) END`;
/** Users whose effective policy comes from this assignment (non-admins; user over department over all). */
const DECIDES = `(SELECT count(*)::int FROM users u WHERE u.deleted_at IS NULL AND NOT u.is_admin AND CASE a.target_type
    WHEN 'user' THEN u.id = a.target_id
    WHEN 'department' THEN u.department_id = a.target_id
      AND NOT EXISTS (SELECT 1 FROM visibility_assignments x WHERE x.target_type = 'user' AND x.target_id = u.id)
    ELSE u.is_account_manager
      AND NOT EXISTS (SELECT 1 FROM visibility_assignments x WHERE (x.target_type = 'user' AND x.target_id = u.id)
                       OR (x.target_type = 'department' AND x.target_id = u.department_id)) END)`;
const ASSIGNMENT_FROM =
  "visibility_assignments a JOIN visibility_policies p ON p.id = a.policy_id LEFT JOIN users cb ON cb.id = a.created_by_id";
const ASSIGNMENT_SELECT = `a.id, a.policy_id, p.name AS policy_name, a.target_type, a.target_id, ${TARGET_NAME} AS target_name,
  ${DECIDES} AS users, cb.username AS created_by, a.inserted_at`;
const mapAssignment = (r: Record<string, unknown>): VisibilityAssignment => ({
  id: Number(r.id),
  policyId: Number(r.policy_id),
  policyName: r.policy_name as string,
  targetType: r.target_type as VisibilityAssignment["targetType"],
  targetId: r.target_id == null ? null : Number(r.target_id),
  targetName: (r.target_name as string | null) ?? "—",
  users: Number(r.users ?? 0),
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: iso(r.inserted_at)!,
});

export const visibilityAssignmentList: ListDef<VisibilityAssignment> = {
  fields: listFields.visibility_assignments,
  from: ASSIGNMENT_FROM,
  columns: {
    id: { sql: "a.id" },
    policyId: { sql: "a.policy_id" },
    policyName: { sql: "p.name" },
    targetType: { sql: "a.target_type" },
    targetId: { sql: "a.target_id" },
    targetName: { sql: `(${TARGET_NAME})` },
    users: { sql: DECIDES },
    createdBy: { sql: "cb.username" },
    createdAt: { sql: "a.inserted_at" },
  },
  search: ["policyName", "targetName"],
  idSql: "a.id",
  select: ASSIGNMENT_SELECT,
  mapRow: mapAssignment,
};
export const queryVisibilityAssignments = listHandler("visibility_assignments", visibilityAssignmentList);

export function assignVisibilityPolicy(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as VisibilityAssignmentInput;
  return withDb(reply, async (pool) => {
    const errors: FieldError[] = [];
    const { rows: p } = await pool.query("SELECT 1 FROM visibility_policies WHERE id = $1 AND deleted_at IS NULL", [
      b.policyId,
    ]);
    if (!p[0]) errors.push({ path: "/policyId", message: "unknown policy" });
    if (b.targetType === "all_ams" ? b.targetId !== null : b.targetId === null)
      errors.push({
        path: "/targetId",
        message: b.targetType === "all_ams" ? "must be null for all account managers" : "choose the target",
      });
    else if (b.targetType !== "all_ams") {
      const table = b.targetType === "department" ? "departments" : "users";
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [b.targetId]);
      if (!rows[0]) errors.push({ path: "/targetId", message: `unknown ${b.targetType}` });
    }
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `INSERT INTO visibility_assignments (policy_id, target_type, target_id, created_by_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (target_type, COALESCE(target_id, 0))
       DO UPDATE SET policy_id = EXCLUDED.policy_id, created_by_id = EXCLUDED.created_by_id, inserted_at = now()
       RETURNING id`,
      [b.policyId, b.targetType, b.targetId, me.id],
    );
    clearVisibilityCache();
    const { rows: a } = await pool.query(`SELECT ${ASSIGNMENT_SELECT} FROM ${ASSIGNMENT_FROM} WHERE a.id = $1`, [
      rows[0].id,
    ]);
    return reply.code(201).send(mapAssignment(a[0]));
  });
}

export function removeVisibilityAssignment(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rowCount } = await pool.query("DELETE FROM visibility_assignments WHERE id = $1", [id]);
    if (!rowCount) return sendProblem(reply, 404, `Visibility assignment ${id} not found`);
    clearVisibilityCache();
    return reply.code(204).send();
  });
}

// ---------------------------------------------------------------- shares and temporary access

const GRANT_STATE = `(CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.expires_at IS NOT NULL AND g.expires_at <= now()
  THEN 'expired' ELSE 'active' END)`;
export const visibilityGrantList: ListDef<ReturnType<typeof mapGrant>> = {
  fields: listFields.visibility_grants,
  from: GRANT_FROM,
  columns: {
    id: { sql: "g.id" },
    userId: { sql: "g.user_id" },
    userName: { sql: "(u.first_name || ' ' || u.last_name)" },
    enterpriseId: { sql: "g.enterprise_id" },
    enterpriseName: { sql: "e.name" },
    kind: { sql: "(CASE WHEN g.expires_at IS NULL THEN 'share' ELSE 'temporary' END)" },
    state: { sql: GRANT_STATE },
    expiresAt: { sql: "g.expires_at" },
    reason: { sql: "g.reason" },
    grantedBy: { sql: "gb.username" },
    createdAt: { sql: "g.inserted_at" },
    revokedAt: { sql: "g.revoked_at" },
  },
  search: ["userName", "enterpriseName", "reason"],
  idSql: "g.id",
  select: GRANT_SELECT,
  mapRow: mapGrant,
};
export const queryVisibilityGrants = listHandler("visibility_grants", visibilityGrantList);

const loadGrant = async (c: Db, id: number) => {
  const { rows } = await c.query(`SELECT ${GRANT_SELECT} FROM ${GRANT_FROM} WHERE g.id = $1`, [id]);
  return rows[0] ? mapGrant(rows[0]) : null;
};

export function createVisibilityGrant(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as VisibilityGrantInput;
  return withDb(reply, async (pool) => {
    const errors: FieldError[] = [];
    const { rows: u } = await pool.query("SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL", [b.userId]);
    if (!u[0]) errors.push({ path: "/userId", message: "unknown user" });
    const { rows: e } = await pool.query("SELECT 1 FROM enterprises WHERE id = $1 AND deleted_at IS NULL", [
      b.enterpriseId,
    ]);
    if (!e[0]) errors.push({ path: "/enterpriseId", message: "unknown enterprise" });
    if (b.expiresAt !== null && Date.parse(b.expiresAt) <= Date.now())
      errors.push({ path: "/expiresAt", message: "must be in the future" });
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `INSERT INTO visibility_grants (user_id, enterprise_id, expires_at, reason, granted_by_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [b.userId, b.enterpriseId, b.expiresAt, b.reason.trim(), me.id],
    );
    clearVisibilityCache();
    return reply.code(201).send(await loadGrant(pool, Number(rows[0].id)));
  });
}

export function revokeVisibilityGrant(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const g = await loadGrant(pool, id);
    if (!g) return sendProblem(reply, 404, `Visibility grant ${id} not found`);
    if (g.state !== "active") return sendProblem(reply, 409, `This grant is already ${g.state}`);
    const me = await getCurrentUser();
    await pool.query("UPDATE visibility_grants SET revoked_at = now(), revoked_by_id = $2 WHERE id = $1", [id, me.id]);
    clearVisibilityCache();
    return loadGrant(pool, id);
  });
}

// ---------------------------------------------------------------- effective policy

export function getUserVisibility(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const v = await loadViewer(pool, id);
    if (!v) return sendProblem(reply, 404, `User ${id} not found`);
    return effective(v);
  });
}

export function getMyVisibility(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async () => {
    const v = await currentViewer();
    return v ? effective(v) : sendProblem(reply, 503, "Visibility not available");
  });
}
