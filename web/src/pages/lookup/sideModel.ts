// Rate Lookup side by side (team trial round 1, §13.16): each side's filters live in the tab URL
// (?c=… customer, ?v=… vendor, ?show=both|customer|vendor) so a lookup survives tab moves and reloads.
import type { LookupSide, LookupSideFilters, LookupSideLine, LookupSideOptions, LookupSideRow } from "@sms/contract";
import type { CheckItem } from "../../ui/CheckList";

export type Show = "both" | "customer" | "vendor";
export type SideSort = "destination" | "tables" | "minSys" | "maxSys";

export interface SideState {
  categoryIds: number[];
  trunkIds: number[];
  mccs: string[];
  mccmncs: string[];
  search: string;
  includeInactive: boolean;
  sort: SideSort;
  dir: "asc" | "desc";
}

export const emptySide = (): SideState => ({
  categoryIds: [],
  trunkIds: [],
  mccs: [],
  mccmncs: [],
  search: "",
  includeInactive: false,
  sort: "destination",
  dir: "asc",
});

const b64 = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64 = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** Only what differs from the empty side is written, so a plain lookup keeps a short URL. */
export function encodeSide(s: SideState): string | null {
  const e = emptySide();
  const diff = Object.fromEntries(
    Object.entries(s).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(e[k as keyof SideState])),
  );
  return Object.keys(diff).length ? b64(JSON.stringify(diff)) : null;
}

export function decodeSide(raw: string | null): SideState {
  if (!raw) return emptySide();
  try {
    const v = JSON.parse(unb64(raw)) as Partial<SideState>;
    return { ...emptySide(), ...v };
  } catch {
    return emptySide();
  }
}

/** The request filters of a side: chosen codes win over countries (codes narrow inside them). */
export function sideFilters(side: LookupSide, s: SideState): LookupSideFilters {
  return {
    side,
    ...(s.categoryIds.length ? { categoryIds: s.categoryIds } : {}),
    ...(s.trunkIds.length ? { trunkIds: s.trunkIds } : {}),
    ...(s.mccmncs.length ? { mccmncs: s.mccmncs } : s.mccs.length ? { mccs: s.mccs } : {}),
    ...(s.search.trim() ? { search: s.search.trim() } : {}),
    ...(s.includeInactive ? { includeInactive: true } : {}),
  };
}

/** Check-list items of a side's options. Codes follow the chosen countries. */
export function optionItems(o: LookupSideOptions | undefined, s: SideState) {
  if (!o) return { categories: [], trunks: [], countries: [], codes: [] };
  const countryOf = new Map(o.countries.map((c) => [c.mcc, c]));
  const inCountries = s.mccs.length ? new Set(s.mccs) : null;
  const tables = (n: number) => (n ? `${n.toLocaleString("en-US")} table${n === 1 ? "" : "s"}` : "no rates");
  return {
    categories: o.categories.map((c): CheckItem<number> => ({ value: c.id, label: c.name })),
    trunks: o.trunks.map((t): CheckItem<number> => ({
      value: t.id,
      label: t.name,
      detail: t.active ? t.enterpriseName : `${t.enterpriseName} · inactive`,
      muted: !t.active,
    })),
    countries: o.countries.map((c): CheckItem<string> => ({
      value: c.mcc,
      label: `${c.name} (${c.iso})`,
      detail: `${c.mcc} · ${tables(c.tables)}`,
      muted: c.tables === 0,
    })),
    codes: o.codes
      .filter((c) => !inCountries || inCountries.has(c.mcc))
      .map((c): CheckItem<string> => {
        const country = countryOf.get(c.mcc)?.name ?? c.mcc;
        return {
          value: c.mccmnc,
          label: inCountries && inCountries.size === 1 ? c.network : `${country} · ${c.network}`,
          detail: `${c.mccmnc} · ${tables(c.tables)}`,
          muted: c.tables === 0,
          keywords: country,
        };
      }),
  };
}

/** Rows on screen: destinations, and under an open one its tables (or a loading line). */
export type FlatRow =
  | { kind: "dest"; row: LookupSideRow; open: boolean }
  | { kind: "line"; code: string; line: LookupSideLine; best: boolean }
  | { kind: "note"; code: string; text: string };

export function flatten(
  rows: LookupSideRow[],
  open: ReadonlySet<string>,
  lines: ReadonlyMap<string, LookupSideLine[] | "loading" | "error">,
): FlatRow[] {
  const out: FlatRow[] = [];
  for (const row of rows) {
    const isOpen = open.has(row.mccmnc);
    out.push({ kind: "dest", row, open: isOpen });
    if (!isOpen) continue;
    const l = lines.get(row.mccmnc);
    if (l === undefined || l === "loading") out.push({ kind: "note", code: row.mccmnc, text: "Loading tables…" });
    else if (l === "error") out.push({ kind: "note", code: row.mccmnc, text: "Could not load the tables" });
    else if (!l.length) out.push({ kind: "note", code: row.mccmnc, text: "No table prices it now" });
    else l.forEach((line, i) => out.push({ kind: "line", code: row.mccmnc, line, best: i === 0 }));
  }
  return out;
}

/** "0.0123 – 0.0456" (or one value when equal). */
export function range(min: number | null, max: number | null, digits = 4): string {
  if (min === null || max === null) return "mixed currencies";
  const f = (v: number) => v.toFixed(digits);
  return min === max ? f(min) : `${f(min)} – ${f(max)}`;
}
