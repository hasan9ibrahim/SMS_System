// Route rule model for the Route Rules page (§6.3, §13.8, §13.9, §13.24, §13.27, §15.4):
// the editable input from a record, and the condition chips of the Conditions section.
import type { FilterCondition, RouteRuleDetail, RouteRuleInput, RouteVendor } from "@sms/contract";

const INPUT_KEYS = [
  "name",
  "priority",
  "status",
  "startsAt",
  "stopsAt",
  "groupId",
  "nextGroupId",
  "continueRouting",
  "matchMode",
  "comment",
  "categoryMode",
  "categoryIds",
  "customerTrunkMode",
  "customerTrunkIds",
  "mccmncMode",
  "mccmncs",
  "mccmncPattern",
  "senderPattern",
  "senderPatternNegate",
  "senderMatchCase",
  "receiverPattern",
  "receiverPatternNegate",
  "contentPattern",
  "contentPatternNegate",
  "senderListId",
  "receiverListId",
  "tps",
  "revenue",
  "hlrPorted",
  "routeType",
  "huntPolicy",
  "enableBackupRoutes",
  "vendorCategoryMode",
  "vendorCategoryIds",
  "vendorTrunkMode",
  "vendorTrunkIds",
  "maxRouteLevel",
  "margin",
  "qbrFormula",
  "skipVendorAtTpsPct",
  "lcrProfileId",
  "dlrTargetPct",
  "hlrAction",
  "denyMultipart",
  "threshold",
  "thresholdInterval",
  "vendors",
  "whitelists",
] as const satisfies readonly (keyof RouteRuleInput)[];

/** The full editable input of a rule (PUT replaces the rule; each save is one change, §13.10). */
export function toInput(rule: RouteRuleDetail, patch: Partial<RouteRuleInput> = {}): RouteRuleInput {
  const out: Record<string, unknown> = {};
  for (const k of INPUT_KEYS) out[k] = rule[k];
  return { ...(out as unknown as RouteRuleInput), ...patch };
}

export type ConditionKey =
  | "trunk"
  | "category"
  | "destination"
  | "sender"
  | "receiver"
  | "content"
  | "tps"
  | "revenue"
  | "time"
  | "hlrPorted"
  | "hlrAction"
  | "multipart";

export const CONDITION_LABELS: Record<ConditionKey, string> = {
  trunk: "Trunk",
  category: "Category",
  destination: "Destination",
  sender: "Sender",
  receiver: "Receiver",
  content: "Content",
  tps: "TPS",
  revenue: "Revenue/msg",
  time: "Time",
  hlrPorted: "HLR ported",
  hlrAction: "HLR action",
  multipart: "Multipart",
};

export interface Chip {
  key: ConditionKey;
  field: string;
  op: string;
  value: string;
}

type Named = { id: number; name: string };
const nameOf = (list: Named[], id: number | null | undefined) =>
  id === null || id === undefined ? "" : (list.find((x) => x.id === id)?.name ?? `#${id}`);
const names = (list: Named[], ids: number[], max = 4) =>
  ids
    .slice(0, max)
    .map((id) => nameOf(list, id))
    .join(", ") + (ids.length > max ? ` +${ids.length - max}` : "");
const modeOp = (mode: string) => (mode === "exclusive" ? "not in" : "in");
const opText = (op: string) => ({ ">=": "≥", "<=": "≤" })[op] ?? op;
const num = (v: number) => String(+v.toFixed(4));
const range = (op: string, v: number, v2: number | null | undefined, fmt = num) =>
  op === "between" ? `${fmt(v)} – ${fmt(v2 ?? v)}` : fmt(v);

const SCOPE: Record<string, string> = {
  customer_trunk: "per trunk",
  customer_enterprise: "per customer",
  destination: "per destination",
  sender_id: "per sender",
  rule: "per rule",
};
const PERIOD: Record<string, string> = {
  "15m": "15 min",
  "60m": "60 min",
  today: "today",
  week: "this week",
  month: "this month",
  billing_cycle: "billing cycle",
};

const fmtTime = (t: string) => t.slice(0, 16).replace("T", " ");
/** Start and stop at the defaults (now → +10 years, §6.3) read as "always". */
export function timeText(startsAt: string, stopsAt: string, now = Date.now()): string {
  const started = Date.parse(startsAt) <= now;
  const farStop = Date.parse(stopsAt) - now > 5 * 365 * 86_400_000;
  if (started && farStop) return "always";
  if (started) return `until ${fmtTime(stopsAt)}`;
  if (farStop) return `from ${fmtTime(startsAt)}`;
  return `${fmtTime(startsAt)} – ${fmtTime(stopsAt)}`;
}

