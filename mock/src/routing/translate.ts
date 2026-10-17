// Translation engine (§6.4, §13.2 Test): runs a sample message through translation rules and
// reports every check and change. Pure: lists, the receiver's network and randomness come in
// through the context, so the same code serves the rule Test, the trunk Rules tab Test and tests.
import type {
  DlrMapEntry,
  MessageState,
  TestMessage,
  TranslationRuleFields,
  TranslationStep,
  TranslationTestResult,
} from "@sms/contract";

export type EngineRule = Required<TranslationRuleFields> & { id: number };

export interface EngineContext {
  /** Live entries per number list id. */
  lists: Map<number, string[]>;
  /** MCCMNC code of a receiver number (dial-code prefix lookup), or null. */
  mccmncOf: (receiver: string) => string | null;
  now: Date;
  /** 0 <= x < 1, for Random Number and Sender ID Template. */
  rand: () => number;
}

type Check = TranslationStep["checks"][number];
type FieldChange = TranslationStep["changes"][number];

/** Compiles a pattern; invalid ones are reported by the caller. */
export function compile(pattern: string, flags = ""): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function initialState(m: TestMessage, ctx: EngineContext): MessageState {
  return {
    sender: m.sender,
    receiver: m.receiver,
    text: m.text,
    senderTon: m.senderTon ?? null,
    senderNpi: m.senderNpi ?? null,
    destTon: null,
    destNpi: null,
    billingType: null,
    registeredDelivery: null,
    dlrStatus: m.dlrStatus ?? null,
    dlrError: m.dlrError ?? null,
    mccmnc: ctx.mccmncOf(m.receiver),
  };
}

function patternCheck(name: string, pattern: string | null, negate: boolean, value: string): Check | null {
  if (!pattern) return null;
  const re = compile(pattern);
  if (!re) return { condition: name, ok: false, detail: `invalid pattern ${pattern}` };
  const hit = re.test(value);
  return {
    condition: name,
    ok: hit !== negate,
    detail: `${JSON.stringify(value)} ${hit ? "matches" : "does not match"} ${negate ? "not " : ""}${pattern}`,
  };
}

/** A list entry matches the value exactly; in a Sender ID Template entry each {n} stands for one digit. */
export function entryMatches(entry: string, value: string): boolean {
  if (!entry.includes("{n}")) return entry === value;
  const re = entry
    .split("{n}")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[0-9]");
  return new RegExp(`^${re}$`).test(value);
}

function listCheck(name: string, id: number | null, negate: boolean, value: string, ctx: EngineContext): Check | null {
  if (id === null) return null;
  const hit = (ctx.lists.get(id) ?? []).some((e) => entryMatches(e, value));
  return {
    condition: name,
    ok: hit !== negate,
    detail: `${JSON.stringify(value)} is ${hit ? "" : "not "}in list #${id}${negate ? " (Not Match)" : ""}`,
  };
}

function lengthCheck(name: string, value: string, min: number, max: number): Check | null {
  if (min <= 0 && max >= 20) return null;
  const n = value.length;
  return { condition: name, ok: n >= min && n <= max, detail: `length ${n}, allowed ${min}-${max}` };
}

/** The conditions of one rule on the current state. */
export function ruleChecks(rule: EngineRule, s: MessageState, ctx: EngineContext): Check[] {
  const checks: (Check | null)[] = [
    rule.startsAt && new Date(rule.startsAt) > ctx.now
      ? { condition: "Start time", ok: false, detail: `starts ${rule.startsAt}` }
      : null,
    rule.stopsAt && new Date(rule.stopsAt) <= ctx.now
      ? { condition: "Stop time", ok: false, detail: `stopped ${rule.stopsAt}` }
      : null,
    patternCheck("Sender ID", rule.senderPattern, rule.senderPatternNegate, s.sender),
    patternCheck("Receiver ID", rule.receiverPattern, rule.receiverPatternNegate, s.receiver),
    rule.mccmncs.length
      ? (() => {
          const code = s.mccmnc;
          const hit = code !== null && rule.mccmncs.some((c) => (c.length === 3 ? code.startsWith(c) : code === c));
          return {
            condition: "MCCMNC",
            ok: hit !== rule.mccmncNegate,
            detail: `${code ?? "unknown network"} ${hit ? "is" : "is not"} in ${rule.mccmncs.slice(0, 5).join(", ")}${
              rule.mccmncs.length > 5 ? ` +${rule.mccmncs.length - 5}` : ""
            }${rule.mccmncNegate ? " (Not Match)" : ""}`,
          };
        })()
      : null,
    patternCheck("Message Body Text", rule.contentPattern, rule.contentPatternNegate, s.text),
    listCheck("Sender ID List", rule.senderListId, rule.senderListNegate, s.sender, ctx),
    listCheck("Receiver ID List", rule.receiverListId, rule.receiverListNegate, s.receiver, ctx),
    lengthCheck("Sender ID length", s.sender, rule.senderMinLength, rule.senderMaxLength),
    lengthCheck("Receiver ID length", s.receiver, rule.receiverMinLength, rule.receiverMaxLength),
  ];
  return checks.filter((c): c is Check => c !== null);
}

const pick = <T>(xs: T[], ctx: EngineContext) => xs[Math.floor(ctx.rand() * xs.length)]!;

