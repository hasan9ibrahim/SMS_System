// Nightly EDR repair (S-7.3, ClickHouse 010, §9.1, §10). The switch's EDR writer now stores each bus row once (a key
// lookup before each insert, an insert token), but rows stored twice before that, or past it, stay in the detailed
// EDRs, and the materialized views counted them twice in the hourly figures and long-term totals. Each night, for the
// last days (3 by default), this job finds keys with more than one row, removes the extra rows, and puts the totals
// right with compensating rows as ClickHouse 009 did: per affected group, what the detailed rows add up to less what
// the totals hold (their counters are signed since 009 and 010). What it found and did goes to the log and to
// edr_repair_runs.
//
// It runs here, on the leader with the other scheduled jobs (jobs/leader.ts: cleanup scan, reports, auto invoicing):
// the switch runs no scheduled maintenance (EDR retention is applied by the release, Sms.Core.Release), and a nightly
// ClickHouse job does not belong on its real-time path.
//
// Rows without a key (written before 010, and the fake data's) are left alone: nothing tells two legitimate rows of
// one EDR id apart from a copy.
import { randomUUID } from "node:crypto";
import { chQuery, chWrite } from "../edr.js";

const DETAIL = ["edr", "edr_receipt"] as const;
type Detail = (typeof DETAIL)[number];

/** Days checked back from today (UTC), and keys handled per table and day in one run (the rest the next night). */
const DEFAULT_DAYS = 3;
const DEFAULT_MAX_KEYS = 10_000;
/** When it runs (UTC): after the night's lowest traffic, before the morning's reports. */
const RUN_AT_UTC = { hour: 3, minute: 17 };
const SLOW_MS = 600_000;

export interface EdrRepairOptions {
  /** How many days back from today (UTC), or the days themselves (YYYY-MM-DD). */
  days?: number | string[];
  maxKeys?: number;
  now?: Date;
}

export interface EdrRepairResult {
  runId: string;
  days: string[];
  /** Keys with more than one row. */
  keysFound: number;
  rowsRemoved: number;
  /** Compensating rows written to the totals. */
  totalsRows: number;
  /** Keys still with more than one row (a part merged during the run): the next run takes them. */
  keysLeft: number;
}

interface Found {
  table: Detail;
  day: string;
  keys: string[];
  /** Rows of those keys. */
  rows: number;
}

const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const list = (xs: string[]) => xs.map(lit).join(", ");
const q = (name: string) => `\`${name.replace(/`/g, "")}\``;

function windowDays(o: EdrRepairOptions): string[] {
  if (Array.isArray(o.days)) return o.days;
  const today = new Date((o.now ?? new Date()).toISOString().slice(0, 10)).getTime();
  return Array.from({ length: o.days ?? DEFAULT_DAYS }, (_, i) =>
    new Date(today - i * 86_400_000).toISOString().slice(0, 10),
  );
}

const ofKeys = (day: string, keys: string[]) => `toDate(start_time) = ${lit(day)} AND row_key IN (${list(keys)})`;
/** The mark on the key of a kept row while its copies are deleted (a NUL at the end: no bus key has one). */
const MARKED = "endsWith(row_key, '\\0')";

/** Keys of one table and day with more than one row: grouped by a 64-bit hash first, so the day's keys are not held. */
async function findCopies(table: Detail, day: string, maxKeys: number): Promise<Found | null> {
  const ofDay = `toDate(start_time) = ${lit(day)} AND row_key != '' AND NOT ${MARKED}`;
  const rows = await chQuery<{ k: string; n: string }>(
    `SELECT row_key AS k, count() AS n FROM ${table}
      WHERE ${ofDay} AND cityHash64(row_key) IN (
            SELECT cityHash64(row_key) AS h FROM ${table} WHERE ${ofDay} GROUP BY h HAVING count() > 1)
      GROUP BY row_key HAVING n > 1 ORDER BY row_key LIMIT ${maxKeys}`,
    SLOW_MS,
  );
  if (!rows.length) return null;
  return { table, day, keys: rows.map((r) => r.k), rows: rows.reduce((n, r) => n + Number(r.n), 0) };
}

