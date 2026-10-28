// EDR Search and Failed EDR Search (§9.1, §9.2) on the ClickHouse `edr` table (chEngine.ts).
import type { EdrRow, FailedEdrRow, FieldDescriptor } from "@sms/contract";
import { CAUSE_CODES, causeName } from "../smpp.js";
import { chIso, lit, type ChColumn, type ChListDef, type NameMaps, type NameSource } from "./chEngine.js";
import { listFields } from "./fields.js";

const ENTERPRISES: NameSource = { table: "enterprises e", name: "e.name", id: "e.id" };
const CUSTOMER_TRUNKS: NameSource = { table: "customer_trunks t", name: "t.name", id: "t.id" };
const VENDOR_TRUNKS: NameSource = { table: "vendor_trunks t", name: "t.name", id: "t.id" };
const HLR_PROVIDERS: NameSource = { table: "hlr_providers p", name: "p.name", id: "p.id" };
const CATEGORIES: NameSource = { table: "product_categories c", name: "c.name", id: "c.id" };
// Destinations by MCCMNC code (team trial round 7): the code is all digits, so it serves as the ID.
const DESTINATIONS: NameSource = {
  table: `(SELECT m.mccmnc::bigint AS code,
             CASE WHEN m.is_all_networks THEN co.name || ' · All networks' ELSE co.name || ' · ' || m.network END AS name
           FROM mccmnc m JOIN countries co ON co.id = m.country_id WHERE m.deleted_at IS NULL) d`,
  name: "d.name",
  id: "d.code",
};

const named = (src: NameSource, idSql: string): ChColumn => ({ sql: idSql, names: { ...src, idSql } });
const has = (arr: string) => (c: { op: string; value?: unknown; values?: unknown[] }) => {
  const vs = (c.values ?? [c.value]).map((v) => String(Math.trunc(Number(v))));
  const any = `hasAny(${arr}, [${vs.join(",")}])`;
  return c.op === "neq" || c.op === "not_in"
    ? `NOT ${any}`
    : c.op === "empty"
      ? `empty(${arr})`
      : c.op === "not_empty"
        ? `notEmpty(${arr})`
        : any;
};
const msgIdWhere = (c: { op: string; value?: unknown; values?: unknown[] }) => {
  const ids = (c.values ?? [c.value]).map((v) => lit(String(v)));
  const any = `hasAny(splitByChar(',', v_message_id), [${ids.join(",")}])`;
  return c.op === "neq" || c.op === "not_in"
    ? `NOT ${any}`
    : c.op === "empty"
      ? "v_message_id = ''"
      : c.op === "not_empty"
        ? "v_message_id != ''"
        : c.op === "like"
          ? `v_message_id ILIKE ${lit(`%${String(c.value)}%`)}`
          : any;
};
/**
 * Number, sender or Msg ID (team trial round 2, §9.1): each value is the start of a receiver number, a sender ID,
 * a Customer Msg ID or any part's Vendor Msg ID ("2348" finds every number starting 2348; a whole value finds it).
 */
const numberOrMsgIdWhere = (c: { op: string; value?: unknown; values?: unknown[] }) => {
  const raw = (c.values ?? [c.value]).map((v) => String(v).trim()).filter(Boolean);
  if (!raw.length) return "0";
  const parts = raw.map((v) => {
    const p = lit(v);
    const digits = v.replace(/[\s+()-]/g, "");
    const or = [
      `startsWith(src_addr, ${p})`,
      `startsWith(c_message_id, ${p})`,
      `arrayExists(x -> startsWith(x, ${p}), splitByChar(',', v_message_id))`,
    ];
    if (/^\d+$/.test(digits)) or.unshift(`startsWith(dst_addr, ${lit(digits)})`);
    return or.join(" OR ");
  });
  return `(${parts.map((p) => `(${p})`).join(" OR ")})`;
};
// The switch writes the final status, delay and receipt-billed money on an outcome row (backend step 11b): the vendor
// side's values count once the vendor's final status is known.
const VENDOR_FINAL = "msg_status != ''";
const CAUSE_TEXT = `transform(command_status, [${CAUSE_CODES.map((c) => c.code).join(",")}], [${CAUSE_CODES.map((c) => lit(c.name)).join(",")}], '')`;

// HLR error in words (team trial round 7): the switch writes 408 when the provider timed out, else the provider's code.
const HLR_ERROR_TEXT = `multiIf(hlr_fetch_type = 'none' OR hlr_is_accomplished = 1, '', hlr_error_code = 408, 'Timeout',
  hlr_error_code = 0, 'No result', concat('Error ', toString(hlr_error_code)))`;

