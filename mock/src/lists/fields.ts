// Field catalogues served by GET /meta/lists/{list}/fields (§13.25).
// Operators per field type follow §13.25 and the column filter widgets in §15.1.
import type { FieldDescriptor, FilterOperator, ListFields, ListId } from "@sms/contract";

const TEXT: FilterOperator[] = ["like", "not_like", "eq", "neq", "in", "not_in", "empty", "not_empty", "regex"];
const NUMBER: FilterOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "empty", "not_empty"];
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
      field({ field: "businessCompanyId", label: "Business Company", type: "integer", defaultOperator: "eq", hidden: true }),
      field({ field: "accountManagerId", label: "Account Manager", type: "integer", defaultOperator: "eq" }),
      field({ field: "country", label: "Country", type: "text", defaultOperator: "eq", hidden: true }),
      field({ field: "updatedBy", label: "Updated By", type: "text", defaultOperator: "like", hidden: true }),
      field({ field: "updatedAt", label: "Updated Time", type: "datetime", defaultOperator: "between", hidden: true }),
    ],
  },
};
