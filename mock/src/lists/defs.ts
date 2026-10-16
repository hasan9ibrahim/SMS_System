// SQL side of each list: FROM clause, an expression per catalogue field, and the
// mapping from database row to the contract's row schema.
import type {
  Change,
  Destination,
  Enterprise,
  ListId,
  RateLineRow,
  RateTableRow,
  TrunkListRow,
  UserSummary,
} from "@sms/contract";
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

const scheduledSql = `(SELECT count(*)::int FROM rate_lines l WHERE l.rate_table_id = rt.id AND l.valid_from > now())`;
const nextChangeSql = `(SELECT min(l.valid_from) FROM rate_lines l WHERE l.rate_table_id = rt.id AND l.valid_from > now())`;
/** Current sell lines below the best buy of their destination and category (customer tables). */
// Lines are in the table currency, so the rate is converted once per table.
export const negativeMarginSql = `(CASE WHEN rt.kind = 'customer' THEN (SELECT count(*)::int
   FROM rate_lines l
   JOIN best_buy_rates bb ON bb.mccmnc_id = l.mccmnc_id AND bb.product_category_id = rt.product_category_id
  WHERE l.rate_table_id = rt.id AND l.sender_id IS NULL AND NOT l.is_blocked
    AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
    AND l.rate < bb.rate_usd * (SELECT cl.rate_per_usd FROM currency_latest cl WHERE cl.iso = rt.currency)) END)`;
// Trunks using a table: customer trunks for a sell table, the owning trunk for a buy table.
const usersSql = (col: string, sep: string | null) => {
  const agg = (expr: string) => (sep ? `string_agg(DISTINCT ${expr}, '${sep}')` : `(array_agg(DISTINCT ${expr}))[1:5]`);
  return `(CASE WHEN rt.kind = 'customer'
    THEN (SELECT ${agg(col)} FROM customer_trunk_rate_tables x
            JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
            JOIN enterprises e ON e.id = t.enterprise_id
           WHERE x.rate_table_id = rt.id)
    ELSE (SELECT ${agg(col)} FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id WHERE t.id = rt.vendor_trunk_id) END)`;
};
const amNamesSql = usersSql("(am.first_name || ' ' || am.last_name)", ", ").replaceAll(
  "JOIN enterprises e ON e.id = t.enterprise_id",
  "JOIN enterprises e ON e.id = t.enterprise_id JOIN users am ON am.id = e.account_manager_id",
);

export const rateTableList: ListDef<RateTableRow> = {
  fields: listFields.rate_tables,
  from: `rate_tables rt
    JOIN product_categories pc ON pc.id = rt.product_category_id
    LEFT JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id
    LEFT JOIN users ub ON ub.id = rt.updated_by_id
    LEFT JOIN rate_table_stats st ON st.rate_table_id = rt.id`,
  // A vendor's buy table leaves the list with its archived trunk.
  baseWhere: "rt.deleted_at IS NULL AND (vt.id IS NULL OR vt.deleted_at IS NULL)",
  archivedField: "archived",
  columns: {
    id: { sql: "rt.id" },
    name: { sql: "rt.name" },
    kind: { sql: "rt.kind" },
    enterpriseNames: { sql: usersSql("e.name", ", ") },
    trunkNames: { sql: usersSql("t.name", ", ") },
    category: { sql: "pc.name" },
    categoryId: { sql: "rt.product_category_id" },
    currency: { sql: "rt.currency" },
    // Counts kept by refresh_rate_table_stats() (migration 004), so sorting by them is cheap.
    activeLines: { sql: "COALESCE(st.active_lines, 0)" },
    scheduledChanges: { sql: scheduledSql },
    negativeMarginLines: { sql: "st.negative_lines" },
    avgMarginPct: { sql: "NULL::numeric" },
    moneyToday: { sql: "NULL::numeric" },
    updatedAt: { sql: "rt.updated_at" },
    updatedBy: { sql: "ub.username" },
    accountManager: { sql: amNamesSql },
    // Tables of the enterprises an AM manages (§13.12 account manager filter).
    accountManagerId: {
      sql: "NULL",
      where: (op, c, p) => {
        const ids = op === "in" ? (c.values ?? []).map(Number) : [Number(c.value)];
        return `(EXISTS (SELECT 1 FROM customer_trunk_rate_tables x
                    JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
                    JOIN enterprises e ON e.id = t.enterprise_id
                   WHERE x.rate_table_id = rt.id AND e.account_manager_id = ANY(${p(ids)}::bigint[]))
              OR EXISTS (SELECT 1 FROM enterprises e WHERE e.id = vt.enterprise_id AND e.account_manager_id = ANY(${p(ids)}::bigint[])))`;
      },
    },
    vendorTrunkName: { sql: "vt.name" },
    vendorTrunkId: { sql: "rt.vendor_trunk_id" },
    trunkCount: {
      sql: "(SELECT count(*)::int FROM customer_trunk_rate_tables x JOIN customer_trunks ct ON ct.id = x.customer_trunk_id WHERE x.rate_table_id = rt.id AND ct.deleted_at IS NULL)",
    },
    nextChangeAt: { sql: nextChangeSql },
    description: { sql: "rt.description" },
    archived: { sql: "(rt.deleted_at IS NOT NULL OR vt.deleted_at IS NOT NULL)" },
  },
  search: ["name", "vendorTrunkName", "trunkNames", "enterpriseNames"],
  idSql: "rt.id",
  select: `rt.id, rt.name, rt.kind, rt.product_category_id, pc.name AS category, rt.currency, rt.vendor_trunk_id,
    vt.name AS vendor_trunk_name, rt.description,
    (SELECT count(*)::int FROM customer_trunk_rate_tables x JOIN customer_trunks ct ON ct.id = x.customer_trunk_id WHERE x.rate_table_id = rt.id AND ct.deleted_at IS NULL) AS trunk_count,
    COALESCE(st.active_lines, 0) AS active_lines, ${scheduledSql} AS scheduled, ${nextChangeSql} AS next_change_at,
    CASE WHEN rt.kind = 'customer' THEN COALESCE(st.negative_lines, 0) END AS negative_lines, ${usersSql("t.name", null)} AS trunk_names,
    ${usersSql("e.name", null)} AS enterprise_names, ub.username AS updated_by, rt.updated_at,
    (rt.deleted_at IS NOT NULL OR vt.deleted_at IS NOT NULL) AS archived`,
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
    description: (r.description as string | null) ?? null,
    trunkNames: ((r.trunk_names as string[] | null) ?? []).filter(Boolean),
    enterpriseNames: ((r.enterprise_names as string[] | null) ?? []).filter(Boolean),
    scheduledChanges: r.scheduled as number,
    nextChangeAt: iso(r.next_change_at),
    negativeMarginLines: (r.negative_lines as number | null) ?? null,
    // Traffic figures are added from the EDR store by the handler.
    avgMarginPct: null,
    moneyToday: null,
    updatedBy: (r.updated_by as string | null) ?? null,
    archived: r.archived as boolean,
  }),
};

