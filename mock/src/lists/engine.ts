// Server-side list engine (CLAUDE.md rule 3, spec §13.25, §14.2): turns a ListQuery
// (filter tree with AND/OR groups, quick search, sort, cursor) into parameterised SQL
// against the seeded PostgreSQL data. Every list endpoint is a ListDef plus this engine.
import type pg from "pg";
import type {
  FieldDescriptor,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  ListFields,
  ListQuery,
  MaskedCell,
} from "@sms/contract";
import type { Viewer } from "../visibility/policy.js";
import { currentViewer } from "../visibility/context.js";
import { modeSql, resolveSql, valueSql, type VisRule } from "../visibility/sql.js";

export interface ColumnSql {
  /** SQL expression, using the aliases of the list's FROM clause. */
  sql: string;
  /** Custom predicate (e.g. array membership); `p` adds a parameter and returns its placeholder. */
  where?: (op: FilterOperator, c: FilterCondition, p: (value: unknown) => string) => string;
  /**
   * Masked or hidden for viewers who do not own the row (§13.17). Filters, sorting and quick search use
   * what the viewer sees; the row's field (`rowKey`, default the field name) is replaced in the answer.
   */
  vis?: VisRule;
  rowKey?: string;
}

export interface ListDef<Row> {
  fields: ListFields;
  /** FROM clause with joins; a function when it depends on the query (e.g. a time window). */
  from: string | ((query: ListQuery) => string);
  /** Always applied, e.g. hiding archived records (§13.29). */
  baseWhere?: string;
  /**
   * A filter on this field ("Show deleted", §13.29) lifts baseWhere, so archived rows can be
   * listed (archived = true) or shown next to live ones (archived in [true, false]).
   */
  archivedField?: string;
  /** SQL for every field of the catalogue. */
  columns: Record<string, ColumnSql>;
  /** Fields matched by the quick search box. */
  search: string[];
  /** Unique, stable tie-breaker so paging never repeats or skips rows. */
  idSql: string;
  /** SELECT list; rows are passed to mapRow. */
  select: string;
  mapRow: (row: Record<string, unknown>) => Row;
}

export interface ListPage<Row> {
  rows: Row[];
  total: number;
  totalIsEstimate: boolean;
  nextCursor: string | null;
  /** Values withheld by the viewer's visibility policy (§13.17). */
  masked?: MaskedCell[];
}

const NUMERIC = new Set(["integer", "decimal", "money", "percent"]);
const TIME = new Set(["date", "datetime"]);

/** `%` / `_` wildcards are used as typed; plain text means "contains" (§13.25). */
export function searchPattern(text: string): string {
  return /[%_]/.test(text) ? text : `%${text}%`;
}