/** Applies a Left/Right Strip, Prepend, Append or Translation ("from=to" prefix swap). */
export function convert(kind: string, value: string | null, input: string): string {
  const v = value ?? "";
  switch (kind) {
    case "left_strip":
      return input.slice(Math.max(0, Number(v) || 0));
    case "right_strip":
      return input.slice(0, Math.max(0, input.length - (Number(v) || 0)));
    case "prepend":
      return v + input;
    case "append":
      return input + v;
    case "translation": {
      const at = v.indexOf("=");
      if (at < 0) return input;
      const from = v.slice(0, at);
      return input.startsWith(from) ? v.slice(at + 1) + input.slice(from.length) : input;
    }
    default:
      return input;
  }
}

/** Content rewrite: replace the Regex Index group (or the whole match), then the MSG Template. */
export function rewriteText(rule: EngineRule, text: string): string {
  let out = text;
  if (rule.contentRegex && rule.contentReplacement !== null) {
    const re = compile(rule.contentRegex, "g");
    if (re) {
      const idx = rule.contentRegexIndex;
      out = out.replace(re, (match: string, ...rest: unknown[]) => {
        if (!idx) return rule.contentReplacement!;
        const groups = rest.slice(0, -2) as (string | undefined)[];
        const g = groups[idx - 1];
        if (g === undefined) return match;
        const at = match.indexOf(g);
        return match.slice(0, at) + rule.contentReplacement! + match.slice(at + g.length);
      });
    }
  }
  if (rule.msgTemplate) out = rule.msgTemplate.replaceAll("{text}", out);
  return out;
}

function mapDlr(map: DlrMapEntry[], status: string | null, error: string | null) {
  if (status === null) return null;
  const hit = map.find(
    (m) => m.fromStatus.toUpperCase() === status.toUpperCase() && (m.fromError === null || m.fromError === error),
  );
  return hit ? { status: hit.toStatus, error: hit.toError ?? error } : null;
}

/** Runs one rule on the state. `continueAfter` is the trunk's setting (default: the rule's own). */
export function runRule(
  rule: EngineRule,
  state: MessageState,
  ctx: EngineContext,
  continueAfter = rule.continueAfter,
): { step: TranslationStep; state: MessageState } {
  const checks = ruleChecks(rule, state, ctx);
  const matched = checks.every((c) => c.ok);
  const step: TranslationStep = {
    ruleId: rule.id,
    name: rule.name,
    matched,
    fired: false,
    blocked: false,
    checks,
    changes: [],
    continueAfter,
  };
  if (!matched) return { step, state };
  if (rule.action === "block") {
    step.blocked = step.fired = true;
    return { step, state };
  }
  const next: MessageState = { ...state };
  const set = <K extends keyof MessageState>(field: K, value: MessageState[K]) => {
    if (value === next[field]) return;
    step.changes.push({
      field,
      before: next[field] === null ? null : String(next[field]),
      after: value === null ? null : String(value),
    } satisfies FieldChange);
    next[field] = value;
  };
  const sc = rule.senderConversion;
  if (sc === "random_number" || sc === "sender_id_template") {
    const entries = rule.senderConversionListId === null ? [] : (ctx.lists.get(rule.senderConversionListId) ?? []);
    if (entries.length) {
      const picked = pick(entries, ctx);
      set(
        "sender",
        sc === "random_number" ? picked : picked.replace(/\{n\}/g, () => String(Math.floor(ctx.rand() * 10))),
      );
    }
  } else if (sc) set("sender", convert(sc, rule.senderConversionValue, next.sender));
  if (rule.receiverConversion) {
    set("receiver", convert(rule.receiverConversion, rule.receiverConversionValue, next.receiver));
    set("mccmnc", ctx.mccmncOf(next.receiver));
  }
  if (rule.senderTon !== null) set("senderTon", rule.senderTon);
  if (rule.senderNpi !== null) set("senderNpi", rule.senderNpi);
  if (rule.destTon !== null) set("destTon", rule.destTon);
  if (rule.destNpi !== null) set("destNpi", rule.destNpi);
  if (rule.billingType !== null) set("billingType", rule.billingType);
  if (rule.registeredDelivery !== null) set("registeredDelivery", rule.registeredDelivery);
  const dlr = mapDlr(rule.dlrMap, next.dlrStatus, next.dlrError);
  if (dlr) {
    set("dlrStatus", dlr.status);
    set("dlrError", dlr.error);
  }
  set("text", rewriteText(rule, next.text));
  step.fired = step.changes.length > 0;
  return { step, state: next };
}

/** Runs rules in order; a block ends the run, and so does a matched rule set to Stop. */
export function runRules(
  rules: { rule: EngineRule; continueAfter?: boolean }[],
  message: TestMessage,
  ctx: EngineContext,
): TranslationTestResult {
  const before = initialState(message, ctx);
  let state = before;
  const steps: TranslationStep[] = [];
  let blocked = false;
  for (const { rule, continueAfter } of rules) {
    const r = runRule(rule, state, ctx, continueAfter ?? rule.continueAfter);
    steps.push(r.step);
    state = r.state;
    if (r.step.blocked) {
      blocked = true;
      break;
    }
    if (r.step.matched && !r.step.continueAfter) break;
  }
  return { before, after: state, blocked, steps };
}
