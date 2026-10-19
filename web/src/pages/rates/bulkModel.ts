// Bulk rating workspace (§13.11) without React: the scope in the tab URL, pasted destination
// lists, cell formulas (=cost*1.15), the reviewed rows after edits and exclusions, the impact
// totals recomputed from them, and the items sent to apply.
import type { RateBulkItem, RateBulkRow } from "@sms/contract";

export interface Scope {
  tables: number[];
  mccmncs: string[];
  countries: string[];
}

const ints = (v: string | null) =>
  v
    ? v
        .split(",")
        .filter((x) => /^\d+$/.test(x))
        .map(Number)
    : [];
const codes = (v: string | null, re: RegExp) => (v ? v.split(",").filter((x) => re.test(x)) : []);

/** ?tables=1,2&mccmnc=26201,26202&country=DE,FR */
export function parseScope(search: string): Scope {
  const p = new URLSearchParams(search);
  return {
    tables: [...new Set(ints(p.get("tables")))],
    mccmncs: [...new Set(codes(p.get("mccmnc"), /^\d{3,6}$/))],
    countries: [...new Set(codes(p.get("country")?.toUpperCase() ?? null, /^[A-Z]{2}$/))],
  };
}

export function scopeUrl(s: Partial<Scope>): string {
  const p = new URLSearchParams();
  if (s.tables?.length) p.set("tables", s.tables.join(","));
  if (s.mccmncs?.length) p.set("mccmnc", s.mccmncs.join(","));
  if (s.countries?.length) p.set("country", s.countries.join(","));
  const qs = p.toString().replaceAll("%2C", ",");
  return `/rates/bulk${qs ? `?${qs}` : ""}`;
}

/** A pasted list (Excel column, comma or space separated): MCCMNC codes and country ISO codes. */
export function parseCodes(text: string): { mccmncs: string[]; countries: string[]; invalid: string[] } {
  const out = { mccmncs: [] as string[], countries: [] as string[], invalid: [] as string[] };
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (/^\d{3,6}$/.test(t)) out.mccmncs.push(t);
    else if (/^[a-z]{2}$/i.test(t)) out.countries.push(t.toUpperCase());
    else out.invalid.push(t);
  }
  out.mccmncs = [...new Set(out.mccmncs)];
  out.countries = [...new Set(out.countries)];
  return out;
}

/**
 * A typed cell value: a number, or a simple formula over `cost` and `rate` (the current rate),
 * e.g. =cost*1.15, =rate+0.002, =(cost+0.001)*1.1. Null when it can't be worked out.
 */
