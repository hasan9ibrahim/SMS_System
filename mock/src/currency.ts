// Platform currency (decided 2026-10-16: EUR by default, configurable with PLATFORM_CURRENCY).
// Converted rates, margins, revenue conditions and every cross-company total use it. Rates
// are stored per USD (currency_rates), so a conversion is amount / from_per_usd * platform_per_usd.
import { db } from "./db.js";

const env = (process.env.PLATFORM_CURRENCY ?? "EUR").toUpperCase();
export const PLATFORM_CURRENCY = /^[A-Z]{3}$/.test(env) ? env : "EUR";

/** SQL: units of the platform currency per 1 USD, at the latest exchange rate. */
export const PLATFORM_PER_USD = `(SELECT pc.rate_per_usd FROM currency_latest pc WHERE pc.iso = '${PLATFORM_CURRENCY}')`;

/** SQL: `amount` in currency `iso` (a currency_latest row aliased `cl`) converted to the platform currency. */
export const toPlatformSql = (amount: string, perUsd = "cl.rate_per_usd") =>
  `(${amount} / ${perUsd} * ${PLATFORM_PER_USD})`;

let factors: { at: number; sql: string } | null = null;

/**
 * ClickHouse expression turning an EDR `*_sys` amount (each business company's base currency,
 * §9.1) into the platform currency, by business_company_id. Cached for five minutes.
 */
export async function sysToPlatformFactor(): Promise<string> {
  if (factors && Date.now() - factors.at < 5 * 60_000) return factors.sql;
  const { rows } = await db().query(
    `SELECT bc.id, ${PLATFORM_PER_USD} / cl.rate_per_usd AS f
       FROM business_companies bc JOIN currency_latest cl ON cl.iso = bc.base_currency`,
  );
  const ids = rows.map((r) => Number(r.id));
  const fs = rows.map((r) => Number(r.f).toFixed(8));
  const sql = ids.length ? `transform(business_company_id, [${ids.join(",")}], [${fs.join(",")}], 1.0)` : "1.0";
  factors = { at: Date.now(), sql };
  return sql;
}
