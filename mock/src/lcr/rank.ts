// LCR ranking (§13.23) without a database: an LCR profile's filters (vendors, tiers, minimum ASR /
// DLR, maximum delay and rate, TPS limit), the order (cost, or the quality-weighted score), the
// tie-breaker, and which vendors it uses with their shares. Used by the LCR table and by route rules
// of type Least cost (routing/evaluate.ts).
import type { LcrProfileFields, LcrWeights } from "@sms/contract";

export type LcrProfileCore = Omit<LcrProfileFields, "name" | "description" | "status">;

export interface LcrCandidate {
  vendorTrunkId: number;
  /** Platform currency. */
  cost: number;
  asr: number | null;
  dlr: number | null;
  delayS: number | null;
  tier: string | null;
  atLimit: boolean;
}

export interface Ranked<C extends LcrCandidate> {
  c: C;
  rank: number | null;
  score: number | null;
  excluded: string | null;
  pick: boolean;
  share: number | null;
}

export const DEFAULT_WEIGHTS: LcrWeights = { cost: 60, asr: 10, dlr: 25, delay: 5 };

function exclusion(c: LcrCandidate, p: LcrProfileCore): string | null {
  const listed = p.vendorTrunkIds.includes(c.vendorTrunkId);
  if (p.vendorTrunkMode === "inclusive" && !listed) return "not in the profile's vendors";
  if (p.vendorTrunkMode === "exclusive" && listed) return "excluded by the profile";
  if (p.tiers.length && !p.tiers.includes((c.tier ?? "") as never)) return `${c.tier ?? "no tier"} not allowed`;
  if (p.maxRate !== null && c.cost > p.maxRate) return `cost above ${p.maxRate}`;
  // Unknown quality is not held against a vendor (no traffic yet).
  if (p.minAsr !== null && c.asr !== null && c.asr < p.minAsr) return `ASR below ${p.minAsr} %`;
  if (p.minDlr !== null && c.dlr !== null && c.dlr < p.minDlr) return `DLR below ${p.minDlr} %`;
  if (p.maxDelayS !== null && c.delayS !== null && c.delayS > p.maxDelayS) return `delay above ${p.maxDelayS} s`;
  if (p.excludeAtTpsLimit && c.atLimit) return "at its TPS limit";
  return null;
}

/** 0–100 per factor within the set (cost and delay: lower is better; unknown quality counts as middling). */
export function scores<C extends LcrCandidate>(list: C[], w: LcrWeights): Map<C, number> {
  const range = (xs: number[]) => [Math.min(...xs), Math.max(...xs)] as const;
  const costs = range(list.map((c) => c.cost));
  const delays = list.flatMap((c) => (c.delayS === null ? [] : [c.delayS]));
  const [dMin, dMax] = delays.length ? range(delays) : [0, 0];
  const low = (v: number, [a, b]: readonly [number, number]) => (b > a ? ((b - v) / (b - a)) * 100 : 100);
  const total = w.cost + w.asr + w.dlr + w.delay || 1;
  return new Map(
    list.map((c) => {
      const s =
        w.cost * low(c.cost, costs) +
        w.asr * (c.asr ?? 50) +
        w.dlr * (c.dlr ?? 50) +
        w.delay * (c.delayS === null ? 50 : low(c.delayS, [dMin, dMax]));
      return [c, Math.round((s / total) * 10) / 10];
    }),
  );
}

export function rankLcr<C extends LcrCandidate>(
  list: C[],
  profile: LcrProfileCore | null,
  opts: { qualityWeighted?: boolean; weights?: LcrWeights } = {},
): Ranked<C>[] {
  const weighted = opts.qualityWeighted ?? profile?.qualityWeighted ?? false;
  const weights = opts.weights ?? profile?.weights ?? DEFAULT_WEIGHTS;
  const tie = profile?.tieBreaker ?? "quality";
  const eligible: C[] = [];
  const out: Ranked<C>[] = [];
  for (const c of list) {
    const excluded = profile ? exclusion(c, profile) : null;
    if (excluded) out.push({ c, rank: null, score: null, excluded, pick: false, share: null });
    else eligible.push(c);
  }
  const sc = weighted && eligible.length ? scores(eligible, weights) : null;
  eligible.sort((a, b) => {
    const main = sc ? sc.get(b)! - sc.get(a)! : a.cost - b.cost;
    if (main) return main;
    const t =
      tie === "quality"
        ? (b.dlr ?? -1) - (a.dlr ?? -1) || a.cost - b.cost
        : a.cost - b.cost || (b.dlr ?? -1) - (a.dlr ?? -1);
    return t || a.vendorTrunkId - b.vendorTrunkId;
  });
  const count = profile?.vendorCount ?? eligible.length;
  const ranked = eligible.map((c, i) => ({
    c,
    rank: i + 1,
    score: sc ? sc.get(c)! : null,
    excluded: null,
    pick: i < count,
    share: profile?.split === "percentage" && i < count ? (profile.shares[i] ?? 0) : null,
  }));
  return [...ranked, ...out.sort((a, b) => a.c.cost - b.c.cost)];
}

/** The vendor a percentage split sends this message to (bucket 0–99), else the first pick. */
export function splitPick<C extends LcrCandidate>(picks: Ranked<C>[], bucket: number): Ranked<C>[] {
  if (!picks.length || picks[0]!.share === null) return picks;
  let acc = 0;
  const hit = picks.find((p) => (acc += p.share ?? 0) > bucket) ?? picks[0]!;
  return [hit, ...picks.filter((p) => p !== hit)];
}
