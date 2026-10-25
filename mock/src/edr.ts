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

export async function chRows<T>(sql: string, timeoutMs = 1500): Promise<T[] | null> {
  try {
    const res = await fetch(`${CH_URL}/?database=${CH_DB}&default_format=JSON`, {
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

/** Like chRows, but throws (with ClickHouse's message) instead of answering null; for screens that list EDRs. */
export async function chQuery<T>(sql: string, timeoutMs = 30_000): Promise<T[]> {
  let res: Response;
  try {
    res = await fetch(`${CH_URL}/?database=${CH_DB}&default_format=JSON`, {
      method: "POST",
      headers: { authorization: AUTH },
      body: sql,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ChUnavailable(String((err as Error).message ?? err));
  }
  if (!res.ok) {
    // Errors come as JSON ({"exception": "..."}) when a format is set, else as plain text.
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { exception?: string }).exception ?? text;
    } catch {
      /* plain text */
    }
    throw new ChError(message.trim());
  }
  // INSERT and ALTER answer with an empty body.
  const text = await res.text();
  return text ? (JSON.parse(text) as { data: T[] }).data : [];
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
      `SELECT ${col} AS id, count() AS n, sum(revenue_sys * ${factor}) AS rev, sum(cost_sys * ${factor}) AS cost
         FROM edr WHERE submit_time >= ${PLATFORM_DAY_START_SQL} GROUP BY id`,
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
