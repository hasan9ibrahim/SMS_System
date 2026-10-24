// Shared plumbing for record screens: API field <-> column maps, field-level diffs for the
// change log (§13.10), safe-delete checks (§13.29) and save results ({record, change}).
import type pg from "pg";
import type {
  Change,
  CurrentUser,
  Dependencies,
  DependencyItem,
} from "@sms/contract";
import { changeSelect, mapChange } from "../lists/defs.js";

export interface DiffEntry {
  entity_id: number;
  field: string;
  before: unknown;
  after: unknown;
}

export const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : v == null ? null : String(v);

export function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    cur[key] ??= {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys.at(-1)!] = value;
}

/** JSON with sorted keys; undefined counts as null. */
function stable(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v);
}
export const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** Field-level diff of two records over the given API paths (each changed path is one entry). */
export function diffPaths(
  id: number,
  before: unknown,
  after: unknown,
  paths: string[],
): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const path of paths) {
    const b = getPath(before, path) ?? null;
    const a = getPath(after, path) ?? null;
    if (!same(a, b))
      out.push({ entity_id: id, field: path, before: b, after: a });
  }
  return out;
}

/**
 * One API field stored in one column. `read` is the SELECT expression (default the column),
 * `cast` the parameter cast on writes (e.g. "::inet[]").
 */
export interface FieldSpec {
  api: string;
  col: string;
  read?: string;
  cast?: string;
  /** Read only: shown on the record, never written (e.g. a generated column). */
  readOnly?: boolean;
}

export const selectSpecs = (alias: string, specs: FieldSpec[]) =>
  specs.map((s) => `${s.read ?? `${alias}.${s.col}`} AS "${s.api}"`).join(", ");

export function rowToObject(
  row: Record<string, unknown>,
  specs: FieldSpec[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of specs) setPath(out, s.api, row[s.api] ?? null);
  return out;
}

/** Writes the given API values to their columns. Undefined values are left as they are. */
export async function updateColumns(
  c: pg.PoolClient,
  table: string,
  id: number,
  specs: FieldSpec[],
  values: Record<string, unknown>,
  userId: number,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id, userId];
  for (const s of specs) {
    if (s.readOnly || !(s.api in values) || values[s.api] === undefined)
      continue;
    params.push(values[s.api]);
    sets.push(`${s.col} = $${params.length}${s.cast ?? ""}`);
  }
  if (sets.length === 0) return;
  await c.query(
    `UPDATE ${table} SET ${sets.join(", ")}, updated_by_id = $2, updated_at = now() WHERE id = $1`,
    params,
  );
}

export async function insertRow(
  c: pg.PoolClient,
  table: string,
  specs: FieldSpec[],
  values: Record<string, unknown>,
  extra: Record<string, unknown>,
): Promise<number> {
  const cols: string[] = [];
  const ph: string[] = [];
  const params: unknown[] = [];
  for (const s of specs) {
    if (s.readOnly || values[s.api] === undefined) continue;
    params.push(values[s.api]);
    cols.push(s.col);
    ph.push(`$${params.length}${s.cast ?? ""}`);
  }
  for (const [col, v] of Object.entries(extra)) {
    params.push(v);
    cols.push(col);
    ph.push(`$${params.length}`);
  }
  const { rows } = await c.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph.join(", ")}) RETURNING id`,
    params,
  );
  return rows[0].id as number;
}

/** Flattens a nested input to the API paths of the specs (undefined where not given). */
export function flatten(
  input: unknown,
  specs: FieldSpec[],
): Record<string, unknown> {
  return Object.fromEntries(specs.map((s) => [s.api, getPath(input, s.api)]));
}

/** Writes one entry of the change log and returns it as the contract's Change. */
export async function recordChange(
  c: pg.PoolClient | pg.Pool,
  args: {
    entityType: string;
    entityIds: number[];
    changeType: Change["changeType"];
    diff: DiffEntry[];
    note?: string | null;
    userId: number;
    ip?: string | null;
  },
): Promise<Change> {
  const { rows } = await c.query(
    `INSERT INTO changes (entity_type, entity_ids, change_type, diff, note, user_id, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      args.entityType,
      args.entityIds,
      args.changeType,
      JSON.stringify(args.diff),
      args.note ?? null,
      args.userId,
      args.ip ?? null,
    ],
  );
  const { rows: out } = await c.query(
    `SELECT ${changeSelect} FROM changes c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
    [rows[0].id],
  );
  return mapChange(out[0]);
}

export const isAdmin = (u: CurrentUser) => u.permissions.includes("*");

export const archivedInfo = (at: unknown, by: unknown) =>
  at ? { at: iso(at)!, by: (by as string | null) ?? null } : null;

export function dependencies(items: DependencyItem[]): Dependencies {
  return {
    blocked: items.some(
      (i) => i.blocking && (i.count === null ? false : i.count !== 0),
    ),
    items,
  };
}

/** Field error for a 400 answer, in the contract's Problem.errors shape. */
export interface FieldError {
  path: string;
  message: string;
}

/** Unique violation (23505) from a partial unique index, e.g. a live trunk username. */
export const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === "23505";

/** IANA time zones offered by forms (§13.31 billing time zone). */
export const TIMEZONES: string[] = [
  "UTC",
  ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC"),
];
export const isTimezone = (z: string) => TIMEZONES.includes(z);
