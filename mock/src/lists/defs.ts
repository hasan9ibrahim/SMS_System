// SQL side of each list: FROM clause, an expression per catalogue field, and the
// mapping from database row to the contract's row schema.
import type { Change, Enterprise, ListId, UserSummary } from "@sms/contract";
import { listFields } from "./fields.js";
import type { ListDef } from "./engine.js";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const fullName = (alias: string) => `(${alias}.first_name || ' ' || ${alias}.last_name)`;

export const enterpriseList: ListDef<Enterprise> = {
  fields: listFields.enterprises,
  from: `enterprises e
    JOIN business_companies bc ON bc.id = e.business_company_id
    LEFT JOIN users am ON am.id = e.account_manager_id
    LEFT JOIN users ub ON ub.id = e.updated_by_id
    LEFT JOIN users cb ON cb.id = e.created_by_id
    LEFT JOIN countries co ON co.id = e.country_id`,
  baseWhere: "e.deleted_at IS NULL",
  columns: {
    id: { sql: "e.id" },
    name: { sql: "e.name" },
    alias: { sql: "e.alias" },
    type: { sql: "e.type" },
    tier: { sql: "e.tier" },
    status: { sql: "e.status" },
    businessCompany: { sql: "bc.name" },
    businessCompanyId: { sql: "e.business_company_id" },
    accountManager: { sql: fullName("am") },
    accountManagerId: { sql: "e.account_manager_id" },
    country: { sql: "co.iso" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "e.updated_at" },
  },
  search: ["name", "alias", "accountManager"],
  idSql: "e.id",
  select: `e.id, e.name, e.alias, e.type, e.tier, e.status, e.business_company_id, bc.name AS business_company_name,
    e.account_manager_id, ${fullName("am")} AS account_manager_name, co.iso AS country,
    cb.username AS created_by, e.inserted_at, ub.username AS updated_by, e.updated_at`,
  mapRow: (r) => ({
    id: r.id as number,
    name: r.name as string,
    alias: r.alias as string,
    type: r.type as Enterprise["type"],
    tier: r.tier as Enterprise["tier"],
    status: r.status as Enterprise["status"],
    businessCompanyId: r.business_company_id as number,
    businessCompanyName: r.business_company_name as string,
    accountManagerId: r.account_manager_id as number,
    accountManagerName: (r.account_manager_name as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.inserted_at),
    updatedBy: (r.updated_by as string | null) ?? "system",
    updatedAt: iso(r.updated_at)!,
  }),
};

export const userList: ListDef<UserSummary> = {
  fields: listFields.users,
  from: `users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN access_groups g ON g.id = u.access_group_id`,
  baseWhere: "u.deleted_at IS NULL",
  columns: {
    id: { sql: "u.id" },
    username: { sql: "u.username" },
    displayName: { sql: fullName("u") },
    email: { sql: "u.email" },
    department: { sql: "d.name" },
    accessGroup: { sql: "g.name" },
    status: { sql: "u.status" },
    isAccountManager: { sql: "u.is_account_manager" },
  },
  search: ["username", "displayName", "email"],
  idSql: "u.id",
  select: `u.id, u.username, ${fullName("u")} AS display_name, u.email, d.name AS department, g.name AS access_group,
    u.status, u.is_account_manager`,
  mapRow: (r) => ({
    id: r.id as number,
    username: r.username as string,
    displayName: r.display_name as string,
    email: r.email as string,
    department: (r.department as string | null) ?? null,
    accessGroup: (r.access_group as string | null) ?? null,
    status: r.status as UserSummary["status"],
    isAccountManager: r.is_account_manager as boolean,
  }),
};

export const changeSelect = `c.id, c.entity_type, c.entity_ids, c.change_type, c.diff, c.note, c.undo_of_id, c.user_id,
  ${fullName("u")} AS user_name, host(c.ip) AS ip, c.inserted_at,
  (SELECT max(x.id) FROM changes x WHERE x.undo_of_id = c.id) AS undone_by_id`;

export function mapChange(r: Record<string, unknown>): Change {
  const diff = (r.diff as { entity_id: number; field: string; before: unknown; after: unknown }[]) ?? [];
  return {
    id: r.id as number,
    entityType: r.entity_type as string,
    entityIds: (r.entity_ids as number[]).map(Number),
    changeType: r.change_type as Change["changeType"],
    diff: diff.map((d) => ({ entityId: d.entity_id, field: d.field, before: d.before, after: d.after })),
    note: (r.note as string | null) ?? null,
    userId: r.user_id as number,
    userName: r.user_name as string,
    ip: (r.ip as string | null) ?? null,
    at: iso(r.inserted_at)!,
    undoOfId: (r.undo_of_id as number | null) ?? null,
    undoneById: (r.undone_by_id as number | null) ?? null,
  };
}

export const changeList: ListDef<Change> = {
  fields: listFields.changes,
  from: "changes c JOIN users u ON u.id = c.user_id",
  columns: {
    id: { sql: "c.id" },
    at: { sql: "c.inserted_at" },
    userName: { sql: fullName("u") },
    entityType: { sql: "c.entity_type" },
    // A change can touch many records (bulk); match any of them.
    entityId: {
      sql: "c.entity_ids",
      where: (op, c, p) =>
        op === "in"
          ? `c.entity_ids && ${p((c.values ?? []).map(Number))}::bigint[]`
          : `${p(Number(c.value))}::bigint = ANY(c.entity_ids)`,
    },
    changeType: { sql: "c.change_type" },
    note: { sql: "c.note" },
    userId: { sql: "c.user_id" },
    undoOfId: { sql: "c.undo_of_id" },
    ip: { sql: "host(c.ip)" },
  },
  search: ["note", "userName", "entityType"],
  idSql: "c.id",
  select: changeSelect,
  mapRow: mapChange,
};

export const listDefs: Record<ListId, ListDef<unknown>> = {
  enterprises: enterpriseList as ListDef<unknown>,
  users: userList as ListDef<unknown>,
  changes: changeList as ListDef<unknown>,
};
