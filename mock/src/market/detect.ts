// Market move detection (§13.14) without a database: among the top vendors of one destination, rate
// changes in the same direction of at least the minimum %, with effective dates within the window of
// each other, from at least the minimum number of vendors, form one move.

export interface VendorChange {
  vendorTrunkId: number;
  at: number; // effective from (ms)
  oldUsd: number;
  newUsd: number;
}

export interface MoveRule {
  windowDays: number;
  minVendors: number;
  minChangePct: number;
}

export interface FoundMove {
  direction: "up" | "down";
  first: number;
  last: number;
  /** The last qualifying change of each vendor in the window. */
  changes: VendorChange[];
  avgChangePct: number;
}

const pct = (c: VendorChange) => (c.newUsd / c.oldUsd - 1) * 100;

export function findMoves(changes: VendorChange[], rule: MoveRule): FoundMove[] {
  const out: FoundMove[] = [];
  const windowMs = rule.windowDays * 86_400_000;
  for (const direction of ["up", "down"] as const) {
    const list = changes
      .filter((c) => c.oldUsd > 0 && (direction === "up" ? pct(c) : -pct(c)) >= rule.minChangePct)
      .sort((a, b) => a.at - b.at || a.vendorTrunkId - b.vendorTrunkId);
    let i = 0;
    while (i < list.length) {
      const start = list[i]!.at;
      let j = i;
      while (j + 1 < list.length && list[j + 1]!.at - start <= windowMs) j++;
      const byVendor = new Map<number, VendorChange>();
      for (const c of list.slice(i, j + 1)) byVendor.set(c.vendorTrunkId, c);
      if (byVendor.size >= rule.minVendors) {
        const used = [...byVendor.values()];
        out.push({
          direction,
          first: Math.min(...used.map((c) => c.at)),
          last: Math.max(...used.map((c) => c.at)),
          changes: used.sort((a, b) => a.vendorTrunkId - b.vendorTrunkId),
          avgChangePct: Math.round((used.reduce((s, c) => s + pct(c), 0) / used.length) * 100) / 100,
        });
        i = j + 1;
      } else i++;
    }
  }
  return out;
}

/** Suggested sell rate: the new cost plus the client's margin, or the target margin when higher. */
export function suggestRate(
  sell: number,
  oldCost: number | null,
  newCost: number | null,
  targetMarginPct: number | null,
): number | null {
  if (newCost === null || newCost <= 0) return null;
  const current = oldCost !== null && sell > 0 ? ((sell - oldCost) / sell) * 100 : null;
  const margin = Math.min(90, Math.max(current ?? targetMarginPct ?? 10, targetMarginPct ?? -Infinity));
  return Math.round((newCost / (1 - margin / 100)) * 1e6) / 1e6;
}
