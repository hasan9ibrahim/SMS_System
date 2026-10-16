// Route rule evaluation for the rule Test and the Route Simulator (§6.3, §13.8, §13.9,
// §13.24, §13.27). Pure: the caller loads the rule, the message context and vendor costs.
// The switch evaluates the same way: conditions (all or any must match), then the vendor:
// number whitelist first, then the warm-up threshold, then the normal split / LCR / QBR.
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
  /** Customer rate for the message, base currency (§13.9 per message). */
  sellRate: number | null;
  accumulatedRevenue: number | null;
  hlrPorted: boolean | null;
  warmupSent: number;
  /** Entries of the number lists the rule uses. */
  listHas: (listId: number, value: string) => boolean;
}

export interface VendorOption {
  vendorTrunkId: number;
  name: string;
  /** Buy rate for the destination in base currency; null when the vendor has none. */
  cost: number | null;
  /** Recent delivered %, for QBR ordering. */
  dlr: number | null;
  categoryId: number | null;
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
  | "whitelists"
  | "vendorTrunkMode"
  | "vendorTrunkIds"
  | "vendorCategoryMode"
  | "vendorCategoryIds"
>;

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

/** A 3-digit code covers every network of the country (§6.1 All networks). */
export const destinationHit = (codes: string[], mccmnc: string) =>
  codes.some((c) => c === mccmnc || (c.length === 3 && mccmnc.startsWith(c)));

function regex(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
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
    const listed = rule.vendors.map((v) => v.vendorTrunkId);
    const inScope = (o: VendorOption) =>
      (listed.length
        ? listed.includes(o.vendorTrunkId)
        : inMode(rule.vendorTrunkMode, rule.vendorTrunkIds.includes(o.vendorTrunkId))) &&
      inMode(rule.vendorCategoryMode, o.categoryId !== null && rule.vendorCategoryIds.includes(o.categoryId));
    const pool = [...options.values()].filter((o) => o.cost !== null && inScope(o));
    pool.sort((a, b) =>
      rule.routeType === "qbr" ? (b.dlr ?? -1) - (a.dlr ?? -1) || a.cost! - b.cost! : a.cost! - b.cost!,
    );
    const candidates = pool.slice(0, 10).map((o, i) => candidate(o.vendorTrunkId, i + 1, null));
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
  const backups = rule.vendors.filter((v) => v.isBackup);
  const candidates: RouteCandidate[] = [];
  for (const level of levels) {
    const at = rule.vendors.filter((v) => v.level === level && !v.isBackup);
    let ordered = at;
    let decidedBy: "percentage" | "top_down" | "round_robin" | "qbr" = rule.huntPolicy;
    if (rule.routeType === "qbr") {
      ordered = [...at].sort(
        (a, b) => (options.get(b.vendorTrunkId)?.dlr ?? -1) - (options.get(a.vendorTrunkId)?.dlr ?? -1),
      );
      decidedBy = "qbr";
    } else if (rule.huntPolicy === "percentage") {
      const b = bucket(m.receiver);
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