export const EDR_COLUMNS: Record<string, ChColumn> = {
  startTime: { sql: "start_time" },
  submitTime: { sql: "submit_time" },
  submitRespTime: { sql: "submit_resp_time", nullable: true },
  deliveryTime: { sql: "delivery_time", nullable: true, outcome: { sql: "receipt_time", merge: "status", when: VENDOR_FINAL } },
  id: { sql: "toString(edr_id)" },
  type: { sql: "toString(msg_type)" },
  businessCompanyId: { sql: "business_company_id" },
  productCategoryId: { sql: "product_category_id" },
  productCategory: named(CATEGORIES, "product_category_id"),
  customerEnterpriseId: { sql: "c_enterprise_id" },
  customerEnterprise: named(ENTERPRISES, "c_enterprise_id"),
  customerTrunkId: { sql: "c_trunk_id" },
  customerTrunk: named(CUSTOMER_TRUNKS, "c_trunk_id"),
  customerIp: { sql: "IPv4NumToString(c_ip)" },
  customerPort: { sql: "c_port" },
  customerSessionId: { sql: "c_session_id" },
  customerBindType: { sql: "c_bind_type" },
  protocol: { sql: "c_protocol" },
  customerMsgId: { sql: "c_message_id" },
  srcTon: { sql: "c_src_ton" },
  srcNpi: { sql: "c_src_npi" },
  dstTon: { sql: "c_dst_ton" },
  dstNpi: { sql: "c_dst_npi" },
  coding: { sql: "c_coding" },
  // Vendor side of the translatable fields (team trial round 2).
  vendorSrcTon: { sql: "v_src_ton" },
  vendorSrcNpi: { sql: "v_src_npi" },
  vendorDstTon: { sql: "v_dst_ton" },
  vendorDstNpi: { sql: "v_dst_npi" },
  vendorCoding: { sql: "v_coding" },
  senderId: { sql: "src_addr" },
  vendorSenderId: { sql: "v_src_addr" },
  dnid: { sql: "dst_addr" },
  routedDnid: { sql: "routed_dst_addr" },
  messageText: { sql: "message_text" },
  vendorMessageText: { sql: "v_message_text" },
  customerMccmnc: { sql: "c_mccmnc" },
  mcc: { sql: "c_mcc" },
  mnc: { sql: "c_mnc" },
  country: { sql: "c_country_iso" },
  customerDestination: named(DESTINATIONS, "toUInt64OrZero(c_mccmnc)"),
  vendorDestination: named(DESTINATIONS, "toUInt64OrZero(v_mccmnc)"),
  customerBillingType: { sql: "c_billing_type" },
  customerRateTableId: { sql: "c_rate_table_id" },
  customerRate: { sql: "toFloat64(c_rate)" },
  customerCurrency: { sql: "c_currency" },
  customerSysRate: { sql: "toFloat64(c_sys_rate)" },
  translationRuleIds: { sql: "c_translation_rule_ids", where: has("c_translation_rule_ids") },
  customerMsgStatus: { sql: "c_msg_status", outcome: { sql: "c_msg_status", merge: "status" } },
  vendorEnterpriseId: { sql: "v_enterprise_id" },
  vendorEnterprise: named(ENTERPRISES, "v_enterprise_id"),
  vendorTrunkId: { sql: "v_trunk_id" },
  vendorTrunk: named(VENDOR_TRUNKS, "v_trunk_id"),
  vendorIp: { sql: "if(v_trunk_id = 0, '', IPv4NumToString(v_ip))" },
  vendorPort: { sql: "v_port" },
  // One ID per part of a multipart message, comma separated: a filter matches any of them (team trial round 2).
  vendorMsgId: { sql: "v_message_id", where: msgIdWhere },
  numberOrMsgId: { sql: "dst_addr", where: numberOrMsgIdWhere },
  vendorMccmnc: { sql: "v_mccmnc" },
  vendorBillingType: { sql: "v_billing_type" },
  vendorRateTableId: { sql: "v_rate_table_id" },
  vendorRate: { sql: "toFloat64(v_rate)" },
  vendorCurrency: { sql: "v_currency" },
  vendorSysRate: { sql: "toFloat64(v_sys_rate)" },
  vendorExRate: { sql: "toFloat64(v_ex_rate)" },
  vendorTranslationRuleIds: { sql: "v_translation_rule_ids", where: has("v_translation_rule_ids") },
  routeRuleId: { sql: "route_rule_id" },
  routeDecidedBy: { sql: "route_decided_by" },
  dlrReroute: { sql: "dlr_reroute" },
  repushRequestId: { sql: "repush_request_id" },
  attemptNo: { sql: "attempt_no" },
  isFinalAttempt: { sql: "is_final_attempt" },
  isSubmitSuccess: { sql: "is_submit_success" },
  causeCode: { sql: "command_status", numeric: true },
  causeText: { sql: CAUSE_TEXT },
  msgStatus: { sql: "msg_status", outcome: { sql: "msg_status", merge: "status" } },
  deliveryError: { sql: "delivery_error", outcome: { sql: "delivery_error", merge: "status", when: VENDOR_FINAL } },
  customerDeliveryError: {
    sql: "c_delivery_error",
    outcome: { sql: "c_delivery_error", merge: "status", when: "c_msg_status != ''" },
  },
  networkError: { sql: "network_error" },
  registeredDelivery: { sql: "registered_delivery" },
  vendorRegisteredDelivery: { sql: "v_registered_delivery" },
  msgCount: { sql: "msg_count" },
  udh: { sql: "udh" },
  deliveryDelaySeconds: {
    sql: "delivery_delay_ms / 1000",
    outcome: { sql: "delivery_delay_ms / 1000", merge: "status", when: VENDOR_FINAL },
  },
  isBuffered: { sql: "is_buffered" },
  isCustomerBillable: { sql: "is_customer_billable", outcome: { sql: "is_customer_billable", merge: "or" } },
  isVendorBillable: { sql: "is_vendor_billable", outcome: { sql: "is_vendor_billable", merge: "or" } },
  revenue: { sql: "toFloat64(revenue)", outcome: { sql: "revenue", merge: "add" } },
  cost: { sql: "toFloat64(cost)", outcome: { sql: "cost", merge: "add" } },
  revenueSys: { sql: "toFloat64(revenue_sys)", outcome: { sql: "revenue_sys", merge: "add" } },
  costSys: { sql: "toFloat64(cost_sys)", outcome: { sql: "cost_sys", merge: "add" } },
  hlrProviderId: { sql: "hlr_provider_id" },
  hlrProvider: named(HLR_PROVIDERS, "hlr_provider_id"),
  hlrFetchType: { sql: "hlr_fetch_type" },
  hlrIsPorted: { sql: "hlr_is_ported" },
  hlrIsAccomplished: { sql: "hlr_is_accomplished" },
  hlrErrorCode: { sql: "hlr_error_code" },
  hlrErrorText: { sql: HLR_ERROR_TEXT },
  hlrCostSys: { sql: "toFloat64(hlr_cost_sys)" },
};