/** Cursor = position in the sorted result. Valid for the same filter and sort only. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}
export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    return typeof o === "number" && Number.isInteger(o) && o >= 0 ? o : 0;
  } catch {
    return 0;
  }
}

class Params {
  readonly values: unknown[] = [];
  add = (value: unknown): string => {
    this.values.push(value);
    return `$${this.values.length}`;
  };
}

function conditionSql(c: FilterCondition, field: FieldDescriptor, col: ColumnSql, p: Params["add"]): string {
  if (col.where) return col.where(c.op, c, p);
  const x = col.sql;
  const numeric = NUMERIC.has(field.type);
  const time = TIME.has(field.type);
  // Integer fields compare as bigint so ID filters use their indexes (a numeric cast doesn't).
  const integer = field.type === "integer";
  const cast = integer
    ? "::bigint"
    : numeric
      ? "::numeric"
      : time
        ? "::timestamptz"
        : field.type === "boolean"
          ? "::boolean"
          : "";
  const value = (v: unknown) =>
    numeric || time || field.type === "boolean" ? p(v) + cast : p(String(v).toLowerCase());
  const list = (vs: unknown[]) =>
    numeric
      ? `${p(vs.map(Number))}::${integer ? "bigint" : "numeric"}[]`
      : time
        ? `${p(vs)}::timestamptz[]`
        : field.type === "boolean"
          ? `${p(vs.map((v) => v === true || v === "true"))}::boolean[]`
          : `${p(vs.map((v) => String(v).toLowerCase()))}::text[]`;
  const subject = numeric || time || field.type === "boolean" ? x : `lower((${x})::text)`;
  const values = c.values ?? [];
  switch (c.op) {
    case "eq":
      return `${subject} = ${value(c.value)}`;
    case "neq":
      return `(${x} IS NULL OR ${subject} <> ${value(c.value)})`;
    case "like":
      return `(${x})::text ILIKE ${p(String(c.value))}`;
    case "not_like":
      return `(${x} IS NULL OR NOT (${x})::text ILIKE ${p(String(c.value))})`;
    case "in":
      return `${subject} = ANY(${list(values)})`;
    case "not_in":
      return `(${x} IS NULL OR NOT (${subject} = ANY(${list(values)})))`;
    case "between":
      return `${x} BETWEEN ${p(values[0])}${cast} AND ${p(values[1])}${cast}`;
    case "gt":
      return `${x} > ${p(c.value)}${cast}`;
    case "gte":
      return `${x} >= ${p(c.value)}${cast}`;
    case "lt":
      return `${x} < ${p(c.value)}${cast}`;
    case "lte":
      return `${x} <= ${p(c.value)}${cast}`;
    case "empty":
      return `(${x} IS NULL OR (${x})::text = '')`;
    case "not_empty":
      return `(${x} IS NOT NULL AND (${x})::text <> '')`;
    case "regex":
      return `(${x})::text ~* ${p(String(c.value))}`;
  }
}

function groupSql(
  group: FilterGroup,
  def: ListDef<unknown>,
  byName: Map<string, FieldDescriptor>,
  p: Params["add"],
): string {
  const parts = group.conditions.map((node) => {
    if ("logic" in node) return groupSql(node, def, byName, p);
    const c = node as FilterCondition;
    return conditionSql(c, byName.get(c.field)!, def.columns[c.field]!, p);
  });
  if (parts.length === 0) return "TRUE";
  return `(${parts.join(group.logic === "or" ? " OR " : " AND ")})`;
}

function mentions(group: FilterGroup, field: string): boolean {
  return group.conditions.some((n) => ("logic" in n ? mentions(n, field) : (n as FilterCondition).field === field));
}

/** The definition as this viewer sees it (§13.17): column SQL with masking and hiding applied. */
export function viewDef(def: ListDef<unknown>, viewer: Viewer | null): { def: ListDef<unknown>; extra: string[] } {
  const extra: string[] = [];
  const columns: Record<string, ColumnSql> = {};
  for (const [field, col] of Object.entries(def.columns)) {
    let sql = resolveSql(col.sql, viewer);
    if (col.vis) {
      const value = valueSql(col.vis, viewer);
      if (value !== col.vis.sql) {
        sql = resolveSql(value, viewer);
        if (col.vis.kind === "mask") extra.push(`${sql} AS "__m_${field}"`);
        else extra.push(`${resolveSql(modeSql(col.vis, viewer)!, viewer)} AS "__v_${field}"`);
      }
    }
    columns[field] = { ...col, sql };
  }
  const from = def.from;
  return {
    def: {
      ...def,
      columns,
      from: typeof from === "function" ? (q: ListQuery) => resolveSql(from(q), viewer) : resolveSql(from, viewer),
      select: resolveSql(def.select, viewer),
      ...(def.baseWhere ? { baseWhere: resolveSql(def.baseWhere, viewer) } : {}),
    },
    extra,
  };
}

