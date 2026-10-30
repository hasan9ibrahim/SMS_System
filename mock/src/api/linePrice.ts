// The rate line that prices one message, picked as the switch picks it (`Sms.Switch.Pipeline.Config.sell_price/4` and
// `vendor_price/4`, §5.4, §6.2): Sender ID lines first, the network before its country's All networks line; for a
// customer, the first of the trunk's rate tables (by position) with a line. The first line in force decides, and a
// blocked one means no rate: blocked means blocked, no fallback to the country line or a later table (decided
// 2026-10-30). A customer's Sender ID lines match the sender it sent; a vendor's the sender it receives after its
// egress translation (decided 2026-10-30). A line in a currency without an exchange rate cannot price, so the next
// line is tried, as in the switch.
import type pg from "pg";
import { toPlatformSql } from "../currency.js";

type Db = pg.Pool | pg.PoolClient;

export interface LinePrice {
  rate: number;
  currency: string;
  /** In the platform currency, 6 decimals. */
  platformRate: number;
  rateTableId: number;
  rateTable: string;
}

/** The line's price, `"blocked"`, or null when no line is in force. */
export type Price = LinePrice | "blocked" | null;

const codesOf = (mccmnc: string) => [mccmnc, mccmnc.slice(0, 3)];

const COLS = `l.rate, l.currency, l.is_blocked, rt.id AS rate_table_id, rt.name AS rate_table,
  ${toPlatformSql("l.rate")} AS conv`;

const IN_FORCE = `l.mccmnc = ANY($2) AND (l.sender_id IS NULL OR l.sender_id = $3)
  AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
  AND (l.is_blocked OR cl.iso IS NOT NULL)`;

function toPrice(row: Record<string, unknown> | undefined): Price {
  if (!row) return null;
  if (row.is_blocked) return "blocked";
  return {
    rate: Number(row.rate),
    currency: String(row.currency).trim(),
    platformRate: Math.round(Number(row.conv) * 1e6) / 1e6,
    rateTableId: Number(row.rate_table_id),
    rateTable: String(row.rate_table),
  };
}

/** The customer trunk's price for a destination; `sender` as the customer sent it. */
export async function customerPrice(
  db: Db,
  customerTrunkId: number,
  mccmnc: string,
  sender: string | null,
): Promise<Price> {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM customer_trunk_rate_tables x
       JOIN rate_tables rt ON rt.id = x.rate_table_id
       JOIN rate_lines l ON l.rate_table_id = x.rate_table_id
       LEFT JOIN currency_latest cl ON cl.iso = l.currency
      WHERE x.customer_trunk_id = $1 AND ${IN_FORCE}
      ORDER BY x.position, (l.sender_id IS NOT NULL) DESC, length(l.mccmnc) DESC LIMIT 1`,
    [customerTrunkId, codesOf(mccmnc), sender || null],
  );
  return toPrice(rows[0]);
}

/** The vendor trunk's price for a destination; `sender` as the vendor receives it, after its egress translation. */
export async function vendorPrice(
  db: Db,
  vendorTrunkId: number,
  mccmnc: string,
  sender: string | null,
): Promise<Price> {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM rate_tables rt
       JOIN rate_lines l ON l.rate_table_id = rt.id
       LEFT JOIN currency_latest cl ON cl.iso = l.currency
      WHERE rt.vendor_trunk_id = $1 AND rt.deleted_at IS NULL AND ${IN_FORCE}
      ORDER BY (l.sender_id IS NOT NULL) DESC, length(l.mccmnc) DESC, rt.id LIMIT 1`,
    [vendorTrunkId, codesOf(mccmnc), sender || null],
  );
  return toPrice(rows[0]);
}

export const priced = (p: Price): LinePrice | null => (p === null || p === "blocked" ? null : p);