/**
 * Leaves one row per key. Copies are identical, so one of each is first written again with its key marked; then every
 * row with the plain key is deleted (lightweight DELETE, wherever merges have put them), and the kept rows get their
 * keys back. A run cut short leaves at worst a kept row still marked (unmark() at the next run) or a key still copied:
 * no row is ever lost. Answers how many extra rows went (the copies beyond one per key).
 */
async function removeCopies(f: Found): Promise<number> {
  const where = ofKeys(f.day, f.keys);
  // Always written (no de-duplication); the views add it to the totals, which reconcile() puts right.
  await chQuery(
    `INSERT INTO ${f.table} SETTINGS insert_deduplicate = 0
     SELECT * REPLACE (concat(row_key, '\\0') AS row_key) FROM (SELECT * FROM ${f.table} WHERE ${where} LIMIT 1 BY row_key)`,
    SLOW_MS,
  );
  await chQuery(`DELETE FROM ${f.table} WHERE ${where} SETTINGS lightweight_deletes_sync = 2`, SLOW_MS);
  // A copy written meanwhile (the writer's lookup would have found the key, so hardly ever) stays for the next run.
  const [left] = await chQuery<{ n: string }>(`SELECT count() AS n FROM ${f.table} WHERE ${where}`, SLOW_MS);
  await unmark(f.table, [f.day]);
  return Math.max(0, f.rows - Number(left?.n ?? 0) - f.keys.length);
}

/** Kept rows whose key is still marked get it back (a mutation, only when there are any). */
async function unmark(table: Detail, days: string[]): Promise<void> {
  const where = `toDate(start_time) IN (${list(days)}) AND ${MARKED}`;
  const [n] = await chQuery<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE ${where}`, SLOW_MS);
  if (!Number(n?.n)) return;
  await chQuery(
    `ALTER TABLE ${table} UPDATE row_key = substring(row_key, 1, length(row_key) - 1) WHERE ${where}
      SETTINGS mutations_sync = 2`,
    SLOW_MS,
  );
}

async function stillCopied(f: Found): Promise<number> {
  const [r] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM (SELECT row_key FROM ${f.table} WHERE ${ofKeys(f.day, f.keys)} GROUP BY row_key HAVING count() > 1)`,
    SLOW_MS,
  );
  return Number(r?.n ?? 0);
}

// ---------------------------------------------------------------- totals

interface View {
  source: Detail;
  /** The view's SELECT (system.tables.as_select), over its source table. */
  select: string;
}

interface Target {
  table: string;
  /** The first sorting key column (the hour, quarter hour or day). */
  time: string;
  columns: { name: string; type: string; key: boolean }[];
  views: View[];
}

const FROM_SOURCE = /\bFROM\s+(?:`?\w+`?\.)?`?(edr|edr_receipt)`?(?:\s+AS\s+`?(\w+)`?)?(?=\s|$)/;

/**
 * The tables the views of `edr` and `edr_receipt` sum into (edr_hourly, edr_totals, edr_sender_daily), found from the
 * views themselves so a view added later is repaired too. A view into a table that does not sum is left out.
 */
async function targets(): Promise<Target[]> {
  const views = await chQuery<{ sel: string; ddl: string }>(
    `SELECT as_select AS sel, create_table_query AS ddl FROM system.tables
      WHERE database = currentDatabase() AND engine = 'MaterializedView'`,
  );
  const byTable = new Map<string, View[]>();
  for (const v of views) {
    const source = FROM_SOURCE.exec(v.sel)?.[1] as Detail | undefined;
    const table = /\bTO\s+(?:`?\w+`?\.)?`?(\w+)`?/.exec(v.ddl)?.[1];
    if (!source || !table) continue;
    byTable.set(table, [...(byTable.get(table) ?? []), { source, select: v.sel }]);
  }
  if (!byTable.size) return [];
  const names = list([...byTable.keys()]);
  const [tables, columns] = await Promise.all([
    chQuery<{ name: string; engine: string; sorting_key: string }>(
      `SELECT name, engine, sorting_key FROM system.tables WHERE database = currentDatabase() AND name IN (${names})`,
    ),
    chQuery<{ table: string; name: string; type: string; key: number }>(
      `SELECT table, name, type, is_in_sorting_key AS key FROM system.columns
        WHERE database = currentDatabase() AND table IN (${names}) ORDER BY table, position`,
    ),
  ]);
  const out: Target[] = [];
  for (const t of tables) {
    const cols = columns.filter((c) => c.table === t.name).map((c) => ({ ...c, key: Number(c.key) === 1 }));
    const sums = cols.filter((c) => !c.key);
    if (!/SummingMergeTree$/.test(t.engine) || !sums.every((c) => /^(U?Int\d+|Decimal|Float)/.test(c.type))) {
      console.warn(`EDR repair: ${t.name} (${t.engine}) is fed by an EDR view but does not sum; not repaired`);
      continue;
    }
    out.push({ table: t.name, time: t.sorting_key.split(",")[0]!.trim(), columns: cols, views: byTable.get(t.name)! });
  }
  return out;
}

