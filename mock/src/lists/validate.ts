// Semantic checks on a ListQuery that JSON Schema cannot express: the fields and
// operators must exist in the list's field catalogue (§13.25).
import type { FilterCondition, FilterGroup, ListFields, ListQuery, Problem } from "@sms/contract";

const NO_VALUE = new Set(["empty", "not_empty"]);
const MULTI_VALUE = new Set(["in", "not_in", "between"]);
const NUMERIC = new Set(["integer", "decimal", "money", "percent"]);

export function checkListQuery(query: ListQuery, fields: ListFields): NonNullable<Problem["errors"]> {
  const byName = new Map(fields.fields.map((f) => [f.field, f]));
  const errors: NonNullable<Problem["errors"]> = [];

  const walk = (group: FilterGroup, path: string) => {
    group.conditions.forEach((node, i) => {
      const at = `${path}/conditions/${i}`;
      if ("logic" in node) return walk(node, at);
      const c = node as FilterCondition;
      const f = byName.get(c.field);
      if (!f) return errors.push({ path: `${at}/field`, message: `unknown field "${c.field}"` });
      if (!f.operators.includes(c.op))
        errors.push({ path: `${at}/op`, message: `operator "${c.op}" is not allowed on "${c.field}"` });
      if (MULTI_VALUE.has(c.op)) {
        if (!c.values?.length) errors.push({ path: `${at}/values`, message: `"${c.op}" needs values` });
        else if (c.op === "between" && c.values.length !== 2)
          errors.push({ path: `${at}/values`, message: `"between" needs exactly 2 values` });
      } else if (!NO_VALUE.has(c.op) && c.value === undefined) {
        errors.push({ path: `${at}/value`, message: `"${c.op}" needs a value` });
      }
      // Operands must suit the field type, so the database never sees a bad cast.
      const operands = c.values ?? (c.value === undefined ? [] : [c.value]);
      const isNumber = NUMERIC.has(f.type);
      const isTime = f.type === "date" || f.type === "datetime";
      for (const v of operands) {
        if (
          isNumber &&
          !(typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))))
        ) {
          errors.push({ path: `${at}/value`, message: `"${String(v)}" is not a number` });
        } else if (isTime && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) {
          errors.push({ path: `${at}/value`, message: `"${String(v)}" is not a date (ISO 8601)` });
        } else if (f.type === "boolean" && typeof v !== "boolean") {
          errors.push({ path: `${at}/value`, message: "expected true or false" });
        }
      }
      if (c.op === "regex" && typeof c.value === "string") {
        try {
          new RegExp(c.value, "i");
        } catch {
          errors.push({ path: `${at}/value`, message: "invalid regular expression" });
        }
      }
    });
  };
  if (query.filter) walk(query.filter, "/filter");

  (query.sort ?? []).forEach((s, i) => {
    const f = byName.get(s.field);
    if (!f) errors.push({ path: `/sort/${i}/field`, message: `unknown field "${s.field}"` });
    else if (!f.sortable) errors.push({ path: `/sort/${i}/field`, message: `"${s.field}" is not sortable` });
  });
  return errors;
}
