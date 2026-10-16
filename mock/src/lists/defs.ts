// SQL side of each list: FROM clause, an expression per catalogue field, and the
// mapping from database row to the contract's row schema.
import type { Change, Enterprise, ListId, RateTableRow, TrunkListRow, UserSummary } from "@sms/contract";
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
  archivedField: "archived",
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
    archived: { sql: "(e.deleted_at IS NOT NULL)" },
  },
  search: ["name", "alias", "accountManager"],
  idSql: "e.id",
  select: `e.id, e.name, e.alias, e.type, e.tier, e.status, e.business_company_id, bc.name AS business_company_name,
    e.account_manager_id, ${fullName("am")} AS account_manager_name, co.iso AS country,
    cb.username AS created_by, e.inserted_at, ub.username AS updated_by, e.updated_at, e.deleted_at AS archived_at`,
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
    archivedAt: iso(r.archived_at),
  }),
};

/**
 * Translation rules that run on trunk `t` (§13.2): reached through a target on the trunk,
 * its enterprise, its category or all trunks of the kind, active, and not switched off here.
 */
const rulesCountSql = (kind: "customer" | "vendor") => `(SELECT count(DISTINCT r.id)::int
    FROM translation_rule_targets tg JOIN translation_rules r ON r.id = tg.translation_rule_id
   WHERE tg.trunk_kind = '${kind}' AND r.deleted_at IS NULL AND r.status = 'active'
     AND (tg.target_type = 'all' OR (tg.target_type = 'trunk' AND tg.target_id = t.id)
          OR (tg.target_type = 'enterprise' AND tg.target_id = t.enterprise_id)
          OR (tg.target_type = 'category' AND tg.target_id = t.product_category_id))
     AND NOT EXISTS (SELECT 1 FROM translation_rule_trunk_settings s
                      WHERE s.translation_rule_id = r.id AND s.trunk_kind = '${kind}' AND s.trunk_id = t.id AND NOT s.enabled))`;

function trunkList(kind: "customer" | "vendor"): ListDef<TrunkListRow> {
  const table = kind === "customer" ? "customer_trunks" : "vendor_trunks";
  return {
    fields: listFields[kind === "customer" ? "customer_trunks" : "vendor_trunks"],
    from: `${table} t
      JOIN enterprises e ON e.id = t.enterprise_id
      LEFT JOIN product_categories pc ON pc.id = t.product_category_id
      LEFT JOIN users ub ON ub.id = t.updated_by_id`,
    baseWhere: "t.deleted_at IS NULL",
    archivedField: "archived",
    columns: {
      id: { sql: "t.id" },
      name: { sql: "t.name" },
      enterpriseName: { sql: "e.name" },
      enterpriseId: { sql: "t.enterprise_id" },
      username: { sql: "t.username" },
      category: { sql: "pc.name" },
      categoryId: { sql: "t.product_category_id" },
      protocol: { sql: "t.protocol" },
      tps: { sql: "t.tps" },
      status: { sql: "t.status" },
      bindType: { sql: "t.bind_type" },
      rulesCount: { sql: rulesCountSql(kind) },
      ...(kind === "vendor" ? { host: { sql: "t.host" } } : {}),
      updatedBy: { sql: "ub.username" },
      updatedAt: { sql: "t.updated_at" },
      archived: { sql: "(t.deleted_at IS NOT NULL)" },
    },
    search: ["name", "username", "enterpriseName"],
    idSql: "t.id",
    select: `t.id, t.enterprise_id, e.name AS enterprise_name, t.name, t.username, t.product_category_id, pc.name AS category,
      t.protocol, t.tps, t.status, t.bind_type, ${rulesCountSql(kind)} AS rules_count, ub.username AS updated_by,
      t.updated_at, t.deleted_at`,
    mapRow: (r) => ({
      id: r.id as number,
      enterpriseId: r.enterprise_id as number,
      enterpriseName: r.enterprise_name as string,
      name: r.name as string,
      username: r.username as string,
      categoryId: (r.product_category_id as number | null) ?? null,
      category: (r.category as string | null) ?? null,
      protocol: r.protocol as TrunkListRow["protocol"],
      tps: r.tps as number,
      status: r.status as TrunkListRow["status"],
      bindType: r.bind_type as string,
      rulesCount: r.rules_count as number,
      updatedBy: (r.updated_by as string | null) ?? null,
      updatedAt: iso(r.updated_at)!,
      archived: r.deleted_at != null,
    }),
  };
}

export const customerTrunkList = trunkList("customer");
export const vendorTrunkList = trunkList("vendor");

// Lines valid now; the partial index on open lines keeps this cheap (§13.12).
const activeLinesSql = `(SELECT count(*)::int FROM rate_lines l
   WHERE l.rate_table_id = rt.id AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now()))`;

export const rateTableList: ListDef<RateTableRow> = {
  fields: listFields.rate_tables,
  from: `rate_tables rt
    JOIN product_categories pc ON pc.id = rt.product_category_id
    LEFT JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id`,
  // A vendor's buy table leaves the list with its archived trunk.
  baseWhere: "rt.deleted_at IS NULL AND (vt.id IS NULL OR vt.deleted_at IS NULL)",
  archivedField: "archived",
  columns: {
    id: { sql: "rt.id" },
    name: { sql: "rt.name" },
    kind: { sql: "rt.kind" },
    category: { sql: "pc.name" },
    categoryId: { sql: "rt.product_category_id" },
    currency: { sql: "rt.currency" },
    vendorTrunkName: { sql: "vt.name" },
    vendorTrunkId: { sql: "rt.vendor_trunk_id" },
    trunkCount: {
      sql: "(SELECT count(*)::int FROM customer_trunk_rate_tables x JOIN customer_trunks ct ON ct.id = x.customer_trunk_id WHERE x.rate_table_id = rt.id AND ct.deleted_at IS NULL)",
    },
    activeLines: { sql: activeLinesSql },
    updatedAt: { sql: "rt.updated_at" },
    archived: { sql: "(rt.deleted_at IS NOT NULL OR vt.deleted_at IS NOT NULL)" },
  },
  search: ["name", "vendorTrunkName"],
  idSql: "rt.id",
  select: `rt.id, rt.name, rt.kind, rt.product_category_id, pc.name AS category, rt.currency, rt.vendor_trunk_id,
    vt.name AS vendor_trunk_name,
    (SELECT count(*)::int FROM customer_trunk_rate_tables x JOIN customer_trunks ct ON ct.id = x.customer_trunk_id WHERE x.rate_table_id = rt.id AND ct.deleted_at IS NULL) AS trunk_count,
    ${activeLinesSql} AS active_lines, rt.updated_at`,
  mapRow: (r) => ({
    id: r.id as number,
    name: r.name as string,
    kind: r.kind as RateTableRow["kind"],
    categoryId: r.product_category_id as number,
    category: r.category as string,
    currency: String(r.currency),
    vendorTrunkId: (r.vendor_trunk_id as number | null) ?? null,
    vendorTrunkName: (r.vendor_trunk_name as string | null) ?? null,
    trunkCount: r.trunk_count as number,
    activeLines: r.active_lines as number,
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
  customer_trunks: customerTrunkList as ListDef<unknown>,
  vendor_trunks: vendorTrunkList as ListDef<unknown>,
  rate_tables: rateTableList as ListDef<unknown>,
};