/** A view's SELECT over other rows of its source table: `rows`, a SELECT of whole rows. */
const viewOver = (v: View, rows: string) =>
  v.select.replace(FROM_SOURCE, (_m, source: string, alias?: string) => `FROM (${rows}) AS ${alias ?? source}`);

/**
 * Puts the totals of one day right for the groups the given keys' rows fall in: per group, what the detailed rows add
 * up to (each view's own SELECT) less what the table holds, as ClickHouse 009. The same on every run: nothing is
 * written once they match. Answers how many compensating rows were written.
 */
async function reconcile(all: Target[], day: string, keys: Map<Detail, string[]>): Promise<number> {
  const oneEach = (s: Detail) => `SELECT * FROM ${s} WHERE ${ofKeys(day, keys.get(s)!)} LIMIT 1 BY row_key`;
  // Only the customer trunks of those rows: the detailed rows read are those trunks' of the day.
  const trunks = (
    await chQuery<{ t: number }>(
      `SELECT DISTINCT c_trunk_id AS t FROM (${[...keys.keys()]
        .map((s) => `SELECT c_trunk_id FROM (${oneEach(s)})`)
        .join(" UNION ALL ")})`,
      SLOW_MS,
    )
  ).map((r) => Number(r.t));
  if (!trunks.length) return 0;
  let written = 0;
  for (const t of all) {
    const fromKeys = t.views.filter((v) => keys.has(v.source));
    if (!fromKeys.length) continue;
    const dims = t.columns.filter((c) => c.key);
    const sums = t.columns.filter((c) => !c.key);
    const cast = (c: { name: string; type: string }) => `CAST(${q(c.name)} AS ${c.type}) AS ${q(c.name)}`;
    const dimList = dims.map((c) => q(c.name)).join(", ");
    const byTrunk = t.columns.some((c) => c.name === "c_trunk_id") ? ` AND c_trunk_id IN (${trunks.join(", ")})` : "";
    const groups = fromKeys
      .map((v) => `SELECT ${dims.map(cast).join(", ")} FROM (${viewOver(v, oneEach(v.source))})`)
      .join(" UNION ALL ");
    const detail = t.views.map(
      (v) =>
        `SELECT ${t.columns.map(cast).join(", ")} FROM (${viewOver(
          v,
          `SELECT * FROM ${v.source} WHERE toDate(start_time) = ${lit(day)}${byTrunk}`,
        )})`,
    );
    const held = `SELECT ${dims.map(cast).join(", ")}, ${sums
      .map((c) => `CAST(-${q(c.name)} AS ${c.type}) AS ${q(c.name)}`)
      .join(", ")} FROM ${t.table} WHERE toDate(${q(t.time)}) = ${lit(day)}${byTrunk}`;
    written += await chWrite(
      `INSERT INTO ${t.table} (${t.columns.map((c) => q(c.name)).join(", ")})
       SELECT ${dimList}, ${sums.map((c) => `sum(${q(c.name)}) AS ${q(c.name)}`).join(", ")}
         FROM (${[...detail, held].join(" UNION ALL ")})
        WHERE (${dimList}) IN (${groups})
        GROUP BY ${dimList}
       HAVING ${sums.map((c) => `${q(c.name)} != 0`).join(" OR ")}`,
      SLOW_MS,
    );
  }
  return written;
}

// ---------------------------------------------------------------- run

