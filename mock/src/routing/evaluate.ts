// Route rule evaluation for the rule Test and the Route Simulator (§6.3, §13.8, §13.9,
// §13.24, §13.27). Pure: the caller loads the rule, the message context and vendor costs.
// The switch evaluates the same way: conditions (all or any must match), then the vendor:
// number whitelist first, then the warm-up threshold, then the normal split / LCR / QBR.
import { rankLcr, splitPick, type LcrProfileCore } from "../lcr/rank.js";
import type { RouteCandidate, RouteCheck, RouteDecision, RouteRuleDetail } from "@sms/contract";

export interface MessageContext {
  now: number;
  customerTrunkId: number | null;
  /** Product category of the customer trunk. */
  categoryId: number | null;
  receiver: string;
  sender: string;
  content: string;
  /** Destination found from the number (or given), with the country-level code. */
  mccmnc: string | null;
  destination: string | null;
  tps: number | null;
  /** Customer rate for the message, platform currency (§13.9 per message). */
  sellRate: number | null;
  accumulatedRevenue: number | null;
  hlrPorted: boolean | null;
  warmupSent: number;
  /** Entries of the number lists the rule uses. */
  listHas: (listId: number, value: string) => boolean;
}

/**
 * Quality score of a vendor for a Quality (QBR) rule, 0–1 (team trial round 1, decided 2026-10-18):
 * ASR and DLR weigh most (35 % each), then delivery delay (20 %), then cost (10 %). Delay scores 1 at
 * 0 s down to 0 at 60 s; cost scores the cheapest of the pool as 1. A missing figure counts as neutral (0.5).
 */
export const QBR_WEIGHTS = { asr: 35, dlr: 35, delay: 20, cost: 10 } as const;
export type QbrWeights = { asr: number; dlr: number; delay: number; cost: number };
export function qbrScore(
  o: Pick<VendorOption, "asr" | "dlr" | "delayS" | "cost">,
  cheapest: number | null,
  weights: QbrWeights | null = null,
): number {
  // A rule may set its own weights (team trial round 1); they are normalised to their sum.
  const w = weights ?? QBR_WEIGHTS;
  const sum = w.asr + w.dlr + w.delay + w.cost || 1;
  const pct = (v: number | null | undefined) =>
    v === null || v === undefined ? 0.5 : Math.min(1, Math.max(0, v / 100));
  const delay = o.delayS === null || o.delayS === undefined ? 0.5 : 1 - Math.min(60, Math.max(0, o.delayS)) / 60;
  const cost = o.cost === null || !cheapest ? 0.5 : Math.min(1, cheapest / o.cost);
  return (w.asr * pct(o.asr) + w.dlr * pct(o.dlr) + w.delay * delay + w.cost * cost) / sum;
}

/** Best quality first (qbrScore), cheaper first on a tie. */
export function byQbr<T extends Pick<VendorOption, "asr" | "dlr" | "delayS" | "cost">>(
  xs: T[],
  weights: QbrWeights | null = null,
): T[] {
  const costs = xs.map((x) => x.cost).filter((c): c is number => c !== null && c > 0);
  const cheapest = costs.length ? Math.min(...costs) : null;
  const scored = xs.map((x) => ({ x, s: qbrScore(x, cheapest, weights) }));
  scored.sort((a, b) => b.s - a.s || (a.x.cost ?? Infinity) - (b.x.cost ?? Infinity));
  return scored.map((y) => y.x);
}

export interface VendorOption {
  vendorTrunkId: number;
  name: string;
  /** Buy rate for the destination in platform currency; null when the vendor has none. */
  cost: number | null;
  /** Recent delivered %, for QBR ordering. */
  dlr: number | null;
  categoryId: number | null;
  /** For LCR profiles (§13.23): QBR ASR and delivery delay, the vendor's tier, at its TPS limit. */
  asr?: number | null;
  delayS?: number | null;
  tier?: string | null;
  atLimit?: boolean;
}

