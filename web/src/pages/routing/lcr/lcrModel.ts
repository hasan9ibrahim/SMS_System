// Advanced LCR (§13.23) without React: the views in the URL, "next Monday", a blank profile and its
// checks, and the CSV export of an LCR table.
import type { LcrProfileInput, LcrTable } from "@sms/contract";
import { emptyState, encodeState } from "../../../grid/filterModel";

export type LcrView = "table" | "clients" | "profiles" | "changes";
export const VIEWS: { key: LcrView; label: string }[] = [
  { key: "table", label: "LCR table" },
  { key: "clients", label: "Client view" },
  { key: "profiles", label: "Profiles" },
  { key: "changes", label: "Changes" },
];
export const isView = (v: string | null): v is LcrView => VIEWS.some((x) => x.key === v);

/** Next Monday 00:00 UTC ("LCR next Monday"). */
export function nextMonday(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const add = (8 - d.getUTCDay()) % 7 || 7;
  return new Date(d.getTime() + add * 86_400_000);
}

export const blankProfile = (): LcrProfileInput => ({
  name: "",
  description: null,
  status: "active",
  vendorTrunkMode: "all",
  vendorTrunkIds: [],
  tiers: [],
  minAsr: null,
  minDlr: null,
  maxDelayS: null,
  maxRate: null,
  vendorCount: 3,
  split: "top_down",
  shares: [],
  tieBreaker: "quality",
  excludeAtTpsLimit: true,
  qualityWeighted: false,
  weights: { cost: 60, asr: 10, dlr: 25, delay: 5 },
});

/** Field problems before saving (the server checks the same). */
export function profileProblems(p: LcrProfileInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (!p.name.trim()) out.name = "required";
  if (p.split === "percentage") {
    const sum = p.shares.slice(0, p.vendorCount).reduce((a, x) => a + (x || 0), 0);
    if (p.shares.length < p.vendorCount) out.shares = `one share per vendor (${p.vendorCount})`;
    else if (sum !== 100) out.shares = `shares add up to ${sum} %, not 100 %`;
  }
  if (p.vendorTrunkMode !== "all" && !p.vendorTrunkIds.length) out.vendorTrunkIds = "choose the vendor trunks";
  return out;
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** The LCR table as CSV (what is on screen). */
export function lcrCsv(t: LcrTable): string {
  const head = [
    "Rank",
    "Vendor trunk",
    "Vendor",
    "Tier",
    `Cost (${t.currency})`,
    "Rate",
    "Currency",
    "Effective",
    "Next rate",
    "Next from",
    "ASR",
    "DLR",
    "Delay s",
    "TPS now",
    "TPS limit",
    "Routed now",
    "Score",
    "Used",
    "Share",
    "Excluded",
  ];
  const rows = t.rows.map((r) => [
    r.rank,
    r.vendorTrunk,
    r.vendor,
    r.tier,
    r.cost,
    r.rate,
    r.currency,
    r.effectiveFrom.slice(0, 10),
    r.nextRate,
    r.nextFrom?.slice(0, 10),
    r.asr,
    r.dlr,
    r.delayS,
    r.tpsNow,
    r.tpsLimit,
    r.routedNow,
    r.score,
    r.pick ? "yes" : "",
    r.share,
    r.excluded,
  ]);
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}

/** Route Rules for a destination, to apply an LCR profile with Bulk edit (§13.11). */
export const rulesForDestination = (mccmnc: string) =>
  `/routing/rules?g=${encodeState({ ...emptyState(), columns: { destination: { field: "destination", op: "like", value: `${mccmnc}%` } } })}`;
