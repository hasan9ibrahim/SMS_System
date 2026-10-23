// Grid filter model (§13.25, §15.1). Column filter boxes accept short text that becomes one
// contract FilterCondition; the filter builder holds a FilterGroup tree; both are sent as one
// tree. Grid state round-trips through the tab's URL so it survives restore and pop-out.
import type { FieldDescriptor, FilterCondition, FilterGroup, FilterOperator, ListQuery, SortKey } from "@sms/contract";

export interface GridState {
  /** One condition per column, from the box under the header. */
  columns: Record<string, FilterCondition>;
  /** Multi-field builder (AND/OR groups); null when unused. */
  builder: FilterGroup | null;
  search: string;
  sort: SortKey[];
  /** Visible columns in order; null = the list's default (non-hidden fields). */
  visible: string[] | null;
  /** Saved view the state came from, to offer "save changes". */
  viewId: number | null;
}

export const emptyState = (): GridState => ({
  columns: {},
  builder: null,
  search: "",
  sort: [],
  visible: null,
  viewId: null,
});

const NUMERIC = new Set(["integer", "decimal", "money", "percent"]);
const TIME = new Set(["date", "datetime"]);

export const isNumeric = (f: FieldDescriptor) => NUMERIC.has(f.type);
export const isTime = (f: FieldDescriptor) => TIME.has(f.type);
export const isChoice = (f: FieldDescriptor) => f.type === "enum" || f.type === "boolean";

/** Placeholder shown in the empty filter box (§15.1 screenshots). */
export function filterPlaceholder(f: FieldDescriptor): string {
  if (isNumeric(f)) return f.defaultOperator === "eq" ? "=" : "≥ ≤";
  if (isTime(f)) return "from..to";
  // Text matches from the start unless % is typed (team trial round 4).
  return "starts with…";
}

const allowed = (f: FieldDescriptor, op: FilterOperator) => f.operators.includes(op);

