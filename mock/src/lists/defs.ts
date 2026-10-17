// SQL side of each list: FROM clause, an expression per catalogue field, and the
// mapping from database row to the contract's row schema.
import { PLATFORM_CURRENCY, toPlatformSql } from "../currency.js";
import type {
  Change,
  Country,
  Destination,
  DialCode,
  DialCodeProfile,
  MoNumber,
  BillingCycleRow,
  CurrencyRateHistoryRow,
  CurrencyRateRow,
  CurrencyRow,
  EnterpriseBalanceRow,
  HlrPolicyRow,
  InvoiceRow,
  TransactionRow,
  HlrProviderRate,
  HlrProviderRow,
  HlrRuleRow,
  NumberList,
  NumberListEntry,
  ProductCategory,
  TranslationRuleRow,
  QbrStat,
  ReratingRequest,
  RouteMapRow,
  Enterprise,
  ListId,
  RateLineRow,
  RateTableRow,
  RouteRuleRow,
  TrafficWindow,
  TrunkListRow,
  UserSummary,
} from "@sms/contract";
import type { ListQuery } from "@sms/contract";
import { listFields } from "./fields.js";
import type { ListDef } from "./engine.js";

const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
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

/**
 * A trunk's currency (decided 2026-10-17 for the MO reference book): its first rate table's (a
 * vendor trunk's buy table), else the enterprise's billing currency for that side, else the
 * platform currency.
 */
