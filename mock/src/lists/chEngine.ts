// Server-side lists on the EDR store (CLAUDE.md rule 3, spec §13.25, §14.2): the same ListQuery
// grammar as engine.ts, compiled to ClickHouse SQL. EDRs carry IDs only, so filters on enterprise,
// trunk and provider names run on PostgreSQL first and apply as ID lists; sorting by a name uses
// transform() over the names. Values are inlined as escaped literals.
import { isNameValue, mccmncByNameSql } from "./mccmncNames.js";
import type {
  FieldDescriptor,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  ListFields,
  ListQuery,
} from "@sms/contract";
import type pg from "pg";
import { chQuery } from "../edr.js";
import type { VisItem } from "../visibility/policy.js";
import { viewChDef } from "../visibility/edr.js";
import { encodeCursor, readCursor, runList, searchPattern, type ListDef, type ListPage } from "./engine.js";

/** A ClickHouse string literal. */
export const lit = (s: string) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${String(v)}`);
  return String(n);
};
const time = (v: unknown) => `parseDateTime64BestEffort(${lit(String(v))}, 3, 'UTC')`;

/** Which PostgreSQL table holds the names behind an ID column. */
export interface NameSource {
  table: string;
  name: string;
  id: string;
  /**
   * The viewer's masking (§13.17, visibility/edr.ts): IDs they do not own show as `label(id)` and are never found by
   * a name filter or the quick search.
   */
  view?: { own: (id: number) => boolean; label: (id: number) => string };
}

export interface ChColumn {
  sql: string;
  /** Numeric column behind an enum field (e.g. cause codes). */
  numeric?: boolean;
  nullable?: boolean;
  /** Name field: the condition runs on these names and applies to `idSql`. */
  names?: NameSource & { idSql: string };
  where?: (c: FilterCondition) => string;
  /**
   * The value the switch's outcome row of the attempt carries (backend step 11b, ClickHouse 006): `sql` a column of
   * `edr_receipt`. "status" replaces the attempt row's value when the outcome has a final status (vendor or customer
   * status, error, delivery time and delay), and filters on the field match that value; "add" adds the outcome's
   * money, "or" its billable flag (filters and sorts on those read the attempt row).
   */
  outcome?: { sql: string; merge: "status" | "add" | "or"; when?: string };
  /** Withheld from a viewer who does not own that side of the message (§13.17): the item and the side. */
  vis?: { item: VisItem; side: "customer" | "vendor" };
  /** A name masked for a viewer who does not own it (§13.17). */
  mask?: "enterprise" | "customerTrunk" | "vendorTrunk";
}

export interface ChListDef<Row> {
  fields: ListFields;
  table: string;
  baseWhere?: string;
  columns: Record<string, ChColumn>;
  search: string[];
  /** Columns a pasted list of numbers matches exactly (sender, receiver). */
  searchNumbers?: string[];
  /** Name columns the quick search also matches by name (customer, vendor). */
  searchNames?: string[];
  idSql: string;
  mapRow: (row: Record<string, unknown>, names: NameMaps) => Row;
  /** The enterprise of each side, as SQL and as the row's field, for visibility (§13.17). */
  owners?: { customer: { sql: string; key: string }; vendor?: { sql: string; key: string } };
}

export type NameMaps = Map<string, Map<number, string>>;

/** How long a list query may run in ClickHouse (it stops it then too); longer answers 503. */
const LIST_TIMEOUT_MS = 30_000;

const NUMERIC = new Set(["integer", "decimal", "money", "percent"]);
const NEGATED: Partial<Record<FilterOperator, FilterOperator>> = { neq: "eq", not_like: "like", not_in: "in" };

// ---------------------------------------------------------------- names

const nameCache = new Map<string, { at: number; map: Map<number, string> }>();

/** id → name for a PostgreSQL table, cached for a minute. */
export async function namesOf(pool: pg.Pool, src: NameSource): Promise<Map<number, string>> {
  const key = `${src.table}|${src.name}`;
  const hit = nameCache.get(key);
  let map = hit && Date.now() - hit.at < 60_000 ? hit.map : null;
  if (!map) {
    const { rows } = await pool.query(`SELECT ${src.id} AS id, ${src.name} AS name FROM ${src.table}`);
    map = new Map(rows.map((r) => [Number(r.id), String(r.name)]));
    nameCache.set(key, { at: Date.now(), map });
  }
  const view = src.view;
  return view ? new Map([...map].map(([id, name]) => [id, view.own(id) ? name : view.label(id)])) : map;
}

/** IDs whose name meets the (positive) condition, using the PostgreSQL list engine. */
async function idsMatching(pool: pg.Pool, src: NameSource, c: FilterCondition, field: FieldDescriptor) {
  const def: ListDef<{ id: number }> = {
    fields: { list: "enterprises", defaultSort: [], fields: [{ ...field, field: "name" }] },
    from: src.table,
    columns: { name: { sql: src.name } },
    search: [],
    idSql: src.id,
    select: `${src.id} AS id`,
    mapRow: (r) => ({ id: Number(r.id) }),
  };
  const page = await runList(pool, def, {
    filter: { logic: "and", conditions: [{ ...c, field: "name" }] },
    limit: 100_000,
    withTotal: false,
  });
  const ids = page.rows.map((r) => r.id);
  return src.view ? ids.filter(src.view.own) : ids;
}

// ---------------------------------------------------------------- compile

type Resolved = Map<FilterCondition, number[]>;

async function resolveNames(pool: pg.Pool, def: ChListDef<unknown>, group: FilterGroup, out: Resolved) {
  const byName = new Map(def.fields.fields.map((f) => [f.field, f]));
  for (const node of group.conditions) {
    if ("logic" in node) {
      await resolveNames(pool, def, node, out);
      continue;
    }
    const c = node as FilterCondition;
    const col = def.columns[c.field];
    if (!col?.names || c.op === "empty" || c.op === "not_empty") continue;
    const op = NEGATED[c.op] ?? c.op;
    out.set(c, await idsMatching(pool, col.names, { ...c, op }, byName.get(c.field)!));
  }
}

function conditionSql(c: FilterCondition, f: FieldDescriptor, col: ChColumn, resolved: Resolved): string {
  if (col.where) return col.where(c);
  const o = col.outcome;
  if (o?.merge === "status") {
    // The outcome's value when it has one, else the attempt row's (append-only EDRs, backend step 11b).
    const plain = { ...col, outcome: undefined };
    const has = `SELECT edr_id FROM edr_receipt WHERE kind = 'outcome' AND ${o.when ?? `${o.sql} != ''`}`;
    return `(edr_id IN (${has} AND ${conditionSql(c, f, { ...plain, sql: o.sql }, resolved)})
      OR (${conditionSql(c, f, plain, resolved)} AND edr_id NOT IN (${has})))`;
  }
  if (col.names) {
    const idSql = col.names.idSql;
    if (c.op === "empty") return `${idSql} = 0`;
    if (c.op === "not_empty") return `${idSql} != 0`;
    const ids = resolved.get(c) ?? [];
    const list = ids.length ? `(${ids.join(",")})` : "(-1)";
    return NEGATED[c.op] ? `${idSql} NOT IN ${list}` : `${idSql} IN ${list}`;
  }
  const x = col.sql;
  const values = c.values ?? [];
  const isTime = f.type === "date" || f.type === "datetime";
  const isNum = NUMERIC.has(f.type) || col.numeric === true;
  const isBool = f.type === "boolean";
  if (isTime) {
    switch (c.op) {
      case "between":
        return `${x} BETWEEN ${time(values[0])} AND ${time(values[1])}`;
      case "gt":
        return `${x} > ${time(c.value)}`;
      case "gte":
        return `${x} >= ${time(c.value)}`;
      case "lt":
        return `${x} < ${time(c.value)}`;
      case "lte":
        return `${x} <= ${time(c.value)}`;
      case "empty":
        return col.nullable ? `isNull(${x})` : "0";
      case "not_empty":
        return col.nullable ? `isNotNull(${x})` : "1";
      default:
        return "1";
    }
  }
  if (isBool) {
    const b = (v: unknown) => (v === true || v === "true" ? "1" : "0");
    if (c.op === "eq") return `${x} = ${b(c.value)}`;
    if (c.op === "neq") return `${x} != ${b(c.value)}`;
    if (c.op === "in") return `${x} IN (${values.map(b).join(",")})`;
    if (c.op === "not_in") return `${x} NOT IN (${values.map(b).join(",")})`;
    return "1";
  }
  if (isNum) {
    const list = values.map(num).join(",") || "NULL";
    switch (c.op) {
      case "eq":
        return `${x} = ${num(c.value)}`;
      case "neq":
        return `${x} != ${num(c.value)}`;
      case "gt":
        return `${x} > ${num(c.value)}`;
      case "gte":
        return `${x} >= ${num(c.value)}`;
      case "lt":
        return `${x} < ${num(c.value)}`;
      case "lte":
        return `${x} <= ${num(c.value)}`;
      case "between":
        return `${x} BETWEEN ${num(values[0])} AND ${num(values[1])}`;
      case "in":
        return `${x} IN (${list})`;
      case "not_in":
        return `${x} NOT IN (${list})`;
      case "empty":
        return `${x} = 0`;
      case "not_empty":
        return `${x} != 0`;
      default:
        return "1";
    }
  }
  const s = `toString(${x})`;
  const lower = `lower(${s})`;
  const strList = values.map((v) => lit(String(v).toLowerCase())).join(",") || "NULL";
  switch (c.op) {
    case "eq":
      return `${lower} = ${lit(String(c.value).toLowerCase())}`;
    case "neq":
      return `${lower} != ${lit(String(c.value).toLowerCase())}`;
    case "like":
      return `${s} ILIKE ${lit(String(c.value))}`;
    case "not_like":
      return `NOT (${s} ILIKE ${lit(String(c.value))})`;
    case "in":
      return `${lower} IN (${strList})`;
    case "not_in":
      return `${lower} NOT IN (${strList})`;
    case "empty":
      return `${s} = ''`;
    case "not_empty":
      return `${s} != ''`;
    case "regex":
      return `match(${s}, ${lit(`(?i)${String(c.value)}`)})`;
    default:
      return "1";
  }
}

function groupSql(
  group: FilterGroup,
  def: ChListDef<unknown>,
  byName: Map<string, FieldDescriptor>,
  r: Resolved,
): string {
  const parts = group.conditions.map((node) => {
    if ("logic" in node) return groupSql(node, def, byName, r);
    const c = node as FilterCondition;
    return conditionSql(c, byName.get(c.field)!, def.columns[c.field]!, r);
  });
  if (!parts.length) return "1";
  return `(${parts.join(group.logic === "or" ? " OR " : " AND ")})`;
}

/**
 * Quick search (team trial round 1). Several items separated by commas match any of them: a number
 * (5+ digits) matches a sender or receiver exactly, any other text matches the search columns as before
 * and, for lists with `searchNames`, the names of those columns (e.g. "acme" finds Acme's EDRs). One item
 * keeps the contains-match on the search columns.
 */
async function searchSql(pool: pg.Pool, def: ChListDef<unknown>, search: string): Promise<string> {
  const items = search
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 500);
  const many = items.length > 1;
  const parts: string[] = [];
  for (const item of items) {
    const digits = item.replace(/[\s+()-]/g, "");
    if (many && /^\d{5,20}$/.test(digits) && def.searchNumbers?.length) {
      parts.push(`(${def.searchNumbers.map((f) => `${def.columns[f]!.sql} = ${lit(digits)}`).join(" OR ")})`);
      continue;
    }
    const p = lit(searchPattern(item));
    const or = def.search.map((f) => `toString(${def.columns[f]!.sql}) ILIKE ${p}`);
    for (const key of def.searchNames ?? []) {
      const col = def.columns[key];
      const field = def.fields.fields.find((f) => f.field === key);
      if (!col?.names || !field || /^\d+$/.test(item)) continue;
      const ids = await idsMatching(pool, col.names, { field: key, op: "like", value: item }, field);
      if (ids.length) or.push(`${col.names.idSql} IN (${ids.slice(0, 5000).join(",")})`);
    }
    parts.push(`(${or.join(" OR ")})`);
  }
  return parts.length ? `(${parts.join(" OR ")})` : "1";
}

/** MCCMNC columns filtered by a name ("Nigeria", "MTN") become the list of codes it names. */
async function mccmncNames(pool: pg.Pool, def: ChListDef<unknown>, group: FilterGroup): Promise<FilterGroup> {
  const byName = new Map(def.fields.fields.map((f) => [f.field, f]));
  const map = async (node: FilterGroup | FilterCondition): Promise<FilterGroup | FilterCondition> => {
    if ("logic" in node) return { ...node, conditions: await Promise.all(node.conditions.map(map)) };
    const c = node as FilterCondition;
    if (byName.get(c.field)?.type !== "mccmnc" || def.columns[c.field]?.names || def.columns[c.field]?.where) return c;
    if (!["like", "not_like", "eq", "neq"].includes(c.op) || !isNameValue(c.value)) return c;
    const text = String(c.value);
    const pattern = c.op === "like" || c.op === "not_like" ? text : text.replace(/[%_\\]/g, "\\$&");
    const { rows } = await pool.query<{ mccmnc: string }>(`SELECT mccmnc FROM ${mccmncByNameSql("$1")} x`, [pattern]);
    const codes = rows.map((r) => r.mccmnc);
    return { field: c.field, op: NEGATED[c.op] ? "not_in" : "in", values: codes.length ? codes : ["\u0000none"] };
  };
  return (await map(group)) as FilterGroup;
}

/** WHERE clause (without the keyword) for a query; names are resolved on PostgreSQL first. */
export async function chWhere(pool: pg.Pool, def: ChListDef<unknown>, query: Pick<ListQuery, "filter" | "search">) {
  if (query.filter) query = { ...query, filter: await mccmncNames(pool, def, query.filter) };
  const byName = new Map(def.fields.fields.map((f) => [f.field, f]));
  const resolved: Resolved = new Map();
  if (query.filter) await resolveNames(pool, def, query.filter, resolved);
  const where: string[] = [];
  if (def.baseWhere) where.push(def.baseWhere);
  if (query.filter) where.push(groupSql(query.filter, def, byName, resolved));
  if (query.search?.trim()) where.push(await searchSql(pool, def, query.search.trim()));
  return where.length ? where.join(" AND ") : "1";
}

interface OrderTerm {
  expr: string;
  desc: boolean;
}

/** The sort terms; a name column sorts by its names via transform(); the ID last, in the first term's direction. */
async function chOrderTerms(pool: pg.Pool, def: ChListDef<unknown>, query: Pick<ListQuery, "sort">) {
  const sort = query.sort?.length ? query.sort : def.fields.defaultSort;
  const terms: OrderTerm[] = [];
  for (const s of sort) {
    const col = def.columns[s.field]!;
    let expr = col.sql;
    if (col.names) {
      const names = [...(await namesOf(pool, col.names)).entries()];
      expr = `transform(${col.names.idSql}, [${names.map(([id]) => id).join(",") || 0}], [${
        names.map(([, n]) => lit(n)).join(",") || "''"
      }], '')`;
    }
    terms.push({ expr, desc: s.dir === "desc" });
  }
  terms.push({ expr: def.idSql, desc: sort[0]?.dir === "desc" });
  return terms;
}

/** ORDER BY clause; a name column sorts by its names via transform(). */
export async function chOrder(pool: pg.Pool, def: ChListDef<unknown>, query: Pick<ListQuery, "sort">) {
  return (await chOrderTerms(pool, def, query)).map((t) => `${t.expr} ${t.desc ? "DESC" : "ASC"}`).join(", ");
}

/**
 * Keyset paging (QA 2026-10-31, §13.25): the rows after the previous page's last row in the sort order, `_k<i>` being
 * the sort terms and `keys` that row's values as text. EDRs arrive all the time, and an offset repeated or skipped rows
 * once new ones sorted before it. ClickHouse puts NULLs last both ways.
 */
function afterKeys(terms: OrderTerm[], keys: (string | null)[]): string {
  const typed = (i: number) => `CAST(${lit(keys[i]!)}, toTypeName(_k${i}))`;
  const ors = terms.map((t, i) => {
    const same = terms.slice(0, i).map((_, j) => (keys[j] === null ? `isNull(_k${j})` : `_k${j} = ${typed(j)}`));
    const after = keys[i] === null ? "0" : `(_k${i} ${t.desc ? "<" : ">"} ${typed(i)} OR isNull(_k${i}))`;
    return `(${[...same, after].join(" AND ")})`;
  });
  return `(${ors.join(" OR ")})`;
}

/** Every name map a list's rows need. */
export async function nameMaps(pool: pg.Pool, def: ChListDef<unknown>): Promise<NameMaps> {
  const out: NameMaps = new Map();
  for (const [field, col] of Object.entries(def.columns)) if (col.names) out.set(field, await namesOf(pool, col.names));
  return out;
}

/** SELECT list: every column as its field name. */
export const chSelect = (def: ChListDef<unknown>, only?: string[]) =>
  (only ?? Object.keys(def.columns))
    .filter((f) => def.columns[f] && !def.columns[f]!.names)
    .map((f) => `${def.columns[f]!.sql} AS ${f}`)
    .concat(
      Object.entries(def.columns)
        .filter(([f, c]) => c.names && (!only || only.includes(f)))
        .map(([f, c]) => `${c.names!.idSql} AS _${f}`),
    )
    .join(", ");

/**
 * One page in two steps: the IDs of the page in order (reads only the sort columns), then the full
 * rows of those IDs. Reading every column of every candidate row before sorting is ~30× slower.
 */
export async function runChList<Row>(pool: pg.Pool, def: ChListDef<Row>, query: ListQuery): Promise<ListPage<Row>> {
  // As the viewer sees it (§13.17): masked names, withheld values, others' traffic left out.
  def = await viewChDef(def);
  const d = def as ChListDef<unknown>;
  const [whereSql, terms, names] = await Promise.all([
    chWhere(pool, d, query),
    chOrderTerms(pool, d, query),
    nameMaps(pool, d),
  ]);
  const limit = query.limit ?? 100;
  const { offset, keys } = readCursor(query.cursor);
  // The page after the last row of the previous one; an offset only for a cursor without its keys.
  const keyed = keys !== null && keys.length === terms.length;
  const [ids, count] = await Promise.all([
    chQuery<Record<string, string | null> & { id: string; t: string }>(
      `WITH ${terms.map((t, i) => `${t.expr} AS _k${i}`).join(", ")}
       SELECT toString(${def.idSql}) AS id, toString(start_time) AS t, ${terms.map((_, i) => `toString(_k${i}) AS k${i}`).join(", ")}
         FROM ${def.table} WHERE ${whereSql}${keyed ? ` AND ${afterKeys(terms, keys)}` : ""}
        ORDER BY ${terms.map((t, i) => `_k${i} ${t.desc ? "DESC" : "ASC"}`).join(", ")}
        LIMIT ${limit + 1}${keyed ? "" : ` OFFSET ${offset}`}`,
      LIST_TIMEOUT_MS,
      { read: true },
    ),
    query.withTotal === false
      ? null
      : chQuery<{ n: string }>(`SELECT count() AS n FROM ${def.table} WHERE ${whereSql}`, LIST_TIMEOUT_MS, {
          read: true,
        }),
  ]);
  const more = ids.length > limit;
  const pageIds = ids.slice(0, limit);
  const last = pageIds[pageIds.length - 1];
  let rows: Record<string, unknown>[] = [];
  if (pageIds.length) {
    const times = pageIds.map((r) => r.t).sort();
    const full = await chQuery<Record<string, unknown>>(
      // PREWHERE on the IDs: only the ID column is read until the page's rows are found. When the page
      // spans the whole period (e.g. sorted by ID), letting ClickHouse pick start_time reads every
      // column of every row (7 s at 5 M EDRs instead of 0.4 s).
      `SELECT ${chSelect(d)}, toString(${def.idSql}) AS _id FROM ${def.table}
        PREWHERE ${def.idSql} IN (${pageIds.map((r) => lit(r.id)).join(",")})
        WHERE start_time BETWEEN ${lit(times[0]!)} AND ${lit(times[times.length - 1]!)}`,
      LIST_TIMEOUT_MS,
      { read: true },
    );
    const byId = new Map(full.map((r) => [String(r._id), r]));
    rows = pageIds.map((r) => byId.get(r.id)).filter((r): r is Record<string, unknown> => !!r);
    await withOutcomes(d, rows, times[0]!, times[times.length - 1]!);
  }
  return {
    rows: rows.map((r) => def.mapRow(r, names)),
    total: count ? Number(count[0]?.n ?? 0) : offset + rows.length + (more ? 1 : 0),
    totalIsEstimate: count === null,
    nextCursor: more && last ? encodeCursor(offset + limit, { keys: terms.map((_, i) => last[`k${i}`] ?? null) }) : null,
  };
}

/**
 * Merges the switch's outcome rows into a page of attempt rows (backend step 11b): the final status, errors, delivery
 * time and delay, and the money billed on the receipt. `from`/`to` bound the page's start times (partition pruning).
 */
export async function withOutcomes(
  def: ChListDef<unknown>,
  rows: Record<string, unknown>[],
  from: string,
  to: string,
  only?: string[],
) {
  const cols = Object.entries(def.columns).filter(([f, c]) => c.outcome && (!only || only.includes(f)));
  if (!cols.length || !rows.length) return;
  const agg = cols.map(([f, c]) => {
    const o = c.outcome!;
    const when = o.when ?? `${o.sql} != ''`;
    if (o.merge === "add") return `toFloat64(sum(${o.sql})) AS ${f}`;
    if (o.merge === "or") return `max(${o.sql}) AS ${f}`;
    return `argMaxIf(${o.sql}, receipt_time, ${when}) AS ${f}, countIf(${when}) AS _has_${f}`;
  });
  const out = await chQuery<Record<string, unknown>>(
    `SELECT toString(edr_id) AS _id, ${agg.join(", ")}
       FROM edr_receipt
      PREWHERE edr_id IN (${rows.map((r) => lit(String(r._id ?? r.id))).join(",")})
      WHERE kind = 'outcome' AND start_time BETWEEN ${lit(from)} AND ${lit(to)}
      GROUP BY edr_id`,
    LIST_TIMEOUT_MS,
    { read: true },
  );
  const byId = new Map(out.map((r) => [String(r._id), r]));
  for (const r of rows) {
    const o = byId.get(String(r._id ?? r.id));
    if (!o) continue;
    for (const [f, c] of cols) {
      const v = o[f];
      if (c.outcome!.merge === "add") r[f] = Number(r[f] ?? 0) + Number(v ?? 0);
      else if (c.outcome!.merge === "or") r[f] = Math.max(Number(r[f] ?? 0), Number(v ?? 0));
      else if (Number(o[`_has_${f}`]) > 0) r[f] = v;
    }
  }
}

/**
 * The same merge in SQL, for exports that stream every matching row (backend step 11b): `from` joins the outcome rows
 * of the attempts `where` matches, and `expr(field)` is the field's merged value.
 */
export function outcomeJoin(def: ChListDef<unknown>, columns: string[], where: string) {
  const cols = columns.filter((f) => def.columns[f]?.outcome);
  if (!cols.length) return { from: def.table, expr: (f: string) => def.columns[f]!.sql };
  const agg = cols.map((f) => {
    const o = def.columns[f]!.outcome!;
    const when = o.when ?? `${o.sql} != ''`;
    if (o.merge === "add") return `sum(${o.sql}) AS o_${f}`;
    if (o.merge === "or") return `max(${o.sql}) AS o_${f}`;
    return `argMaxIf(${o.sql}, receipt_time, ${when}) AS o_${f}, countIf(${when}) AS o_has_${f}`;
  });
  return {
    from: `${def.table} LEFT JOIN (SELECT edr_id, ${agg.join(", ")} FROM edr_receipt
      WHERE kind = 'outcome' AND edr_id IN (SELECT edr_id FROM ${def.table} WHERE ${where}) GROUP BY edr_id) AS o USING edr_id`,
    expr: (f: string) => {
      const c = def.columns[f]!;
      if (!c.outcome) return c.sql;
      if (c.outcome.merge === "add") return `(${c.sql} + toFloat64(o_${f}))`;
      if (c.outcome.merge === "or") return `greatest(${c.sql}, o_${f})`;
      return `if(o_has_${f} > 0, o_${f}, ${c.sql})`;
    },
  };
}

/** Every catalogue field needs SQL. */
export function checkChDef(name: string, def: ChListDef<unknown>): string[] {
  const problems: string[] = [];
  for (const f of def.fields.fields) if (!def.columns[f.field]) problems.push(`${name}: no SQL for field "${f.field}"`);
  for (const f of def.search) if (!def.columns[f]) problems.push(`${name}: search field "${f}" has no SQL`);
  return problems;
}

/** ClickHouse DateTime64 text ('2026-10-16 21:30:00.010') as ISO 8601. */
export const chIso = (v: unknown) =>
  v == null || v === ""
    ? null
    : `${String(v)
        .replace(" ", "T")
        .replace(/(\.\d+)?$/, (m) => (m || ".000").padEnd(4, "0"))}Z`;