function operand(f: FieldDescriptor, raw: string): string | number | null {
  const v = raw.trim();
  if (!v) return null;
  if (isNumeric(f)) {
    const n = Number(v.replace(/[\s,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (isTime(f)) {
    const t = Date.parse(v.length <= 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return v;
}

/**
 * Parses a column filter box. Returns null for an empty box and an Error for text that
 * cannot be a condition on this field.
 *
 * Text:     au → starts with (team trial round 4) · %au → contains · acme% / a_c / %re% → wildcards as
 *           typed · =ACME → equals · !test → does not start with · /^ab/ → regex · empty / !empty
 * Prefix:   505 → starts with
 * Numbers:  5 or =5 · >5 >=5 ≥5 <5 <=5 ≤5 · !=5 · 5..10 (inclusive) · 1,2,3 (in list)
 * Dates:    2026-10-01..2026-10-16 · >=2026-10-01 · <2026-10-01
 */
export function parseColumnFilter(f: FieldDescriptor, input: string): FilterCondition | null | Error {
  const text = input.trim();
  if (!text) return null;
  const field = f.field;
  const lower = text.toLowerCase();
  if ((lower === "empty" || lower === "=empty") && allowed(f, "empty")) return { field, op: "empty" };
  if ((lower === "!empty" || lower === "not empty") && allowed(f, "not_empty")) return { field, op: "not_empty" };

  if (isNumeric(f) || isTime(f)) {
    const range = text.split("..");
    if (range.length === 2) {
      const a = operand(f, range[0]!);
      const b = operand(f, range[1]!);
      if (a === null || b === null) return new Error("Use from..to, e.g. 5..10");
      return { field, op: "between", values: [a, b] };
    }
    if (isNumeric(f) && text.includes(",") && allowed(f, "in")) {
      const values = text.split(",").map((x) => operand(f, x));
      if (values.some((v) => v === null)) return new Error("Use numbers separated by commas");
      return { field, op: "in", values: values as number[] };
    }
    const m = /^(>=|<=|!=|≥|≤|>|<|=)?\s*(.+)$/.exec(text)!;
    const sym = m[1] ?? "";
    const value = operand(f, m[2]!);
    if (value === null)
      return new Error(isTime(f) ? "Use a date, e.g. >=2026-10-01" : "Use a number, e.g. >=5 or 5..10");
    const op: FilterOperator =
      sym === ">"
        ? "gt"
        : sym === ">=" || sym === "≥"
          ? "gte"
          : sym === "<"
            ? "lt"
            : sym === "<=" || sym === "≤"
              ? "lte"
              : sym === "!="
                ? "neq"
                : "eq";
    if (!allowed(f, op)) {
      // Dates have no equals: a bare date means that whole day.
      if (isTime(f) && op === "eq") {
        const start = Date.parse(String(value));
        return { field, op: "between", values: [String(value), new Date(start + 86_399_999).toISOString()] };
      }
      return new Error(`"${sym || "="}" is not available on ${f.label}`);
    }
    return { field, op, value };
  }

  if (f.type === "prefix" || f.type === "mccmnc") {
    return { field, op: "like", value: /[%_]/.test(text) ? text : `${text}%` };
  }
  if (text.startsWith("/") && text.endsWith("/") && text.length > 2 && allowed(f, "regex")) {
    const source = text.slice(1, -1);
    try {
      new RegExp(source, "i");
    } catch {
      return new Error("Invalid regular expression");
    }
    return { field, op: "regex", value: source };
  }
  if (text.startsWith("=") && allowed(f, "eq")) return { field, op: "eq", value: text.slice(1) };
  if (text.startsWith("!") && allowed(f, "not_like")) {
    const v = text.slice(1);
    return { field, op: "not_like", value: textPattern(v) };
  }
  return { field, op: "like", value: textPattern(text) };
}

/** Plain text starts with; a leading % alone (`%au`) searches anywhere (team trial round 4); other wildcards as typed. */
const textPattern = (v: string) =>
  !/[%_]/.test(v) ? `${v}%` : v.length > 1 && v.startsWith("%") && !/[%_]/.test(v.slice(1)) ? `${v}%` : v;

/** "abc%" (starts with, the plain-text default) → "abc"; anything else null. */
const startsWithText = (s: string) =>
  s.length > 1 && s.endsWith("%") && !/[%_]/.test(s.slice(0, -1)) ? s.slice(0, -1) : null;

/** Text to show in the column filter box for a condition (inverse of parseColumnFilter). */
export function formatColumnFilter(f: FieldDescriptor, c: FilterCondition | undefined): string {
  if (!c) return "";
  const v = (x: unknown) => (isTime(f) && typeof x === "string" ? x.slice(0, 10) : String(x));
  switch (c.op) {
    case "empty":
      return "empty";
    case "not_empty":
      return "!empty";
    case "between":
      return `${v(c.values?.[0])}..${v(c.values?.[1])}`;
    case "in":
      return (c.values ?? []).map(v).join(",");
    case "gt":
      return `>${v(c.value)}`;
    case "gte":
      return `>=${v(c.value)}`;
    case "lt":
      return `<${v(c.value)}`;
    case "lte":
      return `<=${v(c.value)}`;
    case "neq":
      return `!=${v(c.value)}`;
    case "regex":
      return `/${String(c.value)}/`;
    case "eq":
      return isNumeric(f) ? v(c.value) : `=${v(c.value)}`;
    case "not_like": {
      const s = String(c.value);
      return `!${startsWithText(s) ?? s}`;
    }
    case "like": {
      const s = String(c.value);
      return startsWithText(s) ?? s;
    }
    default:
      return String(c.value ?? "");
  }
}

export const OP_LABEL: Record<FilterOperator, string> = {
  eq: "equals",
  neq: "not equal",
  like: "matches",
  not_like: "does not match",
  in: "is one of",
  not_in: "is not one of",
  between: "between",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  empty: "is empty",
  not_empty: "is not empty",
  regex: "regex",
};

function valueLabel(f: FieldDescriptor | undefined, v: unknown): string {
  const choice = f?.enumValues?.find((e) => e.value === v);
  if (choice) return choice.label;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (f && isTime(f) && typeof v === "string") return v.slice(0, 16).replace("T", " ");
  return String(v);
}

/** Short chip text, e.g. "Rule au", "Type Customer, Vendor", "Margin < 0" (§15.1 chips). */
export function conditionLabel(f: FieldDescriptor | undefined, c: FilterCondition): string {
  const label = f?.label ?? c.field;
  const vals = (c.values ?? []).map((x) => valueLabel(f, x));
  switch (c.op) {
    case "like": {
      const s = String(c.value);
      return `${label} ${startsWithText(s) ?? s}`;
    }
    case "in":
      return `${label} ${vals.length > 3 ? `${vals.slice(0, 3).join(", ")} +${vals.length - 3}` : vals.join(", ")}`;
    case "not_in":
      return `${label} not ${vals.join(", ")}`;
    case "between":
      return `${label} ${vals[0]}–${vals[1]}`;
    case "empty":
      return `${label} empty`;
    case "not_empty":
      return `${label} not empty`;
    case "eq":
      return `${label} = ${valueLabel(f, c.value)}`;
    default:
      return `${label} ${OP_LABEL[c.op]} ${valueLabel(f, c.value)}`;
  }
}

export function countConditions(g: FilterGroup | null): number {
  if (!g) return 0;
  return g.conditions.reduce((n, c) => n + ("logic" in c ? countConditions(c) : 1), 0);
}

/** Column filters AND the builder tree, as one contract filter. */
export function buildFilter(state: Pick<GridState, "columns" | "builder">): FilterGroup | undefined {
  const conditions: FilterGroup["conditions"] = Object.values(state.columns);
  if (state.builder && countConditions(state.builder) > 0) conditions.push(state.builder);
  return conditions.length ? { logic: "and", conditions } : undefined;
}

export function toListQuery(state: GridState): Pick<ListQuery, "filter" | "search" | "sort"> {
  const filter = buildFilter(state);
  return {
    ...(filter ? { filter } : {}),
    ...(state.search.trim() ? { search: state.search.trim() } : {}),
    ...(state.sort.length ? { sort: state.sort } : {}),
  };
}

/** Header click: asc → desc → off; Shift adds a secondary key (max 5, §13.25). */
export function nextSort(sort: SortKey[], field: string, additive: boolean): SortKey[] {
  const current = sort.find((s) => s.field === field);
  const next: SortKey | null = !current ? { field, dir: "asc" } : current.dir === "asc" ? { field, dir: "desc" } : null;
  if (!additive) return next ? [next] : [];
  const rest = sort.filter((s) => s.field !== field);
  return (next ? [...rest, next] : rest).slice(0, 5);
}

export function isFiltered(state: GridState): boolean {
  return Object.keys(state.columns).length > 0 || countConditions(state.builder) > 0 || state.search.trim() !== "";
}

// ---- URL round-trip: ?g=<base64url(JSON)> in the tab path ----

export function encodeState(state: GridState): string {
  const compact = {
    ...(Object.keys(state.columns).length ? { c: state.columns } : {}),
    ...(state.builder && countConditions(state.builder) ? { b: state.builder } : {}),
    ...(state.search ? { q: state.search } : {}),
    ...(state.sort.length ? { s: state.sort } : {}),
    ...(state.visible ? { v: state.visible } : {}),
    ...(state.viewId ? { w: state.viewId } : {}),
  };
  if (Object.keys(compact).length === 0) return "";
  const json = JSON.stringify(compact);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeState(encoded: string | null): GridState {
  if (!encoded) return emptyState();
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    const o = JSON.parse(json) as {
      c?: GridState["columns"];
      b?: FilterGroup;
      q?: string;
      s?: SortKey[];
      v?: string[];
      w?: number;
    };
    return {
      columns: o.c ?? {},
      builder: o.b ?? null,
      search: o.q ?? "",
      sort: o.s ?? [],
      visible: o.v ?? null,
      viewId: o.w ?? null,
    };
  } catch {
    return emptyState();
  }
}
