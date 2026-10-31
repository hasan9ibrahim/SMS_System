// Read access to the EDR store (ClickHouse) for figures that come from traffic, such as
// today's revenue and margin per rate table (§13.12). Optional: when ClickHouse does not
// answer, callers get null and screens show "—" instead of failing.
import { production } from "./mode.js";
import { sysToPlatformFactor } from "./currency.js";
import { PLATFORM_DAY_START_SQL } from "./platform.js";

const env = process.env;
const CH_URL = `http://${env.CLICKHOUSE_HOST ?? "localhost"}:${env.CLICKHOUSE_HTTP_PORT ?? 8123}`;
const CH_DB = env.CLICKHOUSE_DB ?? "sms_edr";
const AUTH = `Basic ${Buffer.from(`${env.CLICKHOUSE_USER ?? "sms_dev"}:${env.CLICKHOUSE_PASSWORD ?? "sms_dev_password"}`).toString("base64")}`;

/**
 * SQL for "now" in EDR windows: the clock in production (backend step 11); on the fake data its latest EDR, so the
 * screens show traffic after the seed's last day.
 */
export const edrNowSql = () => (production ? "now64(3)" : "(SELECT max(submit_time) FROM edr)");

/**
 * URL settings of a read a screen waits for (QA 2026-10-31): ClickHouse stops it at the caller's timeout, and when the
 * caller gives up first (an aborted request otherwise kept running to its end).
 */
const readSettings = (timeoutMs: number) =>
  `&max_execution_time=${Math.max(1, Math.ceil(timeoutMs / 1000))}&cancel_http_readonly_queries_on_client_close=1`;

export async function chRows<T>(sql: string, timeoutMs = 1500): Promise<T[] | null> {
  try {
    const res = await fetch(`${CH_URL}/?database=${CH_DB}&default_format=JSON${readSettings(timeoutMs)}`, {
      method: "POST",
      headers: { authorization: AUTH },
      body: sql,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { data: T[] }).data;
  } catch {
    return null;
  }
}

/**
 * Like chRows, but throws (with ClickHouse's message) instead of answering null; for screens that list EDRs. `read`:
 * a screen's read, stopped by ClickHouse at the timeout too (readSettings); a timeout either way is a ChTimeout.
 */
/**
 * Every statement sends this (ClickHouse 010, S-7.3): an EDR insert ClickHouse drops as an identical block is dropped
 * by the views too, so the hourly figures and long-term totals never count a row the EDR tables do not hold.
 */
const WRITE_SETTINGS = "&deduplicate_blocks_in_dependent_materialized_views=1";

/**
 * One row per bus key (ClickHouse 010, S-7.3), for reads that list single EDR rows: a row the switch wrote twice shows
 * once until the nightly repair (jobs/edrRepair.ts) removes the copy. Rows without a key (written before 010, and the
 * fake data's) are all kept. `t`: the table's alias in the query, if it needs one.
 */
export function onePerRowKey(t = ""): string {
  const c = (col: string) => (t ? `${t}.${col}` : col);
  return `LIMIT 1 BY ${c("row_key")}, if(${c("row_key")} = '', ${c("_part")}, ''), if(${c("row_key")} = '', ${c("_part_offset")}, 0)`;
}

export async function chQuery<T>(sql: string, timeoutMs = 30_000, opts: { read?: boolean } = {}): Promise<T[]> {
  let res: Response;
  let text: string;
  try {
    const url = `${CH_URL}/?database=${CH_DB}&default_format=JSON${opts.read ? readSettings(timeoutMs) : WRITE_SETTINGS}`;
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: AUTH },
      body: sql,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The answer can still be on its way when the time is up (the headers come first).
    text = await res.text();
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new ChTimeout(`no answer within ${timeoutMs / 1000} s`);
    throw new ChUnavailable(String((err as Error).message ?? err));
  }
  if (!res.ok) {
    // Errors come as JSON ({"exception": "..."}) when a format is set, else as plain text.
    let message = text;
    try {
      message = (JSON.parse(text) as { exception?: string }).exception ?? text;
    } catch {
      /* plain text */
    }
    // Past max_execution_time, or estimated to go past it.
    if (/\b(TIMEOUT_EXCEEDED|TOO_SLOW)\b/.test(message)) throw new ChTimeout(message.trim());
    throw new ChError(message.trim());
  }
  // INSERT and ALTER answer with an empty body.
  return text ? (JSON.parse(text) as { data: T[] }).data : [];
}

/** Runs a statement (an INSERT … SELECT) to its end and answers how many rows it wrote (ClickHouse's summary). */
export async function chWrite(sql: string, timeoutMs = 120_000): Promise<number> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${CH_URL}/?database=${CH_DB}&wait_end_of_query=1${WRITE_SETTINGS}`, {
      method: "POST",
      headers: { authorization: AUTH },
      body: sql,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new ChTimeout(`no answer within ${timeoutMs / 1000} s`);
    throw new ChUnavailable(String((err as Error).message ?? err));
  }
  if (!res.ok) throw new ChError(text.trim());
  const summary = JSON.parse(res.headers.get("x-clickhouse-summary") ?? "{}") as { written_rows?: string };
  return Number(summary.written_rows ?? 0);
}

/** Streams a query's output (e.g. FORMAT CSVWithNames) for exports. */
export async function chStream(sql: string, timeoutMs = 600_000): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${CH_URL}/?database=${CH_DB}`, {
    method: "POST",
    headers: { authorization: AUTH },
    body: sql,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) throw new ChError(await res.text());
  return res.body;
}

export class ChUnavailable extends Error {}
/** The EDR store did not finish in time: answered 503 like ChUnavailable, with advice to narrow the query. */
export class ChTimeout extends ChUnavailable {}
export class ChError extends Error {}

/** Revenue and cost are in the platform currency (converted per business company). */
export interface TrafficToday {
  messages: number;
  revenueSys: number;
  costSys: number;
}

let cache: { at: number; customer: Map<number, TrafficToday>; vendor: Map<number, TrafficToday> } | null = null;

/**
 * Today's traffic (day in the platform time zone) per customer rate table (priced by) and vendor rate table
 * (costed by), cached for a minute. Null when the EDR store is unavailable.
 */
export async function trafficTodayByRateTable() {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const factor = await sysToPlatformFactor();
  const q = (col: string) =>
    chRows<{ id: number; n: string; rev: string; cost: string }>(
      `SELECT ${col} AS id, countIf(kind = 'attempt') AS n, sum(revenue_sys * ${factor}) AS rev, sum(cost_sys * ${factor}) AS cost
         FROM edr_all WHERE submit_time >= ${PLATFORM_DAY_START_SQL} GROUP BY id`,
    );
  const [c, v] = await Promise.all([q("c_rate_table_id"), q("v_rate_table_id")]);
  if (!c || !v) return null;
  const toMap = (rows: { id: number; n: string; rev: string; cost: string }[]) =>
    new Map(
      rows.map((r) => [Number(r.id), { messages: Number(r.n), revenueSys: Number(r.rev), costSys: Number(r.cost) }]),
    );
  cache = { at: Date.now(), customer: toMap(c), vendor: toMap(v) };
  return cache;
}

/** Margin % of a day's traffic, weighted by volume (revenue − cost over revenue). */
export const marginPct = (t: TrafficToday | undefined) =>
  t && t.revenueSys > 0 ? Math.round(((t.revenueSys - t.costSys) / t.revenueSys) * 1000) / 10 : null;
