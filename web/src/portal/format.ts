// Number and period formatting for the customer portal (§1).
export const fmtCount = (n: number) => n.toLocaleString("en-US");
/** Money: 4 decimals, as invoices round (team trial round 5). */
export const fmtAmount = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
/** Rates per message: 6 decimals. */
export const fmtRate = (n: number) => n.toFixed(6);
export const fmtPct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)} %`);

export type Period = "today" | "yesterday" | "7d" | "30d";

/** The period as UTC instants [from, to] for a datetime "between" filter. */
export function periodRange(p: Period, now = new Date()): [string, string] {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const D = 86_400_000;
  const [from, to] =
    p === "today"
      ? [day, day + D]
      : p === "yesterday"
        ? [day - D, day]
        : p === "7d"
          ? [day - 6 * D, day + D]
          : [day - 29 * D, day + D];
  return [new Date(from).toISOString(), new Date(to - 1).toISOString()];
}