export function trunkCurrencySql(kind: "customer" | "vendor", alias: string): string {
  const table =
    kind === "customer"
      ? `(SELECT rt.currency FROM customer_trunk_rate_tables x JOIN rate_tables rt ON rt.id = x.rate_table_id
          WHERE x.customer_trunk_id = ${alias}.id AND rt.deleted_at IS NULL ORDER BY x.position LIMIT 1)`
      : `(SELECT rt.currency FROM rate_tables rt WHERE rt.vendor_trunk_id = ${alias}.id)`;
  return `COALESCE(${table},
    (SELECT eb.currency FROM enterprise_billing eb WHERE eb.enterprise_id = ${alias}.enterprise_id AND eb.side = '${kind}'),
    '${PLATFORM_CURRENCY}')`;
}

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
      currency: { sql: trunkCurrencySql(kind, "t") },
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
      ${trunkCurrencySql(kind, "t")} AS currency, t.protocol, t.tps, t.status, t.bind_type, ${rulesCountSql(kind)} AS rules_count, ub.username AS updated_by,
      t.updated_at, t.deleted_at`,
    mapRow: (r) => ({
      id: r.id as number,
      enterpriseId: r.enterprise_id as number,
      enterpriseName: r.enterprise_name as string,
      name: r.name as string,
      username: r.username as string,
      categoryId: (r.product_category_id as number | null) ?? null,
      category: (r.category as string | null) ?? null,
      currency: String(r.currency),
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
    sysRate: { sql: toPlatformSql("l.rate") },
    rateNote: { sql: "l.rate_note" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "l.updated_at" },
  },
  search: ["country", "network", "mccmnc", "senderId", "bestVendor"],
  idSql: "l.id",
  select: `l.id, l.rate_table_id, l.mccmnc_id, l.mccmnc, co.name AS country, co.iso AS country_iso, m.network,
    l.dial_code, l.sender_id, l.rate, ${toPlatformSql("l.rate")} AS sys_rate, l.currency,
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
  from: "mccmnc m JOIN countries co ON co.id = m.country_id LEFT JOIN users ub ON ub.id = m.updated_by_id",
  baseWhere: "m.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "m.id" },
    country: { sql: "co.name" },
    countryId: { sql: "m.country_id" },
    countryIso: { sql: "co.iso" },
    dialCode: { sql: "co.dial_code" },
    network: { sql: "m.network" },
    mccmnc: { sql: "m.mccmnc" },
    mcc: { sql: "m.mcc" },
    mnc: { sql: "m.mnc" },
    originalMnc: { sql: "m.original_mnc" },
    allNetworks: { sql: "m.is_all_networks" },
    dlrTargetPct: { sql: "m.dlr_target_pct" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "m.updated_at" },
    archived: { sql: "(m.deleted_at IS NOT NULL)" },
  },
  search: ["country", "network", "mccmnc"],
  idSql: "m.id",
  select: `m.id, m.mccmnc, m.mcc, m.mnc, m.original_mnc, m.country_id, co.name AS country, co.iso AS country_iso,
    co.dial_code, m.network, m.is_all_networks, m.dlr_target_pct, ub.username AS updated_by, m.updated_at, m.deleted_at`,
  mapRow: (r) => ({
    id: r.id as number,
    mccmnc: r.mccmnc as string,
    mcc: String(r.mcc),
    mnc: r.mnc as string,
    originalMnc: (r.original_mnc as string | null) ?? null,
    countryId: r.country_id as number,
    country: r.country as string,
    countryIso: String(r.country_iso),
    dialCode: r.dial_code as string,
    network: r.is_all_networks ? "All networks" : (r.network as string),
    allNetworks: r.is_all_networks as boolean,
    dlrTargetPct: r.dlr_target_pct == null ? null : Number(r.dlr_target_pct),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

// ---------------------------------------------------------------- product reference data (§6.1)

const usedBy = (table: string, col = "product_category_id") =>
  `(SELECT count(*) FROM ${table} x WHERE x.${col} = pc.id AND x.deleted_at IS NULL)`;

export const productCategoryList: ListDef<ProductCategory> = {
  fields: listFields.product_categories,
  from: "product_categories pc LEFT JOIN users ub ON ub.id = pc.updated_by_id",
  baseWhere: "pc.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "pc.id" },
    name: { sql: "pc.name" },
    customerTrunks: { sql: usedBy("customer_trunks") },
    vendorTrunks: { sql: usedBy("vendor_trunks") },
    rateTables: { sql: usedBy("rate_tables") },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "pc.updated_at" },
    archived: { sql: "(pc.deleted_at IS NOT NULL)" },
  },
  search: ["name"],
  idSql: "pc.id",
  select: `pc.id, pc.name, ${usedBy("customer_trunks")} AS customer_trunks, ${usedBy("vendor_trunks")} AS vendor_trunks,
    ${usedBy("rate_tables")} AS rate_tables, ub.username AS updated_by, pc.updated_at, pc.deleted_at`,
  mapRow: (r) => ({
    id: r.id as number,
    name: r.name as string,
    customerTrunks: Number(r.customer_trunks),
    vendorTrunks: Number(r.vendor_trunks),
    rateTables: Number(r.rate_tables),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

const countryNetworks = "(SELECT count(*) FROM mccmnc x WHERE x.country_id = co.id AND x.deleted_at IS NULL)";

export const countryList: ListDef<Country> = {
  fields: listFields.countries,
  from: "countries co LEFT JOIN users ub ON ub.id = co.updated_by_id",
  columns: {
    id: { sql: "co.id" },
    name: { sql: "co.name" },
    iso: { sql: "co.iso" },
    dialCode: { sql: "co.dial_code" },
    region: { sql: "co.region" },
    networks: { sql: countryNetworks },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "co.updated_at" },
  },
  search: ["name", "iso", "dialCode"],
  idSql: "co.id",
  select: `co.id, co.name, co.iso, co.dial_code, co.region, ${countryNetworks} AS networks, ub.username AS updated_by,
    co.updated_at`,
  mapRow: (r) => ({
    id: r.id as number,
    name: r.name as string,
    iso: String(r.iso),
    dialCode: r.dial_code as string,
    region: r.region as string,
    networks: Number(r.networks),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
  }),
};

const profilePrefixes = "(SELECT count(*) FROM dial_codes x WHERE x.profile = dp.name AND x.deleted_at IS NULL)";
const profileCodes =
  "(SELECT count(DISTINCT x.mccmnc_id) FROM dial_codes x WHERE x.profile = dp.name AND x.deleted_at IS NULL)";
// A profile shows the latest change to it or its prefixes.
const profileUpdated = `GREATEST(dp.updated_at,
  (SELECT max(x.updated_at) FROM dial_codes x WHERE x.profile = dp.name AND x.updated_by_id IS NOT NULL))`;
const profileUpdatedBy = `COALESCE((SELECT u.username FROM dial_codes x JOIN users u ON u.id = x.updated_by_id
  WHERE x.profile = dp.name AND x.updated_at > dp.updated_at ORDER BY x.updated_at DESC LIMIT 1), ub.username)`;

export const dialCodeProfileList: ListDef<DialCodeProfile> = {
  fields: listFields.dial_code_profiles,
  from: "dial_code_profiles dp LEFT JOIN users ub ON ub.id = dp.updated_by_id",
  baseWhere: "dp.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "dp.id" },
    name: { sql: "dp.name" },
    prefixes: { sql: profilePrefixes },
    destinations: { sql: profileCodes },
    updatedBy: { sql: profileUpdatedBy },
    updatedAt: { sql: profileUpdated },
    archived: { sql: "(dp.deleted_at IS NOT NULL)" },
  },
  search: ["name"],
  idSql: "dp.id",
  select: `dp.id, dp.name, ${profilePrefixes} AS prefixes, ${profileCodes} AS destinations,
    ${profileUpdatedBy} AS updated_by, ${profileUpdated} AS updated_at, dp.deleted_at`,
  mapRow: (r) => ({
    id: r.id as number,
    name: r.name as string,
    isDefault: r.name === "All",
    prefixes: Number(r.prefixes),
    destinations: Number(r.destinations),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

export const dialCodeList: ListDef<DialCode> = {
  fields: listFields.dial_codes,
  from: `dial_codes d JOIN dial_code_profiles dp ON dp.name = d.profile JOIN mccmnc m ON m.id = d.mccmnc_id
    JOIN countries co ON co.id = m.country_id LEFT JOIN users ub ON ub.id = d.updated_by_id`,
  baseWhere: "d.deleted_at IS NULL",
  columns: {
    id: { sql: "d.id" },
    profileId: { sql: "dp.id" },
    prefix: { sql: "d.prefix" },
    mccmnc: { sql: "m.mccmnc" },
    country: { sql: "co.name" },
    network: { sql: "CASE WHEN m.is_all_networks THEN 'All networks' ELSE m.network END" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "d.updated_at" },
  },
  search: ["prefix", "mccmnc", "country", "network"],
  idSql: "d.id",
  select: `d.id, dp.id AS profile_id, dp.name AS profile, d.prefix, m.id AS mccmnc_id, m.mccmnc, co.name AS country,
    CASE WHEN m.is_all_networks THEN 'All networks' ELSE m.network END AS network, ub.username AS updated_by, d.updated_at`,
  mapRow: (r) => ({
    id: r.id as number,
    profileId: r.profile_id as number,
    profile: r.profile as string,
    prefix: r.prefix as string,
    destinationId: r.mccmnc_id as number,
    mccmnc: r.mccmnc as string,
    country: r.country as string,
    network: r.network as string,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
  }),
};

const moDestination =
  "CASE WHEN m.id IS NULL THEN NULL WHEN m.is_all_networks THEN co.name || ' · All networks' ELSE co.name || ' · ' || m.network END";

export const moNumberList: ListDef<MoNumber> = {
  fields: listFields.mo_numbers,
  from: `mo_numbers mo JOIN customer_trunks ct ON ct.id = mo.customer_trunk_id JOIN enterprises e ON e.id = ct.enterprise_id
    LEFT JOIN mccmnc m ON m.id = mo.mccmnc_id LEFT JOIN countries co ON co.id = m.country_id
    LEFT JOIN users cb ON cb.id = mo.created_by_id LEFT JOIN users ub ON ub.id = mo.updated_by_id`,
  baseWhere: "mo.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "mo.id" },
    customerTrunk: { sql: "ct.name" },
    customerTrunkId: { sql: "mo.customer_trunk_id" },
    enterprise: { sql: "e.name" },
    enterpriseId: { sql: "ct.enterprise_id" },
    number: { sql: "mo.number" },
    keyword: { sql: "mo.keyword" },
    rate: { sql: "mo.rate" },
    vendorRate: { sql: "mo.vendor_rate" },
    currency: { sql: trunkCurrencySql("customer", "ct") },
    mccmnc: { sql: "m.mccmnc" },
    destination: { sql: moDestination },
    setupCharge: { sql: "mo.setup_charge" },
    fixCharge: { sql: "mo.fix_charge" },
    createdAt: { sql: "mo.inserted_at" },
    createdBy: { sql: "cb.username" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "mo.updated_at" },
    archived: { sql: "(mo.deleted_at IS NOT NULL)" },
  },
  search: ["number", "keyword", "customerTrunk", "enterprise", "mccmnc", "destination"],
  idSql: "mo.id",
  select: `mo.id, mo.customer_trunk_id, ct.name AS customer_trunk, ct.enterprise_id, e.name AS enterprise, mo.number,
    mo.keyword, mo.rate, mo.vendor_rate, ${trunkCurrencySql("customer", "ct")} AS currency, mo.mccmnc_id, m.mccmnc, ${moDestination} AS destination,
    mo.setup_charge, mo.fix_charge, mo.inserted_at, cb.username AS created_by, ub.username AS updated_by, mo.updated_at,
    mo.deleted_at`,
  mapRow: (r) => ({
    id: r.id as number,
    customerTrunkId: r.customer_trunk_id as number,
    customerTrunk: r.customer_trunk as string,
    enterpriseId: r.enterprise_id as number,
    enterprise: r.enterprise as string,
    number: r.number as string,
    keyword: (r.keyword as string | null) ?? null,
    rate: Number(r.rate),
    vendorRate: r.vendor_rate == null ? null : Number(r.vendor_rate),
    currency: String(r.currency),
    destinationId: (r.mccmnc_id as number | null) ?? null,
    mccmnc: (r.mccmnc as string | null) ?? null,
    destination: (r.destination as string | null) ?? null,
    setupCharge: Number(r.setup_charge),
    fixCharge: Number(r.fix_charge),
    createdAt: iso(r.inserted_at)!,
    createdBy: (r.created_by as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

// ---------------------------------------------------------------- route map, re-rating, QBR stats (§6.3)

/**
 * Route map rows per customer trunk, computed by api/routeMap.ts before each query. The list
 * reads them as a JSON record set, so the whole filter grammar (§13.25) works on computed columns.
 */
export const routeMapRows = new Map<number, Omit<RouteMapRow, "currency">[]>();
const ROUTE_MAP_COLUMNS: [string, string][] = [
  ["id", "bigint"],
  ["mccmnc", "text"],
  ["country", "text"],
  ["network", "text"],
  ["allNetworks", "boolean"],
  ["sellRate", "numeric"],
  ["sellCurrency", "text"],
  ["sellRateConverted", "numeric"],
  ["rateTableId", "bigint"],
  ["rateTableName", "text"],
  ["status", "text"],
  ["ruleId", "bigint"],
  ["ruleName", "text"],
  ["rulePriority", "int"],
  ["routeType", "text"],
  ["vendorTrunkId", "bigint"],
  ["vendor", "text"],
  ["vendorCost", "numeric"],
  ["margin", "numeric"],
  ["marginPct", "numeric"],
  ["decidedBy", "text"],
];

/** The trunk of a route map query (a top-level customerTrunkId eq condition), or null. */
export function routeMapTrunk(query: ListQuery): number | null {
  const top = !query.filter || query.filter.logic === "and" ? (query.filter?.conditions ?? []) : [];
  const c = top.find((x) => !("logic" in x) && x.field === "customerTrunkId" && x.op === "eq") as
    { value?: unknown } | undefined;
  return c && Number.isInteger(Number(c.value)) ? Number(c.value) : null;
}

export const routeMapList: ListDef<RouteMapRow> = {
  fields: listFields.route_map,
  from: (query) => {
    const trunk = routeMapTrunk(query) ?? 0;
    const json = JSON.stringify((routeMapRows.get(trunk) ?? []).map((r) => ({ ...r, customerTrunkId: trunk })));
    const cols = [...ROUTE_MAP_COLUMNS, ["customerTrunkId", "bigint"]].map(([c, t]) => `"${c}" ${t}`).join(", ");
    return `jsonb_to_recordset($rm$${json}$rm$::jsonb) AS rm(${cols})`;
  },
  columns: Object.fromEntries(
    [...ROUTE_MAP_COLUMNS.map(([c]) => c), "customerTrunkId"].map((c) => [c, { sql: `rm."${c}"` }]),
  ),
  search: ["country", "network", "mccmnc", "ruleName", "vendor"],
  idSql: 'rm."id"',
  select: [...ROUTE_MAP_COLUMNS.map(([c]) => `rm."${c}"`)].join(", "),
  mapRow: (r) => ({
    id: Number(r.id),
    mccmnc: r.mccmnc as string,
    country: r.country as string,
    network: r.network as string,
    allNetworks: r.allNetworks as boolean,
    sellRate: Number(r.sellRate),
    sellCurrency: r.sellCurrency as string,
    sellRateConverted: Number(r.sellRateConverted),
    rateTableId: Number(r.rateTableId),
    rateTableName: r.rateTableName as string,
    status: r.status as RouteMapRow["status"],
    ruleId: r.ruleId == null ? null : Number(r.ruleId),
    ruleName: (r.ruleName as string | null) ?? null,
    rulePriority: r.rulePriority == null ? null : Number(r.rulePriority),
    routeType: (r.routeType as RouteMapRow["routeType"]) ?? null,
    vendorTrunkId: r.vendorTrunkId == null ? null : Number(r.vendorTrunkId),
    vendor: (r.vendor as string | null) ?? null,
    vendorCost: r.vendorCost == null ? null : Number(r.vendorCost),
    margin: r.margin == null ? null : Number(r.margin),
    marginPct: r.marginPct == null ? null : Number(r.marginPct),
    decidedBy: (r.decidedBy as string | null) ?? null,
    currency: PLATFORM_CURRENCY,
  }),
};

const SIGNED_IN = Number(process.env.MOCK_USER_ID ?? 1);
const reratingEnterprises = `(SELECT string_agg(e.name, ', ' ORDER BY e.name) FROM enterprises e WHERE e.id = ANY(rr.enterprise_ids))`;

export const reratingList: ListDef<ReratingRequest> = {
  fields: listFields.rerating_requests,
  from: `rerating_requests rr JOIN rate_tables rt ON rt.id = rr.rate_table_id
    JOIN users rb ON rb.id = rr.requested_by_id LEFT JOIN users db ON db.id = rr.decided_by_id
    LEFT JOIN users ub ON ub.id = rr.updated_by_id`,
  columns: {
    id: { sql: "rr.id" },
    side: { sql: "rr.side" },
    reprocessType: { sql: "rr.reprocess_type" },
    enterprises: { sql: reratingEnterprises },
    rateTableName: { sql: "rt.name" },
    description: { sql: "rr.description" },
    senderId: { sql: "rr.sender_id" },
    startDate: { sql: "rr.start_date" },
    endDate: { sql: "rr.end_date" },
    priority: { sql: "rr.priority" },
    requestStatus: { sql: "rr.request_status" },
    reprocessStatus: { sql: "rr.reprocess_status" },
    totalEdrs: { sql: "rr.total_edrs" },
    requestedBy: { sql: "rb.username" },
    requestedAt: { sql: "rr.inserted_at" },
    decidedBy: { sql: "db.username" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "rr.updated_at" },
  },
  search: ["description", "enterprises", "rateTableName", "requestedBy"],
  idSql: "rr.id",
  select: `rr.*, rt.name AS rate_table_name, rb.username AS requested_by, db.username AS decided_by, ub.username AS updated_by,
    (SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name) FROM enterprises e
      WHERE e.id = ANY(rr.enterprise_ids)) AS enterprise_list`,
  mapRow: (r) => {
    const pending = r.request_status === "pending_approval";
    const mine = Number(r.requested_by_id) === SIGNED_IN;
    return {
      id: r.id as number,
      side: r.side as ReratingRequest["side"],
      reprocessType: r.reprocess_type as ReratingRequest["reprocessType"],
      description: (r.description as string | null) ?? null,
      senderId: (r.sender_id as string | null) ?? null,
      startDate: ymd(r.start_date),
      endDate: ymd(r.end_date),
      enterprises: ((r.enterprise_list as { id: number; name: string }[] | null) ?? []).map((e) => ({
        id: Number(e.id),
        name: e.name,
      })),
      rateTableId: Number(r.rate_table_id),
      rateTableName: r.rate_table_name as string,
      reason: "rate_correction",
      mccmncs: (r.mccmncs as string[]) ?? [],
      noNote: r.no_note as boolean,
      priority: r.priority as ReratingRequest["priority"],
      requestStatus: r.request_status as ReratingRequest["requestStatus"],
      reprocessStatus: r.reprocess_status as ReratingRequest["reprocessStatus"],
      requestedBy: r.requested_by as string,
      requestedAt: iso(r.inserted_at)!,
      decidedBy: (r.decided_by as string | null) ?? null,
      decidedAt: iso(r.decided_at),
      declineReason: (r.decline_reason as string | null) ?? null,
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      totalEdrs: r.total_edrs == null ? null : Number(r.total_edrs),
      error: (r.error as string | null) ?? null,
      canDecide: pending && !mine,
      canEdit: pending && mine,
      updatedBy: (r.updated_by as string | null) ?? null,
      updatedAt: iso(r.updated_at)!,
    };
  },
};

const eff = (col: string) => `(CASE WHEN q.overridden THEN COALESCE(q.override_${col}, q.${col}) ELSE q.${col} END)`;

export const qbrStatList: ListDef<QbrStat> = {
  fields: listFields.qbr_stats,
  // One join to customer and vendor trunks together keeps the planner's row estimates right.
  from: `qbr_stats q JOIN mccmnc m ON m.id = q.mccmnc_id JOIN countries co ON co.id = m.country_id
    JOIN (SELECT 'customer' AS side, id, name, enterprise_id, deleted_at FROM customer_trunks
          UNION ALL SELECT 'vendor', id, name, enterprise_id, deleted_at FROM vendor_trunks) tr
      ON tr.side = q.side AND tr.id = q.trunk_id
    JOIN enterprises e ON e.id = tr.enterprise_id
    LEFT JOIN users ub ON ub.id = q.updated_by_id`,
  baseWhere: "tr.deleted_at IS NULL AND (q.attempts > 0 OR q.overridden)",
  columns: {
    id: { sql: "q.id" },
    // Plain equality on the fixed lowercase values, so the planner estimates the side right.
    side: {
      sql: "q.side",
      where: (_op, c, p) => `q.side = ${p(String(c.value).toLowerCase())}`,
    },
    trunkId: { sql: "q.trunk_id" },
    trunk: { sql: "tr.name" },
    enterprise: { sql: "e.name" },
    mccmnc: { sql: "m.mccmnc" },
    country: { sql: "co.name" },
    network: { sql: "CASE WHEN m.is_all_networks THEN 'All networks' ELSE m.network END" },
    attempts: { sql: "q.attempts" },
    asr: { sql: eff("asr") },
    dlr: { sql: eff("dlr") },
    addSeconds: { sql: eff("add_s") },
    overridden: { sql: "q.overridden" },
    updatedAt: { sql: "q.updated_at" },
    updatedBy: { sql: "ub.username" },
  },
  search: ["trunk", "mccmnc", "country", "network"],
  idSql: "q.id",
  select: `q.id, q.side, q.trunk_id, tr.name AS trunk, e.id AS enterprise_id, e.name AS enterprise,
    m.id AS mccmnc_id, m.mccmnc, co.name AS country, CASE WHEN m.is_all_networks THEN 'All networks' ELSE m.network END AS network,
    q.attempts, q.asr, q.dlr, q.add_s, ${eff("asr")} AS e_asr, ${eff("dlr")} AS e_dlr, ${eff("add_s")} AS e_add,
    q.overridden, q.updated_at, CASE WHEN q.overridden THEN ub.username END AS updated_by`,
  mapRow: (r) => {
    const n = (v: unknown) => (v == null ? null : Number(v));
    return {
      id: r.id as number,
      side: r.side as QbrStat["side"],
      trunkId: Number(r.trunk_id),
      trunk: r.trunk as string,
      enterpriseId: Number(r.enterprise_id),
      enterprise: r.enterprise as string,
      destinationId: Number(r.mccmnc_id),
      mccmnc: r.mccmnc as string,
      country: r.country as string,
      network: r.network as string,
      attempts: Number(r.attempts),
      asr: n(r.e_asr),
      dlr: n(r.e_dlr),
      addSeconds: n(r.e_add),
      trafficAsr: n(r.asr),
      trafficDlr: n(r.dlr),
      trafficAddSeconds: n(r.add_s),
      overridden: r.overridden as boolean,
      updatedAt: iso(r.updated_at)!,
      updatedBy: (r.updated_by as string | null) ?? null,
    };
  },
};

// ---------------------------------------------------------------- route rules (§15.4 grid)

const WINDOW_VALUES = new Set(["15m", "1h", "24h", "7d", "30d"]);

/** The traffic window asked for in the filter (default 24h). */
export function trafficWindow(query: ListQuery): TrafficWindow {
  const found = JSON.stringify(query.filter ?? {}).match(/"field":"window","op":"eq","value":"([^"]+)"/);
  return found && WINDOW_VALUES.has(found[1]!) ? (found[1] as TrafficWindow) : "24h";
}

/**
 * A rule's DLR target (decided 2026-10-16): its own, else the lowest target among the
 * destinations it lists (a network without one uses its country's); null = no target. Block
 * rules deliver nothing by design, so they have none.
 */
const dlrTargetSql = `CASE WHEN r.route_type = 'block' THEN NULL ELSE COALESCE(r.dlr_target_pct,
  CASE WHEN r.mccmnc_mode = 'inclusive' THEN (
    SELECT min(COALESCE(dm.dlr_target_pct, dc.dlr_target_pct)) FROM unnest(r.mccmncs) AS c(code)
      LEFT JOIN mccmnc dm ON dm.mccmnc = c.code LEFT JOIN mccmnc dc ON dc.mccmnc = left(c.code, 3)) END) END`;

const trunkNamesSql = `(SELECT string_agg(t.name, ', ') FROM customer_trunks t WHERE t.id = ANY(r.customer_trunk_ids))`;
const vendorNamesSql = `(SELECT string_agg(vt.name, ', ') FROM route_rule_vendors v JOIN vendor_trunks vt ON vt.id = v.vendor_trunk_id
   WHERE v.route_rule_id = r.id)`;

export const routeRuleList: ListDef<RouteRuleRow> = {
  fields: listFields.route_rules,
  // The window is one of five fixed values (checked in trafficWindow), so it is inlined.
  from: (query) => `route_rules r
    LEFT JOIN route_rule_traffic tr ON tr.route_rule_id = r.id AND tr.time_window = '${trafficWindow(query)}'
    LEFT JOIN route_rule_groups g ON g.id = r.route_rule_group_id
    LEFT JOIN users ub ON ub.id = r.updated_by_id`,
  baseWhere: "r.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "r.id" },
    name: { sql: "r.name" },
    priority: { sql: "r.priority" },
    routeType: { sql: "r.route_type" },
    // A rule matches a category when it takes all, lists it, or doesn't exclude it.
    category: {
      sql: "NULL",
      where: (_op, c, p) => {
        const values = (c.values ?? []).map(String);
        const ids = values.filter((v) => /^\d+$/.test(v)).map(Number);
        const parts: string[] = [];
        if (values.includes("all")) parts.push("r.category_mode = 'all'");
        if (ids.length) {
          const arr = `${p(ids)}::bigint[]`;
          parts.push(`(r.category_mode = 'inclusive' AND r.category_ids && ${arr})`);
          parts.push(`(r.category_mode = 'exclusive' AND NOT (r.category_ids @> ${arr}))`);
        }
        return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
      },
    },
    customerTrunks: { sql: `(CASE WHEN r.customer_trunk_mode = 'all' THEN 'All trunks' ELSE ${trunkNamesSql} END)` },
    // "505" finds rules on 505 and its networks (50501…), and rules on 50501 find 505.
    destination: {
      sql: "array_to_string(r.mccmncs, ',')",
      where: (op, c, p) => {
        if (op === "empty") return "(r.mccmnc_mode = 'all')";
        if (op === "not_empty") return "(r.mccmnc_mode <> 'all')";
        const v = p(String(c.value ?? "").replace(/[%_]/g, ""));
        return op === "eq"
          ? `(${v} = ANY(r.mccmncs))`
          : `(EXISTS (SELECT 1 FROM unnest(r.mccmncs) m WHERE m LIKE ${v} || '%' OR ${v} LIKE m || '%'))`;
      },
    },
    vendors: { sql: vendorNamesSql },
    messages: { sql: "tr.messages" },
    asr: { sql: "tr.asr" },
    dlr: { sql: "tr.dlr" },
    dlrTarget: { sql: dlrTargetSql },
    dlrBelowTarget: { sql: `(tr.dlr < ${dlrTargetSql})` },
    margin: { sql: "tr.margin" },
    status: { sql: "r.status" },
    window: { sql: "NULL", where: () => "TRUE" },
    // Rules that apply to a trunk: all trunks, a list naming it, or an exclusion not naming it.
    customerTrunkId: {
      sql: "NULL",
      where: (_op, c, p) => {
        const id = `${p(Number(c.value))}::bigint`;
        return `(r.customer_trunk_mode = 'all' OR (r.customer_trunk_mode = 'inclusive' AND ${id} = ANY(r.customer_trunk_ids))
          OR (r.customer_trunk_mode = 'exclusive' AND NOT ${id} = ANY(r.customer_trunk_ids)))`;
      },
    },
    vendorTrunkId: {
      sql: "NULL",
      where: (_op, c, p) => {
        const id = `${p(Number(c.value))}::bigint`;
        return `(EXISTS (SELECT 1 FROM route_rule_vendors v WHERE v.route_rule_id = r.id AND v.vendor_trunk_id = ${id})
          OR (r.vendor_trunk_mode = 'inclusive' AND ${id} = ANY(r.vendor_trunk_ids)))`;
      },
    },
    groupName: { sql: "g.name" },
    startsAt: { sql: "r.starts_at" },
    stopsAt: { sql: "r.stops_at" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "r.updated_at" },
    archived: { sql: "(r.deleted_at IS NOT NULL)" },
  },
  search: ["name", "customerTrunks", "vendors", "destination"],
  idSql: "r.id",
  select: `r.id, r.name, r.priority, r.route_type, r.status, r.hunt_policy, r.category_mode, r.customer_trunk_mode,
    r.mccmnc_mode, r.mccmncs, r.mccmnc_pattern, r.vendor_trunk_mode, cardinality(r.vendor_trunk_ids) AS scope_count,
    cardinality(r.customer_trunk_ids) AS trunk_count,
    (SELECT string_agg(pc.name, ', ' ORDER BY pc.name) FROM product_categories pc WHERE pc.id = ANY(r.category_ids)) AS categories,
    ARRAY(SELECT t.name FROM unnest(r.customer_trunk_ids) WITH ORDINALITY u(id, o) JOIN customer_trunks t ON t.id = u.id
           ORDER BY u.o LIMIT 30) AS trunk_names,
    (SELECT json_agg(json_build_object('n', vt.name, 's', v.share_pct, 'l', v.level, 'b', v.is_backup)
                     ORDER BY v.level, v.share_pct DESC NULLS LAST, v.id)
       FROM route_rule_vendors v JOIN vendor_trunks vt ON vt.id = v.vendor_trunk_id WHERE v.route_rule_id = r.id) AS vendors,
    tr.messages, tr.asr, tr.dlr, ${dlrTargetSql} AS dlr_target, r.dlr_target_pct, tr.margin, r.starts_at, r.stops_at, g.name AS group_name, ub.username AS updated_by,
    r.updated_at, r.deleted_at`,
  mapRow: (r) => {
    const names = (r.trunk_names as string[]) ?? [];
    const count = r.trunk_count as number;
    const first = names.slice(0, 2).join(", ") + (count > 2 ? ` +${count - 2}` : "");
    const mode = r.customer_trunk_mode as string;
    const codes = (r.mccmncs as string[]) ?? [];
    const vendors = ((r.vendors as { n: string; s: number | null; l: number; b: boolean }[] | null) ?? []).filter(
      (v) => !v.b,
    );
    const level1 = vendors.filter((v) => v.l === (vendors[0]?.l ?? 1));
    const type = r.route_type as RouteRuleRow["routeType"];
    const hunt = r.hunt_policy as string;
    const lcrCount = vendors.length || (r.vendor_trunk_mode === "inclusive" ? (r.scope_count as number) : 0);
    const vendorsLabel =
      type === "block"
        ? "—"
        : type === "dynamic"
          ? `LCR · ${lcrCount ? `${lcrCount} vendor${lcrCount === 1 ? "" : "s"}` : "all vendors"}`
          : level1.length === 0
            ? type === "qbr"
              ? "Quality · all vendors"
              : "No vendor"
            : level1.length === 1
              ? `${level1[0]!.n} 100%`
              : hunt === "percentage"
                ? level1.map((v) => `${v.n} ${v.s ?? 0}`).join(" · ")
                : level1.map((v) => v.n).join(hunt === "round_robin" ? " / " : " › ");
    return {
      id: r.id as number,
      name: r.name as string,
      priority: r.priority as number,
      routeType: type,
      status: r.status as RouteRuleRow["status"],
      categoryLabel:
        r.category_mode === "all"
          ? "All"
          : `${r.category_mode === "exclusive" ? "All but " : ""}${(r.categories as string | null) ?? "—"}`,
      customerTrunksLabel: mode === "all" ? "All trunks" : mode === "exclusive" ? `All but ${first}` : first || "—",
      customerTrunkNames: names,
      customerTrunkCount: count,
      destinationLabel:
        r.mccmnc_mode === "all"
          ? "All"
          : r.mccmnc_pattern
            ? `/${String(r.mccmnc_pattern)}/`
            : (r.mccmnc_mode === "exclusive" ? "All but " : "") +
              (codes
                .slice(0, 3)
                .map((c) => (c.length === 3 ? `${c} · all` : c))
                .join(", ") + (codes.length > 3 ? ` +${codes.length - 3}` : "") || "—"),
      vendorsLabel,
      messages: (r.messages as number | null) ?? null,
      asr: r.asr == null ? null : Number(r.asr),
      dlr: r.dlr == null ? null : Number(r.dlr),
      dlrTarget: r.dlr_target == null ? null : Number(r.dlr_target),
      dlrTargetSource: r.dlr_target == null ? null : r.dlr_target_pct != null ? "rule" : "destination",
      margin: r.margin == null ? null : Number(r.margin),
      startsAt: iso(r.starts_at)!,
      stopsAt: iso(r.stops_at)!,
      groupName: (r.group_name as string | null) ?? null,
      updatedBy: (r.updated_by as string | null) ?? null,
      updatedAt: iso(r.updated_at)!,
      archived: r.deleted_at != null,
    };
  },
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

// ---------------------------------------------------------------- Number lists, Translation rules (§6.4, §13.2)

/** Live rules using number list `nl` (translation match and conversion lists, route rule lists and whitelists). */
export const numberListUsedBySql = (alias: string) => `(
  (SELECT count(*) FROM translation_rules x WHERE x.deleted_at IS NULL
      AND ${alias}.id IN (x.sender_list_id, x.receiver_list_id, x.sender_conversion_list_id))
  + (SELECT count(*) FROM route_rules x WHERE x.deleted_at IS NULL
      AND (${alias}.id IN (x.sender_list_id, x.receiver_list_id)
           OR EXISTS (SELECT 1 FROM route_rule_whitelists w WHERE w.route_rule_id = x.id AND w.number_list_id = ${alias}.id))))::int`;
const numberListEntries =
  "(SELECT count(*) FROM number_list_entries x WHERE x.number_list_id = nl.id AND x.deleted_at IS NULL)::int";

export const numberListList: ListDef<NumberList> = {
  fields: listFields.number_lists,
  from: "number_lists nl LEFT JOIN users ub ON ub.id = nl.updated_by_id",
  baseWhere: "nl.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "nl.id" },
    name: { sql: "nl.name" },
    listType: { sql: "nl.list_type" },
    entries: { sql: numberListEntries },
    usedBy: { sql: numberListUsedBySql("nl") },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "nl.updated_at" },
    archived: { sql: "(nl.deleted_at IS NOT NULL)" },
  },
  search: ["name"],
  idSql: "nl.id",
  select: `nl.id, nl.name, nl.list_type, ${numberListEntries} AS entries, ${numberListUsedBySql("nl")} AS used_by,
    ub.username AS updated_by, nl.updated_at, nl.deleted_at`,
  mapRow: (r) => ({
    id: r.id as number,
    name: r.name as string,
    listType: r.list_type as NumberList["listType"],
    entries: Number(r.entries),
    usedBy: Number(r.used_by),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

export const numberListEntryList: ListDef<NumberListEntry> = {
  fields: listFields.number_list_entries,
  from: "number_list_entries ne LEFT JOIN users cb ON cb.id = ne.created_by_id",
  baseWhere: "ne.deleted_at IS NULL",
  columns: {
    id: { sql: "ne.id" },
    numberListId: { sql: "ne.number_list_id" },
    value: { sql: "ne.value" },
    createdBy: { sql: "cb.username" },
    createdAt: { sql: "ne.inserted_at" },
  },
  search: ["value"],
  idSql: "ne.id",
  select: "ne.id, ne.number_list_id, ne.value, cb.username AS created_by, ne.inserted_at",
  mapRow: (r) => ({
    id: r.id as number,
    numberListId: r.number_list_id as number,
    value: r.value as string,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.inserted_at)!,
  }),
};

/** Trunks a translation rule reaches through its targets (§13.2 Used by). */
export const translationUsedBySql = (alias: string) => `(SELECT count(*)::int FROM (
    SELECT 'c' AS k, t.id FROM translation_rule_targets tg JOIN customer_trunks t ON t.deleted_at IS NULL
       AND (tg.target_type = 'all' OR (tg.target_type = 'trunk' AND tg.target_id = t.id)
            OR (tg.target_type = 'enterprise' AND tg.target_id = t.enterprise_id)
            OR (tg.target_type = 'category' AND tg.target_id = t.product_category_id))
     WHERE tg.translation_rule_id = ${alias}.id AND tg.trunk_kind = 'customer'
    UNION
    SELECT 'v', t.id FROM translation_rule_targets tg JOIN vendor_trunks t ON t.deleted_at IS NULL
       AND (tg.target_type = 'all' OR (tg.target_type = 'trunk' AND tg.target_id = t.id)
            OR (tg.target_type = 'enterprise' AND tg.target_id = t.enterprise_id)
            OR (tg.target_type = 'category' AND tg.target_id = t.product_category_id))
     WHERE tg.translation_rule_id = ${alias}.id AND tg.trunk_kind = 'vendor') u)`;
/** "3 customer trunks, 1 vendor enterprise", or "Not assigned". */
const appliesToSql = `COALESCE((SELECT string_agg(CASE WHEN g.target_type = 'all' THEN 'All ' || g.trunk_kind || ' trunks'
      ELSE g.n || ' ' || g.trunk_kind || ' ' || CASE WHEN g.n = 1 THEN g.target_type
        WHEN g.target_type = 'category' THEN 'categories' ELSE g.target_type || 's' END END, ', '
      ORDER BY g.trunk_kind, array_position(ARRAY['all','category','enterprise','trunk'], g.target_type))
    FROM (SELECT target_type, trunk_kind, count(*) AS n FROM translation_rule_targets
           WHERE translation_rule_id = tr.id GROUP BY target_type, trunk_kind) g), 'Not assigned')`;
const trConversionValue = `CASE WHEN tr.sender_conversion IN ('random_number','sender_id_template') THEN cl.name
    ELSE tr.sender_conversion_value END`;

export const translationRuleList: ListDef<TranslationRuleRow> = {
  fields: listFields.translation_rules,
  from: `translation_rules tr LEFT JOIN number_lists cl ON cl.id = tr.sender_conversion_list_id
    LEFT JOIN users ub ON ub.id = tr.updated_by_id`,
  baseWhere: "tr.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "tr.id" },
    name: { sql: "tr.name" },
    direction: { sql: "tr.direction" },
    action: { sql: "tr.action" },
    continueAfter: { sql: "tr.continue_after" },
    senderPattern: { sql: "tr.sender_pattern" },
    receiverPattern: { sql: "tr.receiver_pattern" },
    mccmncs: { sql: "array_to_string(tr.mccmncs, ',')" },
    contentPattern: { sql: "tr.content_pattern" },
    senderConversion: { sql: "tr.sender_conversion" },
    senderConversionValue: { sql: trConversionValue },
    status: { sql: "tr.status" },
    appliesTo: { sql: appliesToSql },
    usedBy: { sql: translationUsedBySql("tr") },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "tr.updated_at" },
    archived: { sql: "(tr.deleted_at IS NOT NULL)" },
  },
  search: ["name", "senderPattern", "receiverPattern", "contentPattern"],
  idSql: "tr.id",
  select: `tr.id, tr.name, tr.direction, tr.action, tr.continue_after, tr.sender_pattern, tr.receiver_pattern, tr.mccmncs,
    tr.content_pattern, tr.sender_conversion, ${trConversionValue} AS sender_conversion_value, tr.status,
    ${appliesToSql} AS applies_to, ${translationUsedBySql("tr")} AS used_by, ub.username AS updated_by, tr.updated_at,
    tr.deleted_at`,
  mapRow: (r) => ({
    id: r.id as number,
    name: r.name as string,
    direction: (r.direction as TranslationRuleRow["direction"]) ?? null,
    action: r.action as TranslationRuleRow["action"],
    continueAfter: r.continue_after as boolean,
    senderPattern: (r.sender_pattern as string | null) ?? null,
    receiverPattern: (r.receiver_pattern as string | null) ?? null,
    mccmncs: (r.mccmncs as string[]) ?? [],
    contentPattern: (r.content_pattern as string | null) ?? null,
    senderConversion: (r.sender_conversion as string | null) ?? null,
    senderConversionValue: (r.sender_conversion_value as string | null) ?? null,
    status: r.status as TranslationRuleRow["status"],
    appliesTo: r.applies_to as string,
    usedBy: Number(r.used_by),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

// ---------------------------------------------------------------- HLR (§6.5, §13.24)

/** up / slow / down from the last 24 hours (hlr_provider_stats), inactive when switched off. */
export const hlrLiveStatusSql = `CASE WHEN hp.status = 'inactive' THEN 'inactive'
    WHEN hs.success_pct IS NOT NULL AND hs.success_pct < 50 THEN 'down'
    WHEN hs.avg_response_ms IS NOT NULL AND hs.avg_response_ms > hp.timeout_ms * 0.8 THEN 'slow' ELSE 'up' END`;
/** Live HLR rules and policies using provider hp. */
export const hlrProviderRulesSql =
  "(SELECT count(*)::int FROM hlr_rules x WHERE x.hlr_provider_id = hp.id AND x.deleted_at IS NULL)";
export const hlrProviderPoliciesSql = `(SELECT count(*)::int FROM hlr_policies x WHERE x.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(x.entries) e, jsonb_array_elements_text(e -> 'providerIds') pid
                 WHERE pid::bigint = hp.id))`;
const hlrProviderRatesSql =
  "(SELECT count(*)::int FROM hlr_provider_rates x WHERE x.hlr_provider_id = hp.id AND x.deleted_at IS NULL)";

export const hlrProviderList: ListDef<HlrProviderRow> = {
  fields: listFields.hlr_providers,
  from: `hlr_providers hp LEFT JOIN hlr_provider_stats hs ON hs.hlr_provider_id = hp.id
    LEFT JOIN users ub ON ub.id = hp.updated_by_id`,
  baseWhere: "hp.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "hp.id" },
    name: { sql: "hp.name" },
    providerType: { sql: "hp.provider_type" },
    currency: { sql: "hp.currency" },
    defaultRate: { sql: "hp.default_rate" },
    cacheDays: { sql: "hp.cache_days" },
    timeoutMs: { sql: "hp.timeout_ms" },
    dailyBudget: { sql: "hp.daily_budget" },
    status: { sql: "hp.status" },
    liveStatus: { sql: hlrLiveStatusSql },
    lookups: { sql: "COALESCE(hs.lookups, 0)" },
    successPct: { sql: "hs.success_pct" },
    avgResponseMs: { sql: "hs.avg_response_ms" },
    cost: { sql: "COALESCE(hs.cost_sys, 0)" },
    rates: { sql: hlrProviderRatesSql },
    rules: { sql: hlrProviderRulesSql },
    policies: { sql: hlrProviderPoliciesSql },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "hp.updated_at" },
    archived: { sql: "(hp.deleted_at IS NOT NULL)" },
  },
  search: ["name"],
  idSql: "hp.id",
  select: `hp.id, hp.name, hp.provider_type, hp.currency, hp.default_rate, hp.cache_days, hp.timeout_ms, hp.daily_budget,
    hp.status, ${hlrLiveStatusSql} AS live_status, COALESCE(hs.lookups, 0) AS lookups, hs.success_pct, hs.avg_response_ms,
    COALESCE(hs.cost_sys, 0) AS cost, ${hlrProviderRatesSql} AS rates, ${hlrProviderRulesSql} AS rules,
    ${hlrProviderPoliciesSql} AS policies, ub.username AS updated_by, hp.updated_at, hp.deleted_at`,
  mapRow: (r) => ({
    id: Number(r.id),
    name: r.name as string,
    providerType: r.provider_type as HlrProviderRow["providerType"],
    currency: String(r.currency).trim(),
    defaultRate: Number(r.default_rate),
    cacheDays: Number(r.cache_days),
    timeoutMs: Number(r.timeout_ms),
    dailyBudget: r.daily_budget === null ? null : Number(r.daily_budget),
    status: r.status as HlrProviderRow["status"],
    liveStatus: r.live_status as HlrProviderRow["liveStatus"],
    lookups: Number(r.lookups),
    successPct: r.success_pct === null ? null : Number(r.success_pct),
    avgResponseMs: r.avg_response_ms === null ? null : Number(r.avg_response_ms),
    cost: Number(r.cost),
    rates: Number(r.rates),
    rules: Number(r.rules),
    policies: Number(r.policies),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

export const hlrProviderRateList: ListDef<HlrProviderRate> = {
  fields: listFields.hlr_provider_rates,
  from: `hlr_provider_rates hr JOIN hlr_providers hp ON hp.id = hr.hlr_provider_id JOIN mccmnc m ON m.id = hr.mccmnc_id
    JOIN countries co ON co.id = m.country_id LEFT JOIN users ub ON ub.id = hr.updated_by_id`,
  baseWhere: "hr.deleted_at IS NULL",
  columns: {
    id: { sql: "hr.id" },
    providerId: { sql: "hr.hlr_provider_id" },
    mccmnc: { sql: "m.mccmnc" },
    country: { sql: "co.name" },
    network: { sql: "CASE WHEN m.is_all_networks THEN 'All networks' ELSE m.network END" },
    rate: { sql: "hr.rate" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "hr.updated_at" },
  },
  search: ["mccmnc", "country", "network"],
  idSql: "hr.id",
  select: `hr.id, hr.hlr_provider_id, m.id AS mccmnc_id, m.mccmnc, co.name AS country,
    CASE WHEN m.is_all_networks THEN 'All networks' ELSE m.network END AS network, hr.rate, hp.currency,
    ub.username AS updated_by, hr.updated_at`,
  mapRow: (r) => ({
    id: Number(r.id),
    providerId: Number(r.hlr_provider_id),
    destinationId: Number(r.mccmnc_id),
    mccmnc: r.mccmnc as string,
    country: r.country as string,
    network: r.network as string,
    rate: Number(r.rate),
    currency: String(r.currency).trim(),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
  }),
};

/** Customer trunks an HLR rule reaches through its targets (§13.2 Used by). */
export const hlrUsedBySql = (alias: string) => `(SELECT count(DISTINCT t.id)::int FROM hlr_rule_targets tg
    JOIN customer_trunks t ON t.deleted_at IS NULL
     AND (tg.target_type = 'all' OR (tg.target_type = 'trunk' AND tg.target_id = t.id)
          OR (tg.target_type = 'enterprise' AND tg.target_id = t.enterprise_id)
          OR (tg.target_type = 'category' AND tg.target_id = t.product_category_id))
   WHERE tg.hlr_rule_id = ${alias}.id)`;
const hlrAppliesToSql = `COALESCE((SELECT string_agg(CASE WHEN g.target_type = 'all' THEN 'All customer trunks'
      ELSE g.n || ' ' || CASE WHEN g.n = 1 THEN g.target_type
        WHEN g.target_type = 'category' THEN 'categories' ELSE g.target_type || 's' END END, ', '
      ORDER BY array_position(ARRAY['all','category','enterprise','trunk'], g.target_type))
    FROM (SELECT target_type, count(*) AS n FROM hlr_rule_targets WHERE hlr_rule_id = hr.id GROUP BY target_type) g),
  'Not assigned')`;

export const hlrRuleList: ListDef<HlrRuleRow> = {
  fields: listFields.hlr_rules,
  from: `hlr_rules hr JOIN hlr_providers hp ON hp.id = hr.hlr_provider_id LEFT JOIN users ub ON ub.id = hr.updated_by_id`,
  baseWhere: "hr.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "hr.id" },
    name: { sql: "hr.name" },
    providerId: { sql: "hr.hlr_provider_id" },
    provider: { sql: "hp.name" },
    providerType: { sql: "hp.provider_type" },
    dnidPattern: { sql: "hr.dnid_pattern" },
    status: { sql: "hr.status" },
    appliesTo: { sql: hlrAppliesToSql },
    usedBy: { sql: hlrUsedBySql("hr") },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "hr.updated_at" },
    archived: { sql: "(hr.deleted_at IS NOT NULL)" },
  },
  search: ["name", "provider", "dnidPattern"],
  idSql: "hr.id",
  select: `hr.id, hr.name, hr.hlr_provider_id, hp.name AS provider, hp.provider_type, hr.dnid_pattern, hr.status,
    ${hlrAppliesToSql} AS applies_to, ${hlrUsedBySql("hr")} AS used_by, ub.username AS updated_by, hr.updated_at,
    hr.deleted_at`,
  mapRow: (r) => ({
    id: Number(r.id),
    name: r.name as string,
    providerId: Number(r.hlr_provider_id),
    provider: r.provider as string,
    providerType: r.provider_type as HlrRuleRow["providerType"],
    dnidPattern: r.dnid_pattern as string,
    status: r.status as HlrRuleRow["status"],
    appliesTo: r.applies_to as string,
    usedBy: Number(r.used_by),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

/** Live route rules whose HLR action uses policy hpo. */
export const hlrPolicyUsedBySql = `(SELECT count(*)::int FROM route_rules x WHERE x.deleted_at IS NULL
    AND (x.hlr_action ->> 'policy_id')::bigint = hpo.id)`;
const policyDestinationsSql =
  "(SELECT count(*)::int FROM jsonb_array_elements(hpo.entries) e WHERE e ->> 'code' IS NOT NULL)";
const policyCatchAllSql = "EXISTS (SELECT 1 FROM jsonb_array_elements(hpo.entries) e WHERE e ->> 'code' IS NULL)";
const policyProvidersSql = `COALESCE((SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM hlr_providers p
    WHERE p.id IN (SELECT pid::bigint FROM jsonb_array_elements(hpo.entries) e,
                   jsonb_array_elements_text(e -> 'providerIds') pid)), '')`;

export const hlrPolicyList: ListDef<HlrPolicyRow> = {
  fields: listFields.hlr_policies,
  from: "hlr_policies hpo LEFT JOIN users ub ON ub.id = hpo.updated_by_id",
  baseWhere: "hpo.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "hpo.id" },
    name: { sql: "hpo.name" },
    status: { sql: "hpo.status" },
    destinations: { sql: policyDestinationsSql },
    hasCatchAll: { sql: policyCatchAllSql },
    providerNames: { sql: policyProvidersSql },
    usedBy: { sql: hlrPolicyUsedBySql },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "hpo.updated_at" },
    archived: { sql: "(hpo.deleted_at IS NOT NULL)" },
  },
  search: ["name", "providerNames"],
  idSql: "hpo.id",
  select: `hpo.id, hpo.name, hpo.status, ${policyDestinationsSql} AS destinations, ${policyCatchAllSql} AS has_catch_all,
    ${policyProvidersSql} AS provider_names, ${hlrPolicyUsedBySql} AS used_by, ub.username AS updated_by,
    hpo.updated_at, hpo.deleted_at`,
  mapRow: (r) => ({
    id: Number(r.id),
    name: r.name as string,
    status: r.status as HlrPolicyRow["status"],
    destinations: Number(r.destinations),
    hasCatchAll: r.has_catch_all as boolean,
    providerNames: r.provider_names as string,
    usedBy: Number(r.used_by),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

// ---------------------------------------------------------------- Finance (§7, §13.33)

export const transactionList: ListDef<TransactionRow> = {
  fields: listFields.transactions,
  from: `transactions tx JOIN enterprises e ON e.id = tx.enterprise_id LEFT JOIN invoices inv ON inv.id = tx.invoice_id
    LEFT JOIN users ub ON ub.id = tx.updated_by_id`,
  baseWhere: "tx.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "tx.id" },
    side: { sql: "tx.side" },
    enterpriseId: { sql: "tx.enterprise_id" },
    enterprise: { sql: "e.name" },
    paymentDate: { sql: "tx.payment_date" },
    transactionTime: { sql: "tx.inserted_at" },
    paymentMode: { sql: "tx.payment_mode" },
    paymentType: { sql: "tx.payment_type" },
    transactionType: { sql: "tx.transaction_type" },
    amount: { sql: "tx.amount" },
    currency: { sql: "tx.currency" },
    amountBase: { sql: "tx.amount_base" },
    baseCurrency: { sql: "tx.base_currency" },
    invoiceNumber: { sql: "inv.invoice_number" },
    description: { sql: "tx.description" },
    confirmationStatus: { sql: "tx.confirmation_status" },
    includeInSoa: { sql: "tx.include_in_soa" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "tx.updated_at" },
    archived: { sql: "(tx.deleted_at IS NOT NULL)" },
  },
  search: ["enterprise", "description", "invoiceNumber"],
  idSql: "tx.id",
  select: `tx.id, tx.side, tx.enterprise_id, e.name AS enterprise, tx.payment_mode, tx.payment_type, tx.transaction_type,
    tx.amount, tx.currency, tx.amount_base, tx.base_currency, tx.payment_date, tx.inserted_at, tx.invoice_id,
    inv.invoice_number, tx.description, tx.send_confirmation, tx.confirmation_status, tx.include_in_soa, tx.exclude_reason,
    ub.username AS updated_by, tx.updated_at, tx.deleted_at`,
  mapRow: (r) => ({
    id: Number(r.id),
    side: r.side as TransactionRow["side"],
    enterpriseId: Number(r.enterprise_id),
    enterprise: r.enterprise as string,
    paymentMode: (r.payment_mode as TransactionRow["paymentMode"]) ?? null,
    paymentType: r.payment_type as TransactionRow["paymentType"],
    transactionType: r.transaction_type as TransactionRow["transactionType"],
    amount: Number(r.amount),
    currency: String(r.currency).trim(),
    amountBase: Number(r.amount_base),
    baseCurrency: String(r.base_currency ?? r.currency).trim(),
    paymentDate: ymd(r.payment_date),
    transactionTime: iso(r.inserted_at)!,
    invoiceId: r.invoice_id === null ? null : Number(r.invoice_id),
    invoiceNumber: (r.invoice_number as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    sendConfirmation: r.send_confirmation as boolean,
    confirmationStatus: r.confirmation_status as TransactionRow["confirmationStatus"],
    includeInSoa: r.include_in_soa as boolean,
    excludeReason: (r.exclude_reason as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

export const invoiceList: ListDef<InvoiceRow> = {
  fields: listFields.invoices,
  from: "invoices inv JOIN enterprises e ON e.id = inv.enterprise_id",
  baseWhere: "inv.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "inv.id" },
    invoiceNumber: { sql: "inv.invoice_number" },
    enterpriseId: { sql: "inv.enterprise_id" },
    enterprise: { sql: "e.name" },
    enterpriseType: { sql: "e.type" },
    invoiceType: { sql: "inv.invoice_type" },
    billingType: { sql: "inv.billing_type" },
    currency: { sql: "inv.currency" },
    invoiceDate: { sql: "inv.invoice_date" },
    usageStart: { sql: "inv.usage_start" },
    usageEnd: { sql: "inv.usage_end" },
    dueDate: { sql: "inv.due_date" },
    openingBalance: { sql: "inv.opening_balance" },
    usageCharges: { sql: "inv.usage_charges" },
    closingBalance: { sql: "inv.closing_balance" },
    dueAmount: { sql: "inv.due_amount" },
    messageCount: { sql: "inv.message_count" },
    status: { sql: "inv.status" },
    paymentStatus: { sql: "inv.payment_status" },
    emailStatus: { sql: "inv.email_status" },
    remarks: { sql: "inv.remarks" },
    archived: { sql: "(inv.deleted_at IS NOT NULL)" },
  },
  search: ["invoiceNumber", "enterprise"],
  idSql: "inv.id",
  select: `inv.*, e.name AS enterprise, e.type AS enterprise_type`,
  mapRow: (r) => ({
    id: Number(r.id),
    invoiceNumber: r.invoice_number as string,
    enterpriseId: Number(r.enterprise_id),
    enterprise: r.enterprise as string,
    enterpriseType: r.enterprise_type as string,
    invoiceType: r.invoice_type as InvoiceRow["invoiceType"],
    billingType: r.billing_type as InvoiceRow["billingType"],
    currency: String(r.currency).trim(),
    invoiceDate: ymd(r.invoice_date),
    usageStart: ymd(r.usage_start),
    usageEnd: ymd(r.usage_end),
    dueDate: ymd(r.due_date),
    openingBalance: Number(r.opening_balance),
    usageCharges: Number(r.usage_charges),
    closingBalance: Number(r.closing_balance),
    dueAmount: Number(r.due_amount),
    messageCount: Number(r.message_count),
    status: r.status as InvoiceRow["status"],
    paymentStatus: r.payment_status as InvoiceRow["paymentStatus"],
    emailStatus: r.email_status as InvoiceRow["emailStatus"],
    remarks: (r.remarks as string | null) ?? null,
    archivedAt: iso(r.deleted_at),
  }),
};

const currencyRateSql = "(SELECT cl.rate_per_usd FROM currency_latest cl WHERE cl.iso = c.iso)";
const currencyRateAtSql =
  "(SELECT max(r.valid_from) FROM currency_rates r WHERE r.iso = c.iso AND r.valid_from <= now())";
const currencyEnterprisesSql = "(SELECT count(*)::int FROM enterprise_billing b WHERE b.currency = c.iso)";

export const currencyList: ListDef<CurrencyRow> = {
  fields: listFields.currencies,
  from: "currencies c LEFT JOIN users ub ON ub.id = c.updated_by_id",
  baseWhere: "c.deleted_at IS NULL",
  columns: {
    id: { sql: "c.id" },
    name: { sql: "c.name" },
    iso: { sql: "c.iso" },
    symbol: { sql: "c.symbol" },
    ratePerUsd: { sql: currencyRateSql },
    rateUpdatedAt: { sql: currencyRateAtSql },
    enterprises: { sql: currencyEnterprisesSql },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "c.updated_at" },
  },
  search: ["name", "iso"],
  idSql: "c.id",
  select: `c.id, c.name, c.iso, c.symbol, ${currencyRateSql} AS rate, ${currencyRateAtSql} AS rate_at,
    ${currencyEnterprisesSql} AS enterprises, ub.username AS updated_by, c.updated_at`,
  mapRow: (r) => ({
    id: Number(r.id),
    name: r.name as string,
    iso: String(r.iso).trim(),
    symbol: r.symbol as string,
    ratePerUsd: Number(r.rate),
    rateUpdatedAt: iso(r.rate_at),
    enterprises: Number(r.enterprises),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
  }),
};

/** The rate in force per currency (USD = 1, no row), the one before it and who set it. */
const rateNow = `LEFT JOIN LATERAL (SELECT r.rate_per_usd, r.valid_from, r.updated_by_id FROM currency_rates r
    WHERE r.iso = c.iso AND r.valid_from <= now() ORDER BY r.valid_from DESC LIMIT 1) cur ON true
  LEFT JOIN LATERAL (SELECT r.rate_per_usd FROM currency_rates r
    WHERE r.iso = c.iso AND r.valid_from < cur.valid_from ORDER BY r.valid_from DESC LIMIT 1) prev ON true
  LEFT JOIN users ub ON ub.id = cur.updated_by_id`;

export const currencyRateList: ListDef<CurrencyRateRow> = {
  fields: listFields.currency_rates,
  from: `currencies c ${rateNow}`,
  baseWhere: "c.deleted_at IS NULL",
  columns: {
    id: { sql: "c.id" },
    iso: { sql: "c.iso" },
    currency: { sql: "c.name" },
    ratePerUsd: { sql: "COALESCE(cur.rate_per_usd, 1)" },
    validFrom: { sql: "cur.valid_from" },
    updatedBy: { sql: "ub.username" },
  },
  search: ["iso", "currency"],
  idSql: "c.id",
  select: `c.id, c.iso, c.name, COALESCE(cur.rate_per_usd, 1) AS rate, cur.valid_from, ub.username AS updated_by,
    prev.rate_per_usd AS previous_rate`,
  mapRow: (r) => ({
    id: Number(r.id),
    iso: String(r.iso).trim(),
    currency: r.name as string,
    ratePerUsd: Number(r.rate),
    validFrom: iso(r.valid_from),
    updatedBy: (r.updated_by as string | null) ?? null,
    previousRate: r.previous_rate === null ? null : Number(r.previous_rate),
  }),
};

export const currencyRateHistoryList: ListDef<CurrencyRateHistoryRow> = {
  fields: listFields.currency_rate_history,
  from: "currency_rates r JOIN currencies c ON c.iso = r.iso LEFT JOIN users ub ON ub.id = r.updated_by_id",
  columns: {
    id: { sql: "r.id" },
    iso: { sql: "r.iso" },
    currency: { sql: "c.name" },
    ratePerUsd: { sql: "r.rate_per_usd" },
    validFrom: { sql: "r.valid_from" },
    updatedBy: { sql: "ub.username" },
  },
  search: ["iso", "currency", "updatedBy"],
  idSql: "r.id",
  select: "r.id, r.iso, c.name, r.rate_per_usd, r.valid_from, ub.username AS updated_by",
  mapRow: (r) => ({
    id: Number(r.id),
    iso: String(r.iso).trim(),
    currency: r.name as string,
    ratePerUsd: Number(r.rate_per_usd),
    validFrom: iso(r.valid_from)!,
    updatedBy: (r.updated_by as string | null) ?? null,
  }),
};

const cycleEnterprisesSql =
  "(SELECT count(DISTINCT b.enterprise_id)::int FROM enterprise_billing b WHERE b.billing_cycle_id = bcy.id)";

export const billingCycleList: ListDef<BillingCycleRow> = {
  fields: listFields.billing_cycles,
  from: "billing_cycles bcy LEFT JOIN users ub ON ub.id = bcy.updated_by_id",
  baseWhere: "bcy.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "bcy.id" },
    name: { sql: "bcy.name" },
    billingType: { sql: "bcy.billing_type" },
    weekDay: { sql: "bcy.week_day" },
    usageDays: { sql: "bcy.usage_days" },
    dueDays: { sql: "bcy.due_days" },
    enterprises: { sql: cycleEnterprisesSql },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "bcy.updated_at" },
    archived: { sql: "(bcy.deleted_at IS NOT NULL)" },
  },
  search: ["name"],
  idSql: "bcy.id",
  select: `bcy.id, bcy.name, bcy.billing_type, bcy.week_day, bcy.usage_days, bcy.due_days,
    ${cycleEnterprisesSql} AS enterprises, ub.username AS updated_by, bcy.updated_at, bcy.deleted_at`,
  mapRow: (r) => ({
    id: Number(r.id),
    name: r.name as string,
    billingType: r.billing_type as BillingCycleRow["billingType"],
    weekDay: (r.week_day as BillingCycleRow["weekDay"]) ?? null,
    usageDays: Number(r.usage_days),
    dueDays: Number(r.due_days),
    enterprises: Number(r.enterprises),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

/**
 * Balances (§7, same rule as the enterprise Billing tab): customer = opening + invoiced usage −
 * payments and credits + debits (what the client owes us); vendor = opening + accepted vendor
 * invoices − payments (what we owe the vendor). Excluded-from-SOA payments still count (§13.33).
 */
export const BALANCE_FROM = `enterprises e
    LEFT JOIN enterprise_billing cb ON cb.enterprise_id = e.id AND cb.side = 'customer'
    LEFT JOIN enterprise_billing vb ON vb.enterprise_id = e.id AND vb.side = 'vendor'
    LEFT JOIN billing_cycles bcy ON bcy.id = COALESCE(cb.billing_cycle_id, vb.billing_cycle_id)
    LEFT JOIN users am ON am.id = e.account_manager_id
    LEFT JOIN LATERAL (SELECT
        CASE WHEN cb.id IS NULL THEN NULL ELSE cb.opening_balance
          + COALESCE((SELECT sum(usage_charges) FROM invoices WHERE enterprise_id = e.id AND deleted_at IS NULL AND status <> 'failed'), 0)
          - COALESCE((SELECT sum(CASE payment_type WHEN 'credit' THEN amount ELSE -amount END) FROM transactions
                       WHERE enterprise_id = e.id AND side = 'customer' AND deleted_at IS NULL), 0) END AS customer,
        CASE WHEN vb.id IS NULL THEN NULL ELSE vb.opening_balance
          + COALESCE((SELECT sum(charge_amount) FROM vendor_invoices
                       WHERE enterprise_id = e.id AND deleted_at IS NULL AND recon_status IN ('match', 'accepted')), 0)
          - COALESCE((SELECT sum(CASE payment_type WHEN 'debit' THEN amount ELSE -amount END) FROM transactions
                       WHERE enterprise_id = e.id AND side = 'vendor' AND deleted_at IS NULL), 0) END AS vendor) bal ON true
    LEFT JOIN currency_latest ccl ON ccl.iso = cb.currency
    LEFT JOIN currency_latest vcl ON vcl.iso = vb.currency`;
const netSql = `round(COALESCE(bal.customer, 0)
    - COALESCE(bal.vendor * COALESCE(ccl.rate_per_usd, vcl.rate_per_usd) / vcl.rate_per_usd, 0), 2)`;
const creditUsedSql = `CASE WHEN cb.credit_limit > 0 THEN GREATEST(0, round(bal.customer / cb.credit_limit * 100, 1)) END`;

export const enterpriseBalanceList: ListDef<EnterpriseBalanceRow> = {
  fields: listFields.enterprise_balances,
  from: BALANCE_FROM,
  baseWhere: "e.deleted_at IS NULL AND (cb.id IS NOT NULL OR vb.id IS NOT NULL)",
  columns: {
    id: { sql: "e.id" },
    enterprise: { sql: "e.name" },
    enterpriseType: { sql: "e.type" },
    customerBalance: { sql: "round(bal.customer, 2)" },
    customerCurrency: { sql: "cb.currency" },
    vendorBalance: { sql: "round(bal.vendor, 2)" },
    vendorCurrency: { sql: "vb.currency" },
    netBalance: { sql: netSql },
    accountManager: { sql: fullName("am") },
    billingType: { sql: "cb.billing_type" },
    creditLimit: { sql: "cb.credit_limit" },
    creditUsedPct: { sql: creditUsedSql },
    billingCycle: { sql: "bcy.name" },
    currency: { sql: "COALESCE(cb.currency, vb.currency)" },
  },
  search: ["enterprise", "accountManager"],
  idSql: "e.id",
  select: `e.id, e.name, e.type, round(bal.customer, 2) AS customer_balance, cb.currency AS customer_currency,
    round(bal.vendor, 2) AS vendor_balance, vb.currency AS vendor_currency, ${netSql} AS net_balance,
    ${fullName("am")} AS account_manager, cb.billing_type, cb.credit_limit, ${creditUsedSql} AS credit_used_pct,
    bcy.name AS billing_cycle, COALESCE(cb.currency, vb.currency) AS currency`,
  mapRow: (r) => ({
    id: Number(r.id),
    enterprise: r.name as string,
    enterpriseType: r.type as string,
    customerBalance: r.customer_balance === null ? null : Number(r.customer_balance),
    customerCurrency: r.customer_currency === null ? null : String(r.customer_currency).trim(),
    vendorBalance: r.vendor_balance === null ? null : Number(r.vendor_balance),
    vendorCurrency: r.vendor_currency === null ? null : String(r.vendor_currency).trim(),
    netBalance: Number(r.net_balance),
    accountManager: (r.account_manager as string | null) ?? null,
    billingType: (r.billing_type as EnterpriseBalanceRow["billingType"]) ?? null,
    creditLimit: r.credit_limit === null ? null : Number(r.credit_limit),
    creditUsedPct: r.credit_used_pct === null ? null : Number(r.credit_used_pct),
    billingCycle: (r.billing_cycle as string | null) ?? null,
    currency: String(r.currency).trim(),
  }),
};

/** Lists answered from PostgreSQL; the Enterprise report runs on the EDR store (api/enterpriseReport.ts). */
export type PgListId = Exclude<ListId, "enterprise_report">;

export const listDefs: Record<PgListId, ListDef<unknown>> = {
  enterprises: enterpriseList as ListDef<unknown>,
  users: userList as ListDef<unknown>,
  changes: changeList as ListDef<unknown>,
  customer_trunks: customerTrunkList as ListDef<unknown>,
  vendor_trunks: vendorTrunkList as ListDef<unknown>,
  rate_tables: rateTableList as ListDef<unknown>,
  rate_lines: rateLineList as ListDef<unknown>,
  destinations: destinationList as ListDef<unknown>,
  route_rules: routeRuleList as ListDef<unknown>,
  product_categories: productCategoryList as ListDef<unknown>,
  countries: countryList as ListDef<unknown>,
  dial_code_profiles: dialCodeProfileList as ListDef<unknown>,
  dial_codes: dialCodeList as ListDef<unknown>,
  mo_numbers: moNumberList as ListDef<unknown>,
  route_map: routeMapList as ListDef<unknown>,
  rerating_requests: reratingList as ListDef<unknown>,
  qbr_stats: qbrStatList as ListDef<unknown>,
  number_lists: numberListList as ListDef<unknown>,
  number_list_entries: numberListEntryList as ListDef<unknown>,
  translation_rules: translationRuleList as ListDef<unknown>,
  hlr_providers: hlrProviderList as ListDef<unknown>,
  hlr_provider_rates: hlrProviderRateList as ListDef<unknown>,
  hlr_rules: hlrRuleList as ListDef<unknown>,
  hlr_policies: hlrPolicyList as ListDef<unknown>,
  transactions: transactionList as ListDef<unknown>,
  invoices: invoiceList as ListDef<unknown>,
  currencies: currencyList as ListDef<unknown>,
  currency_rates: currencyRateList as ListDef<unknown>,
  currency_rate_history: currencyRateHistoryList as ListDef<unknown>,
  billing_cycles: billingCycleList as ListDef<unknown>,
  enterprise_balances: enterpriseBalanceList as ListDef<unknown>,
};
