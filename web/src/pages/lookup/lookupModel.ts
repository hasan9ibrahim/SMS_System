// Rate Lookup helpers (§13.16): pasted or uploaded destinations, the lookup in the tab URL,
// number formats and table copies (CSV / TSV of rows already on screen).
import type { RateLookupQuery } from "@sms/contract";

/** Pasted text or an uploaded file: 3–6 digits are MCCMNCs, 7–15 digits phone numbers. */
export function parseDestinations(text: string): { mccmncs: string[]; numbers: string[]; invalid: string[] } {
  const mccmncs = new Set<string>();
  const numbers = new Set<string>();
  const invalid: string[] = [];
  // Lines, commas, semicolons and tabs separate entries; spaces too, unless the entry reads
  // as one phone number written with spaces ("+61 412 345 678").
  const tokens = text.split(/[\r\n,;|\t]+/).flatMap((piece) => {
    const joined = piece.replace(/[\s\-().]/g, "");
    return /^\+[0-9]{6,15}$/.test(joined) ||
      (/\s/.test(piece.trim()) && /^[0-9]{7,15}$/.test(joined) && /[\-()]/.test(piece))
      ? [joined]
      : piece.split(/\s+/);
  });
  for (const raw of tokens) {
    const token = raw.trim().replace(/^["']|["']$/g, "");
    if (!token) continue;
    const digits = token.replace(/[\-().]/g, "").replace(/^\+/, "");
    if (/^[0-9]{3,6}$/.test(digits) && !token.startsWith("+")) mccmncs.add(digits);
    else if (/^[0-9]{6,15}$/.test(digits)) numbers.add(digits);
    else invalid.push(token);
  }
  return { mccmncs: [...mccmncs], numbers: [...numbers], invalid };
}

/** Advanced lookups live in the tab URL (?q=…) so they survive tab moves and reloads. */
export function encodeQuery(q: RateLookupQuery): string {
  const json = JSON.stringify(q);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeQuery(s: string | null): RateLookupQuery | null {
  if (!s) return null;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const q = JSON.parse(json) as RateLookupQuery;
    return q && typeof q === "object" && typeof q.view === "string" ? q : null;
  } catch {
    return null;
  }
}

/** Number of filters set in a lookup, for the "Filters (n)" button. */
export function filterCount(q: RateLookupQuery): number {
  const lists: (keyof RateLookupQuery)[] = [
    "accountManagerIds",
    "customerEnterpriseIds",
    "customerTrunkIds",
    "rateTableIds",
    "vendorEnterpriseIds",
    "vendorTrunkIds",
    "tiers",
    "categoryIds",
    "businessCompanyIds",
    "currencies",
  ];
  return lists.filter((k) => ((q[k] as unknown[] | undefined) ?? []).length > 0).length + (q.senderId ? 1 : 0);
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** A rate: up to 6 decimals, at least 4 (§13.12 rate format). */
export function rate(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const s = v.toFixed(6).replace(/0{1,2}$/, "");
  return s.length - s.indexOf(".") - 1 < 4 ? v.toFixed(4) : s;
}

export function money(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "—";
  return `${SYMBOL[currency] ?? `${currency} `}${rate(v)}`;
}

/** A signed margin with a real minus sign. */
export function signed(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${rate(Math.abs(v))}`;
}

export const count = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Rows to CSV (RFC 4180) or TSV (for pasting into a spreadsheet). */
export function toDelimited(rows: (string | number | null | undefined)[][], sep: "," | "\t"): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    if (sep === "\t") return s.replace(/[\t\r\n]+/g, " ");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(sep)).join(sep === "," ? "\r\n" : "\n") + (sep === "," ? "\r\n" : "\n");
}