interface RunRow {
  status: "started" | "done" | "failed";
  table_name?: string;
  day: string;
  row_keys?: string[];
  keys_found?: number;
  rows_removed?: number;
  totals_rows?: number;
  keys_left?: number;
  message?: string;
}

async function record(runId: string, rows: RunRow[]): Promise<void> {
  const at = new Date().toISOString().replace("T", " ").replace("Z", "");
  const body = rows
    .map((r) => JSON.stringify({ run_id: runId, run_at: at, table_name: "", row_keys: [], message: "", ...r }))
    .join("\n");
  await chQuery(`INSERT INTO edr_repair_runs FORMAT JSONEachRow\n${body}`);
}

/** Keys found in these days by every run so far (this one too): their totals are put right again, which costs nothing
 *  once right and repairs a run cut short between removing rows and writing the totals. */
async function recordedKeys(days: string[]): Promise<Map<string, Map<Detail, string[]>>> {
  const rows = await chQuery<{ t: Detail; d: string; keys: string[] }>(
    `SELECT table_name AS t, toString(day) AS d, groupUniqArrayArray(row_keys) AS keys FROM edr_repair_runs
      WHERE status = 'started' AND day IN (${list(days)}) AND table_name IN (${list([...DETAIL])})
      GROUP BY t, d`,
  );
  const out = new Map<string, Map<Detail, string[]>>();
  for (const r of rows) {
    const day = out.get(r.d) ?? new Map<Detail, string[]>();
    day.set(r.t, r.keys);
    out.set(r.d, day);
  }
  return out;
}

/** One run: find, remove, compensate, check, record. */
export async function repairEdrDuplicates(o: EdrRepairOptions = {}): Promise<EdrRepairResult> {
  const runId = randomUUID();
  const days = windowDays(o);
  const result: EdrRepairResult = { runId, days, keysFound: 0, rowsRemoved: 0, totalsRows: 0, keysLeft: 0 };
  try {
    // Kept rows a run cut short left marked.
    for (const table of DETAIL) await unmark(table, days);
    const found: Found[] = [];
    for (const day of days)
      for (const table of DETAIL) {
        const f = await findCopies(table, day, o.maxKeys ?? DEFAULT_MAX_KEYS);
        if (f) found.push(f);
      }
    result.keysFound = found.reduce((n, f) => n + f.keys.length, 0);
    // Recorded before anything changes, so a run cut short is finished by the next.
    if (found.length)
      await record(
        runId,
        found.map((f) => ({
          status: "started",
          table_name: f.table,
          day: f.day,
          row_keys: f.keys,
          keys_found: f.keys.length,
        })),
      );
    for (const f of found) result.rowsRemoved += await removeCopies(f);
    const scopes = await recordedKeys(days);
    if (scopes.size) {
      const all = await targets();
      for (const [day, keys] of scopes) result.totalsRows += await reconcile(all, day, keys);
    }
    for (const f of found) result.keysLeft += await stillCopied(f);
    await record(runId, [
      {
        status: "done",
        day: days[0]!,
        keys_found: result.keysFound,
        rows_removed: result.rowsRemoved,
        totals_rows: result.totalsRows,
        keys_left: result.keysLeft,
        message: `days ${days.join(", ")}`,
      },
    ]);
  } catch (err) {
    const message = (err as Error).message;
    await record(runId, [{ status: "failed", day: days[0]!, message: message.slice(0, 2000) }]).catch(() => undefined);
    throw err;
  }
  console.log(
    `EDR repair (${days.join(", ")}): ${result.keysFound} keys stored more than once, ${result.rowsRemoved} rows ` +
      `removed, ${result.totalsRows} compensating totals rows, ${result.keysLeft} keys left for the next run`,
  );
  return result;
}

/** Milliseconds until the next RUN_AT_UTC. */
export function untilNextRun(now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(RUN_AT_UTC.hour, RUN_AT_UTC.minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Every night at RUN_AT_UTC on the leader (index.ts). */
export function startEdrRepair(): () => void {
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    timer = setTimeout(() => {
      void repairEdrDuplicates()
        .catch((err: Error) => console.warn(`EDR repair: ${err.message}`))
        .finally(schedule);
    }, untilNextRun());
    timer.unref();
  };
  schedule();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
