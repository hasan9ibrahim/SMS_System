// Read access to the EDR store (ClickHouse) for figures that come from traffic, such as
// today's revenue and margin per rate table (§13.12). Optional: when ClickHouse does not
// answer, callers get null and screens show "—" instead of failing.
import { sysToPlatformFactor } from "./currency.js";

const env = process.env;
const CH_URL = `http://${env.CLICKHOUSE_HOST ?? "localhost"}:${env.CLICKHOUSE_HTTP_PORT ?? 8123}`;
const CH_DB = env.CLICKHOUSE_DB ?? "sms_edr";
const AUTH = `Basic ${Buffer.from(`${env.CLICKHOUSE_USER ?? "sms_dev"}:${env.CLICKHOUSE_PASSWORD ?? "sms_dev_password"}`).toString("base64")}`;

export async function chRows<T>(sql: string): Promise<T[] | null> {
  try {
    const res = await fetch(`${CH_URL}/?database=${CH_DB}&default_format=JSON`, {
      method: "POST",
      headers: { authorization: AUTH },
      body: sql,
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { data: T[] }).data;
  } catch {
    return null;
  }
}

/** Revenue and cost are in the platform currency (converted per business company). */
export interface TrafficToday {
  messages: number;
  revenueSys: number;
  costSys: number;
}

let cache: { at: number; customer: Map<number, TrafficToday>; vendor: Map<number, TrafficToday> } | null = null;

/**
 * Today's traffic (UTC day) per customer rate table (priced by) and vendor rate table
 * (costed by), cached for a minute. Null when the EDR store is unavailable.
 */
export async function trafficTodayByRateTable() {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const factor = await sysToPlatformFactor();
  const q = (col: string) =>
    chRows<{ id: number; n: string; rev: string; cost: string }>(
      `SELECT ${col} AS id, count() AS n, sum(revenue_sys * ${factor}) AS rev, sum(cost_sys * ${factor}) AS cost
         FROM edr WHERE submit_time >= toStartOfDay(now('UTC')) GROUP BY id`,
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