export function evalCell(input: string, vars: { cost: number | null; rate: number | null }): number | null {
  const s = input.trim().replace(",", ".");
  if (!s) return null;
  if (!s.startsWith("=")) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const tokens =
    s
      .slice(1)
      .toLowerCase()
      .match(/\d+(?:\.\d+)?|cost|rate|[-+*/()]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const fail = () => {
    throw new Error("bad formula");
  };
  const atom = (): number => {
    const t = tokens[i++];
    if (t === undefined) return fail();
    if (t === "(") {
      const v = sum();
      if (tokens[i++] !== ")") fail();
      return v;
    }
    if (t === "-") return -atom();
    if (t === "cost" || t === "rate") {
      const v = vars[t];
      return v === null ? fail() : v;
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : fail();
  };
  const product = (): number => {
    let v = atom();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[i++];
      const r = atom();
      v = op === "*" ? v * r : r === 0 ? fail() : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = tokens[i++] === "+" ? v + product() : v - product();
    return v;
  };
  try {
    const v = sum();
    if (i !== tokens.length || !Number.isFinite(v) || v < 0) return null;
    return Math.round(v * 1e6) / 1e6;
  } catch {
    return null;
  }
}

/** The user's changes to the previewed rows, by row key. */
export interface Edits {
  rates: Map<string, number>;
  excluded: Set<string>;
}
export const noEdits = (): Edits => ({ rates: new Map(), excluded: new Set() });

export interface Reviewed extends RateBulkRow {
  included: boolean;
  edited: boolean;
}

const DAY_MS = 86_400_000;
const pct = (a: number, b: number) => Math.round(((a - b) / b) * 1000) / 10;
const margin = (rate: number, cost: number) => (rate > 0 ? Math.round(((rate - cost) / rate) * 1000) / 10 : null);

/** The rows as they would be applied: typed rates replace the computed ones; flags follow. */
export function review(rows: RateBulkRow[], edits: Edits, now = Date.now()): Reviewed[] {
  return rows.map((r) => {
    const typed = edits.rates.get(r.key);
    const included = !edits.excluded.has(r.key);
    if (typed === undefined || r.edit === "close" || r.edit === "block") return { ...r, included, edited: false };
    const cur = r.currentRate;
    const change: RateBulkRow["change"] =
      cur === null ? "new" : typed > cur ? "increase" : typed < cur ? "decrease" : "same";
    const noticeBreach =
      change === "increase" &&
      r.noticeDays !== null &&
      Date.parse(r.effectiveFrom) < now + r.noticeDays * DAY_MS - 60_000;
    return {
      ...r,
      included,
      edited: true,
      newRate: typed,
      edit: change === "same" ? "none" : "set",
      change,
      changePct: cur !== null && cur > 0 && change !== "same" ? pct(typed, cur) : null,
      newMarginPct: r.cost !== null ? margin(typed, r.cost) : null,
      belowCost: r.cost !== null && typed < r.cost,
      noticeBreach,
      noticeAdjusted: r.noticeAdjusted && change === "increase",
      revenueChange7d: cur === null ? 0 : Math.round(r.messages7d * (typed - cur) * 100) / 100,
    };
  });
}

export interface Impact {
  rows: number;
  applying: number;
  excluded: number;
  up: number;
  down: number;
  new: number;
  closed: number;
  blocked: number;
  unblocked: number;
  unchanged: number;
  belowCost: number;
  noticeBreach: number;
  revenue7d: number;
  revenueChange7d: number;
  marginChange7d: number;
}

/** Step 4 impact over the rows that will be applied (money in the platform currency). */
export function impact(rows: Reviewed[]): Impact {
  const t: Impact = {
    rows: rows.length,
    applying: 0,
    excluded: 0,
    up: 0,
    down: 0,
    new: 0,
    closed: 0,
    blocked: 0,
    unblocked: 0,
    unchanged: 0,
    belowCost: 0,
    noticeBreach: 0,
    revenue7d: 0,
    revenueChange7d: 0,
    marginChange7d: 0,
  };
  for (const r of rows) {
    t.revenue7d += r.revenue7d * r.toPlatform;
    if (!r.included) {
      t.excluded++;
      continue;
    }
    if (r.edit === "none") {
      t.unchanged++;
      continue;
    }
    t.applying++;
    if (r.change === "increase") t.up++;
    else if (r.change === "decrease") t.down++;
    else if (r.change === "new") t.new++;
    else if (r.change === "close") t.closed++;
    else if (r.change === "block") t.blocked++;
    else if (r.change === "unblock") t.unblocked++;
    if (r.belowCost) t.belowCost++;
    if (r.noticeBreach) t.noticeBreach++;
    if (r.edit === "close") {
      t.revenueChange7d -= r.revenue7d * r.toPlatform;
      t.marginChange7d -= r.margin7d * r.toPlatform;
    } else if (r.edit === "set") {
      t.revenueChange7d += r.revenueChange7d * r.toPlatform;
      t.marginChange7d += r.revenueChange7d * r.toPlatform;
    }
  }
  for (const k of ["revenue7d", "revenueChange7d", "marginChange7d"] as const) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

/** Items for apply: included rows that change something. Start times already past mean "now". */
export function applyItems(rows: Reviewed[], now = Date.now()): RateBulkItem[] {
  const out: RateBulkItem[] = [];
  for (const r of rows) {
    if (!r.included || r.edit === "none") continue;
    const from = Date.parse(r.effectiveFrom) > now + 5_000 ? { effectiveFrom: r.effectiveFrom } : {};
    if (r.edit === "set")
      out.push({
        rateTableId: r.rateTableId,
        action: "set",
        ...(r.lineId !== null ? { lineId: r.lineId } : { mccmnc: r.mccmnc, senderId: r.senderId }),
        rate: r.newRate!,
        ...from,
      });
    else if (r.edit === "close") out.push({ rateTableId: r.rateTableId, action: "close", lineId: r.lineId!, ...from });
    else out.push({ rateTableId: r.rateTableId, action: "block", lineId: r.lineId!, blocked: r.newBlocked ?? true });
  }
  return out;
}

export type Show = "all" | "changing" | "flagged" | "below" | "notice" | "excluded" | "edited";

/** The review grid's quick view and search (within the previewed job, already in memory). */
export function visible(rows: Reviewed[], show: Show, search: string): Reviewed[] {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (show === "changing" && (r.edit === "none" || !r.included)) return false;
    if (show === "flagged" && !r.belowCost && !r.noticeBreach) return false;
    if (show === "below" && !r.belowCost) return false;
    if (show === "notice" && !r.noticeBreach) return false;
    if (show === "excluded" && r.included) return false;
    if (show === "edited" && !r.edited) return false;
    if (!q) return true;
    return [r.table, r.clients, r.country, r.network, r.mccmnc, r.senderId, r.costVendor]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });
}