type Rule = Pick<
  RouteRuleDetail,
  | "id"
  | "status"
  | "startsAt"
  | "stopsAt"
  | "matchMode"
  | "categoryMode"
  | "categoryIds"
  | "customerTrunkMode"
  | "customerTrunkIds"
  | "mccmncMode"
  | "mccmncs"
  | "mccmncPattern"
  | "senderPattern"
  | "senderPatternNegate"
  | "receiverPattern"
  | "receiverPatternNegate"
  | "contentPattern"
  | "contentPatternNegate"
  | "senderListId"
  | "receiverListId"
  | "tps"
  | "revenue"
  | "hlrPorted"
  | "routeType"
  | "huntPolicy"
  | "margin"
  | "vendors"
  | "qbrWeights"
  | "percentagePerCustomerTrunk"
  | "whitelists"
  | "vendorTrunkMode"
  | "vendorTrunkIds"
  | "vendorCategoryMode"
  | "vendorCategoryIds"
> & {
  /** The LCR profile of a Least cost rule, loaded with the rules (§13.23). */
  lcrProfile?: LcrProfileCore | null;
};

export function compare(
  op: string,
  actual: number,
  value: number,
  value2: number | null | undefined,
  tolerancePct = 5,
) {
  switch (op) {
    case ">":
      return actual > value;
    case ">=":
      return actual >= value;
    case "<":
      return actual < value;
    case "<=":
      return actual <= value;
    case "=":
      return Math.abs(actual - value) <= (Math.abs(value) * tolerancePct) / 100;
    case "between":
      return actual >= value && actual <= (value2 ?? value);
    default:
      return false;
  }
}

/** Mode check for a list condition (all / inclusive / exclusive). */
const inMode = (mode: string, hit: boolean) => (mode === "all" ? true : mode === "inclusive" ? hit : !hit);

/**
 * Exact codes only: a 3-digit code is the country's "All networks" default entry (§6.1), not the whole
 * country (decided in team trial round 1); a whole country is all its codes ticked.
 */
export const destinationHit = (codes: string[], mccmnc: string) => {
  // A code list as a set, built once per array (rules route thousands of destinations).
  let set = codeSets.get(codes);
  if (!set) codeSets.set(codes, (set = new Set(codes)));
  return set.has(mccmnc);
};
const codeSets = new WeakMap<string[], Set<string>>();

const compiled = new Map<string, RegExp | null>();
function regex(pattern: string, value: string): boolean {
  let re = compiled.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = null;
    }
    if (compiled.size > 5000) compiled.clear();
    compiled.set(pattern, re);
  }
  return re ? re.test(value) : false;
}

const liveTimes = new WeakMap<object, [number, number]>();
/** A rule's start and stop as epoch ms, parsed once per rule object. */
function liveWindow(rule: Rule): [number, number] {
  let t = liveTimes.get(rule);
  if (!t) liveTimes.set(rule, (t = [Date.parse(rule.startsAt), Date.parse(rule.stopsAt)]));
  return t;
}

/**
 * Whether a rule matches, without the check details: the same answer as
 * matches(conditionChecks(rule, m), rule.matchMode), for routing many messages at once.
 * "all" stops at the first failed condition, "any" at the first passed one.
 */
export function quickMatch(rule: Rule, m: MessageContext): boolean {
  if (rule.status !== "active") return false;
  const t = liveWindow(rule);
  if (!(t[0] <= m.now && m.now < t[1])) return false;
  const all = rule.matchMode === "all";
  let set = false;
  let ok: boolean;
  if (rule.categoryMode !== "all") {
    ok = inMode(rule.categoryMode, m.categoryId !== null && rule.categoryIds.includes(m.categoryId));
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.customerTrunkMode !== "all") {
    ok = inMode(
      rule.customerTrunkMode,
      m.customerTrunkId !== null && rule.customerTrunkIds.includes(m.customerTrunkId),
    );
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.mccmncMode !== "all" || rule.mccmncPattern) {
    ok = !m.mccmnc
      ? false
      : rule.mccmncPattern
        ? regex(rule.mccmncPattern, m.mccmnc)
        : inMode(rule.mccmncMode, destinationHit(rule.mccmncs, m.mccmnc));
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.senderPattern) {
    ok = regex(rule.senderPattern, m.sender) !== rule.senderPatternNegate;
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.receiverPattern) {
    ok = regex(rule.receiverPattern, m.receiver) !== rule.receiverPatternNegate;
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.contentPattern) {
    ok = regex(rule.contentPattern, m.content) !== rule.contentPatternNegate;
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.senderListId) {
    ok = m.listHas(rule.senderListId, m.sender);
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.receiverListId) {
    ok = m.listHas(rule.receiverListId, m.receiver);
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.tps) {
    const tp = rule.tps;
    ok = m.tps !== null && compare(tp.op, m.tps, tp.value, tp.value2, tp.tolerancePct ?? 5);
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.revenue) {
    const r = rule.revenue;
    const actual = r.type === "per_message" ? m.sellRate : m.accumulatedRevenue;
    ok = actual !== null && compare(r.op, actual, r.value, r.value2);
    if (all !== ok) return ok;
    set = true;
  }
  if (rule.hlrPorted !== null && rule.hlrPorted !== undefined) {
    ok = m.hlrPorted === rule.hlrPorted;
    if (all !== ok) return ok;
    set = true;
  }
  return all || !set;
}