// ---------------------------------------------------------------- rate lines (§13.12 rate grid)

const VALID_NOW = "l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())";
const bestBuySql = "(bb.rate_usd * cl.rate_per_usd)";
const marginSql = `(l.rate - ${bestBuySql})`;
const marginPctSql = `(CASE WHEN l.rate > 0 THEN (l.rate - ${bestBuySql}) / l.rate * 100 END)`;
const changeTypeSql = `(CASE WHEN prev.rate IS NULL THEN 'new' WHEN l.rate > prev.rate THEN 'increase'
  WHEN l.rate < prev.rate THEN 'decrease' ELSE 'same' END)`;
const changePctSql = "(CASE WHEN prev.rate > 0 THEN (l.rate - prev.rate) / prev.rate * 100 END)";
const sameKey = (a: string) =>
  `${a}.rate_table_id = l.rate_table_id AND ${a}.mccmnc = l.mccmnc AND ${a}.sender_id IS NOT DISTINCT FROM l.sender_id`;

export const rateLineFrom = `rate_lines l
    JOIN rate_tables rt ON rt.id = l.rate_table_id
    JOIN mccmnc m ON m.id = l.mccmnc_id
    JOIN countries co ON co.id = m.country_id
    JOIN currency_latest cl ON cl.iso = l.currency
    LEFT JOIN best_buy_rates bb ON rt.kind = 'customer' AND bb.mccmnc_id = l.mccmnc_id AND bb.product_category_id = rt.product_category_id
    LEFT JOIN vendor_trunks bv ON bv.id = bb.vendor_trunk_id
    LEFT JOIN users ub ON ub.id = COALESCE(l.updated_by_id, l.created_by_id)
    LEFT JOIN LATERAL (SELECT p.rate FROM rate_lines p WHERE ${sameKey("p")} AND p.valid_from < l.valid_from
                        ORDER BY p.valid_from DESC LIMIT 1) prev ON true
    LEFT JOIN LATERAL (SELECT n.rate, n.valid_from FROM rate_lines n WHERE ${sameKey("n")} AND n.valid_from > l.valid_from
                        AND n.valid_from > now() ORDER BY n.valid_from LIMIT 1) nxt ON true`;

