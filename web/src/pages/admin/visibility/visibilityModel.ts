// AM visibility (§13.17): the items a policy can hide, their labels and allowed modes, a blank policy,
// form checks and the one-line summary of an effective policy.
import type {
  EffectiveVisibility,
  VisibilityItems,
  VisibilityMode,
  VisibilityPolicyInput,
  VisibilityPolicyRow,
} from "@sms/contract";

export type VisItem = keyof VisibilityItems;
export const ITEMS: { key: VisItem; label: string; hint: string }[] = [
  { key: "margin", label: "Margin and margin %", hint: "Bands show Low / Normal / High instead" },
  { key: "revenue", label: "Revenue", hint: "Can also be limited to an amount" },
  { key: "cost", label: "Cost / vendor buy rates", hint: "Others' vendors can count as own by traffic" },
  { key: "sellRates", label: "Customer sell rates", hint: "" },
  { key: "balances", label: "Balances, credit limits, invoices, payments", hint: "" },
  { key: "contacts", label: "Contact details, IPs, usernames, passwords", hint: "" },
  { key: "traffic", label: "Traffic volumes (attempts, TPS)", hint: "" },
];
export const MODE_LABEL: Record<VisibilityMode, string> = { show: "Shown", hide: "Hidden", band: "Band" };
/** Bands are for margin only (§13.17 thresholds). */
export const modesFor = (k: VisItem): VisibilityMode[] =>
  k === "margin" ? ["show", "band", "hide"] : ["show", "hide"];

export const VIEWS = [
  { key: "policies", label: "Policies" },
  { key: "assignments", label: "Assignments" },
  { key: "grants", label: "Shares & temporary access" },
] as const;
export type VisibilityView = (typeof VIEWS)[number]["key"];
export const isView = (v: string | null): v is VisibilityView => VIEWS.some((x) => x.key === v);

export function blankPolicy(): VisibilityPolicyInput {
  const items = Object.fromEntries(ITEMS.map((i) => [i.key, { others: "hide", own: "show" }])) as VisibilityItems;
  items.traffic = { others: "show", own: "show" };
  return {
    name: "",
    description: null,
    status: "active",
    maskOthers: true,
    includeTeam: false,
    items,
    thresholds: { marginLowPct: 5, marginHighPct: 20, revenueHideAbove: null, costTrafficDays: null },
  };
}

export function policyInput(r: VisibilityPolicyRow): VisibilityPolicyInput {
  const { id: _i, assignments: _a, summary: _s, updatedBy: _u, updatedAt: _t, archivedAt: _d, ...rest } = r;
  return rest;
}

export function policyProblems(p: VisibilityPolicyInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (!p.name.trim()) out.name = "Give the policy a name";
  if (p.thresholds.marginLowPct > p.thresholds.marginHighPct) out.bands = "Low must not be above High";
  if (p.thresholds.revenueHideAbove !== null && p.thresholds.revenueHideAbove < 0) out.revenue = "Not below 0";
  for (const i of ITEMS)
    if (i.key !== "margin" && (p.items[i.key].others === "band" || p.items[i.key].own === "band"))
      out[i.key] = "Bands are for margin only";
  return out;
}

/** "Standard AM · from All account managers · 68 own + 3 granted" */
export function effectiveLine(v: EffectiveVisibility): string {
  if (v.exempt) return `Sees everything · ${v.exemptReason ?? "no policy"}`;
  const own = [
    `${v.ownEnterprises} own`,
    v.teamEnterprises ? `${v.teamEnterprises} team` : null,
    v.grantedEnterprises ? `${v.grantedEnterprises} granted` : null,
  ]
    .filter(Boolean)
    .join(" + ");
  return [v.policy?.name, v.sourceName ? `from ${v.sourceName}` : null, `${own} enterprises`]
    .filter(Boolean)
    .join(" · ");
}

/** Hidden items as words, others first: "others: margin, revenue · own: —". */
export function hiddenWords(items: VisibilityItems): string {
  const side = (s: "others" | "own") =>
    ITEMS.filter((i) => items[i.key][s] !== "show")
      .map((i) => (items[i.key][s] === "band" ? `${i.key} as bands` : i.key))
      .join(", ") || "nothing";
  return `others: ${side("others")} · own: ${side("own")}`;
}
