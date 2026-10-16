// Field catalogues served by GET /meta/lists/{list}/fields (§13.25).
// Operators per field type follow §13.25 and the column filter widgets in §15.1.
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

  // Rate tables (§6.2, §13.12): customer (sell) tables and each vendor trunk's buy table
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
      field({ field: "category", label: "Product Category", type: "text", defaultOperator: "like" }),
      field({ field: "categoryId", label: "Category ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "currency", label: "Currency", type: "text", defaultOperator: "eq" }),
      field({ field: "vendorTrunkName", label: "Vendor Trunk", type: "text", defaultOperator: "like" }),
      field({ field: "vendorTrunkId", label: "Vendor Trunk ID", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "trunkCount", label: "Customer Trunks", type: "integer", defaultOperator: "gte" }),
      field({ field: "activeLines", label: "Active Lines", type: "integer", defaultOperator: "gte" }),
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
