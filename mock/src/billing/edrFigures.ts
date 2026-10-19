// Billing figures from the EDR store (§7, §13.31): usage per enterprise and side for a period cut
// at midnight in a time zone, converted to the document's currency. Shared by invoices (customer
// side) and vendor invoice reconciliation (vendor side).
import type pg from "pg";
import { chRows } from "../edr.js";

type Db = pg.Pool | pg.PoolClient;
export type Side = "customer" | "vendor";

const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
import { nextDay, zonedMidnight } from "./zone.js";

export { nextDay, zonedMidnight };

let coverageCache: { at: number; from: Date | null; to: Date | null } | null = null;

/** First and last EDR in the store (cached a minute); null when ClickHouse does not answer. */
export async function edrCoverage(): Promise<{ from: Date | null; to: Date | null } | null> {
  if (coverageCache && Date.now() - coverageCache.at < 60_000) return coverageCache;
  const rows = await chRows<{ f: string; t: string; n: string }>(
    "SELECT min(submit_time) AS f, max(submit_time) AS t, count() AS n FROM edr",
    10_000,
  );
  if (!rows) return null;
  const r = rows[0]!;
  const empty = Number(r.n) === 0;
  coverageCache = {
    at: Date.now(),
    from: empty ? null : new Date(`${r.f.replace(" ", "T")}Z`),
    to: empty ? null : new Date(`${r.t.replace(" ", "T")}Z`),
  };
  return coverageCache;
}

/** Whether the store holds the whole period [from, to] (inclusive days in `tz`). */
export function coverageOf(
  cov: { from: Date | null; to: Date | null },
  from: string,
  to: string,
  tz: string,
): "full" | "partial" | "none" {
  if (!cov.from || !cov.to) return "none";
  const start = zonedMidnight(from, tz).getTime();
  const end = zonedMidnight(nextDay(to), tz).getTime();
  if (end <= cov.from.getTime() || start > cov.to.getTime()) return "none";
  return start >= cov.from.getTime() && end <= cov.to.getTime() + 1000 ? "full" : "partial";
}

export interface UsageLine {
  mccmnc: string;
  rate: number | null;
  messages: number;
  amount: number;
}

/** Units of `iso` per USD at the latest rate, for each currency asked. */
async function ratesPerUsd(db: Db, isos: string[]): Promise<Map<string, number>> {
  const { rows } = await db.query("SELECT iso, rate_per_usd FROM currency_latest WHERE iso = ANY($1)", [isos]);
  const m = new Map(rows.map((r) => [String(r.iso).trim(), Number(r.rate_per_usd)]));
  m.set("USD", 1);
  return m;
}

/**
 * Billable messages and charges of one enterprise and side, per destination (and rate, with
 * `byRate`), for days [from, to] in `tz`, in `currency` (other trunk currencies converted at the
 * latest rate). Null when the EDR store does not answer.
 */
export async function usageLines(
  db: Db,
  side: Side,
  enterpriseId: number,
  from: string,
  to: string,
  tz: string,
  currency: string,
  byRate: boolean,
): Promise<UsageLine[] | null> {
  const s = side === "customer" ? "c" : "v";
  const billable = side === "customer" ? "is_customer_billable" : "is_vendor_billable";
  const money = side === "customer" ? "revenue" : "cost";
  const mccmnc = side === "customer" ? "c_mccmnc" : "if(v_mccmnc = '', c_mccmnc, v_mccmnc)";
  const rows = await chRows<{ mccmnc: string; rate: number; cur: string; msgs: string; amount: number }>(
    `SELECT ${mccmnc} AS mccmnc, ${byRate ? `toFloat64(${s}_rate)` : "0"} AS rate, ${s}_currency AS cur,
            sum(msg_count * ${billable}) AS msgs, toFloat64(sum(${money})) AS amount
       FROM edr
      WHERE ${s}_enterprise_id = ${Number(enterpriseId)}
        AND submit_time >= toDateTime64(${lit(`${from} 00:00:00`)}, 3, ${lit(tz)})
        AND submit_time < toDateTime64(${lit(`${nextDay(to)} 00:00:00`)}, 3, ${lit(tz)})
      GROUP BY mccmnc, rate, cur
      HAVING msgs > 0 OR amount <> 0`,
    30_000,
  );
  if (!rows) return null;
  const rates = await ratesPerUsd(db, [currency, ...new Set(rows.map((r) => r.cur))]);
  const target = rates.get(currency) ?? 1;
  const out = new Map<string, UsageLine>();
  for (const r of rows) {
    const factor = r.cur === currency ? 1 : target / (rates.get(r.cur) ?? target);
    const key = `${r.mccmnc}:${byRate ? r.rate : ""}`;
    const line = out.get(key) ?? { mccmnc: r.mccmnc, rate: byRate ? r.rate : null, messages: 0, amount: 0 };
    line.messages += Number(r.msgs);
    line.amount += r.amount * factor;
    out.set(key, line);
  }
  return [...out.values()].sort((a, b) => b.amount - a.amount);
}

export const sumLines = (lines: UsageLine[]) => ({
  messages: lines.reduce((t, l) => t + l.messages, 0),
  amount: Math.round(lines.reduce((t, l) => t + l.amount, 0) * 100) / 100,
});

/** Country and network names for MCCMNC codes. */
export async function destinationNames(
  db: Db,
  codes: string[],
): Promise<Map<string, { country: string | null; network: string | null }>> {
  if (!codes.length) return new Map();
  const { rows } = await db.query(
    `SELECT m.mccmnc, c.name AS country, m.network FROM mccmnc m LEFT JOIN countries c ON c.id = m.country_id
      WHERE m.mccmnc = ANY($1) AND m.deleted_at IS NULL`,
    [codes],
  );
  return new Map(
    rows.map((r) => [
      r.mccmnc as string,
      { country: (r.country as string) ?? null, network: (r.network as string) ?? null },
    ]),
  );
}

export const fmtDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");
