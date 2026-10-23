// Number formats for rates and money (§15.3: tabular numbers in grids).
import { displayTz, isoToZoned, zoneAbbr } from "../../ui/zonedCore";
const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", INR: "₹", AED: "AED " };

/** Rates keep 4 decimals, more when the value needs them (up to 6). */
export function formatRate(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const s = v.toFixed(6).replace(/0{1,2}$/, "");
  return s.length - s.indexOf(".") - 1 < 4 ? v.toFixed(4) : s;
}

export function formatSigned(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${formatRate(Math.abs(v))}`;
}

export function formatPct(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined) return "—";
  return `${signed && v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function formatMoney(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "—";
  const sym = SYMBOL[currency] ?? `${currency} `;
  return `${sym}${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
}

// Rate dates show in the platform time zone (team trial round 2), 24-hour.
export const shortDate = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: displayTz(),
      })
    : "—";

export const shortDateTime = (s: string | null | undefined) =>
  s ? `${isoToZoned(s, displayTz()).replace("T", " ")} ${displayTz() === "UTC" ? "UTC" : zoneAbbr(s)}` : "—";

/** "starts in 3 days", "starts today", "started 5 days ago" (market moves, incoming RNs; team trial round 5). */
export function relDays(at: string, now = Date.now()): string {
  const d = Math.round(
    (Date.parse(at.slice(0, 10)) - Date.parse(new Date(now).toISOString().slice(0, 10))) / 86_400_000,
  );
  if (d === 0) return "starts today";
  return d > 0 ? `starts in ${d} day${d === 1 ? "" : "s"}` : `started ${-d} day${d === -1 ? "" : "s"} ago`;
}