/** The conditions a rule sets, as chips "field op value" (§15.4). */
export function conditionChips(
  rule: RouteRuleDetail,
  now = Date.now(),
  /** Codes by name ("Country · Network (code)"; team trial round 1); codes as they are without it. */
  destinationText?: (codes: string[]) => string,
): Chip[] {
  const l = rule.labels;
  const chips: Chip[] = [];
  if (rule.customerTrunkMode !== "all")
    chips.push({
      key: "trunk",
      field: "Trunk",
      op: modeOp(rule.customerTrunkMode),
      value: names(l.customerTrunks, rule.customerTrunkIds),
    });
  if (rule.categoryMode !== "all")
    chips.push({
      key: "category",
      field: "Category",
      op: modeOp(rule.categoryMode),
      value: names(l.categories, rule.categoryIds),
    });
  if (rule.mccmncMode !== "all" || rule.mccmncPattern) {
    const parts = [
      ...(rule.mccmncMode !== "all"
        ? [
            destinationText
              ? destinationText(rule.mccmncs)
              : rule.mccmncs.slice(0, 6).join(", ") + (rule.mccmncs.length > 6 ? ` +${rule.mccmncs.length - 6}` : ""),
          ]
        : []),
      ...(rule.mccmncPattern ? [`/${rule.mccmncPattern}/`] : []),
    ];
    chips.push({
      key: "destination",
      field: "Destination",
      op: rule.mccmncMode === "exclusive" ? "not in" : rule.mccmncMode === "all" ? "matches" : "in",
      value: parts.join(" · "),
    });
  }
  const pattern = (
    key: "sender" | "receiver" | "content",
    p: string | null,
    negate: boolean,
    listId?: number | null,
    anyCase = false,
  ) => {
    const list = listId ? nameOf(l.numberLists, listId) : "";
    if (!p && !list) return;
    // A pattern built from a value list reads as that list ("is one of BANK, OTP"; team trial round 1).
    const parsed = p ? parsePattern(p) : null;
    const listed = parsed && parsed.kind !== "regex";
    chips.push({
      key,
      field: CONDITION_LABELS[key],
      op: listed ? `${negate ? "not " : ""}${PATTERN_KINDS[parsed.kind]}` : negate ? "not" : "matches",
      value: [listed ? parsed.values.join(", ") : p, list && `list ${list}`, anyCase && "any case"]
        .filter(Boolean)
        .join(" · "),
    });
  };
  // Sender conditions match the exact capitals unless Case sensitive is off (team trial round 1).
  pattern("sender", rule.senderPattern, rule.senderPatternNegate, rule.senderListId, rule.senderMatchCase === false);
  pattern("receiver", rule.receiverPattern, rule.receiverPatternNegate, rule.receiverListId);
  pattern("content", rule.contentPattern, rule.contentPatternNegate);
  if (rule.tps) {
    const t = rule.tps;
    const release = t.releasePct ? ` · release ${num(t.value * (1 - t.releasePct / 100))}` : "";
    chips.push({
      key: "tps",
      field: `TPS ${t.windowS ?? 5}s`,
      op: opText(t.op),
      value: `${range(t.op, t.value, t.value2)}${release}${t.scope !== "customer_trunk" ? ` · ${SCOPE[t.scope]}` : ""}`,
    });
  }
  if (rule.revenue) {
    const r = rule.revenue;
    const v = range(r.op, r.value, r.value2, (x) => x.toFixed(3));
    const minMargin =
      r.minMargin !== null && r.minMargin !== undefined
        ? ` · margin ≥ ${r.minMarginUnit === "percent" ? `${num(r.minMargin)}%` : r.minMargin.toFixed(3)}`
        : "";
    chips.push(
      r.type === "per_message"
        ? { key: "revenue", field: "Revenue/msg", op: opText(r.op), value: `${v}${minMargin}` }
        : {
            key: "revenue",
            field: `Revenue ${PERIOD[r.period ?? "today"]}`,
            op: opText(r.op),
            value: `${v} ${SCOPE[r.scope ?? "customer_trunk"]}${minMargin}`,
          },
    );
  }
  chips.push({ key: "time", field: "Time", op: "", value: timeText(rule.startsAt, rule.stopsAt, now) });
  if (rule.hlrPorted !== null)
    chips.push({ key: "hlrPorted", field: "HLR ported", op: "=", value: rule.hlrPorted ? "yes" : "no" });
  if (rule.hlrAction)
    chips.push({
      key: "hlrAction",
      field: "HLR action",
      op: "",
      value: `${l.hlrPolicies.find((p) => p.id === rule.hlrAction!.policyId)?.name ?? `policy #${rule.hlrAction.policyId}`} · ${
        rule.hlrAction.customerTrunkIds.length ? names(l.customerTrunks, rule.hlrAction.customerTrunkIds) : "all trunks"
      }`,
    });
  if (rule.denyMultipart) chips.push({ key: "multipart", field: "Multipart", op: "", value: "denied" });
  return chips;
}

/** Input that clears one condition (the chip's ×). */
export function clearCondition(key: ConditionKey, rule: RouteRuleDetail): Partial<RouteRuleInput> {
  switch (key) {
    case "trunk":
      return { customerTrunkMode: "all", customerTrunkIds: [] };
    case "category":
      return { categoryMode: "all", categoryIds: [] };
    case "destination":
      return { mccmncMode: "all", mccmncs: [], mccmncPattern: null };
    case "sender":
      return { senderPattern: null, senderPatternNegate: false, senderListId: null, senderMatchCase: true };
    case "receiver":
      return { receiverPattern: null, receiverPatternNegate: false, receiverListId: null };
    case "content":
      return { contentPattern: null, contentPatternNegate: false };
    case "tps":
      return { tps: null };
    case "revenue":
      return { revenue: null };
    case "time": {
      const now = new Date();
      return {
        startsAt: rule.startsAt < now.toISOString() ? rule.startsAt : now.toISOString(),
        stopsAt: new Date(now.getTime() + 10 * 365.25 * 86_400_000).toISOString(),
      };
    }
    case "hlrPorted":
      return { hlrPorted: null };
    case "hlrAction":
      return { hlrAction: null };
    case "multipart":
      return { denyMultipart: false };
  }
}

/** Conditions not yet on the rule, for "+ Add condition". Time is always shown. */
export function missingConditions(rule: RouteRuleDetail): ConditionKey[] {
  const present = new Set(conditionChips(rule).map((c) => c.key));
  return (Object.keys(CONDITION_LABELS) as ConditionKey[]).filter((k) => k !== "time" && !present.has(k));
}

/** Shares of each level must add up to 100 under the percentage hunt policy (§6.3). */
export function shareProblems(vendors: RouteVendor[], huntPolicy: string): string[] {
  if (huntPolicy !== "percentage") return [];
  const sums = new Map<number, number>();
  for (const v of vendors) if (!v.isBackup) sums.set(v.level, (sums.get(v.level) ?? 0) + (v.sharePct ?? 0));
  return [...sums]
    .filter(([, s]) => s !== 100)
    .sort(([a], [b]) => a - b)
    .map(([level, s]) => `Level ${level} shares add up to ${s}%, not 100%.`);
}

/** Each vendor's backups: all chosen, and their shares add up to 100 when there are several. */
export function backupProblems(vendors: RouteVendor[], nameOf: (id: number) => string): string[] {
  const by = new Map<number, RouteVendor[]>();
  for (const v of vendors)
    if (v.isBackup && v.backupForVendorTrunkId)
      by.set(v.backupForVendorTrunkId, [...(by.get(v.backupForVendorTrunkId) ?? []), v]);
  const out: string[] = [];
  for (const [id, bs] of by) {
    if (bs.some((b) => !b.vendorTrunkId)) out.push(`Choose every backup of ${nameOf(id)}.`);
    const sum = bs.reduce((n, b) => n + (b.sharePct ?? 0), 0);
    if (bs.length > 1 && sum !== 100) out.push(`Backups of ${nameOf(id)} add up to ${sum}%, not 100%.`);
  }
  return out;
}

export const ROUTE_TYPES = [
  { value: "static", label: "Static", tone: "neutral" },
  { value: "dynamic", label: "Least cost", tone: "accent" },
  { value: "qbr", label: "Quality", tone: "good" },
  { value: "block", label: "Block", tone: "error" },
] as const;

export const routeTypeOf = (v: string) => ROUTE_TYPES.find((t) => t.value === v) ?? ROUTE_TYPES[0];

/** Compact counts: 28 200 → "28.2k" (§15.4 selection summary and 24h column). */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** One time bucket of a rule's traffic per vendor trunk (team trial round 1). */
export interface VendorBucket {
  at: string;
  messages: number;
  vendors?: { vendorTrunkId: number; messages: number }[];
}

/**
 * When the main vendor (the one carrying the most messages) changed over the window: the first bucket,
 * then every bucket where another vendor took over. Buckets without traffic are skipped.
 */
export function vendorSwitches(
  series: readonly VendorBucket[],
): { at: string; vendorTrunkId: number; sharePct: number; untilAt: string | null }[] {
  const out: { at: string; vendorTrunkId: number; sharePct: number; untilAt: string | null }[] = [];
  for (const b of series) {
    const top = [...(b.vendors ?? [])].sort((x, y) => y.messages - x.messages)[0];
    if (!top || !b.messages) continue;
    const last = out[out.length - 1];
    if (last?.vendorTrunkId === top.vendorTrunkId) continue;
    if (last) last.untilAt = b.at;
    out.push({
      at: b.at,
      vendorTrunkId: top.vendorTrunkId,
      sharePct: Math.round((top.messages / b.messages) * 1000) / 10,
      untilAt: null,
    });
  }
  return out;
}

/**
 * Sender, receiver and content conditions without regex (team trial round 1): a list of values that
 * becomes the pattern the rule stores (the contract and the switch keep one regex). "Is one of" =
 * ^(?:A|B)$, "starts with" = ^(?:A|B), "contains" = (?:A|B). Receiver and content ignore case in the switch;
 * sender conditions match the exact capitals unless the rule's Case sensitive is off (team trial round 1).
 */
export type PatternKind = "is" | "starts" | "contains" | "regex";
export const PATTERN_KINDS: Record<PatternKind, string> = {
  is: "is one of",
  starts: "starts with",
  contains: "contains",
  regex: "matches",
};

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function buildPattern(kind: Exclude<PatternKind, "regex">, values: readonly string[]): string | null {
  const vs = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (!vs.length) return null;
  const body = `(?:${vs.map(escapeRe).join("|")})`;
  return kind === "is" ? `^${body}$` : kind === "starts" ? `^${body}` : body;
}

/** Splits on | that are not escaped. */
function alternatives(body: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\") {
      cur += ch + (body[i + 1] ?? "");
      i++;
    } else if (ch === "|") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A pattern back into its value list when it has one of the built shapes; anything else is regex. */
export function parsePattern(pattern: string): { kind: PatternKind; values: string[] } {
  const shapes: [PatternKind, RegExp][] = [
    ["is", /^\^\(\?:(.*)\)\$$/s],
    ["starts", /^\^\(\?:(.*)\)$/s],
    ["contains", /^\(\?:(.*)\)$/s],
  ];
  for (const [kind, re] of shapes) {
    const m = pattern.match(re);
    if (!m) continue;
    const parts = alternatives(m[1]!);
    const values = parts?.map((p) => p.replace(/\\(.)/g, "$1"));
    // Only plain text: every value escapes back to exactly what was stored.
    if (values && values.every((v, i) => v !== "" && escapeRe(v) === parts![i])) return { kind, values };
  }
  return { kind: "regex", values: [] };
}

/** Trunk pickers follow the rule's product categories (team trial round 1): only Promo trunks for a Promo rule. */
export function categoryFilter(mode: string, ids: readonly number[]): FilterCondition[] {
  if (mode === "all" || !ids.length) return [];
  return [{ field: "categoryId", op: mode === "exclusive" ? "not_in" : "in", values: ids.map(String) }];
}

/**
 * Margin as typed (team trial round 1): "0.002" is an amount in the platform currency, "5%" a percentage
 * of the sell rate; a minus sign makes either negative. Null when it is not a number.
 */
export function parseMargin(text: string): { value: number; type: "amount" | "percent" } | null {
  const t = text.trim().replace(",", ".");
  const m = t.match(/^([+-−]?)\s*(\d+(?:\.\d+)?|\.\d+)\s*(%?)$/);
  if (!m) return t === "" ? { value: 0, type: "amount" } : null;
  const value = Number(m[2]) * (m[1] === "-" || m[1] === "−" ? -1 : 1);
  return { value, type: m[3] ? "percent" : "amount" };
}

export const formatMargin = (value: number | null | undefined, type: string | null | undefined) =>
  value === null || value === undefined ? "" : `${value}${type === "percent" ? "%" : ""}`;