/** Sorted least-cost / quality pools per vendor options map and rule (they don't depend on the message). */
const pools = new WeakMap<Map<number, VendorOption>, WeakMap<object, VendorOption[]>>();

/** A rule's vendor scope as sets, built once per rule object (the LCR pool runs per destination). */
const scopes = new WeakMap<object, { listed: Set<number>; trunks: Set<number>; categories: Set<number> }>();
function scopeSets(rule: Rule) {
  let sc = scopes.get(rule);
  if (!sc) {
    sc = {
      listed: new Set(rule.vendors.map((v) => v.vendorTrunkId)),
      trunks: new Set(rule.vendorTrunkIds),
      categories: new Set(rule.vendorCategoryIds),
    };
    scopes.set(rule, sc);
  }
  return sc;
}

/** Condition checks. `set` = the rule actually uses the condition (matters for "any"). */
export function conditionChecks(rule: Rule, m: MessageContext): (RouteCheck & { set: boolean; gate: boolean })[] {
  const checks: (RouteCheck & { set: boolean; gate: boolean })[] = [];
  const add = (condition: string, set: boolean, ok: boolean, detail: string, gate = false) =>
    checks.push({ condition, set, ok, detail, gate });

  add("Status", true, rule.status === "active", rule.status === "active" ? "active" : "the rule is off", true);
  const live = Date.parse(rule.startsAt) <= m.now && m.now < Date.parse(rule.stopsAt);
  add("Time", true, live, live ? "within start and stop time" : "outside the rule's start and stop time", true);

  if (rule.categoryMode !== "all") {
    const hit = m.categoryId !== null && rule.categoryIds.includes(m.categoryId);
    add(
      "Category",
      true,
      inMode(rule.categoryMode, hit),
      m.categoryId === null
        ? "no customer trunk given"
        : `${rule.categoryMode} list ${hit ? "has" : "lacks"} the trunk's category`,
    );
  }
  if (rule.customerTrunkMode !== "all") {
    const hit = m.customerTrunkId !== null && rule.customerTrunkIds.includes(m.customerTrunkId);
    add(
      "Trunk",
      true,
      inMode(rule.customerTrunkMode, hit),
      m.customerTrunkId === null
        ? "no customer trunk given"
        : `${rule.customerTrunkMode} list ${hit ? "has" : "lacks"} the trunk`,
    );
  }
  if (rule.mccmncMode !== "all" || rule.mccmncPattern) {
    let ok = true;
    let detail = m.mccmnc ? `destination ${m.mccmnc}` : "destination unknown";
    if (!m.mccmnc) ok = false;
    else if (rule.mccmncPattern) {
      ok = regex(rule.mccmncPattern, m.mccmnc);
      detail += ok ? " matches the pattern" : " doesn't match the pattern";
    } else {
      const hit = destinationHit(rule.mccmncs, m.mccmnc);
      ok = inMode(rule.mccmncMode, hit);
      detail += ` ${hit ? "is" : "isn't"} in the ${rule.mccmncMode} list`;
    }
    add("Destination", true, ok, detail);
  }
  const pattern = (name: string, p: string | null, negate: boolean, value: string) => {
    if (!p) return;
    const hit = regex(p, value);
    add(name, true, negate ? !hit : hit, `"${value}" ${hit ? "matches" : "doesn't match"} ${negate ? "not " : ""}${p}`);
  };
  pattern("Sender", rule.senderPattern, rule.senderPatternNegate, m.sender);
  pattern("Receiver", rule.receiverPattern, rule.receiverPatternNegate, m.receiver);
  pattern("Content", rule.contentPattern, rule.contentPatternNegate, m.content);
  if (rule.senderListId) {
    const hit = m.listHas(rule.senderListId, m.sender);
    add("Sender list", true, hit, hit ? "sender is in the list" : "sender isn't in the list");
  }
  if (rule.receiverListId) {
    const hit = m.listHas(rule.receiverListId, m.receiver);
    add("Receiver list", true, hit, hit ? "number is in the list" : "number isn't in the list");
  }
  if (rule.tps) {
    const t = rule.tps;
    const ok = m.tps !== null && compare(t.op, m.tps, t.value, t.value2, t.tolerancePct ?? 5);
    add(
      "TPS",
      true,
      ok,
      m.tps === null
        ? "no simulated TPS"
        : `${m.tps} ${t.op} ${t.value}${t.op === "between" ? `–${t.value2}` : ""} (${t.scope}, ${t.windowS ?? 5}s)`,
    );
  }
  if (rule.revenue) {
    const r = rule.revenue;
    const actual = r.type === "per_message" ? m.sellRate : m.accumulatedRevenue;
    const ok = actual !== null && compare(r.op, actual, r.value, r.value2);
    add(
      "Revenue",
      true,
      ok,
      actual === null
        ? r.type === "per_message"
          ? "no customer rate for this destination"
          : "no simulated accumulated revenue"
        : `${r.type === "per_message" ? "per message" : `accumulated ${r.period ?? ""}`} ${actual} ${r.op} ${r.value}`,
    );
  }
  if (rule.hlrPorted !== null && rule.hlrPorted !== undefined) {
    const ok = m.hlrPorted === rule.hlrPorted;
    add(
      "HLR ported",
      true,
      ok,
      m.hlrPorted === null ? "no HLR result" : m.hlrPorted ? "number is ported" : "number is not ported",
    );
  }
  return checks;
}

