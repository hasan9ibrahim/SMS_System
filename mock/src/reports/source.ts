// Which EDR table a report reads (product owner 2026-10-27, docs/BACKEND_PLAN.md §3.7): detailed EDRs are kept
// EDR_DETAIL_MONTHS (12) months, the totals of ClickHouse 008 forever. A period that starts within the detailed months
// reads edr_all as before; an older one reads edr_totals (15 minutes) or, for Sender IDs, edr_sender_daily (UTC
// days). Both use edr_all's column names, so a report's SQL changes only where it counts rows: count() over edr_all is
// sum(rows) over the totals (`counter`).

export type EdrSource = "edr_all" | "edr_totals" | "edr_sender_daily";

const MONTHS = Number(process.env.EDR_DETAIL_MONTHS ?? 12);
let forced: Date | null = null;

/** Tests: the first moment the detailed EDRs cover (null: back to the clock). */
export function setDetailHorizonForTests(at: Date | null): void {
  forced = at;
}

/** The oldest moment the detailed EDRs are sure to hold: EDR_DETAIL_MONTHS before now. */
export function detailHorizon(now = Date.now()): Date {
  if (forced) return forced;
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - MONTHS);
  return d;
}

/** A query the totals cannot answer; shown to the user as a 400 with this text. */
export class PastDetailError extends Error {}

export const DETAIL_MONTHS = MONTHS;
export const pastDetail = (what: string) =>
  new PastDetailError(`${what} is kept for the last ${MONTHS} months only; older periods have totals per 15 minutes`);

/** True when a period starting at `from` needs the totals. */
export const beforeDetail = (from: Date) => from.getTime() < detailHorizon().getTime();

/** count() / countIf(cond) on the source. */
export const counter = (src: EdrSource) => (cond?: string) =>
  src === "edr_all" ? (cond ? `countIf(${cond})` : "count()") : cond ? `sumIf(rows, ${cond})` : "sum(rows)";

/**
 * The totals hold quarter hours: a bound inside one cannot be answered, unless it is at or after `now` (the period
 * ends now and its last quarter holds nothing later).
 */
export function checkQuarterBounds(now: number, ...bounds: Date[]): void {
  if (bounds.some((d) => d.getTime() % 900_000 !== 0 && d.getTime() < now))
    throw new PastDetailError(
      `Times inside a quarter hour are kept for the last ${MONTHS} months only; pick bounds on :00, :15, :30 or :45`,
    );
}

/** edr_all, or the 15-minute totals when a window starts before the detailed EDRs (its bounds checked). */
export function periodSource(now: number, ...windows: { from: Date; to: Date }[]): "edr_all" | "edr_totals" {
  if (!windows.some((w) => beforeDetail(w.from))) return "edr_all";
  for (const w of windows) checkQuarterBounds(now, w.from, w.to);
  return "edr_totals";
}

/** Money in exact decimals for multiplying by a rate or factor: sums then agree on edr_all and on the totals. */
export const dec = (col: string) => `toDecimal128(${col}, 6)`;
/**
 * A platform-currency factor (sysToPlatformFactor) as a decimal. Materialised: with no business company yet (a new
 * server) the factor is the constant 1.0, and ClickHouse 24.8 rejects sum(decimal column × constant decimal)
 * ("Unexpected literal type in function"), which failed every EDR report until a company existed (R9).
 */
export const decFactor = (factor: string) => `materialize(toDecimal128(${factor}, 8))`;
/** The row's revenue below its cost: per row on edr_all, kept as neg_margin in the totals. */
export const negMargin = (src: EdrSource) => (src === "edr_all" ? "revenue_sys < cost_sys" : "neg_margin = 1");
