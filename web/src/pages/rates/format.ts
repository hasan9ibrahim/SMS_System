// Number formats for rates and money (§15.3: tabular numbers in grids).
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

export const shortDate = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    : "—";

export const shortDateTime = (s: string | null | undefined) => (s ? `${s.slice(0, 16).replace("T", " ")} UTC` : "—");