export function matches(checks: { ok: boolean; set: boolean; gate: boolean }[], mode: "all" | "any"): boolean {
  if (checks.some((c) => c.gate && !c.ok)) return false;
  const conditions = checks.filter((c) => !c.gate && c.set);
  if (conditions.length === 0) return true;
  return mode === "all" ? conditions.every((c) => c.ok) : conditions.some((c) => c.ok);
}

/** Stable pick for a percentage split: the same number always lands on the same vendor. */
export function bucket(receiver: string): number {
  let h = 0;
  for (const ch of receiver) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
  return h % 100;
}

export function decide(rule: Rule, m: MessageContext, options: Map<number, VendorOption>): RouteDecision {
  const checks = conditionChecks(rule, m);
  const matched = matches(checks, rule.matchMode);
  const base = {
    ruleId: rule.id,
    matched,
    checks: checks.map(({ condition, ok, detail }) => ({ condition, ok, detail })),
    mccmnc: m.mccmnc,
    destination: m.destination,
    sellRate: m.sellRate,
  };
  if (!matched) return { ...base, outcome: "not_matched", vendor: null, candidates: [] };
  if (rule.routeType === "block") return { ...base, outcome: "block", vendor: null, candidates: [] };

  const marginOf = (cost: number | null) =>
    cost === null || m.sellRate === null ? null : Math.round((m.sellRate - cost) * 1e6) / 1e6;
  const candidate = (id: number, level: number, note: string | null): RouteCandidate => {
    const o = options.get(id);
    return {
      vendorTrunkId: id,
      name: o?.name ?? `Trunk ${id}`,
      level,
      cost: o?.cost ?? null,
      margin: marginOf(o?.cost ?? null),
      note,
    };
  };
  /** Vendors leaving less than the rule's margin are skipped (§6.3 Margin). */
  const marginOk = (c: RouteCandidate) => c.margin === null || c.margin >= rule.margin;

  // 1. Number whitelist pinned to a vendor (§13.27).
  for (const w of rule.whitelists) {
    if (w.numbers.includes(m.receiver) || (w.numberListId && m.listHas(w.numberListId, m.receiver))) {
      const c = candidate(w.vendorTrunkId, 1, "number whitelist");
      return {
        ...base,
        outcome: "route",
        vendor: { vendorTrunkId: c.vendorTrunkId, name: c.name, level: 1, decidedBy: "whitelist" },
        candidates: [c],
      };
    }
  }
  // 2. Warm-up threshold: the first N messages go to that vendor.
  const warm = [...rule.vendors]
    .sort((a, b) => a.level - b.level)
    .find((v) => v.warmupCount && m.warmupSent < v.warmupCount);
  if (warm) {
    const c = candidate(warm.vendorTrunkId, warm.level, `warm-up ${m.warmupSent}/${warm.warmupCount}`);
    return {
      ...base,
      outcome: "route",
      vendor: { vendorTrunkId: c.vendorTrunkId, name: c.name, level: warm.level, decidedBy: "warmup" },
      candidates: [c],
    };
  }

  // 3. Least cost and quality: every vendor in scope with a rate for the destination.
  if (rule.routeType === "dynamic" || (rule.routeType === "qbr" && rule.vendors.length === 0)) {
    const sc = scopeSets(rule);
    const inScope = (o: VendorOption) =>
      (sc.listed.size
        ? sc.listed.has(o.vendorTrunkId)
        : inMode(rule.vendorTrunkMode, sc.trunks.has(o.vendorTrunkId))) &&
      inMode(rule.vendorCategoryMode, o.categoryId !== null && sc.categories.has(o.categoryId));
    let byRule = pools.get(options);
    if (!byRule) pools.set(options, (byRule = new WeakMap()));
    let pool = byRule.get(rule);
    if (!pool) {
      pool = [...options.values()].filter((o) => o.cost !== null && inScope(o));
      if (rule.routeType === "qbr") pool = byQbr(pool, rule.qbrWeights ?? null);
      else pool.sort((a, b) => a.cost! - b.cost!);
      byRule.set(rule, pool);
    }
    let candidates: RouteCandidate[];
    if (rule.routeType === "dynamic" && rule.lcrProfile) {
      // An LCR profile filters, orders and splits the vendors (§13.23).
      const ranked = rankLcr(
        pool.map((o) => ({
          ...o,
          cost: o.cost!,
          asr: o.asr ?? null,
          delayS: o.delayS ?? null,
          tier: o.tier ?? null,
          atLimit: o.atLimit ?? false,
        })),
        rule.lcrProfile,
      );
      candidates = splitPick(
        ranked.filter((r) => r.pick),
        bucket(m.receiver),
      ).map((r, i) => candidate(r.c.vendorTrunkId, i + 1, r.share !== null ? `${r.share}%` : null));
    } else candidates = pool.slice(0, 10).map((o, i) => candidate(o.vendorTrunkId, i + 1, null));
    for (const c of candidates) if (!marginOk(c)) c.note = `margin below ${rule.margin}`;
    const pick = candidates.find(marginOk);
    return pick
      ? {
          ...base,
          outcome: "route",
          vendor: {
            vendorTrunkId: pick.vendorTrunkId,
            name: pick.name,
            level: pick.level,
            decidedBy: rule.routeType === "qbr" ? "qbr" : "lcr",
          },
          candidates,
        }
      : { ...base, outcome: "no_vendor", vendor: null, candidates };
  }

  // 4. Static (and QBR with listed vendors): levels in order, the split inside a level.
  const levels = [...new Set(rule.vendors.filter((v) => !v.isBackup).map((v) => v.level))].sort((a, b) => a - b);
  // Backups of one vendor stand in for it first (team trial round 1); the others are the rule's last resort.
  const backups = rule.vendors.filter((v) => v.isBackup && !v.backupForVendorTrunkId);
  const backupsOf = (id: number) => {
    const bs = rule.vendors.filter((v) => v.isBackup && v.backupForVendorTrunkId === id);
    if (bs.length < 2) return bs;
    // Split the vendor's traffic between its backups by their share %.
    const b = bucket(`${m.receiver}:b`);
    const total = bs.reduce((n, v) => n + (v.sharePct ?? 0), 0) || bs.length;
    let acc = 0;
    const hit = bs.find((v) => (acc += ((v.sharePct ?? (total === bs.length ? 1 : 0)) * 100) / total) > b) ?? bs[0]!;
    return [hit, ...bs.filter((v) => v !== hit)];
  };
  const candidates: RouteCandidate[] = [];
  for (const level of levels) {
    const at = rule.vendors.filter((v) => v.level === level && !v.isBackup);
    let ordered = at;
    let decidedBy: "percentage" | "top_down" | "round_robin" | "qbr" = rule.huntPolicy;
    if (rule.routeType === "qbr") {
      const none = { asr: null, dlr: null, delayS: null, cost: null };
      ordered = byQbr(
        at.map((v) => ({ v, ...(options.get(v.vendorTrunkId) ?? none) })),
        rule.qbrWeights ?? null,
      ).map((x) => x.v);
      decidedBy = "qbr";
    } else if (rule.huntPolicy === "percentage") {
      // Per customer trunk: each trunk's own traffic follows the shares (on unless switched off; the backend keeps one split counter
      // per rule and customer trunk instead of one per rule; team trial round 1).
      const b = bucket(
        rule.percentagePerCustomerTrunk !== false ? `${m.customerTrunkId ?? 0}:${m.receiver}` : m.receiver,
      );
      let acc = 0;
      const hit = at.find((v) => (acc += v.sharePct ?? 0) > b) ?? at[0];
      ordered = hit ? [hit, ...at.filter((v) => v !== hit)] : at;
    } else if (rule.huntPolicy === "round_robin") {
      const start = at.length ? bucket(m.receiver) % at.length : 0;
      ordered = [...at.slice(start), ...at.slice(0, start)];
    }
    for (const v of ordered) {
      const c = candidate(
        v.vendorTrunkId,
        level,
        v.sharePct !== null && v.sharePct !== undefined ? `${v.sharePct}%` : null,
      );
      candidates.push(c);
      if (marginOk(c)) {
        return {
          ...base,
          outcome: "route",
          vendor: { vendorTrunkId: c.vendorTrunkId, name: c.name, level, decidedBy },
          candidates,
        };
      }
      c.note = `margin below ${rule.margin}`;
      for (const bv of backupsOf(v.vendorTrunkId)) {
        const bc = candidate(bv.vendorTrunkId, level, `backup for ${c.name}${bv.sharePct ? ` (${bv.sharePct}%)` : ""}`);
        candidates.push(bc);
        if (marginOk(bc))
          return {
            ...base,
            outcome: "route",
            vendor: { vendorTrunkId: bc.vendorTrunkId, name: bc.name, level, decidedBy },
            candidates,
          };
        bc.note = `${bc.note}; margin below ${rule.margin}`;
      }
    }
  }
  for (const v of backups) {
    const c = candidate(v.vendorTrunkId, v.level, "backup route");
    candidates.push(c);
    if (marginOk(c))
      return {
        ...base,
        outcome: "route",
        vendor: { vendorTrunkId: c.vendorTrunkId, name: c.name, level: v.level, decidedBy: "top_down" },
        candidates,
      };
  }
  return { ...base, outcome: "no_vendor", vendor: null, candidates };
}

