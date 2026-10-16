// Field catalogues served by GET /meta/lists/{list}/fields (§13.25).
// Operators per field type follow §13.25 and the column filter widgets in §15.1.
import { PLATFORM_CURRENCY } from "../currency.js";
import type { FieldDescriptor, FilterOperator, ListFields, ListId } from "@sms/contract";

const TEXT: FilterOperator[] = ["like", "not_like", "eq", "neq", "in", "not_in", "empty", "not_empty", "regex"];
const NUMBER: FilterOperator[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "empty",
  "not_empty",
];
const ENUM: FilterOperator[] = ["in", "not_in", "eq", "neq"];
const DATETIME: FilterOperator[] = ["between", "gt", "gte", "lt", "lte", "empty", "not_empty"];

type Def = Omit<FieldDescriptor, "operators" | "sortable" | "hidden"> &
  Partial<Pick<FieldDescriptor, "operators" | "sortable" | "hidden">>;

function field(def: Def): FieldDescriptor {
  const operators =
    def.operators ??
    (def.type === "enum" || def.type === "boolean"
      ? ENUM
      : def.type === "date" || def.type === "datetime"
        ? DATETIME
        : ["integer", "decimal", "money", "percent"].includes(def.type)
          ? NUMBER
          : TEXT);
  return { sortable: true, hidden: false, ...def, operators };
}

/** "Show deleted" (§13.29): archived records are hidden unless this filter is set. */
const ARCHIVED = field({
  field: "archived",
  label: "Deleted",
  type: "boolean",
  defaultOperator: "eq",
  hidden: true,
});

const STATUS_VALUES = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

// Customer and vendor trunk lists (§5.4, §5.5): the Enterprise screen's trunk tabs.
function trunkFields(list: "customer_trunks" | "vendor_trunks"): ListFields {
  const customer = list === "customer_trunks";
  return {
    list,
    defaultSort: [{ field: "name", dir: "asc" }],
    fields: [
      field({ field: "id", label: "ID", type: "integer", defaultOperator: "eq" }),
      field({ field: "name", label: "Trunk Name", type: "text", defaultOperator: "like" }),
      field({ field: "enterpriseName", label: "Enterprise", type: "text", defaultOperator: "like" }),
      field({ field: "enterpriseId", label: "Enterprise ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "username", label: "UserName", type: "text", defaultOperator: "like" }),
      field({ field: "category", label: "Product Category", type: "text", defaultOperator: "like" }),
      field({ field: "categoryId", label: "Category ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({
        field: "protocol",
        label: "Protocol",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "smpp", label: "SMPP" },
          { value: "http", label: "HTTP" },
        ],
      }),
      field({ field: "tps", label: "TPS", type: "integer", defaultOperator: "gte" }),
      field({ field: "status", label: "Status", type: "enum", defaultOperator: "in", enumValues: STATUS_VALUES }),
      field({
        field: "bindType",
        label: "Bind Type",
        type: "enum",
        defaultOperator: "in",
        enumValues: ["TX", "RX", "TR", ...(customer ? ["AUTO"] : [])].map((v) => ({ value: v, label: v })),
      }),
      field({ field: "rulesCount", label: "Rules", type: "integer", defaultOperator: "gte" }),
      ...(customer
        ? []
        : [field({ field: "host", label: "Host", type: "text", defaultOperator: "like", hidden: true })]),
      field({ field: "updatedBy", label: "Updated By", type: "text", defaultOperator: "like", hidden: true }),
      field({ field: "updatedAt", label: "Updated Time", type: "datetime", defaultOperator: "between", hidden: true }),
      ARCHIVED,
    ],
  };
}