export const rateLineList: ListDef<RateLineRow> = {
  fields: listFields.rate_lines,
  from: rateLineFrom,
  columns: {
    id: { sql: "l.id" },
    rateTableId: { sql: "l.rate_table_id" },
    view: {
      sql: "NULL",
      where: (_op, c) =>
        c.value === "scheduled"
          ? "l.valid_from > now()"
          : c.value === "closed"
            ? "(l.valid_to IS NOT NULL AND l.valid_to <= now())"
            : VALID_NOW,
    },
    country: { sql: "co.name" },
    network: { sql: "m.network" },
    mccmnc: { sql: "l.mccmnc" },
    senderId: { sql: "l.sender_id" },
    rate: { sql: "l.rate" },
    bestBuy: { sql: bestBuySql },
    bestVendor: { sql: "bv.name" },
    margin: { sql: marginSql },
    marginPct: { sql: marginPctSql },
    changeType: { sql: changeTypeSql },
    changePct: { sql: changePctSql },
    validFrom: { sql: "l.valid_from" },
    validTo: { sql: "l.valid_to" },
    nextRate: { sql: "nxt.rate" },
    nextFrom: { sql: "nxt.valid_from" },
    isBlocked: { sql: "l.is_blocked" },
    negativeMargin: { sql: `(COALESCE(l.rate < ${bestBuySql}, false))` },
    dialCode: { sql: "l.dial_code" },
    sysRate: { sql: "(l.rate / cl.rate_per_usd)" },
    rateNote: { sql: "l.rate_note" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "l.updated_at" },
  },
  search: ["country", "network", "mccmnc", "senderId", "bestVendor"],
  idSql: "l.id",
  select: `l.id, l.rate_table_id, l.mccmnc_id, l.mccmnc, co.name AS country, co.iso AS country_iso, m.network,
    l.dial_code, l.sender_id, l.rate, (l.rate / cl.rate_per_usd) AS sys_rate, l.currency,
    ${bestBuySql} AS best_buy, bb.vendor_trunk_id AS best_vendor_trunk_id, bv.name AS best_vendor,
    ${marginSql} AS margin, ${marginPctSql} AS margin_pct, ${changeTypeSql} AS change_type, ${changePctSql} AS change_pct,
    l.valid_from, l.valid_to, l.stated_valid_from, nxt.rate AS next_rate, nxt.valid_from AS next_from,
    l.is_blocked, l.rate_note, ub.username AS updated_by, l.updated_at`,
  mapRow: (r) => {
    const round = (v: unknown, d: number) => (v == null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
    return {
      id: r.id as number,
      rateTableId: r.rate_table_id as number,
      mccmncId: r.mccmnc_id as number,
      mccmnc: r.mccmnc as string,
      country: r.country as string,
      countryIso: String(r.country_iso),
      network: r.network as string,
      dialCode: (r.dial_code as string | null) ?? null,
      senderId: (r.sender_id as string | null) ?? null,
      rate: r.rate as number,
      sysRate: round(r.sys_rate, 6)!,
      currency: String(r.currency),
      bestBuy: round(r.best_buy, 6),
      bestVendorTrunkId: (r.best_vendor_trunk_id as number | null) ?? null,
      bestVendor: (r.best_vendor as string | null) ?? null,
      margin: round(r.margin, 6),
      marginPct: round(r.margin_pct, 1),
      changeType: r.change_type as RateLineRow["changeType"],
      changePct: round(r.change_pct, 1),
      validFrom: iso(r.valid_from)!,
      validTo: iso(r.valid_to),
      statedValidFrom: iso(r.stated_valid_from),
      nextRate: (r.next_rate as number | null) ?? null,
      nextFrom: iso(r.next_from),
      isBlocked: r.is_blocked as boolean,
      rateNote: (r.rate_note as string | null) ?? null,
      updatedBy: (r.updated_by as string | null) ?? null,
      updatedAt: iso(r.updated_at)!,
    };
  },
};

export const destinationList: ListDef<Destination> = {
  fields: listFields.destinations,
  from: "mccmnc m JOIN countries co ON co.id = m.country_id",
  columns: {
    id: { sql: "m.id" },
    country: { sql: "co.name" },
    countryIso: { sql: "co.iso" },
    network: { sql: "m.network" },
    mccmnc: { sql: "m.mccmnc" },
    mcc: { sql: "m.mcc" },
    mnc: { sql: "m.mnc" },
    allNetworks: { sql: "m.is_all_networks" },
  },
  search: ["country", "network", "mccmnc"],
  idSql: "m.id",
  select: "m.id, m.mccmnc, m.mcc, m.mnc, co.name AS country, co.iso AS country_iso, m.network, m.is_all_networks",
  mapRow: (r) => ({
    id: r.id as number,
    mccmnc: r.mccmnc as string,
    mcc: String(r.mcc),
    mnc: r.mnc as string,
    country: r.country as string,
    countryIso: String(r.country_iso),
    network: r.is_all_networks ? "All networks" : (r.network as string),
    allNetworks: r.is_all_networks as boolean,
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
  rate_lines: rateLineList as ListDef<unknown>,
  destinations: destinationList as ListDef<unknown>,
};
