/**
 * Sample LCR profiles (§13.23, team trial round 1) and which Least cost route rules use them.
 * Fixed and picked from the world without random draws, so every other table stays the same for
 * a seed. Most Least cost rules get the profile that fits their product category; every fifth keeps
 * the plain cheapest-first behaviour (no profile).
 */
import { json, type TableSink } from "./sink.js";
import type { World } from "./world.js";

const WEIGHTS = { cost: 60, asr: 10, dlr: 25, delay: 5 };

interface SampleProfile {
  id: number;
  name: string;
  description: string;
  status?: "active" | "inactive";
  /** Vendor trunk scope: all, only the listed trunks, or all but them. */
  scope?: { mode: "inclusive" | "exclusive"; categories: string[]; take: number };
  tiers?: string[];
  minAsr?: number;
  minDlr?: number;
  maxRate?: number;
  vendorCount: number;
  split?: "top_down" | "percentage";
  shares?: number[];
  tieBreaker?: "quality" | "cost";
  qualityWeighted?: boolean;
  weights?: typeof WEIGHTS;
  /** Product categories whose Least cost rules use this profile. */
  forCategories: string[];
}

const SAMPLES: SampleProfile[] = [
  {
    id: 1,
    name: "Cheapest 3, top-down",
    description: "The three cheapest vendors in order; quality breaks ties.",
    vendorCount: 3,
    forCategories: [],
  },
  {
    id: 2,
    name: "OTP quality first",
    description: "Tier 1 and 2 vendors with good receipts, ranked by a quality-weighted score.",
    tiers: ["tier1", "tier2"],
    minAsr: 90,
    minDlr: 85,
    vendorCount: 2,
    qualityWeighted: true,
    weights: { cost: 30, asr: 20, dlr: 40, delay: 10 },
    forCategories: ["OTP", "SPECIAL"],
  },
  {
    id: 3,
    name: "Promo low cost 70/30",
    description: "The two cheapest vendors under the rate cap, split 70/30.",
    maxRate: 0.02,
    vendorCount: 2,
    split: "percentage",
    shares: [70, 30],
    tieBreaker: "cost",
    forCategories: ["PROMO", "LOCAL"],
  },
  {
    id: 4,
    name: "Direct premium vendors",
    description: "Only the listed direct and HQ vendors, with high delivery.",
    scope: { mode: "inclusive", categories: ["DIRECT", "HQ"], take: 6 },
    minDlr: 90,
    vendorCount: 3,
    forCategories: ["DIRECT", "HQ", "Enterprise"],
  },
  {
    id: 5,
    name: "Wholesale, no SIM routes",
    description: "Every vendor except the listed SIM routes.",
    scope: { mode: "exclusive", categories: ["SIM"], take: 5 },
    vendorCount: 4,
    forCategories: ["WHS", "CS"],
  },
  {
    id: 6,
    name: "Bulk night routes",
    description: "Kept for night bulk campaigns; switched off for now.",
    status: "inactive",
    vendorCount: 5,
    split: "percentage",
    shares: [40, 30, 30],
    forCategories: [],
  },
];

/** The profile a Least cost rule uses: by its first product category, none for every fifth rule. */
export function lcrProfileFor(world: World, ruleId: number, categoryIds: number[]): number | null {
  if (ruleId % 5 === 0) return null;
  const cat = world.categories.find((c) => c.id === categoryIds[0])?.name.toUpperCase();
  const fit = SAMPLES.find((p) => p.status !== "inactive" && p.forCategories.some((c) => c.toUpperCase() === cat));
  return (fit ?? SAMPLES[0]!).id;
}

export async function generateLcrProfiles(world: World, sink: TableSink): Promise<void> {
  const editor = world.users.find((u) => u.isAdmin) ?? world.users[0]!;
  for (const p of SAMPLES) {
    const scopeIds = p.scope
      ? world.vendorTrunks
          .filter((v) => v.status === "active" && !v.deletedAt)
          .filter((v) =>
            p.scope!.categories.some(
              (c) => world.categories.find((x) => x.id === v.categoryId)?.name.toUpperCase() === c.toUpperCase(),
            ),
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, p.scope.take)
          .map((v) => v.id)
      : [];
    const at = new Date(world.anchor - (30 - p.id * 3) * 86_400_000);
    await sink.insert("lcr_profiles", {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status ?? "active",
      vendor_trunk_mode: p.scope && scopeIds.length ? p.scope.mode : "all",
      vendor_trunk_ids: scopeIds,
      tiers: p.tiers ?? [],
      min_asr: p.minAsr ?? null,
      min_dlr: p.minDlr ?? null,
      max_delay_s: null,
      max_rate: p.maxRate ?? null,
      vendor_count: p.vendorCount,
      split: p.split ?? "top_down",
      shares: p.shares ?? [],
      tie_breaker: p.tieBreaker ?? "quality",
      exclude_at_tps_limit: true,
      quality_weighted: p.qualityWeighted ?? false,
      weights: json(p.weights ?? WEIGHTS),
      updated_by_id: editor.id,
      inserted_at: at,
      updated_at: at,
      deleted_at: null,
    });
  }
}