/** Builds the page and count statements. The query must have passed checkListQuery. */
export function compileQuery(def: ListDef<unknown>, query: ListQuery, extraSelect: string[] = []) {
  const byName = new Map(def.fields.fields.map((f) => [f.field, f]));
  const params = new Params();
  const where: string[] = [];
  const showArchived = !!def.archivedField && !!query.filter && mentions(query.filter, def.archivedField);
  if (def.baseWhere && !showArchived) where.push(def.baseWhere);
  if (query.filter) where.push(groupSql(query.filter, def, byName, params.add));
  if (query.search?.trim()) {
    const pattern = params.add(searchPattern(query.search.trim()));
    where.push(`(${def.search.map((f) => `(${def.columns[f]!.sql})::text ILIKE ${pattern}`).join(" OR ")})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sort = query.sort?.length ? query.sort : def.fields.defaultSort;
  const orderSql = [
    ...sort.map((s) => `${def.columns[s.field]!.sql} ${s.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`),
    `${def.idSql} ${sort[0]?.dir === "desc" ? "DESC" : "ASC"}`,
  ].join(", ");
  const limit = query.limit ?? 100;
  const offset = decodeCursor(query.cursor);
  const countValues = [...params.values];
  const limitP = params.add(limit + 1);
  const offsetP = params.add(offset);
  const from = typeof def.from === "function" ? def.from(query) : def.from;
  // Rule placeholders not resolved for a viewer (internal callers) read the plain values (§13.17).
  const plain = (sql: string) => resolveSql(sql, null);
  return {
    sql: plain(
      `SELECT ${[def.select, ...extraSelect].join(", ")} FROM ${from} ${whereSql} ORDER BY ${orderSql} LIMIT ${limitP} OFFSET ${offsetP}`,
    ),
    values: params.values,
    countSql: plain(`SELECT count(*)::bigint AS n FROM ${from} ${whereSql}`),
    countValues,
    limit,
    offset,
  };
}

export async function runList<Row>(
  pool: pg.Pool,
  def: ListDef<Row>,
  query: ListQuery,
  viewer?: Viewer | null,
): Promise<ListPage<Row>> {
  const view = viewDef(def as ListDef<unknown>, viewer === undefined ? await currentViewer() : viewer);
  const q = compileQuery(view.def, query, view.extra);
  const [page, count] = await Promise.all([
    pool.query(q.sql, q.values),
    query.withTotal === false ? null : pool.query<{ n: number }>(q.countSql, q.countValues),
  ]);
  const more = page.rows.length > q.limit;
  const masked: MaskedCell[] = [];
  const rows = page.rows.slice(0, q.limit).map((raw) => {
    const r = raw as Record<string, unknown>;
    const row = def.mapRow(r) as Record<string, unknown>;
    if (view.extra.length) applyVisibility(def, r, row, masked);
    return row as Row;
  });
  return {
    rows,
    total: count ? Number(count.rows[0]?.n ?? 0) : q.offset + rows.length + (more ? 1 : 0),
    totalIsEstimate: count === null,
    nextCursor: more ? encodeCursor(q.offset + q.limit) : null,
    ...(masked.length ? { masked } : {}),
  };
}

/** Every matching row (up to the query's limit) as the current viewer sees it, for exports (§13.17). */
export async function exportRows<Row>(pool: pg.Pool, def: ListDef<Row>, query: ListQuery): Promise<Row[]> {
  const view = viewDef(def as ListDef<unknown>, await currentViewer());
  const q = compileQuery(view.def, query, view.extra);
  const { rows } = await pool.query(q.sql, q.values);
  return rows.slice(0, q.limit).map((raw) => {
    const r = raw as Record<string, unknown>;
    const row = def.mapRow(r) as Record<string, unknown>;
    if (view.extra.length) applyVisibility(def as ListDef<unknown>, r, row, []);
    return row as Row;
  });
}

/** Puts masked names into the row and withholds hidden values (§13.17). */
function applyVisibility(
  def: ListDef<unknown>,
  r: Record<string, unknown>,
  row: Record<string, unknown>,
  masked: MaskedCell[],
) {
  for (const [field, col] of Object.entries(def.columns)) {
    if (!col.vis) continue;
    const key = col.rowKey ?? field;
    if (`__m_${field}` in r) {
      if (key in row && r[`__m_${field}`] != null) row[key] = r[`__m_${field}`];
    } else if (`__v_${field}` in r) {
      const mode = r[`__v_${field}`];
      if (mode !== "show" && mode != null) {
        if (key in row) row[key] = null;
        masked.push({ id: Number(row.id), field, text: String(mode) });
      }
    }
  }
}

/** Every catalogue field needs SQL, and every quick-search field must exist. */
export function checkDef(name: string, def: ListDef<unknown>): string[] {
  const problems: string[] = [];
  for (const f of def.fields.fields) if (!def.columns[f.field]) problems.push(`${name}: no SQL for field "${f.field}"`);
  for (const f of def.search) if (!def.columns[f]) problems.push(`${name}: search field "${f}" has no SQL`);
  return problems;
}