/** Turns a ClickHouse row into field values by the catalogue's types; names come from PostgreSQL. */
export function edrValues(
  fields: FieldDescriptor[],
  cols: Record<string, ChColumn>,
  r: Record<string, unknown>,
  names: NameMaps,
) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const col = cols[f.field]!;
    if (col.names) {
      const id = Number(r[`_${f.field}`] ?? 0);
      // A destination code missing from the master shows empty, like an unknown MCCMNC elsewhere.
      if (f.field.endsWith("Destination")) out[f.field] = (id && names.get(f.field)?.get(id)) || "";
      else out[f.field] = id ? (names.get(f.field)?.get(id) ?? `#${id}`) : null;
      continue;
    }
    const v = r[f.field];
    if (f.field === "causeText") out[f.field] = causeName(Number(r.causeCode ?? 0));
    else if (Array.isArray(v)) out[f.field] = v.map(Number);
    else if (f.type === "datetime") out[f.field] = chIso(v);
    else if (f.type === "boolean") out[f.field] = Number(v) === 1;
    else if (["integer", "decimal", "money", "percent"].includes(f.type) || col.numeric) out[f.field] = Number(v ?? 0);
    else out[f.field] = v == null ? "" : String(v);
  }
  return out;
}

const edrFields = listFields.edrs;
export const edrList: ChListDef<EdrRow> = {
  fields: edrFields,
  table: "edr",
  columns: EDR_COLUMNS,
  search: ["senderId", "vendorSenderId", "dnid", "customerMsgId", "vendorMsgId"],
  searchNumbers: ["senderId", "dnid"],
  searchNames: ["customerEnterprise", "customerTrunk", "vendorEnterprise", "vendorTrunk"],
  idSql: "edr_id",
  mapRow: (r, names) => edrValues(edrFields.fields, EDR_COLUMNS, r, names) as unknown as EdrRow,
};

const failedFields = listFields.failed_edrs;
// Customer-side failures never reached a vendor: no outcome rows to merge.
export const FAILED_COLUMNS: Record<string, ChColumn> = Object.fromEntries(
  failedFields.fields.map((f) => [f.field, { ...EDR_COLUMNS[f.field]!, outcome: undefined }]),
);
export const failedEdrList: ChListDef<FailedEdrRow> = {
  fields: failedFields,
  table: "edr",
  baseWhere: "v_trunk_id = 0 AND is_submit_success = 0",
  columns: FAILED_COLUMNS,
  search: ["senderId", "dnid", "customerMsgId", "customerIp"],
  searchNumbers: ["senderId", "dnid"],
  searchNames: ["customerEnterprise", "customerTrunk"],
  idSql: "edr_id",
  mapRow: (r, names) => edrValues(failedFields.fields, FAILED_COLUMNS, r, names) as unknown as FailedEdrRow,
};