/**
 * Rules that can still match a message to this destination at `now`: on, live, and (for
 * "all must match" rules) with a destination condition that passes. Running many messages
 * to one destination (Rate Lookup's routed vendor per client, §13.16) only needs these;
 * the order is kept, so routing through them gives the same answer as through all rules.
 */
/**
 * Rules indexed by destination code, built once per rules array: an inclusive code list is
 * looked up by code, everything else (all codes, patterns, exclusions, "any" matching) is
 * checked for every destination. Positions keep the evaluation order.
 */
const destIndexes = new WeakMap<object, { general: number[]; byCode: Map<string, number[]> }>();
function destIndex(rules: Rule[]) {
  let ix = destIndexes.get(rules);
  if (!ix) {
    ix = { general: [], byCode: new Map() };
    rules.forEach((r, i) => {
      if (r.matchMode === "all" && r.mccmncMode === "inclusive" && !r.mccmncPattern) {
        for (const c of new Set(r.mccmncs)) ix!.byCode.set(c, [...(ix!.byCode.get(c) ?? []), i]);
      } else ix!.general.push(i);
    });
    destIndexes.set(rules, ix);
  }
  return ix;
}

export function rulesForDestination<R extends Rule>(rules: R[], mccmnc: string, now: number): R[] {
  const ix = destIndex(rules);
  const hits = [...ix.general, ...(ix.byCode.get(mccmnc) ?? [])];
  return [...new Set(hits)]
    .sort((a, b) => a - b)
    .map((i) => rules[i]!)
    .filter((r) => {
      if (r.status !== "active") return false;
      const t = liveWindow(r);
      if (!(t[0] <= now && now < t[1])) return false;
      if (r.matchMode !== "all" || (r.mccmncMode === "all" && !r.mccmncPattern)) return true;
      if (r.mccmncPattern) return regex(r.mccmncPattern, mccmnc);
      return inMode(r.mccmncMode, destinationHit(r.mccmncs, mccmnc));
    });
}
