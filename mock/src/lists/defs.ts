// SQL side of each list: FROM clause, an expression per catalogue field, and the
// mapping from database row to the contract's row schema.
import {
  accessGroupList,
  auditList,
  businessCompanyList,
  departmentList,
  emailTemplateList,
  portalUserList,
  sessionList,
  userList,
} from "./adminDefs.js";
import { CURRENT_USER_ID } from "../api/session.js";
import { alertRuleList, incidentList } from "./alertDefs.js";
import { rnLineList, rnList } from "./rnDefs.js";
import { marketMoveList } from "../api/marketMoves.js";
import { lcrChangeList, lcrProfileList } from "../api/lcr.js";
import { visibilityAssignmentList, visibilityGrantList, visibilityPolicyList } from "../api/visibility.js";
import { teamTimelineList } from "../api/team.js";
import { cleanupFindingList } from "../api/cleanup.js";
import { PLATFORM_CURRENCY, toPlatformSql } from "../currency.js";
import type {
  PcapTraceRow,
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
  InvoiceRequestRow,
  EmailTemplateRow,
  EmailLogRow,
  FirewallRuleRow,
  FirewallFilterRow,
  TrafficAlertRow,
  SmsVoiceRuleRow,
  BroadcastRow,
  EdrTemplateRow,
  EdrDownloadRow,
  RepushRequestRow,
  NetworkBindRow,
  SignalingCaptureRow,
  ScheduledReportRow,
  DailyTrafficAlertRow,
  BillingReportRow,
  SoaReportRow,
  ReconRuleRow,
  VendorInvoiceRow,
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
import { PRESETS } from "../reports/presets.js";
import type { ListDef } from "./engine.js";
import { isNameValue, mccmncByNameSql } from "./mccmncNames.js";
import { byEnterprise, enterpriseLabel, hide, lit, maskName, vis, visCol } from "../visibility/sql.js";

// AM visibility (§13.17): names masked and values hidden for viewers who do not own the row.
const enterpriseMask = (alias: string) =>
  maskName(`${alias}.name`, `${alias}.id`, byEnterprise(`${alias}.id`), enterpriseLabel(`${alias}.type`));
const trunkMask = (alias: string, label: string) =>
  maskName(`${alias}.name`, `${alias}.id`, byEnterprise(`${alias}.enterprise_id`), lit(label));
/** A customer rate table is own when an own client's trunk uses it; a buy table when its vendor is own. */
const ownedTable = `(CASE WHEN rt.kind = 'vendor'
    THEN (SELECT ovt.enterprise_id FROM vendor_trunks ovt WHERE ovt.id = rt.vendor_trunk_id) = ANY($OWN)
    ELSE EXISTS (SELECT 1 FROM customer_trunk_rate_tables ox JOIN customer_trunks oct ON oct.id = ox.customer_trunk_id
                  WHERE ox.rate_table_id = rt.id AND oct.enterprise_id = ANY($OWN)) END)`;
const rateHide = (sql: string) =>
  hide("sellRates", sql, ownedTable, { when: "rt.kind = 'customer'", else: hide("cost", sql, ownedTable) });

const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const fullName = (alias: string) => `(${alias}.first_name || ' ' || ${alias}.last_name)`;

/** An enterprise's live trunks of one kind: count, and names for the hover list (team trial round 1). */
const entTrunkCount = (table: string) =>
  `(SELECT count(*)::int FROM ${table} x WHERE x.enterprise_id = e.id AND x.deleted_at IS NULL)`;
const entTrunkNames = (table: string, name: string, alias: string) =>
  `ARRAY(SELECT ${name} FROM ${table} ${alias} WHERE ${alias}.enterprise_id = e.id AND ${alias}.deleted_at IS NULL
    ORDER BY ${alias}.name LIMIT 100)`;

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
    name: visCol(enterpriseMask("e")),
    alias: visCol(maskName("e.alias", "e.id", byEnterprise("e.id"), enterpriseLabel("e.type"))),
    type: { sql: "e.type" },
    tier: { sql: "e.tier" },
    status: { sql: "e.status" },
    businessCompany: { sql: "bc.name" },
    businessCompanyId: { sql: "e.business_company_id" },
    accountManager: { sql: fullName("am") },
    accountManagerId: { sql: "e.account_manager_id" },
    country: { sql: "co.iso" },
    customerTrunkCount: { sql: entTrunkCount("customer_trunks") },
    vendorTrunkCount: { sql: entTrunkCount("vendor_trunks") },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "e.updated_at" },
    archived: { sql: "(e.deleted_at IS NOT NULL)" },
  },
  search: ["name", "alias", "accountManager"],
  idSql: "e.id",
  select: `e.id, e.name, e.alias, e.type, e.tier, e.status, e.business_company_id, bc.name AS business_company_name,
    e.account_manager_id, ${fullName("am")} AS account_manager_name, co.iso AS country,
    ${entTrunkCount("customer_trunks")} AS customer_trunk_count, ${entTrunkCount("vendor_trunks")} AS vendor_trunk_count,
    ${entTrunkNames("customer_trunks", vis(trunkMask("t", "Customer trunk")), "t")} AS customer_trunk_names,
    ${entTrunkNames("vendor_trunks", vis(trunkMask("vt", "Vendor trunk")), "vt")} AS vendor_trunk_names,
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
    customerTrunkCount: Number(r.customer_trunk_count),
    customerTrunkNames: (r.customer_trunk_names as string[]) ?? [],
    vendorTrunkCount: Number(r.vendor_trunk_count),
    vendorTrunkNames: (r.vendor_trunk_names as string[]) ?? [],
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
/** The same rules by name, for the hover list (team trial round 1). */
const ruleNamesSql = (kind: "customer" | "vendor") => `ARRAY(SELECT DISTINCT r.name
    FROM translation_rule_targets tg JOIN translation_rules r ON r.id = tg.translation_rule_id
   WHERE tg.trunk_kind = '${kind}' AND r.deleted_at IS NULL AND r.status = 'active'
     AND (tg.target_type = 'all' OR (tg.target_type = 'trunk' AND tg.target_id = t.id)
          OR (tg.target_type = 'enterprise' AND tg.target_id = t.enterprise_id)
          OR (tg.target_type = 'category' AND tg.target_id = t.product_category_id))
     AND NOT EXISTS (SELECT 1 FROM translation_rule_trunk_settings s
                      WHERE s.translation_rule_id = r.id AND s.trunk_kind = '${kind}' AND s.trunk_id = t.id AND NOT s.enabled)
   ORDER BY r.name LIMIT 100)`;
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
      name: visCol(trunkMask("t", kind === "customer" ? "Customer trunk" : "Vendor trunk")),
      enterpriseName: visCol(enterpriseMask("e")),
      enterpriseId: { sql: "t.enterprise_id" },
      username: visCol(hide("contacts", "t.username", byEnterprise("t.enterprise_id"))),
      category: { sql: "pc.name" },
      categoryId: { sql: "t.product_category_id" },
      currency: { sql: trunkCurrencySql(kind, "t") },
      protocol: { sql: "t.protocol" },
      tps: { sql: "t.tps" },
      status: { sql: "t.status" },
      bindType: { sql: "t.bind_type" },
      rulesCount: { sql: rulesCountSql(kind) },
      ...(kind === "vendor" ? { host: visCol(hide("contacts", "t.host", byEnterprise("t.enterprise_id"))) } : {}),
      updatedBy: { sql: "ub.username" },
      updatedAt: { sql: "t.updated_at" },
      archived: { sql: "(t.deleted_at IS NOT NULL)" },
    },
    search: ["name", "username", "enterpriseName"],
    idSql: "t.id",
    select: `t.id, t.enterprise_id, e.name AS enterprise_name, t.name, t.username, t.product_category_id, pc.name AS category,
      ${trunkCurrencySql(kind, "t")} AS currency, t.protocol, t.tps, t.status, t.bind_type, ${rulesCountSql(kind)} AS rules_count, ${ruleNamesSql(kind)} AS rule_names, ub.username AS updated_by,
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
      ruleNames: (r.rule_names as string[]) ?? [],
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
    AND l.rate < bb.rate_eur * (SELECT cl.rate_per_eur FROM currency_latest cl WHERE cl.iso = rt.currency)) END)`;
// Trunks using a table: customer trunks for a sell table, the owning trunk for a buy table.
const usersSql = (col: string, sep: string | null) => {
  // Names for the cell and its hover list: up to 100, sorted (team trial round 1).
  const agg = (expr: string) =>
    sep ? `string_agg(DISTINCT ${expr}, '${sep}')` : `(array_agg(DISTINCT ${expr} ORDER BY ${expr}))[1:100]`;
  return `(CASE WHEN rt.kind = 'customer'
    THEN (SELECT ${agg(col)} FROM customer_trunk_rate_tables x
            JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
            JOIN enterprises e ON e.id = t.enterprise_id
           WHERE x.rate_table_id = rt.id)
    ELSE (SELECT ${agg(col)} FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id WHERE t.id = rt.vendor_trunk_id) END)`;
};
/** Clients using a customer table (1 for a vendor table). */
const tableClientCount = `(CASE WHEN rt.kind = 'customer'
    THEN (SELECT count(DISTINCT t.enterprise_id)::int FROM customer_trunk_rate_tables x
            JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL WHERE x.rate_table_id = rt.id)
    ELSE (CASE WHEN rt.vendor_trunk_id IS NULL THEN 0 ELSE 1 END) END)`;
const tableTrunkName = vis(
  maskName(
    "t.name",
    "t.id",
    byEnterprise("t.enterprise_id"),
    "(CASE rt.kind WHEN 'customer' THEN 'Customer trunk' ELSE 'Vendor trunk' END)",
  ),
);
const tableEnterpriseName = vis(enterpriseMask("e"));
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
    name: visCol(maskName("rt.name", "rt.id", ownedTable, lit("Rate table"))),
    kind: { sql: "rt.kind" },
    enterpriseNames: { sql: usersSql(tableEnterpriseName, ", ") },
    trunkNames: { sql: usersSql(tableTrunkName, ", ") },
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
    // Tables used by these customer trunks (bulk rating, pick by trunk; team trial round 2).
    customerTrunkId: {
      sql: "NULL",
      where: (op, c, p) => {
        const ids = op === "in" ? (c.values ?? []).map(Number) : [Number(c.value)];
        return `EXISTS (SELECT 1 FROM customer_trunk_rate_tables x
                   WHERE x.rate_table_id = rt.id AND x.customer_trunk_id = ANY(${p(ids)}::bigint[]))`;
      },
    },
    vendorTrunkName: visCol(trunkMask("vt", "Vendor trunk")),
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
    CASE WHEN rt.kind = 'customer' THEN COALESCE(st.negative_lines, 0) END AS negative_lines, ${usersSql(tableTrunkName, null)} AS trunk_names,
    ${usersSql(tableEnterpriseName, null)} AS enterprise_names, ${tableClientCount} AS enterprise_count, ub.username AS updated_by, rt.updated_at,
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
    enterpriseCount: Number(r.enterprise_count ?? 0),
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
const bestBuySql = "(bb.rate_eur * cl.rate_per_eur)";
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
    rate: visCol(rateHide("l.rate")),
    bestBuy: visCol(hide("cost", bestBuySql, byEnterprise("bv.enterprise_id"))),
    bestVendor: visCol(trunkMask("bv", "Vendor trunk")),
    margin: visCol(hide("margin", marginSql, ownedTable, { pct: marginPctSql })),
    marginPct: visCol(hide("margin", marginPctSql, ownedTable)),
    changeType: { sql: changeTypeSql },
    changePct: { sql: changePctSql },
    validFrom: { sql: "l.valid_from" },
    validTo: { sql: "l.valid_to" },
    nextRate: visCol(rateHide("nxt.rate")),
    nextFrom: { sql: "nxt.valid_from" },
    isBlocked: { sql: "l.is_blocked" },
    negativeMargin: { sql: `(COALESCE(l.rate < ${bestBuySql}, false))` },
    dialCode: { sql: "l.dial_code" },
    sysRate: visCol(rateHide(toPlatformSql("l.rate"))),
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
    trunk: visCol(
      maskName(
        "tr.name",
        "tr.id",
        byEnterprise("tr.enterprise_id"),
        "(CASE tr.side WHEN 'customer' THEN 'Customer trunk' ELSE 'Vendor trunk' END)",
      ),
    ),
    enterprise: visCol(enterpriseMask("e")),
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

const ruleTrunkName = vis(trunkMask("t", "Customer trunk"));
const ruleVendorName = vis(trunkMask("vt", "Vendor trunk"));
/** A rule is own when it names only own clients' trunks. */
const ownedRule = `(r.customer_trunk_mode = 'inclusive' AND NOT EXISTS (SELECT 1 FROM customer_trunks ot
    WHERE ot.id = ANY(r.customer_trunk_ids) AND NOT ot.enterprise_id = ANY($OWN)))`;
const trunkNamesSql = `(SELECT string_agg(${ruleTrunkName}, ', ') FROM customer_trunks t WHERE t.id = ANY(r.customer_trunk_ids))`;
const vendorNamesSql = `(SELECT string_agg(${ruleVendorName}, ', ') FROM route_rule_vendors v JOIN vendor_trunks vt ON vt.id = v.vendor_trunk_id
   WHERE v.route_rule_id = r.id)`;

/**
 * A rule's destinations per country (team trial round 1): the country, whether every code of it is listed,
 * and its codes as "MCCMNC-Country-Network", joined by chr(31). A 3-digit code is only the All networks entry.
 */
const ruleDestinationNames = `ARRAY(
  SELECT x.country || chr(31) || (x.n = x.total AND x.total > 1)::text || chr(31) || x.parts
    FROM (SELECT min(u.o) AS o, co.name AS country, count(*) AS n,
                 (SELECT count(*) FROM mccmnc y WHERE y.mcc = m.mcc AND y.deleted_at IS NULL) AS total,
                 string_agg(m.mccmnc || '-' || co.name || '-' || CASE WHEN m.is_all_networks THEN 'All Networks' ELSE m.network END,
                            chr(31) ORDER BY u.o) AS parts
            FROM unnest(r.mccmncs) WITH ORDINALITY u(c, o)
            JOIN mccmnc m ON m.mccmnc = u.c AND m.deleted_at IS NULL
            JOIN countries co ON co.id = m.country_id
           GROUP BY m.mcc, co.name) x
   ORDER BY x.o LIMIT 100)`;

/** Per country: its name, whether every code of it is picked, and each code as "MCCMNC-Country-Network". */
function destinationGroups(names: unknown): { country: string; whole: boolean; parts: string[] }[] {
  return ((names as string[] | null) ?? []).map((g) => {
    const [country, whole, ...parts] = g.split("\x1f");
    return { country: country!, whole: whole === "true", parts };
  });
}

/** A rule's destinations for the hover list: every code, one per line as "MCCMNC-Country-Network" (team trial round 1). */
function ruleDestinationList(codes: string[], names: unknown): string[] {
  const groups = destinationGroups(names);
  return groups.length ? groups.flatMap((g) => g.parts) : codes;
}

function destinationSummary(codes: string[], names: unknown): string {
  const groups = destinationGroups(names);
  // The cell keeps a whole country as one entry; the hover list shows every code.
  const list = groups.length ? groups.flatMap((g) => (g.whole ? [`${g.country} (whole country)`] : g.parts)) : codes;
  const rest = list.length - 2;
  return list.slice(0, 2).join(", ") + (rest > 0 ? ` +${rest}${groups.length >= 100 ? "…" : ""}` : "");
}

/** Every vendor for the hover list: share on percentage splits, the level when there are several, backups last. */
function vendorList(all: { n: string; s: number | null; l: number; b: boolean }[], hunt: string): string[] {
  const levels = new Set(all.filter((v) => !v.b).map((v) => v.l));
  const main = all
    .filter((v) => !v.b)
    .map(
      (v) => `${levels.size > 1 ? `L${v.l} · ` : ""}${v.n}${hunt === "percentage" && v.s != null ? ` (${v.s}%)` : ""}`,
    );
  return [...main, ...all.filter((v) => v.b).map((v) => `Backup · ${v.n}`)];
}

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
    // "505" finds rules on 505 (All networks) and its networks (50501…); "50501" finds rules on 50501 only
    // (a 3-digit code is the All networks entry, not the whole country; team trial round 1).
    destination: {
      sql: "array_to_string(r.mccmncs, ',')",
      where: (op, c, p) => {
        if (op === "empty") return "(r.mccmnc_mode = 'all')";
        if (op === "not_empty") return "(r.mccmnc_mode <> 'all')";
        // Names work too: "France" finds rules on any French code, "Orange" on Orange networks.
        if (isNameValue(c.value)) {
          const raw = String(c.value);
          const names = mccmncByNameSql(p(op === "eq" ? raw.replace(/[%_\\]/g, "\\$&") : raw));
          return `(r.mccmncs && ARRAY${names})`;
        }
        const v = p(String(c.value ?? "").replace(/[%_]/g, ""));
        return op === "eq"
          ? `(${v} = ANY(r.mccmncs))`
          : `(EXISTS (SELECT 1 FROM unnest(r.mccmncs) m WHERE m LIKE ${v} || '%'))`;
      },
    },
    vendors: { sql: vendorNamesSql },
    messages: visCol(hide("traffic", "tr.messages", ownedRule)),
    asr: { sql: "tr.asr" },
    dlr: { sql: "tr.dlr" },
    dlrTarget: { sql: dlrTargetSql },
    dlrBelowTarget: { sql: `(tr.dlr < ${dlrTargetSql})` },
    margin: visCol(hide("margin", "tr.margin", ownedRule)),
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
    ARRAY(SELECT ${ruleTrunkName} FROM unnest(r.customer_trunk_ids) WITH ORDINALITY u(id, o) JOIN customer_trunks t ON t.id = u.id
           ORDER BY u.o LIMIT 30) AS trunk_names,
    (SELECT json_agg(json_build_object('n', ${ruleVendorName}, 's', v.share_pct, 'l', v.level, 'b', v.is_backup)
                     ORDER BY v.level, v.share_pct DESC NULLS LAST, v.id)
       FROM route_rule_vendors v JOIN vendor_trunks vt ON vt.id = v.vendor_trunk_id WHERE v.route_rule_id = r.id) AS vendors,
    tr.messages, tr.asr, tr.dlr, ${dlrTargetSql} AS dlr_target, r.dlr_target_pct, tr.margin, r.starts_at, r.stops_at, g.name AS group_name, ub.username AS updated_by,
    r.updated_at, r.deleted_at, ${ruleDestinationNames} AS dest_names`,
  mapRow: (r) => {
    const names = (r.trunk_names as string[]) ?? [];
    const count = r.trunk_count as number;
    const first = names.slice(0, 2).join(", ") + (count > 2 ? ` +${count - 2}` : "");
    const mode = r.customer_trunk_mode as string;
    const codes = (r.mccmncs as string[]) ?? [];
    const allVendors = (r.vendors as { n: string; s: number | null; l: number; b: boolean }[] | null) ?? [];
    const vendors = allVendors.filter((v) => !v.b);
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
            : (r.mccmnc_mode === "exclusive" ? "All but " : "") + (destinationSummary(codes, r.dest_names) || "—"),
      destinationNames:
        r.mccmnc_mode === "all" || r.mccmnc_pattern ? [] : ruleDestinationList(codes, r.dest_names).slice(0, 100),
      destinationCount: r.mccmnc_mode === "all" || r.mccmnc_pattern ? 0 : codes.length,
      vendorsLabel,
      vendorNames: type === "block" ? [] : vendorList(allVendors, hunt),
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

/** The first entries, for the hover list (team trial round 1). */
const numberListValues = `ARRAY(SELECT x.value FROM number_list_entries x WHERE x.number_list_id = nl.id
    AND x.deleted_at IS NULL ORDER BY x.id LIMIT 100)`;
/** The live rules using the list, by name (same rules as numberListUsedBySql). */
const numberListUsers = `ARRAY(SELECT u.label FROM (
    SELECT 'Translation rule · ' || x.name AS label FROM translation_rules x WHERE x.deleted_at IS NULL
       AND nl.id IN (x.sender_list_id, x.receiver_list_id, x.sender_conversion_list_id)
    UNION ALL
    SELECT 'Route rule · ' || x.name FROM route_rules x WHERE x.deleted_at IS NULL
       AND (nl.id IN (x.sender_list_id, x.receiver_list_id)
            OR EXISTS (SELECT 1 FROM route_rule_whitelists w WHERE w.route_rule_id = x.id AND w.number_list_id = nl.id))
  ) u ORDER BY u.label LIMIT 100)`;

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
    ${numberListValues} AS entry_values, ${numberListUsers} AS used_by_names,
    ub.username AS updated_by, nl.updated_at, nl.deleted_at`,
  mapRow: (r) => ({
    id: r.id as number,
    name: r.name as string,
    listType: r.list_type as NumberList["listType"],
    entries: Number(r.entries),
    entryValues: (r.entry_values as string[]) ?? [],
    usedBy: Number(r.used_by),
    usedByNames: (r.used_by_names as string[]) ?? [],
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
    content: { sql: "ne.content" },
    createdBy: { sql: "cb.username" },
    createdAt: { sql: "ne.inserted_at" },
  },
  search: ["value", "content"],
  idSql: "ne.id",
  select: "ne.id, ne.number_list_id, ne.value, ne.content, cb.username AS created_by, ne.inserted_at",
  mapRow: (r) => ({
    id: r.id as number,
    numberListId: r.number_list_id as number,
    value: r.value as string,
    content: (r.content as string | null) ?? null,
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
/** A translation rule's MCCMNC codes by name, in order (team trial round 1). */
const trMccmncNames = `ARRAY(SELECT co.name || ' · ' || CASE WHEN m.is_all_networks THEN 'All networks' ELSE m.network END
      || ' (' || m.mccmnc || ')'
    FROM unnest(tr.mccmncs) WITH ORDINALITY u(c, o) JOIN mccmnc m ON m.mccmnc = u.c AND m.deleted_at IS NULL
    JOIN countries co ON co.id = m.country_id ORDER BY u.o LIMIT 100)`;
/** Every target by name for the hover list: "Customer trunk · X", "Vendor enterprise · Y", "All customer trunks". */
const trTargetNames = `ARRAY(SELECT CASE trt.target_type
      WHEN 'all' THEN 'All ' || trt.trunk_kind || ' trunks'
      WHEN 'trunk' THEN initcap(trt.trunk_kind) || ' trunk · ' || COALESCE(CASE WHEN trt.trunk_kind = 'customer'
        THEN (SELECT ${ruleTrunkName} FROM customer_trunks t WHERE t.id = trt.target_id)
        ELSE (SELECT ${ruleVendorName} FROM vendor_trunks vt WHERE vt.id = trt.target_id) END, '#' || trt.target_id)
      WHEN 'enterprise' THEN initcap(trt.trunk_kind) || ' enterprise · '
        || COALESCE((SELECT ${vis(enterpriseMask("e"))} FROM enterprises e WHERE e.id = trt.target_id), '#' || trt.target_id)
      ELSE initcap(trt.trunk_kind) || ' category · '
        || COALESCE((SELECT pc.name FROM product_categories pc WHERE pc.id = trt.target_id), '#' || trt.target_id) END
    FROM translation_rule_targets trt WHERE trt.translation_rule_id = tr.id
    ORDER BY trt.trunk_kind, array_position(ARRAY['all','category','enterprise','trunk'], trt.target_type), 1 LIMIT 100)`;
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
    // Codes or names: "208" finds rules listing 208…, "France" or "Orange" rules listing a matching code.
    mccmncs: {
      sql: "array_to_string(tr.mccmncs, ',')",
      where: (op, c, p) => {
        const text = String(c.value ?? "");
        if (op === "empty") return "(cardinality(tr.mccmncs) = 0)";
        if (op === "not_empty") return "(cardinality(tr.mccmncs) > 0)";
        const hit = isNameValue(text)
          ? `(tr.mccmncs && ARRAY${mccmncByNameSql(p(text))})`
          : op === "eq" || op === "neq"
            ? `(${p(text)} = ANY(tr.mccmncs))`
            : `(EXISTS (SELECT 1 FROM unnest(tr.mccmncs) m WHERE m ILIKE ${p(text)}))`;
        return op === "not_like" || op === "neq" ? `(NOT ${hit})` : hit;
      },
    },
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
    ${appliesToSql} AS applies_to, ${trTargetNames} AS target_names, ${trMccmncNames} AS mccmnc_names,
    (SELECT count(*)::int FROM translation_rule_targets x WHERE x.translation_rule_id = tr.id) AS target_count,
    ${translationUsedBySql("tr")} AS used_by, ub.username AS updated_by, tr.updated_at,
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
    mccmncNames: (r.mccmnc_names as string[]) ?? [],
    contentPattern: (r.content_pattern as string | null) ?? null,
    senderConversion: (r.sender_conversion as string | null) ?? null,
    senderConversionValue: (r.sender_conversion_value as string | null) ?? null,
    status: r.status as TranslationRuleRow["status"],
    appliesTo: r.applies_to as string,
    appliesToNames: (r.target_names as string[]) ?? [],
    appliesToCount: Number(r.target_count),
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

/** Every target by name for the hover list: "Customer trunk · X", "Enterprise · Y", "All customer trunks". */
const hlrTargetNames = `ARRAY(SELECT CASE ht.target_type
      WHEN 'all' THEN 'All customer trunks'
      WHEN 'trunk' THEN 'Customer trunk · '
        || COALESCE((SELECT ${ruleTrunkName} FROM customer_trunks t WHERE t.id = ht.target_id), '#' || ht.target_id)
      WHEN 'enterprise' THEN 'Enterprise · '
        || COALESCE((SELECT ${vis(enterpriseMask("e"))} FROM enterprises e WHERE e.id = ht.target_id), '#' || ht.target_id)
      ELSE 'Category · ' || COALESCE((SELECT pc.name FROM product_categories pc WHERE pc.id = ht.target_id), '#' || ht.target_id) END
    FROM hlr_rule_targets ht WHERE ht.hlr_rule_id = hr.id
    ORDER BY array_position(ARRAY['all','category','enterprise','trunk'], ht.target_type), 1 LIMIT 100)`;

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
    ${hlrAppliesToSql} AS applies_to, ${hlrTargetNames} AS target_names,
    (SELECT count(*)::int FROM hlr_rule_targets x WHERE x.hlr_rule_id = hr.id) AS target_count,
    ${hlrUsedBySql("hr")} AS used_by, ub.username AS updated_by, hr.updated_at,
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
    appliesToNames: (r.target_names as string[]) ?? [],
    appliesToCount: Number(r.target_count),
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
    enterprise: visCol(enterpriseMask("e")),
    paymentDate: { sql: "tx.payment_date" },
    transactionTime: { sql: "tx.inserted_at" },
    paymentMode: { sql: "tx.payment_mode" },
    paymentType: { sql: "tx.payment_type" },
    transactionType: { sql: "tx.transaction_type" },
    amount: visCol(hide("balances", "tx.amount", byEnterprise("tx.enterprise_id"))),
    currency: { sql: "tx.currency" },
    amountBase: visCol(hide("balances", "tx.amount_base", byEnterprise("tx.enterprise_id"))),
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
  from: "invoices inv JOIN enterprises e ON e.id = inv.enterprise_id JOIN business_companies bco ON bco.id = e.business_company_id",
  baseWhere: "inv.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "inv.id" },
    invoiceNumber: { sql: "inv.invoice_number" },
    enterpriseId: { sql: "inv.enterprise_id" },
    enterprise: visCol(enterpriseMask("e")),
    enterpriseType: { sql: "e.type" },
    businessCompany: { sql: "bco.name" },
    kind: { sql: "inv.kind" },
    invoiceType: { sql: "inv.invoice_type" },
    billingType: { sql: "inv.billing_type" },
    currency: { sql: "inv.currency" },
    timezone: { sql: "inv.timezone" },
    invoiceDate: { sql: "inv.invoice_date" },
    usageStart: { sql: "inv.usage_start" },
    usageEnd: { sql: "inv.usage_end" },
    dueDate: { sql: "inv.due_date" },
    openingBalance: visCol(hide("balances", "inv.opening_balance", byEnterprise("inv.enterprise_id"))),
    usageCharges: visCol(hide("balances", "inv.usage_charges", byEnterprise("inv.enterprise_id"))),
    closingBalance: visCol(hide("balances", "inv.closing_balance", byEnterprise("inv.enterprise_id"))),
    dueAmount: visCol(hide("balances", "inv.due_amount", byEnterprise("inv.enterprise_id"))),
    messageCount: { sql: "inv.message_count" },
    status: { sql: "inv.status" },
    paymentStatus: { sql: "inv.payment_status" },
    emailStatus: { sql: "inv.email_status" },
    emailSentAt: { sql: "inv.email_sent_at" },
    remarks: { sql: "inv.remarks" },
    archived: { sql: "(inv.deleted_at IS NOT NULL)" },
  },
  search: ["invoiceNumber", "enterprise"],
  idSql: "inv.id",
  select: `inv.*, e.name AS enterprise, e.type AS enterprise_type, bco.name AS business_company`,
  mapRow: (r) => mapInvoiceRow(r),
};

/** Shared by the list and the invoice detail. */
export function mapInvoiceRow(r: Record<string, unknown>): InvoiceRow {
  return {
    id: Number(r.id),
    invoiceNumber: r.invoice_number as string,
    enterpriseId: Number(r.enterprise_id),
    enterprise: r.enterprise as string,
    enterpriseType: r.enterprise_type as string,
    businessCompany: r.business_company as string,
    invoiceType: r.invoice_type as InvoiceRow["invoiceType"],
    kind: r.kind as InvoiceRow["kind"],
    billingType: r.billing_type as InvoiceRow["billingType"],
    currency: String(r.currency).trim(),
    timezone: r.timezone as string,
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
    emailSentAt: iso(r.email_sent_at),
    remarks: (r.remarks as string | null) ?? null,
    archivedAt: iso(r.deleted_at),
  };
}

/** Invoice Request list (§12.3): Request No is the id with a prefix. */
export const requestNoSql = (alias: string) => `('IR-' || lpad(${alias}.id::text, 6, '0'))`;
export const INVOICE_REQUEST_FROM = `invoice_requests r
    JOIN enterprises e ON e.id = r.enterprise_id
    LEFT JOIN enterprise_billing cb ON cb.enterprise_id = r.enterprise_id AND cb.side = 'customer'
    LEFT JOIN invoices inv ON inv.id = r.invoice_id
    LEFT JOIN users u ON u.id = r.created_by_id`;
export const INVOICE_REQUEST_SELECT = `r.*, ${requestNoSql("r")} AS request_no, e.name AS enterprise, e.type AS enterprise_type,
    cb.billing_type, inv.invoice_number, u.username AS created_by`;
export const invoiceRequestList: ListDef<InvoiceRequestRow> = {
  fields: listFields.invoice_requests,
  from: INVOICE_REQUEST_FROM,
  columns: {
    id: { sql: "r.id" },
    requestNo: { sql: requestNoSql("r") },
    startedAt: { sql: "r.started_at" },
    finishedAt: { sql: "r.finished_at" },
    invoiceType: { sql: "r.invoice_type" },
    kind: { sql: "r.kind" },
    regenerate: { sql: "r.regenerate" },
    enterprise: visCol(enterpriseMask("e")),
    enterpriseId: { sql: "r.enterprise_id" },
    enterpriseType: { sql: "e.type" },
    billingType: { sql: "cb.billing_type" },
    timezone: { sql: "r.timezone" },
    usageStart: { sql: "r.usage_start" },
    usageEnd: { sql: "r.usage_end" },
    status: { sql: "r.status" },
    error: { sql: "r.error" },
    invoiceNumber: { sql: "inv.invoice_number" },
    remarks: { sql: "r.remarks" },
    createdBy: { sql: "u.username" },
    createdAt: { sql: "r.inserted_at" },
  },
  search: ["requestNo", "enterprise", "invoiceNumber"],
  idSql: "r.id",
  select: INVOICE_REQUEST_SELECT,
  mapRow: (r) => mapInvoiceRequest(r),
};

export function mapInvoiceRequest(r: Record<string, unknown>): InvoiceRequestRow {
  return {
    id: Number(r.id),
    requestNo: r.request_no as string,
    kind: r.kind as InvoiceRequestRow["kind"],
    invoiceType: r.invoice_type as InvoiceRequestRow["invoiceType"],
    regenerate: r.regenerate as boolean,
    enterpriseId: Number(r.enterprise_id),
    enterprise: r.enterprise as string,
    enterpriseType: r.enterprise_type as string,
    billingType: (r.billing_type as InvoiceRequestRow["billingType"]) ?? null,
    timezone: r.timezone as string,
    usageStart: ymd(r.usage_start),
    usageEnd: ymd(r.usage_end),
    status: r.status as InvoiceRequestRow["status"],
    error: (r.error as string | null) ?? null,
    remarks: (r.remarks as string | null) ?? null,
    invoiceId: r.invoice_id === null ? null : Number(r.invoice_id),
    invoiceNumber: (r.invoice_number as string | null) ?? null,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.inserted_at)!,
  };
}

/** Vendor invoices and the reconciliation list (§7, §13.31). Dispute amount = theirs − ours. */
const viDisputeSql = "(v.charge_amount - v.our_amount)";
const viPctSql =
  "(CASE WHEN v.our_amount > 0 THEN round((v.charge_amount - v.our_amount) / v.our_amount * 100, 2) END)";
const viLinesSql = "(SELECT count(*)::int FROM vendor_invoice_lines l WHERE l.vendor_invoice_id = v.id)";
export const VENDOR_INVOICE_FROM = `vendor_invoices v
    JOIN enterprises e ON e.id = v.enterprise_id
    LEFT JOIN users am ON am.id = e.account_manager_id
    LEFT JOIN users cu ON cu.id = v.created_by_id`;
export const VENDOR_INVOICE_SELECT = `v.*, e.name AS enterprise, ${fullName("am")} AS account_manager,
    cu.username AS created_by, ${viLinesSql} AS line_count`;
export const vendorInvoiceList: ListDef<VendorInvoiceRow> = {
  fields: listFields.vendor_invoices,
  from: VENDOR_INVOICE_FROM,
  baseWhere: "v.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "v.id" },
    enterprise: visCol(enterpriseMask("e")),
    enterpriseId: { sql: "v.enterprise_id" },
    accountManager: { sql: fullName("am") },
    invoiceNumber: { sql: "v.invoice_number" },
    status: { sql: "v.recon_status" },
    comparison: { sql: "v.comparison" },
    currency: { sql: "v.currency" },
    chargeVolume: visCol(hide("traffic", "v.charge_volume", byEnterprise("v.enterprise_id"))),
    chargeAmount: visCol(hide("balances", "v.charge_amount", byEnterprise("v.enterprise_id"))),
    ourVolume: visCol(hide("traffic", "v.our_volume", byEnterprise("v.enterprise_id"))),
    ourAmount: visCol(hide("balances", "v.our_amount", byEnterprise("v.enterprise_id"))),
    disputeAmount: visCol(hide("balances", viDisputeSql, byEnterprise("v.enterprise_id"))),
    differencePct: { sql: viPctSql },
    volumeDifference: { sql: "(v.charge_volume - v.our_volume)" },
    invoiceDate: { sql: "v.invoice_date" },
    dueDate: { sql: "v.due_date" },
    periodFrom: { sql: "v.period_from" },
    periodTo: { sql: "v.period_to" },
    timezone: { sql: "v.timezone" },
    emailStatus: { sql: "v.email_status" },
    source: { sql: "v.source" },
    lineCount: { sql: viLinesSql },
    remarks: { sql: "v.remarks" },
    checkedAt: { sql: "v.checked_at" },
    inputFrom: { sql: "v.input_from" },
    inputTo: { sql: "v.input_to" },
    createdBy: { sql: "cu.username" },
    createdAt: { sql: "v.inserted_at" },
    archived: { sql: "(v.deleted_at IS NOT NULL)" },
  },
  search: ["invoiceNumber", "enterprise"],
  idSql: "v.id",
  select: VENDOR_INVOICE_SELECT,
  mapRow: (r) => mapVendorInvoice(r),
};

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export function mapVendorInvoice(r: Record<string, unknown>): VendorInvoiceRow {
  const their = Number(r.charge_amount);
  const our = numOrNull(r.our_amount);
  const theirVol = numOrNull(r.charge_volume);
  const ourVol = numOrNull(r.our_volume);
  return {
    id: Number(r.id),
    enterpriseId: Number(r.enterprise_id),
    enterprise: r.enterprise as string,
    accountManager: (r.account_manager as string | null) ?? null,
    invoiceNumber: r.invoice_number as string,
    currency: String(r.currency).trim(),
    chargeVolume: theirVol,
    chargeAmount: their,
    ourVolume: ourVol,
    ourAmount: our,
    disputeAmount: our === null ? null : Math.round((their - our) * 100) / 100,
    differencePct: our === null || our <= 0 ? null : Math.round(((their - our) / our) * 10000) / 100,
    volumeDifference: theirVol === null || ourVol === null ? null : theirVol - ourVol,
    invoiceDate: ymd(r.invoice_date),
    dueDate: r.due_date === null ? null : ymd(r.due_date),
    periodFrom: ymd(r.period_from),
    periodTo: ymd(r.period_to),
    timezone: r.timezone as string,
    comparison: (r.comparison as VendorInvoiceRow["comparison"]) ?? null,
    status: r.recon_status as VendorInvoiceRow["status"],
    emailStatus: r.email_status as VendorInvoiceRow["emailStatus"],
    source: r.source as VendorInvoiceRow["source"],
    lineCount: Number(r.line_count ?? 0),
    remarks: (r.remarks as string | null) ?? null,
    checkedAt: iso(r.checked_at),
    inputFrom: iso(r.input_from),
    inputTo: iso(r.input_to),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.inserted_at)!,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

/** Email Logs (§8). */
export const EMAIL_LOG_FROM = `email_logs l
    LEFT JOIN enterprises e ON e.id = l.enterprise_id
    LEFT JOIN customer_trunks ct ON ct.id = l.customer_trunk_id
    LEFT JOIN vendor_trunks vt ON vt.id = l.vendor_trunk_id
    LEFT JOIN users u ON u.id = l.user_id`;
export const EMAIL_LOG_SELECT = `l.id, l.enterprise_id, l.email_type, l.status, l.rate_date, l.file_name, l.error, l.to_addresses,
    l.cc_addresses, l.subject, l.inserted_at, e.name AS enterprise, ct.name AS customer_trunk, vt.name AS vendor_trunk,
    u.username AS updated_by`;
export const emailLogList: ListDef<EmailLogRow> = {
  fields: listFields.email_logs,
  from: EMAIL_LOG_FROM,
  columns: {
    id: { sql: "l.id" },
    enterprise: { sql: "e.name" },
    enterpriseId: { sql: "l.enterprise_id" },
    customerTrunk: { sql: "ct.name" },
    vendorTrunk: { sql: "vt.name" },
    emailType: { sql: "l.email_type" },
    status: { sql: "l.status" },
    rateDate: { sql: "l.rate_date" },
    file: { sql: "l.file_name" },
    error: { sql: "l.error" },
    to: { sql: "array_to_string(l.to_addresses, ', ')" },
    cc: { sql: "array_to_string(l.cc_addresses, ', ')" },
    subject: { sql: "l.subject" },
    updatedBy: { sql: "u.username" },
    updatedAt: { sql: "l.inserted_at" },
  },
  search: ["enterprise", "to", "subject"],
  idSql: "l.id",
  select: EMAIL_LOG_SELECT,
  mapRow: (r) => mapEmailLog(r),
};

export function mapEmailLog(r: Record<string, unknown>): EmailLogRow {
  return {
    id: Number(r.id),
    enterpriseId: r.enterprise_id === null ? null : Number(r.enterprise_id),
    enterprise: (r.enterprise as string | null) ?? null,
    customerTrunk: (r.customer_trunk as string | null) ?? null,
    vendorTrunk: (r.vendor_trunk as string | null) ?? null,
    emailType: r.email_type as EmailLogRow["emailType"],
    status: r.status as EmailLogRow["status"],
    rateDate: r.rate_date === null ? null : ymd(r.rate_date),
    file: (r.file_name as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    to: (r.to_addresses as string[]) ?? [],
    cc: (r.cc_addresses as string[]) ?? [],
    subject: r.subject as string,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.inserted_at)!,
  };
}

/** Firewall banned / trusted IPs (§8). */
export const FIREWALL_RULE_FROM = `firewall_rules fr JOIN firewall_filters ff ON ff.id = fr.filter_id
    LEFT JOIN users u ON u.id = fr.created_by_id`;
/** A single address without its /32 or /128; a range in full CIDR form. */
const fwIpSql =
  "(CASE WHEN masklen(fr.ip) = (CASE family(fr.ip) WHEN 4 THEN 32 ELSE 128 END) THEN host(fr.ip) ELSE text(fr.ip) END)";
export const FIREWALL_RULE_SELECT = `fr.*, ${fwIpSql} AS ip_text, ff.name AS filter_name, u.username AS created_by`;
export const firewallRuleList: ListDef<FirewallRuleRow> = {
  fields: listFields.firewall_rules,
  from: FIREWALL_RULE_FROM,
  baseWhere: "fr.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "fr.id" },
    list: { sql: "fr.list" },
    ip: { sql: fwIpSql },
    filter: { sql: "ff.name" },
    filterId: { sql: "fr.filter_id" },
    source: { sql: "fr.source" },
    reason: { sql: "fr.reason" },
    hits: { sql: "fr.hits" },
    lastHitAt: { sql: "fr.last_hit_at" },
    expiresAt: { sql: "fr.expires_at" },
    createdBy: { sql: "u.username" },
    createdAt: { sql: "fr.inserted_at" },
    archived: { sql: "(fr.deleted_at IS NOT NULL)" },
  },
  search: ["ip", "reason"],
  idSql: "fr.id",
  select: FIREWALL_RULE_SELECT,
  mapRow: (r) => mapFirewallRule(r),
};

export function mapFirewallRule(r: Record<string, unknown>): FirewallRuleRow {
  return {
    id: Number(r.id),
    list: r.list as FirewallRuleRow["list"],
    ip: r.ip_text as string,
    filterId: Number(r.filter_id),
    filter: r.filter_name as string,
    source: r.source as FirewallRuleRow["source"],
    reason: (r.reason as string | null) ?? null,
    hits: Number(r.hits),
    lastHitAt: iso(r.last_hit_at),
    expiresAt: iso(r.expires_at),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.inserted_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

const ffCount = (list: string) =>
  `(SELECT count(*)::int FROM firewall_rules x WHERE x.filter_id = ff.id AND x.list = '${list}' AND x.deleted_at IS NULL)`;
export const FIREWALL_FILTER_FROM = "firewall_filters ff LEFT JOIN users u ON u.id = ff.updated_by_id";
export const FIREWALL_FILTER_SELECT = `ff.*, u.username AS updated_by, ${ffCount("banned")} AS banned, ${ffCount("trusted")} AS trusted`;
export const firewallFilterList: ListDef<FirewallFilterRow> = {
  fields: listFields.firewall_filters,
  from: FIREWALL_FILTER_FROM,
  baseWhere: "ff.deleted_at IS NULL",
  columns: {
    id: { sql: "ff.id" },
    name: { sql: "ff.name" },
    listener: { sql: "ff.listener" },
    status: { sql: "ff.status" },
    failedAttempts: { sql: "ff.failed_attempts" },
    windowSeconds: { sql: "ff.window_seconds" },
    banMinutes: { sql: "ff.ban_minutes" },
    banned: { sql: ffCount("banned") },
    trusted: { sql: ffCount("trusted") },
    updatedBy: { sql: "u.username" },
    updatedAt: { sql: "ff.updated_at" },
  },
  search: ["name"],
  idSql: "ff.id",
  select: FIREWALL_FILTER_SELECT,
  mapRow: (r) => mapFirewallFilter(r),
};

export function mapFirewallFilter(r: Record<string, unknown>): FirewallFilterRow {
  return {
    id: Number(r.id),
    name: r.name as string,
    listener: r.listener as FirewallFilterRow["listener"],
    status: r.status as FirewallFilterRow["status"],
    failedAttempts: Number(r.failed_attempts),
    windowSeconds: Number(r.window_seconds),
    banMinutes: Number(r.ban_minutes),
    banned: Number(r.banned ?? 0),
    trusted: Number(r.trusted ?? 0),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
  };
}

/** Traffic Alert (§8). */
export const TRAFFIC_ALERT_FROM = `traffic_alerts ta
    JOIN customer_trunks ct ON ct.id = ta.customer_trunk_id
    JOIN enterprises e ON e.id = ct.enterprise_id
    LEFT JOIN vendor_trunks vt ON vt.id = ta.vendor_trunk_id
    LEFT JOIN email_templates tp ON tp.id = ta.template_id
    LEFT JOIN users u ON u.id = ta.updated_by_id`;
export const TRAFFIC_ALERT_SELECT = `ta.*, ct.name AS customer_trunk, e.name AS enterprise, vt.name AS vendor_trunk, tp.name AS template,
    u.username AS updated_by`;
export const trafficAlertList: ListDef<TrafficAlertRow> = {
  fields: listFields.traffic_alerts,
  from: TRAFFIC_ALERT_FROM,
  baseWhere: "ta.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "ta.id" },
    name: { sql: "ta.name" },
    customerTrunk: { sql: "ct.name" },
    customerTrunkId: { sql: "ta.customer_trunk_id" },
    enterprise: { sql: "e.name" },
    vendorTrunk: { sql: "vt.name" },
    notificationEmails: { sql: "array_to_string(ta.notification_emails, ', ')" },
    status: { sql: "ta.status" },
    state: { sql: "ta.state" },
    lastCheckedAt: { sql: "ta.last_checked_at" },
    lastTriggeredAt: { sql: "ta.last_triggered_at" },
    asrThreshold: { sql: "ta.asr_threshold" },
    dlrThreshold: { sql: "ta.dlr_threshold" },
    marginThreshold: { sql: "ta.margin_threshold" },
    updatedBy: { sql: "u.username" },
    updatedAt: { sql: "ta.updated_at" },
    archived: { sql: "(ta.deleted_at IS NOT NULL)" },
  },
  search: ["name", "customerTrunk", "enterprise"],
  idSql: "ta.id",
  select: TRAFFIC_ALERT_SELECT,
  mapRow: (r) => mapTrafficAlert(r),
};

export function mapTrafficAlert(r: Record<string, unknown>): TrafficAlertRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(r.id),
    name: r.name as string,
    sampleCount: Number(r.sample_count),
    sampleMinutes: Number(r.sample_minutes),
    asrThreshold: Number(r.asr_threshold),
    dlrThreshold: Number(r.dlr_threshold),
    marginThreshold: Number(r.margin_threshold),
    customerTrunkId: Number(r.customer_trunk_id),
    vendorTrunkId: num(r.vendor_trunk_id),
    senderId: (r.sender_id as string | null) ?? null,
    mccmnc: (r.mccmnc as string | null) ?? null,
    delayThreshold: num(r.delay_threshold),
    notificationEmails: (r.notification_emails as string[]) ?? [],
    contactEmail: r.contact_email as TrafficAlertRow["contactEmail"],
    templateId: Number(r.template_id),
    status: r.status as TrafficAlertRow["status"],
    customerTrunk: r.customer_trunk as string,
    enterprise: r.enterprise as string,
    vendorTrunk: (r.vendor_trunk as string | null) ?? null,
    template: (r.template as string | null) ?? null,
    state: r.state as TrafficAlertRow["state"],
    lastCheckedAt: iso(r.last_checked_at),
    lastTriggeredAt: iso(r.last_triggered_at),
    lastValues: (r.last_values as TrafficAlertRow["lastValues"]) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

/** SMS To Voice (§8). */
const voiceDestSql = `(SELECT co.name || COALESCE(' · ' || m.network, '') FROM mccmnc m LEFT JOIN countries co ON co.id = m.country_id
    WHERE m.mccmnc = sv.mccmnc AND m.deleted_at IS NULL LIMIT 1)`;
export const SMS_VOICE_FROM = "sms_voice_rules sv LEFT JOIN users u ON u.id = sv.updated_by_id";
export const SMS_VOICE_SELECT = `sv.*, ${voiceDestSql} AS destination, u.username AS updated_by`;
export const smsVoiceRuleList: ListDef<SmsVoiceRuleRow> = {
  fields: listFields.sms_voice_rules,
  from: SMS_VOICE_FROM,
  baseWhere: "sv.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "sv.id" },
    senderId: { sql: "sv.sender_id" },
    receiverId: { sql: "sv.receiver_id" },
    prefix: { sql: "sv.prefix" },
    repeat: { sql: "sv.repeat_count" },
    destination: { sql: voiceDestSql },
    status: { sql: "sv.status" },
    updatedBy: { sql: "u.username" },
    updatedAt: { sql: "sv.updated_at" },
    archived: { sql: "(sv.deleted_at IS NOT NULL)" },
  },
  search: ["senderId", "receiverId", "prefix"],
  idSql: "sv.id",
  select: SMS_VOICE_SELECT,
  mapRow: (r) => mapSmsVoiceRule(r),
};

export function mapSmsVoiceRule(r: Record<string, unknown>): SmsVoiceRuleRow {
  return {
    id: Number(r.id),
    senderId: (r.sender_id as string | null) ?? null,
    receiverId: (r.receiver_id as string | null) ?? null,
    prefix: (r.prefix as string | null) ?? null,
    repeat: Number(r.repeat_count),
    mccmnc: (r.mccmnc as string | null) ?? null,
    status: r.status as SmsVoiceRuleRow["status"],
    destination: (r.destination as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

/** Broadcasts (§8). */
export const BROADCAST_FROM = `broadcasts b JOIN business_companies bc ON bc.id = b.business_company_id
    LEFT JOIN users u ON u.id = b.sent_by_id`;
export const BROADCAST_SELECT = "b.*, bc.name AS business_company, u.username AS sent_by";
export const broadcastList: ListDef<BroadcastRow> = {
  fields: listFields.broadcasts,
  from: BROADCAST_FROM,
  columns: {
    id: { sql: "b.id" },
    subject: { sql: "b.subject" },
    businessCompany: { sql: "bc.name" },
    sender: { sql: "b.sender" },
    enterprises: { sql: "b.enterprises" },
    addresses: { sql: "b.addresses" },
    failed: { sql: "b.failed" },
    attachment: { sql: "b.attachment_name" },
    sentBy: { sql: "u.username" },
    sentAt: { sql: "b.inserted_at" },
  },
  search: ["subject", "sender"],
  idSql: "b.id",
  select: BROADCAST_SELECT,
  mapRow: (r) => mapBroadcast(r),
};

export function mapBroadcast(r: Record<string, unknown>): BroadcastRow {
  return {
    id: Number(r.id),
    businessCompany: r.business_company as string,
    sender: r.sender as string,
    subject: r.subject as string,
    contactTypes: (r.contact_types as string[]) ?? [],
    enterpriseTypes: (r.enterprise_types as string[]) ?? [],
    enterprises: Number(r.enterprises),
    addresses: Number(r.addresses),
    failed: Number(r.failed),
    attachment: (r.attachment_name as string | null) ?? null,
    sentBy: (r.sent_by as string | null) ?? null,
    sentAt: iso(r.inserted_at)!,
  };
}

// ---------------------------------------------------------------- Observation Deck (§9)

export const EDR_TEMPLATE_FROM = "edr_templates t LEFT JOIN users u ON u.id = t.updated_by_id";
export const EDR_TEMPLATE_SELECT = "t.*, u.username AS updated_by";
export const edrTemplateList: ListDef<EdrTemplateRow> = {
  fields: listFields.edr_templates,
  from: EDR_TEMPLATE_FROM,
  baseWhere: "t.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "t.id" },
    name: { sql: "t.name" },
    columnCount: { sql: "cardinality(t.columns)" },
    updatedBy: { sql: "u.username" },
    updatedAt: { sql: "t.updated_at" },
    archived: { sql: "(t.deleted_at IS NOT NULL)" },
  },
  search: ["name"],
  idSql: "t.id",
  select: EDR_TEMPLATE_SELECT,
  mapRow: (r) => mapEdrTemplate(r),
};
export function mapEdrTemplate(r: Record<string, unknown>): EdrTemplateRow {
  return {
    id: Number(r.id),
    name: r.name as string,
    columns: (r.columns as string[]) ?? [],
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export const EDR_DOWNLOAD_FROM = "edr_downloads d LEFT JOIN users u ON u.id = d.requested_by_id";
export const EDR_DOWNLOAD_SELECT = "d.*, u.username AS requested_by";
export const edrDownloadList: ListDef<EdrDownloadRow> = {
  fields: listFields.edr_downloads,
  from: EDR_DOWNLOAD_FROM,
  columns: {
    id: { sql: "d.id" },
    kind: { sql: "d.kind" },
    status: { sql: "d.status" },
    fileName: { sql: "d.file_name" },
    fileType: { sql: "d.file_type" },
    progress: { sql: "d.progress" },
    rows: { sql: "d.row_count" },
    filterSummary: { sql: "d.filter_summary" },
    template: { sql: "d.template_name" },
    requestedAt: { sql: "d.requested_at" },
    finishedAt: { sql: "d.finished_at" },
    error: { sql: "d.error" },
    requestedBy: { sql: "u.username" },
  },
  search: ["fileName", "filterSummary", "requestedBy"],
  idSql: "d.id",
  select: EDR_DOWNLOAD_SELECT,
  mapRow: (r) => mapEdrDownload(r),
};
export function mapEdrDownload(r: Record<string, unknown>): EdrDownloadRow {
  return {
    id: Number(r.id),
    kind: r.kind as string,
    status: r.status as string,
    fileName: (r.file_name as string | null) ?? null,
    fileType: r.file_type as string,
    progress: Number(r.progress),
    rows: r.row_count == null ? null : Number(r.row_count),
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    filterSummary: (r.filter_summary as string) ?? "",
    template: (r.template_name as string | null) ?? null,
    requestedAt: iso(r.requested_at)!,
    finishedAt: iso(r.finished_at),
    error: (r.error as string | null) ?? null,
    requestedBy: (r.requested_by as string | null) ?? null,
  };
}

export const REPUSH_FROM = `repush_requests r JOIN vendor_trunks vt ON vt.id = r.vendor_trunk_id
    LEFT JOIN users u ON u.id = r.created_by_id`;
export const REPUSH_SELECT = "r.*, vt.name AS vendor_trunk, u.username AS created_by";
export const repushList: ListDef<RepushRequestRow> = {
  fields: listFields.repush_requests,
  from: REPUSH_FROM,
  columns: {
    id: { sql: "r.id" },
    edrCount: { sql: "r.edr_count" },
    vendorTrunk: { sql: "vt.name" },
    vendorTrunkId: { sql: "r.vendor_trunk_id" },
    status: { sql: "r.status" },
    delivered: { sql: "r.delivered" },
    failed: { sql: "r.failed" },
    skipped: { sql: "r.skipped" },
    createdBy: { sql: "u.username" },
    createdAt: { sql: "r.inserted_at" },
  },
  search: ["vendorTrunk", "createdBy"],
  idSql: "r.id",
  select: REPUSH_SELECT,
  mapRow: (r) => mapRepush(r),
};
export function mapRepush(r: Record<string, unknown>): RepushRequestRow {
  return {
    id: Number(r.id),
    edrCount: Number(r.edr_count),
    skipped: Number(r.skipped),
    vendorTrunkId: Number(r.vendor_trunk_id),
    vendorTrunk: r.vendor_trunk as string,
    status: r.status as string,
    delivered: Number(r.delivered),
    failed: Number(r.failed),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.inserted_at)!,
  };
}

/** Network Status (§9.2): every live trunk with its bind status, customer and vendor side. */
export const NETWORK_FROM = `(
    SELECT 'customer' AS side, t.id AS trunk_id, t.enterprise_id, e.name AS enterprise_name, t.name AS trunk_name,
           t.max_connections, tb.status, tb.connections, tb.queue, tb.tps, tb.since, u.username AS changed_by,
           coalesce((SELECT array_agg(DISTINCT host(s.ip) ORDER BY host(s.ip)) FROM bind_sessions s
                      WHERE s.side = 'customer' AND s.trunk_id = t.id), '{}') AS ips
      FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
      JOIN trunk_binds tb ON tb.side = 'customer' AND tb.trunk_id = t.id
      LEFT JOIN users u ON u.id = tb.changed_by_id
     WHERE t.deleted_at IS NULL
    UNION ALL
    SELECT 'vendor', t.id, t.enterprise_id, e.name, t.name, t.max_connections, tb.status, tb.connections, tb.queue,
           tb.tps, tb.since, u.username, ARRAY[t.host]
      FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id
      JOIN trunk_binds tb ON tb.side = 'vendor' AND tb.trunk_id = t.id
      LEFT JOIN users u ON u.id = tb.changed_by_id
     WHERE t.deleted_at IS NULL
  ) nb`;
export const networkBindList: ListDef<NetworkBindRow> = {
  fields: listFields.network_binds,
  from: NETWORK_FROM,
  columns: {
    side: { sql: "nb.side" },
    enterpriseId: { sql: "nb.enterprise_id" },
    trunkId: { sql: "nb.trunk_id" },
    enterpriseName: { sql: "nb.enterprise_name" },
    trunkName: { sql: "nb.trunk_name" },
    ipAddresses: { sql: "array_to_string(nb.ips, ', ')" },
    connections: { sql: "nb.connections" },
    maxConnections: { sql: "nb.max_connections" },
    queue: { sql: "nb.queue" },
    tps: { sql: "nb.tps" },
    status: { sql: "nb.status" },
    since: { sql: "nb.since" },
    changedBy: { sql: "nb.changed_by" },
  },
  search: ["enterpriseName", "trunkName", "ipAddresses"],
  idSql: "(nb.side || '-' || nb.trunk_id)",
  select: "nb.*",
  mapRow: (r) => mapNetworkBind(r),
};
export function mapNetworkBind(r: Record<string, unknown>): NetworkBindRow {
  return {
    id: `${r.side}-${r.trunk_id}`,
    side: r.side as string,
    trunkId: Number(r.trunk_id),
    enterpriseId: Number(r.enterprise_id),
    enterpriseName: r.enterprise_name as string,
    trunkName: r.trunk_name as string,
    ipAddresses: (r.ips as string[]) ?? [],
    connections: Number(r.connections),
    maxConnections: Number(r.max_connections),
    status: r.status as string,
    queue: r.side === "vendor" ? Number(r.queue ?? 0) : null,
    tps: Math.round(Number(r.tps) * 10) / 10,
    since: iso(r.since)!,
    changedBy: (r.changed_by as string | null) ?? null,
  };
}

const ipText = (col: string) => `CASE WHEN masklen(${col}) IN (32, 128) THEN host(${col}) ELSE text(${col}) END`;
export const CAPTURE_FROM =
  "signaling_captures c LEFT JOIN users u ON u.id = c.started_by_id LEFT JOIN users ku ON ku.id = c.kept_by_id";
/** Capture files are deleted 30 days after the capture ended unless kept (team trial round 1). */
export const CAPTURE_KEEP_DAYS = 30;
const captureExpires = `CASE WHEN c.keep OR c.status = 'running' THEN NULL ELSE c.updated_at + interval '${CAPTURE_KEEP_DAYS} days' END`;
export const CAPTURE_SELECT = `c.*, ${ipText("c.ip_filter")} AS ip_text, u.username AS started_by, ku.username AS kept_by, ${captureExpires} AS expires_at`;
export const captureList: ListDef<SignalingCaptureRow> = {
  fields: listFields.signaling_captures,
  from: CAPTURE_FROM,
  columns: {
    id: { sql: "c.id" },
    fileName: { sql: "c.file_name" },
    ipFilter: { sql: ipText("c.ip_filter") },
    status: { sql: "c.status" },
    sizeBytes: { sql: "c.size_bytes" },
    packets: { sql: "c.packets" },
    maxDurationSeconds: { sql: "c.max_duration_seconds" },
    maxFileSizeBytes: { sql: "c.max_file_size_bytes" },
    startedAt: { sql: "c.started_at" },
    updatedAt: { sql: "c.updated_at" },
    startedBy: { sql: "u.username" },
    keep: { sql: "c.keep" },
    expiresAt: { sql: captureExpires },
    source: { sql: "c.source" },
    criteria: { sql: "c.criteria" },
  },
  search: ["fileName", "ipFilter", "criteria"],
  idSql: "c.id",
  select: CAPTURE_SELECT,
  mapRow: (r) => mapCapture(r),
};
export function mapCapture(r: Record<string, unknown>): SignalingCaptureRow {
  return {
    id: Number(r.id),
    fileName: r.file_name as string,
    ipFilter: (r.ip_text as string | null) ?? null,
    status: r.status as string,
    sizeBytes: Number(r.size_bytes),
    packets: Number(r.packets),
    maxDurationSeconds: Number(r.max_duration_seconds),
    maxFileSizeBytes: Number(r.max_file_size_bytes),
    startedAt: iso(r.started_at)!,
    updatedAt: iso(r.updated_at)!,
    startedBy: (r.started_by as string | null) ?? null,
    source: (r.source as SignalingCaptureRow["source"] | undefined) ?? "live",
    recordedFrom: iso(r.recorded_from as Date | null),
    recordedTo: iso(r.recorded_to as Date | null),
    criteria: (r.criteria as string | null) ?? null,
    keep: r.keep === true,
    keptBy: (r.kept_by as string | null) ?? null,
    expiresAt: iso(r.expires_at as Date | null),
  };
}

// ---------------------------------------------------------------- Reports (§10, §13.15)

const presetSql = `CASE s.preset_key ${PRESETS.map((p) => `WHEN '${p.key}' THEN '${p.name.replace(/'/g, "''")}'`).join(" ")} ELSE s.preset_key END`;
export const SCHEDULED_REPORT_FROM = `scheduled_reports s JOIN business_companies bc ON bc.id = s.business_company_id
    LEFT JOIN saved_views v ON v.id = s.view_id LEFT JOIN users u ON u.id = s.updated_by_id`;
export const SCHEDULED_REPORT_SELECT = `s.*, bc.name AS business_company, u.username AS updated_by,
    CASE WHEN s.template_kind = 'view' THEN coalesce(v.name, '(deleted view)')
      WHEN s.template_kind = 'team' THEN 'Team report' || coalesce(' · ' || (SELECT d.name FROM departments d WHERE d.id = s.team_department_id), '') ELSE ${presetSql} END AS template`;
export const scheduledReportList: ListDef<ScheduledReportRow> = {
  fields: listFields.scheduled_reports,
  from: SCHEDULED_REPORT_FROM,
  baseWhere: "s.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "s.id" },
    name: { sql: "s.name" },
    template: {
      sql: `CASE WHEN s.template_kind = 'view' THEN coalesce(v.name, '') WHEN s.template_kind = 'team' THEN 'Team report' || coalesce(' · ' || (SELECT d.name FROM departments d WHERE d.id = s.team_department_id), '') ELSE ${presetSql} END`,
    },
    status: { sql: "s.status" },
    cronExpression: { sql: "s.cron_expression" },
    nextRunAt: { sql: "s.next_run_at" },
    lastRunAt: { sql: "s.last_run_at" },
    lastStatus: { sql: "s.last_status" },
    businessCompany: { sql: "bc.name" },
    updatedBy: { sql: "u.username" },
    archived: { sql: "(s.deleted_at IS NOT NULL)" },
  },
  search: ["name", "template"],
  idSql: "s.id",
  select: SCHEDULED_REPORT_SELECT,
  mapRow: (r) => mapScheduledReport(r),
};
export function mapScheduledReport(r: Record<string, unknown>): ScheduledReportRow {
  return {
    id: Number(r.id),
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    templateKind: r.template_kind as ScheduledReportRow["templateKind"],
    presetKey: (r.preset_key as string | null) ?? null,
    viewId: r.view_id == null ? null : Number(r.view_id),
    teamDepartmentId: r.team_department_id == null ? null : Number(r.team_department_id),
    teamPeriod: (r.team_period as ScheduledReportRow["teamPeriod"]) ?? null,
    template: r.template as string,
    status: r.status as ScheduledReportRow["status"],
    businessCompanyId: Number(r.business_company_id),
    businessCompany: r.business_company as string,
    notificationEmails: (r.notification_emails as string[]) ?? [],
    cronInterval: r.cron_interval as ScheduledReportRow["cronInterval"],
    cronFrequency: Number(r.cron_frequency),
    cronExpression: r.cron_expression as string,
    fileType: r.file_type as ScheduledReportRow["fileType"],
    emailBody: r.email_body as string,
    nextRunAt: iso(r.next_run_at),
    lastRunAt: iso(r.last_run_at),
    lastStatus: (r.last_status as ScheduledReportRow["lastStatus"]) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export const DAILY_ALERT_FROM = `daily_traffic_alerts d JOIN enterprises e ON e.id = d.enterprise_id
    LEFT JOIN business_companies bc ON bc.id = coalesce(d.business_company_id, e.business_company_id)
    LEFT JOIN users u ON u.id = d.updated_by_id`;
export const DAILY_ALERT_SELECT = "d.*, e.name AS enterprise, bc.name AS business_company, u.username AS updated_by";
export const dailyAlertList: ListDef<DailyTrafficAlertRow> = {
  fields: listFields.daily_traffic_alerts,
  from: DAILY_ALERT_FROM,
  baseWhere: "d.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "d.id" },
    name: { sql: "d.name" },
    enterprise: { sql: "e.name" },
    contactType: { sql: "d.contact_type" },
    sendHour: { sql: "d.send_hour" },
    status: { sql: "d.status" },
    lastSentAt: { sql: "d.last_sent_at" },
    updatedBy: { sql: "u.username" },
    archived: { sql: "(d.deleted_at IS NOT NULL)" },
  },
  search: ["name", "enterprise"],
  idSql: "d.id",
  select: DAILY_ALERT_SELECT,
  mapRow: (r) => mapDailyAlert(r),
};
export function mapDailyAlert(r: Record<string, unknown>): DailyTrafficAlertRow {
  return {
    id: Number(r.id),
    name: r.name as string,
    status: r.status as DailyTrafficAlertRow["status"],
    businessCompanyId: r.business_company_id == null ? null : Number(r.business_company_id),
    businessCompany: (r.business_company as string | null) ?? null,
    contactType: r.contact_type as DailyTrafficAlertRow["contactType"],
    enterpriseId: Number(r.enterprise_id),
    enterprise: r.enterprise as string,
    sendHour: Number(r.send_hour),
    emailBody: r.email_body as string,
    lastSentAt: iso(r.last_sent_at),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

/** SOA Report (§7): exports and sends with the statement kept as it was. */
export const SOA_REPORT_FROM = `soa_reports s
    JOIN enterprises e ON e.id = s.enterprise_id
    LEFT JOIN email_templates t ON t.id = s.template_id
    LEFT JOIN users u ON u.id = s.created_by_id`;
export const SOA_REPORT_SELECT = `s.id, s.enterprise_id, s.period_from, s.period_to, s.invoice_type, s.file_type, s.purpose, s.status,
    s.error, s.emailed_at, s.email_to, s.closing_balance, s.currency, s.inserted_at, s.finished_at,
    e.name AS enterprise, t.name AS template, u.username AS created_by`;
export const soaReportList: ListDef<SoaReportRow> = {
  fields: listFields.soa_reports,
  from: SOA_REPORT_FROM,
  columns: {
    id: { sql: "s.id" },
    enterprise: visCol(enterpriseMask("e")),
    enterpriseId: { sql: "s.enterprise_id" },
    from: { sql: "s.period_from" },
    to: { sql: "s.period_to" },
    invoiceType: { sql: "s.invoice_type" },
    fileType: { sql: "s.file_type" },
    purpose: { sql: "s.purpose" },
    status: { sql: "s.status" },
    error: { sql: "s.error" },
    emailedAt: { sql: "s.emailed_at" },
    template: { sql: "t.name" },
    closingBalance: visCol(hide("balances", "s.closing_balance", byEnterprise("s.enterprise_id"))),
    createdBy: { sql: "u.username" },
    createdAt: { sql: "s.inserted_at" },
  },
  search: ["enterprise"],
  idSql: "s.id",
  select: SOA_REPORT_SELECT,
  mapRow: (r) => mapSoaReport(r),
};

export function mapSoaReport(r: Record<string, unknown>): SoaReportRow {
  return {
    id: Number(r.id),
    enterpriseId: Number(r.enterprise_id),
    enterprise: r.enterprise as string,
    from: ymd(r.period_from),
    to: ymd(r.period_to),
    invoiceType: r.invoice_type as SoaReportRow["invoiceType"],
    fileType: r.file_type as SoaReportRow["fileType"],
    purpose: r.purpose as SoaReportRow["purpose"],
    status: r.status as SoaReportRow["status"],
    error: (r.error as string | null) ?? null,
    emailedAt: iso(r.emailed_at),
    emailTo: (r.email_to as string[]) ?? [],
    template: (r.template as string | null) ?? null,
    closingBalance: r.closing_balance === null ? null : Number(r.closing_balance),
    currency: r.currency ? String(r.currency).trim() : null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.inserted_at)!,
    finishedAt: iso(r.finished_at),
  };
}

/** Reconciliation rules (§13.31): the default rule (no enterprise) first, then partners. */
const rrInvoicesSql = `(CASE WHEN rr.enterprise_id IS NULL
    THEN (SELECT count(*)::int FROM vendor_invoices vi WHERE vi.deleted_at IS NULL AND NOT EXISTS
           (SELECT 1 FROM recon_rules x WHERE x.enterprise_id = vi.enterprise_id AND x.deleted_at IS NULL))
    ELSE (SELECT count(*)::int FROM vendor_invoices vi WHERE vi.deleted_at IS NULL AND vi.enterprise_id = rr.enterprise_id) END)`;
export const RECON_RULE_FROM = `recon_rules rr
    LEFT JOIN enterprises e ON e.id = rr.enterprise_id
    LEFT JOIN enterprise_billing vb ON vb.enterprise_id = rr.enterprise_id AND vb.side = 'vendor'
    LEFT JOIN users u ON u.id = rr.updated_by_id`;
export const RECON_RULE_SELECT = `rr.*, e.name AS enterprise, vb.currency AS vendor_currency, u.username AS updated_by,
    ${rrInvoicesSql} AS invoices`;
export const reconRuleList: ListDef<ReconRuleRow> = {
  fields: listFields.recon_rules,
  from: RECON_RULE_FROM,
  baseWhere: "rr.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "rr.id" },
    // The default rule sorts first.
    enterprise: { sql: "COALESCE(e.name, '')" },
    enterpriseId: { sql: "rr.enterprise_id" },
    amountPct: { sql: "rr.amount_pct" },
    amountFixed: { sql: "rr.amount_fixed" },
    amountCombine: { sql: "rr.amount_combine" },
    countPct: { sql: "rr.count_pct" },
    countFixed: { sql: "rr.count_fixed" },
    countCombine: { sql: "rr.count_combine" },
    destinationPct: { sql: "rr.destination_pct" },
    autoSend: { sql: "rr.auto_send" },
    disputedInSoa: { sql: "rr.disputed_in_soa" },
    currency: { sql: "vb.currency" },
    invoices: { sql: rrInvoicesSql },
    updatedBy: { sql: "u.username" },
    updatedAt: { sql: "rr.updated_at" },
    archived: { sql: "(rr.deleted_at IS NOT NULL)" },
  },
  search: ["enterprise"],
  idSql: "rr.id",
  select: RECON_RULE_SELECT,
  mapRow: (r) => mapReconRule(r),
};

export function mapReconRule(r: Record<string, unknown>): ReconRuleRow {
  return {
    id: Number(r.id),
    enterpriseId: numOrNull(r.enterprise_id),
    enterprise: (r.enterprise as string | null) ?? null,
    amountPct: numOrNull(r.amount_pct),
    amountFixed: numOrNull(r.amount_fixed),
    amountCombine: r.amount_combine as ReconRuleRow["amountCombine"],
    countPct: numOrNull(r.count_pct),
    countFixed: numOrNull(r.count_fixed),
    countCombine: r.count_combine as ReconRuleRow["countCombine"],
    destinationPct: numOrNull(r.destination_pct),
    autoSend: r.auto_send as ReconRuleRow["autoSend"],
    disputedInSoa: r.disputed_in_soa as ReconRuleRow["disputedInSoa"],
    currency: r.vendor_currency ? String(r.vendor_currency).trim() : null,
    invoices: Number(r.invoices ?? 0),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

const currencyRateSql = "(SELECT cl.rate_per_eur FROM currency_latest cl WHERE cl.iso = c.iso)";
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
    ratePerEur: { sql: currencyRateSql },
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
    ratePerEur: Number(r.rate),
    rateUpdatedAt: iso(r.rate_at),
    enterprises: Number(r.enterprises),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
  }),
};

/** The rate in force per currency (units per EUR; EUR = 1, no row), the one before it and who set it. */
const rateNow = `LEFT JOIN LATERAL (SELECT r.rate_per_eur, r.valid_from, r.updated_by_id FROM currency_rates r
    WHERE r.iso = c.iso AND r.valid_from <= now() ORDER BY r.valid_from DESC LIMIT 1) cur ON true
  LEFT JOIN LATERAL (SELECT r.rate_per_eur FROM currency_rates r
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
    ratePerEur: { sql: "COALESCE(cur.rate_per_eur, 1)" },
    validFrom: { sql: "cur.valid_from" },
    updatedBy: { sql: "ub.username" },
  },
  search: ["iso", "currency"],
  idSql: "c.id",
  select: `c.id, c.iso, c.name, COALESCE(cur.rate_per_eur, 1) AS rate, cur.valid_from, ub.username AS updated_by,
    prev.rate_per_eur AS previous_rate`,
  mapRow: (r) => ({
    id: Number(r.id),
    iso: String(r.iso).trim(),
    currency: r.name as string,
    ratePerEur: Number(r.rate),
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
    ratePerEur: { sql: "r.rate_per_eur" },
    validFrom: { sql: "r.valid_from" },
    updatedBy: { sql: "ub.username" },
  },
  search: ["iso", "currency", "updatedBy"],
  idSql: "r.id",
  select: "r.id, r.iso, c.name, r.rate_per_eur, r.valid_from, ub.username AS updated_by",
  mapRow: (r) => ({
    id: Number(r.id),
    iso: String(r.iso).trim(),
    currency: r.name as string,
    ratePerEur: Number(r.rate_per_eur),
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
 * Balances (§7, sign decided 2026-10-17): opening + payments and credits − usage charges, so a
 * positive balance is the partner's credit with us and a negative one is what the client owes us
 * (customer) or what we owe the vendor (vendor: opening + our payments − accepted vendor
 * invoices). Payments left off the SOA still count (§13.33).
 */
export const BALANCE_FROM = `enterprises e
    LEFT JOIN enterprise_billing cb ON cb.enterprise_id = e.id AND cb.side = 'customer'
    LEFT JOIN enterprise_billing vb ON vb.enterprise_id = e.id AND vb.side = 'vendor'
    LEFT JOIN billing_cycles bcy ON bcy.id = COALESCE(cb.billing_cycle_id, vb.billing_cycle_id)
    LEFT JOIN users am ON am.id = e.account_manager_id
    LEFT JOIN LATERAL (SELECT
        CASE WHEN cb.id IS NULL THEN NULL ELSE cb.opening_balance
          + COALESCE((SELECT sum(CASE payment_type WHEN 'credit' THEN amount ELSE -amount END) FROM transactions
                       WHERE enterprise_id = e.id AND side = 'customer' AND deleted_at IS NULL), 0)
          - COALESCE((SELECT sum(usage_charges) FROM invoices WHERE enterprise_id = e.id AND deleted_at IS NULL
                       AND status <> 'failed' AND kind = 'traffic'), 0) END AS customer,
        CASE WHEN vb.id IS NULL THEN NULL ELSE vb.opening_balance
          + COALESCE((SELECT sum(CASE payment_type WHEN 'debit' THEN amount ELSE -amount END) FROM transactions
                       WHERE enterprise_id = e.id AND side = 'vendor' AND deleted_at IS NULL), 0)
          - COALESCE((SELECT sum(charge_amount) FROM vendor_invoices
                       WHERE enterprise_id = e.id AND deleted_at IS NULL AND recon_status = 'accepted'), 0) END AS vendor) bal ON true
    LEFT JOIN currency_latest ccl ON ccl.iso = cb.currency
    LEFT JOIN currency_latest vcl ON vcl.iso = vb.currency`;
const netSql = `round(COALESCE(bal.customer, 0)
    - COALESCE(bal.vendor * COALESCE(ccl.rate_per_eur, vcl.rate_per_eur) / vcl.rate_per_eur, 0), 2)`;
/** Credit used: what the client owes us (a negative balance) as a share of the limit, never below 0. */
const creditUsedSql = `CASE WHEN cb.credit_limit > 0 THEN GREATEST(0, round(-bal.customer / cb.credit_limit * 100, 1)) END`;

export const enterpriseBalanceList: ListDef<EnterpriseBalanceRow> = {
  fields: listFields.enterprise_balances,
  from: BALANCE_FROM,
  baseWhere: "e.deleted_at IS NULL AND (cb.id IS NOT NULL OR vb.id IS NOT NULL)",
  columns: {
    id: { sql: "e.id" },
    enterprise: visCol(enterpriseMask("e")),
    enterpriseType: { sql: "e.type" },
    customerBalance: visCol(hide("balances", "round(bal.customer, 2)", byEnterprise("e.id"))),
    customerCurrency: { sql: "cb.currency" },
    vendorBalance: visCol(hide("balances", "round(bal.vendor, 2)", byEnterprise("e.id"))),
    vendorCurrency: { sql: "vb.currency" },
    netBalance: visCol(hide("balances", netSql, byEnterprise("e.id"))),
    accountManager: { sql: fullName("am") },
    billingType: { sql: "cb.billing_type" },
    creditLimit: visCol(hide("balances", "cb.credit_limit", byEnterprise("e.id"))),
    creditUsedPct: visCol(hide("balances", creditUsedSql, byEnterprise("e.id"))),
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

/**
 * Billing report (§13.15): enterprises with the period's traffic (a temporary table `br_traffic`
 * filled from the EDR store in the same transaction), invoices, payments, balances and disputes.
 * The period is filled in by billingReportDef.
 */
const BR_PERIOD = "'__FROM__'::timestamptz";
const BR_PERIOD_END = "'__TO__'::timestamptz";
const BILLING_REPORT_FROM = `${BALANCE_FROM}
    LEFT JOIN br_traffic tr ON tr.enterprise_id = e.id
    LEFT JOIN LATERAL (SELECT count(*) AS n, coalesce(sum(usage_charges), 0) AS amount FROM invoices i
       WHERE i.enterprise_id = e.id AND i.deleted_at IS NULL AND i.status <> 'failed'
         AND i.invoice_date >= ${BR_PERIOD}::date AND i.invoice_date < ${BR_PERIOD_END}::date) inv ON true
    LEFT JOIN LATERAL (SELECT
         coalesce(sum(amount) FILTER (WHERE side = 'customer' AND payment_type = 'credit'), 0) AS received,
         coalesce(sum(amount) FILTER (WHERE side = 'vendor' AND payment_type = 'debit'), 0) AS made
       FROM transactions t WHERE t.enterprise_id = e.id AND t.deleted_at IS NULL AND t.transaction_type IN ('receipt', 'bill_payment')
         AND t.payment_date >= ${BR_PERIOD}::date AND t.payment_date < ${BR_PERIOD_END}::date) pay ON true
    LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE recon_status = 'disputed') AS disputed,
         coalesce(sum(charge_amount - our_amount) FILTER (WHERE our_amount IS NOT NULL), 0) AS diff
       FROM vendor_invoices vi WHERE vi.enterprise_id = e.id AND vi.deleted_at IS NULL
         AND vi.period_from < ${BR_PERIOD_END}::date AND vi.period_to >= ${BR_PERIOD}::date) vin ON true
    LEFT JOIN LATERAL (SELECT coalesce(sum(new_amount - old_amount), 0) AS amount FROM rerating_results rr
       WHERE rr.enterprise_id = e.id AND rr.start_time < ${BR_PERIOD_END} AND rr.end_time >= ${BR_PERIOD}) rer ON true`;
const brCurrency = "COALESCE(cb.currency, vb.currency, 'EUR')";
/** The Billing report list for a period [from, to). */
export const billingReportDef = (from: Date, to: Date): ListDef<BillingReportRow> => ({
  ...billingReportList,
  from: BILLING_REPORT_FROM.replace(/__FROM__/g, from.toISOString()).replace(/__TO__/g, to.toISOString()),
});
export const billingReportList: ListDef<BillingReportRow> = {
  fields: listFields.billing_report,
  from: BILLING_REPORT_FROM,
  baseWhere: "e.deleted_at IS NULL AND (cb.id IS NOT NULL OR vb.id IS NOT NULL)",
  columns: {
    id: { sql: "e.id" },
    enterprise: { sql: "e.name" },
    type: { sql: "e.type" },
    accountManager: { sql: fullName("am") },
    billingCycle: { sql: "bcy.name" },
    currency: { sql: brCurrency },
    customerBillable: { sql: "coalesce(tr.c_billable, 0)" },
    customerAmount: { sql: "round(coalesce(tr.c_amount, 0), 2)" },
    vendorBillable: { sql: "coalesce(tr.v_billable, 0)" },
    vendorAmount: { sql: "round(coalesce(tr.v_amount, 0), 2)" },
    invoicesIssued: { sql: "inv.n" },
    invoicedAmount: { sql: "round(inv.amount, 2)" },
    paymentsReceived: { sql: "round(pay.received, 2)" },
    paymentsMade: { sql: "round(pay.made, 2)" },
    balance: { sql: "round(COALESCE(bal.customer, -bal.vendor), 2)" },
    creditLimit: { sql: "cb.credit_limit" },
    creditUsePct: { sql: creditUsedSql },
    disputedInvoices: { sql: "vin.disputed" },
    vendorInvoiceDifference: { sql: "round(vin.diff, 2)" },
    negativeMarginMessages: { sql: "coalesce(tr.neg_msgs, 0)" },
    negativeMarginAmount: { sql: "round(coalesce(tr.neg_amount, 0), 2)" },
    reratedAmount: { sql: "round(rer.amount, 2)" },
  },
  search: ["enterprise", "accountManager"],
  idSql: "e.id",
  select: `e.id, e.name, e.type, ${fullName("am")} AS account_manager, bcy.name AS billing_cycle, ${brCurrency} AS currency,
    coalesce(tr.c_billable, 0) AS c_billable, coalesce(tr.c_amount, 0) AS c_amount, coalesce(tr.v_billable, 0) AS v_billable,
    coalesce(tr.v_amount, 0) AS v_amount, inv.n AS invoices, inv.amount AS invoiced, pay.received, pay.made,
    COALESCE(bal.customer, -bal.vendor) AS balance, cb.credit_limit, ${creditUsedSql} AS credit_use, vin.disputed, vin.diff,
    coalesce(tr.neg_msgs, 0) AS neg_msgs, coalesce(tr.neg_amount, 0) AS neg_amount, rer.amount AS rerated`,
  mapRow: (r) => ({
    id: Number(r.id),
    enterprise: r.name as string,
    type: r.type as string,
    accountManager: (r.account_manager as string | null) ?? null,
    billingCycle: (r.billing_cycle as string | null) ?? null,
    currency: String(r.currency).trim(),
    customerBillable: Number(r.c_billable),
    customerAmount: Math.round(Number(r.c_amount) * 100) / 100,
    vendorBillable: Number(r.v_billable),
    vendorAmount: Math.round(Number(r.v_amount) * 100) / 100,
    invoicesIssued: Number(r.invoices),
    invoicedAmount: Math.round(Number(r.invoiced) * 100) / 100,
    paymentsReceived: Math.round(Number(r.received) * 100) / 100,
    paymentsMade: Math.round(Number(r.made) * 100) / 100,
    balance: r.balance == null ? null : Math.round(Number(r.balance) * 100) / 100,
    creditLimit: r.credit_limit == null ? null : Number(r.credit_limit),
    creditUsePct: r.credit_use == null ? null : Number(r.credit_use),
    disputedInvoices: Number(r.disputed),
    vendorInvoiceDifference: Math.round(Number(r.diff) * 100) / 100,
    negativeMarginMessages: Number(r.neg_msgs),
    negativeMarginAmount: Math.round(Number(r.neg_amount) * 100) / 100,
    reratedAmount: Math.round(Number(r.rerated) * 100) / 100,
  }),
};

/** Lists answered from PostgreSQL; the Enterprise report and EDR lists run on the EDR store (enterpriseReport.ts, edrDefs.ts). */
export type PgListId = Exclude<
  ListId,
  "enterprise_report" | "edrs" | "failed_edrs" | "master_report" | "billing_report"
>;

/**
 * PCAP Trace (§9.2, team trial round 1): every SMPP packet is recorded into one file per quarter-hour,
 * gzip-compressed once the quarter is over, and kept 60 days. The files are listed from a series of
 * quarters; sizes follow the platform volume and the hour of the day (fake, deterministic per quarter).
 */
export const RECORDING_KEEP_DAYS = 60;
const SIM_TPS = Number(process.env.SIM_TOTAL_TPS ?? 40) || 40;
const PCAP_TRACE_FROM = `(SELECT q.*, CASE WHEN q.in_progress
          THEN greatest(24, (extract(epoch FROM now() - q.started_at) * ${SIM_TPS} * 1000)::bigint)
          ELSE (900 * ${SIM_TPS} * 1000 / 2.4 * (0.55 + 0.45 * sin(pi() * extract(hour FROM q.started_at AT TIME ZONE 'UTC') / 24))
                * (0.95 + (abs(hashtext(q.id::text)) % 100) / 1000.0))::bigint END AS size_bytes,
        'trace-' || to_char(q.started_at AT TIME ZONE 'UTC', 'YY-MM-DD-HH24-MI-SS')
          || CASE WHEN q.in_progress THEN '.pcap' ELSE '.pcap.gz' END AS file_name
      FROM (SELECT (extract(epoch FROM g) / 900)::bigint AS id, g AS started_at,
                   least(g + interval '15 minutes', now()) AS updated_at, g + interval '15 minutes' > now() AS in_progress
              FROM generate_series(to_timestamp(floor(extract(epoch FROM now() - interval '${RECORDING_KEEP_DAYS} days') / 900) * 900),
                                   now(), interval '15 minutes') g) q) t`;
export const pcapTraceList: ListDef<PcapTraceRow> = {
  fields: listFields.pcap_traces,
  from: PCAP_TRACE_FROM,
  columns: {
    fileName: { sql: "t.file_name" },
    sizeBytes: { sql: "t.size_bytes" },
    updatedAt: { sql: "t.updated_at" },
    startedAt: { sql: "t.started_at" },
  },
  search: ["fileName"],
  idSql: "t.id",
  select: "t.*",
  mapRow: (r) => ({
    id: Number(r.id),
    fileName: r.file_name as string,
    sizeBytes: Number(r.size_bytes),
    startedAt: iso(r.started_at)!,
    updatedAt: iso(r.updated_at)!,
    inProgress: r.in_progress === true,
  }),
};

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
  invoice_requests: invoiceRequestList as ListDef<unknown>,
  vendor_invoices: vendorInvoiceList as ListDef<unknown>,
  recon_rules: reconRuleList as ListDef<unknown>,
  soa_reports: soaReportList as ListDef<unknown>,
  email_templates: emailTemplateList as ListDef<unknown>,
  departments: departmentList as ListDef<unknown>,
  access_groups: accessGroupList as ListDef<unknown>,
  user_sessions: sessionList(CURRENT_USER_ID) as ListDef<unknown>,
  audit_log: auditList as ListDef<unknown>,
  business_companies: businessCompanyList as ListDef<unknown>,
  customer_portal_users: portalUserList as ListDef<unknown>,
  alert_rules: alertRuleList as ListDef<unknown>,
  incidents: incidentList as ListDef<unknown>,
  rate_notifications: rnList as ListDef<unknown>,
  rate_notification_lines: rnLineList as ListDef<unknown>,
  market_moves: marketMoveList as ListDef<unknown>,
  lcr_profiles: lcrProfileList as ListDef<unknown>,
  lcr_changes: lcrChangeList as ListDef<unknown>,
  email_logs: emailLogList as ListDef<unknown>,
  firewall_rules: firewallRuleList as ListDef<unknown>,
  firewall_filters: firewallFilterList as ListDef<unknown>,
  traffic_alerts: trafficAlertList as ListDef<unknown>,
  sms_voice_rules: smsVoiceRuleList as ListDef<unknown>,
  broadcasts: broadcastList as ListDef<unknown>,
  edr_templates: edrTemplateList as ListDef<unknown>,
  edr_downloads: edrDownloadList as ListDef<unknown>,
  repush_requests: repushList as ListDef<unknown>,
  network_binds: networkBindList as ListDef<unknown>,
  signaling_captures: captureList as ListDef<unknown>,
  scheduled_reports: scheduledReportList as ListDef<unknown>,
  daily_traffic_alerts: dailyAlertList as ListDef<unknown>,
  currencies: currencyList as ListDef<unknown>,
  currency_rates: currencyRateList as ListDef<unknown>,
  currency_rate_history: currencyRateHistoryList as ListDef<unknown>,
  billing_cycles: billingCycleList as ListDef<unknown>,
  enterprise_balances: enterpriseBalanceList as ListDef<unknown>,
  visibility_policies: visibilityPolicyList as ListDef<unknown>,
  visibility_assignments: visibilityAssignmentList as ListDef<unknown>,
  visibility_grants: visibilityGrantList as ListDef<unknown>,
  team_timeline: teamTimelineList as ListDef<unknown>,
  cleanup_findings: cleanupFindingList as ListDef<unknown>,
  pcap_traces: pcapTraceList as ListDef<unknown>,
};

export { emailTemplateList, userList };