export const listFields: Record<ListId, ListFields> = {
  // Enterprise list and selector (§5, §5.1)
  enterprises: {
    list: "enterprises",
    defaultSort: [{ field: "name", dir: "asc" }],
    fields: [
      field({ field: "id", label: "ID", type: "integer", defaultOperator: "eq" }),
      field({ field: "name", label: "Name", type: "text", defaultOperator: "like" }),
      field({ field: "alias", label: "Alias", type: "text", defaultOperator: "like" }),
      field({
        field: "type",
        label: "Type",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "customer", label: "Customer" },
          { value: "vendor", label: "Vendor" },
          { value: "reciprocal", label: "Reciprocal" },
        ],
      }),
      field({
        field: "tier",
        label: "Category",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "tier1", label: "Tier 1" },
          { value: "tier2", label: "Tier 2" },
          { value: "tier3", label: "Tier 3" },
        ],
      }),
      field({
        field: "status",
        label: "Status",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "active", label: "Active" },
          { value: "inactive", label: "Inactive" },
        ],
      }),
      field({ field: "businessCompany", label: "Business Company", type: "text", defaultOperator: "like" }),
      field({
        field: "businessCompanyId",
        label: "Business Company ID",
        type: "integer",
        defaultOperator: "eq",
        hidden: true,
      }),
      field({ field: "accountManager", label: "Account Manager", type: "text", defaultOperator: "like" }),
      field({
        field: "accountManagerId",
        label: "Account Manager ID",
        type: "integer",
        defaultOperator: "eq",
        hidden: true,
      }),
      field({ field: "country", label: "Country", type: "text", defaultOperator: "eq", hidden: true }),
      field({ field: "updatedBy", label: "Updated By", type: "text", defaultOperator: "like", hidden: true }),
      field({ field: "updatedAt", label: "Updated Time", type: "datetime", defaultOperator: "between", hidden: true }),
      ARCHIVED,
    ],
  },

  customer_trunks: trunkFields("customer_trunks"),
  vendor_trunks: trunkFields("vendor_trunks"),

  // Rate Manager list (§13.12): customer (sell) tables and each vendor trunk's buy table.
  // Traffic figures (margin, money today) come from the EDR store, so they can't be
  // filtered or sorted in the database.
  rate_tables: {
    list: "rate_tables",
    defaultSort: [{ field: "name", dir: "asc" }],
    fields: [
      field({ field: "id", label: "ID", type: "integer", defaultOperator: "eq" }),
      field({ field: "name", label: "Name", type: "text", defaultOperator: "like" }),
      field({
        field: "kind",
        label: "Type",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "customer", label: "Customer (sell)" },
          { value: "vendor", label: "Vendor (buy)" },
        ],
      }),
      field({ field: "enterpriseNames", label: "Clients", type: "text", defaultOperator: "like", sortable: false }),
      field({ field: "trunkNames", label: "Trunks", type: "text", defaultOperator: "like", sortable: false }),
      field({ field: "category", label: "Product Category", type: "text", defaultOperator: "like" }),
      field({ field: "categoryId", label: "Category ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "currency", label: "Currency", type: "text", defaultOperator: "eq" }),
      field({ field: "activeLines", label: "Active Rates", type: "integer", defaultOperator: "gte" }),
      field({ field: "scheduledChanges", label: "Scheduled", type: "integer", defaultOperator: "gte" }),
      field({ field: "negativeMarginLines", label: "Neg. Margin", type: "integer", defaultOperator: "gte" }),
      field({
        field: "avgMarginPct",
        label: "Avg Margin",
        type: "percent",
        defaultOperator: "gte",
        operators: [],
        sortable: false,
      }),
      field({
        field: "moneyToday",
        label: "Today",
        type: "money",
        defaultOperator: "gte",
        operators: [],
        sortable: false,
      }),
      field({ field: "updatedAt", label: "Last Change", type: "datetime", defaultOperator: "between" }),
      field({ field: "updatedBy", label: "By", type: "text", defaultOperator: "like" }),
      field({ field: "accountManager", label: "Account Manager", type: "text", defaultOperator: "like", hidden: true }),
      field({
        field: "accountManagerId",
        label: "Account Manager ID",
        type: "integer",
        defaultOperator: "eq",
        operators: ["eq", "in"],
        hidden: true,
        sortable: false,
      }),
      field({ field: "vendorTrunkName", label: "Vendor Trunk", type: "text", defaultOperator: "like", hidden: true }),
      field({ field: "vendorTrunkId", label: "Vendor Trunk ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "trunkCount", label: "Customer Trunks", type: "integer", defaultOperator: "gte", hidden: true }),
      field({
        field: "nextChangeAt",
        label: "Next Change",
        type: "datetime",
        defaultOperator: "between",
        hidden: true,
      }),
      field({ field: "description", label: "Description", type: "text", defaultOperator: "like", hidden: true }),
      ARCHIVED,
    ],
  },

  // Rate lines of one table (§13.12 rate grid). `view` picks current / scheduled / closed.
  rate_lines: {
    list: "rate_lines",
    defaultSort: [
      { field: "country", dir: "asc" },
      { field: "mccmnc", dir: "asc" },
    ],
    fields: [
      field({ field: "id", label: "Rate ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({
        field: "rateTableId",
        label: "Rate Table",
        type: "integer",
        defaultOperator: "eq",
        operators: ["eq"],
        hidden: true,
        sortable: false,
      }),
      field({
        field: "view",
        label: "View",
        type: "enum",
        defaultOperator: "eq",
        operators: ["eq"],
        hidden: true,
        sortable: false,
        enumValues: [
          { value: "current", label: "Current" },
          { value: "scheduled", label: "Scheduled" },
          { value: "closed", label: "Closed" },
        ],
      }),
      field({ field: "country", label: "Country", type: "text", defaultOperator: "like" }),
      field({ field: "network", label: "Network", type: "text", defaultOperator: "like" }),
      field({ field: "mccmnc", label: "MCCMNC", type: "mccmnc", defaultOperator: "like" }),
      field({ field: "senderId", label: "Sender ID", type: "text", defaultOperator: "like" }),
      field({ field: "rate", label: "Sell Rate", type: "decimal", defaultOperator: "gte" }),
      field({ field: "bestBuy", label: "Best Buy", type: "decimal", defaultOperator: "gte" }),
      field({ field: "bestVendor", label: "Best Vendor", type: "text", defaultOperator: "like" }),
      field({ field: "margin", label: "Margin", type: "decimal", defaultOperator: "lt" }),
      field({ field: "marginPct", label: "Margin %", type: "percent", defaultOperator: "lt" }),
      field({
        field: "changeType",
        label: "Change",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "new", label: "New" },
          { value: "same", label: "Same" },
          { value: "increase", label: "Increase" },
          { value: "decrease", label: "Decrease" },
        ],
      }),
      field({ field: "changePct", label: "Change %", type: "percent", defaultOperator: "gte", hidden: true }),
      field({ field: "validFrom", label: "Effective", type: "datetime", defaultOperator: "between" }),
      field({ field: "validTo", label: "Until", type: "datetime", defaultOperator: "between", hidden: true }),
      field({ field: "nextRate", label: "Next Rate", type: "decimal", defaultOperator: "gte", hidden: true }),
      field({ field: "nextFrom", label: "Next From", type: "datetime", defaultOperator: "between", hidden: true }),
      field({ field: "isBlocked", label: "Blocked", type: "boolean", defaultOperator: "eq", hidden: true }),
      field({
        field: "negativeMargin",
        label: "Negative margin",
        type: "boolean",
        defaultOperator: "eq",
        hidden: true,
      }),
      field({ field: "dialCode", label: "Dial Code", type: "prefix", defaultOperator: "like", hidden: true }),
      field({
        field: "sysRate",
        label: `Sys Rate (${PLATFORM_CURRENCY})`,
        type: "decimal",
        defaultOperator: "gte",
        hidden: true,
      }),
      field({ field: "rateNote", label: "Rate Note", type: "text", defaultOperator: "like", hidden: true }),
      field({ field: "updatedBy", label: "Updated By", type: "text", defaultOperator: "like", hidden: true }),
      field({ field: "updatedAt", label: "Updated Time", type: "datetime", defaultOperator: "between", hidden: true }),
    ],
  },

  // MCCMNC master for the destination picker (§6.1, §13.21)
  destinations: {
    list: "destinations",
    defaultSort: [
      { field: "country", dir: "asc" },
      { field: "mccmnc", dir: "asc" },
    ],
    fields: [
      field({ field: "id", label: "ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "country", label: "Country", type: "text", defaultOperator: "like" }),
      field({ field: "countryIso", label: "ISO", type: "text", defaultOperator: "eq" }),
      field({ field: "network", label: "Network", type: "text", defaultOperator: "like" }),
      field({ field: "mccmnc", label: "MCCMNC", type: "mccmnc", defaultOperator: "like" }),
      field({ field: "mcc", label: "MCC", type: "text", defaultOperator: "eq", hidden: true }),
      field({ field: "mnc", label: "MNC", type: "text", defaultOperator: "eq", hidden: true }),
      field({ field: "allNetworks", label: "All networks", type: "boolean", defaultOperator: "eq" }),
    ],
  },

  // Route rules grid (§15.4): the columns of the screenshot, a filter under each header.
  // Traffic columns follow the `window` field (§13.27); the category list comes from the
  // database when the catalogue is served.
  route_rules: {
    list: "route_rules",
    defaultSort: [
      { field: "priority", dir: "asc" },
      { field: "id", dir: "asc" },
    ],
    fields: [
      field({ field: "id", label: "ID", type: "integer", defaultOperator: "eq" }),
      field({ field: "name", label: "Rule", type: "text", defaultOperator: "like" }),
      field({ field: "priority", label: "Pri", type: "integer", defaultOperator: "between" }),
      field({
        field: "routeType",
        label: "Type",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "static", label: "Static" },
          { value: "dynamic", label: "Least cost" },
          { value: "qbr", label: "Quality" },
          { value: "block", label: "Block" },
        ],
      }),
      field({
        field: "category",
        label: "Category",
        type: "enum",
        defaultOperator: "in",
        operators: ["in"],
        sortable: false,
        enumValues: [{ value: "all", label: "All categories" }],
      }),
      field({
        field: "customerTrunks",
        label: "Customer trunks",
        type: "text",
        defaultOperator: "like",
        sortable: false,
      }),
      field({
        field: "destination",
        label: "Destination",
        type: "mccmnc",
        defaultOperator: "like",
        operators: ["like", "eq", "empty", "not_empty"],
        sortable: false,
      }),
      field({ field: "vendors", label: "Vendors", type: "text", defaultOperator: "like", sortable: false }),
      field({ field: "messages", label: "24h", type: "integer", defaultOperator: "gte" }),
      field({ field: "asr", label: "ASR", type: "percent", defaultOperator: "gte" }),
      field({ field: "dlr", label: "DLR", type: "percent", defaultOperator: "lte" }),
      field({ field: "margin", label: "Margin", type: "money", defaultOperator: "lt" }),
      field({
        field: "status",
        label: "On",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "active", label: "On" },
          { value: "inactive", label: "Off" },
        ],
      }),
      field({
        field: "window",
        label: "Traffic window",
        type: "enum",
        defaultOperator: "eq",
        operators: ["eq"],
        hidden: true,
        sortable: false,
        enumValues: ["15m", "1h", "24h", "7d", "30d"].map((v) => ({ value: v, label: v })),
      }),
      field({
        field: "customerTrunkId",
        label: "Customer trunk ID",
        type: "integer",
        defaultOperator: "eq",
        operators: ["eq"],
        hidden: true,
        sortable: false,
      }),
      field({
        field: "vendorTrunkId",
        label: "Vendor trunk ID",
        type: "integer",
        defaultOperator: "eq",
        operators: ["eq"],
        hidden: true,
        sortable: false,
      }),
      field({ field: "groupName", label: "Group", type: "text", defaultOperator: "like", hidden: true }),
      field({ field: "startsAt", label: "Start Time", type: "datetime", defaultOperator: "between", hidden: true }),
      field({ field: "stopsAt", label: "Stop Time", type: "datetime", defaultOperator: "between", hidden: true }),
      field({ field: "updatedBy", label: "Updated By", type: "text", defaultOperator: "like", hidden: true }),
      field({ field: "updatedAt", label: "Updated Time", type: "datetime", defaultOperator: "between", hidden: true }),
      ARCHIVED,
    ],
  },

  // Users (§11), e.g. the "share with" picker of saved views
  users: {
    list: "users",
    defaultSort: [{ field: "displayName", dir: "asc" }],
    fields: [
      field({ field: "id", label: "ID", type: "integer", defaultOperator: "eq" }),
      field({ field: "username", label: "UserName", type: "text", defaultOperator: "like" }),
      field({ field: "displayName", label: "Name", type: "text", defaultOperator: "like" }),
      field({ field: "email", label: "Email", type: "text", defaultOperator: "like" }),
      field({ field: "department", label: "Department", type: "text", defaultOperator: "like" }),
      field({ field: "accessGroup", label: "GUI Access Group", type: "text", defaultOperator: "like" }),
      field({
        field: "status",
        label: "Status",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "active", label: "Active" },
          { value: "inactive", label: "Inactive" },
        ],
      }),
      field({ field: "isAccountManager", label: "Account Manager", type: "boolean", defaultOperator: "eq" }),
    ],
  },

  // Change history and undo (§13.10)
  changes: {
    list: "changes",
    defaultSort: [{ field: "at", dir: "desc" }],
    fields: [
      field({ field: "id", label: "Change", type: "integer", defaultOperator: "eq" }),
      field({ field: "at", label: "Time (UTC)", type: "datetime", defaultOperator: "between" }),
      field({ field: "userName", label: "User", type: "text", defaultOperator: "like" }),
      field({
        field: "entityType",
        label: "Record type",
        type: "enum",
        defaultOperator: "in",
        enumValues: [
          { value: "route_rule", label: "Route rule" },
          { value: "rate_line", label: "Rate line" },
          { value: "translation_rule", label: "Translation rule" },
          { value: "hlr_rule", label: "HLR rule" },
          { value: "customer_trunk", label: "Customer trunk" },
          { value: "vendor_trunk", label: "Vendor trunk" },
          { value: "enterprise", label: "Enterprise" },
          { value: "enterprise_doc", label: "Enterprise document" },
          { value: "rate_table", label: "Rate table" },
        ],
      }),
      field({
        field: "entityId",
        label: "Record ID",
        type: "integer",
        defaultOperator: "eq",
        operators: ["eq", "in"],
        sortable: false,
      }),
      field({
        field: "changeType",
        label: "Type",
        type: "enum",
        defaultOperator: "in",
        enumValues: ["create", "edit", "clone", "delete", "reorder", "enable", "disable", "bulk", "undo"].map((v) => ({
          value: v,
          label: v[0]!.toUpperCase() + v.slice(1),
        })),
      }),
      field({ field: "note", label: "Note", type: "text", defaultOperator: "like" }),
      field({ field: "userId", label: "User ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "undoOfId", label: "Undo of", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "ip", label: "IP", type: "text", defaultOperator: "like", hidden: true }),
    ],
  },
};
