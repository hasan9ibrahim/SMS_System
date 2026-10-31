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
        } else if (
          isNumber &&
          f.type === "integer" &&
          (typeof v === "string" ? !/^\s*-?\d+\s*$/.test(v) : !Number.isInteger(v)) // "1.0" is no bigint
        ) {
          errors.push({ path: `${at}/value`, message: `"${String(v)}" is not a whole number` });
        } else if (isNumber && f.type === "integer" && !Number.isSafeInteger(Number(v))) {
          errors.push({ path: `${at}/value`, message: `"${String(v)}" is too large` });
        } else if (isTime && !isIsoTime(v)) {
          errors.push({ path: `${at}/value`, message: `"${String(v)}" is not a date (ISO 8601)` });
        } else if (f.type === "boolean" && typeof v !== "boolean") {
          errors.push({ path: `${at}/value`, message: "expected true or false" });
        }
      }
      // PostgreSQL and ClickHouse refuse a LIKE pattern that ends in its escape character (QA 2026-10-31).
      if ((c.op === "like" || c.op === "not_like") && typeof c.value === "string" && endsInEscape(c.value))
        errors.push({
          path: `${at}/value`,
          message: "a pattern cannot end with a single \\; write \\\\ for a backslash",
        });
      if (c.op === "regex" && typeof c.value === "string") {
        const problem = regexProblem(c.value);
        if (problem) errors.push({ path: `${at}/value`, message: problem });
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

/** Ends in an odd number of backslashes: the last one escapes nothing. */
export const endsInEscape = (s: string) => /(^|[^\\])(\\\\)*\\$/.test(s);

/**
 * A date or date-time in ISO 8601 that exists (QA 2026-10-31): JavaScript's Date.parse takes "1" and rolls
 * "2026-02-30" over to March, PostgreSQL refuses both. Date, optional time (seconds and fraction optional), optional
 * Z or offset.
 */
export function isIsoTime(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(
    v,
  );
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1).map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return (
    day.getUTCFullYear() === y &&
    day.getUTCMonth() === mo - 1 &&
    day.getUTCDate() === d &&
    h < 24 &&
    mi < 60 &&
    sec < 60
  );
}

/**
 * Why a regex filter is refused, or null. PostgreSQL's engine backtracks on back references and on a repeated group
 * that repeats inside, like (a+)+, so one such filter could hold a database connection for the whole statement
 * timeout (round 13 security review); a long pattern is refused too.
 */
export function regexProblem(value: string): string | null {
  if (value.length > 200) return "a regular expression may have at most 200 characters";
  if (/\\[1-9]/.test(value)) return "back references (\\1 to \\9) are not allowed";
  if (/\((?:[^()\\]|\\.)*[+*}]\)[+*{]/.test(value))
    return "a repeated group inside a repetition, like (a+)+, is not allowed";
  try {
    new RegExp(value, "i");
  } catch {
    return "invalid regular expression";
  }
  return null;
}
