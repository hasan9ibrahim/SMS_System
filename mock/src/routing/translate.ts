// Translation engine (§6.4, §13.2 Test): runs a sample message through translation rules and
// reports every check and change. Pure: lists, the receiver's network and randomness come in
// through the context, so the same code serves the rule Test, the trunk Rules tab Test and tests.
import { keywordPattern } from "./evaluate.js";
import type {
  ContentWordRule,
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
  /** Sender ID template lists: the content templates of each Sender ID (team trial round 1). */
  templates?: Map<number, Map<string, string[]>>;
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

/** `matchCase` false = any case (the Sender ID conditions with Case sensitive off, team trial round 1). */
function patternCheck(
  name: string,
  pattern: string | null,
  negate: boolean,
  value: string,
  matchCase = true,
): Check | null {
  if (!pattern) return null;
  const re = compile(keywordPattern(pattern) ?? pattern, matchCase ? "" : "i");
  if (!re) return { condition: name, ok: false, detail: `invalid pattern ${pattern}` };
  const hit = re.test(value);
  return {
    condition: name,
    ok: hit !== negate,
    detail: `${JSON.stringify(value)} ${hit ? "matches" : "does not match"} ${negate ? "not " : ""}${pattern}${
      matchCase ? "" : " (any case)"
    }`,
  };
}

/**
 * A list entry matches the value exactly; in a Sender ID Template entry each {n} stands for one digit.
 * `matchCase` false compares any case (Sender ID list with Case sensitive off, team trial round 1).
 */
export function entryMatches(entry: string, value: string, matchCase = true): boolean {
  if (!entry.includes("{n}")) return matchCase ? entry === value : entry.toLowerCase() === value.toLowerCase();
  const re = entry
    .split("{n}")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[0-9]");
  return new RegExp(`^${re}$`, matchCase ? "" : "i").test(value);
}

function listCheck(
  name: string,
  id: number | null,
  negate: boolean,
  value: string,
  ctx: EngineContext,
  matchCase = true,
): Check | null {
  if (id === null) return null;
  const hit = (ctx.lists.get(id) ?? []).some((e) => entryMatches(e, value, matchCase));
  return {
    condition: name,
    ok: hit !== negate,
    detail: `${JSON.stringify(value)} is ${hit ? "" : "not "}in list #${id}${negate ? " (Not Match)" : ""}${
      matchCase ? "" : " (any case)"
    }`,
  };
}

function lengthCheck(name: string, value: string, min: number, max: number): Check | null {
  if (min <= 0 && max >= 20) return null;
  const n = value.length;
  return { condition: name, ok: n >= min && n <= max, detail: `length ${n}, allowed ${min}-${max}` };
}

/** The conditions of one rule on the current state. */
export function ruleChecks(rule: EngineRule, s: MessageState, ctx: EngineContext): Check[] {
  // Case sensitive for the Sender ID conditions: on unless switched off (team trial round 1).
  const senderCase = rule.senderMatchCase !== false;
  const checks: (Check | null)[] = [
    rule.startsAt && new Date(rule.startsAt) > ctx.now
      ? { condition: "Start time", ok: false, detail: `starts ${rule.startsAt}` }
      : null,
    rule.stopsAt && new Date(rule.stopsAt) <= ctx.now
      ? { condition: "Stop time", ok: false, detail: `stopped ${rule.stopsAt}` }
      : null,
    patternCheck("Sender ID", rule.senderPattern, rule.senderPatternNegate, s.sender, senderCase),
    patternCheck("Receiver ID", rule.receiverPattern, rule.receiverPatternNegate, s.receiver),
    rule.mccmncs.length || rule.mccmncPattern
      ? (() => {
          const code = s.mccmnc;
          // Exact codes: a 3-digit code is the "All networks" entry only (team trial round 1); or the MCCMNC
          // regex, as on route rules (team trial round 2). Either one is a hit.
          const inList = code !== null && rule.mccmncs.includes(code);
          const re = rule.mccmncPattern ? compile(rule.mccmncPattern, "") : null;
          if (rule.mccmncPattern && !re)
            return { condition: "MCCMNC", ok: false, detail: `invalid pattern ${rule.mccmncPattern}` };
          const hit = inList || (code !== null && !!re?.test(code));
          const what = [
            rule.mccmncs.length
              ? `in ${rule.mccmncs.slice(0, 5).join(", ")}${rule.mccmncs.length > 5 ? ` +${rule.mccmncs.length - 5}` : ""}`
              : "",
            rule.mccmncPattern ? `matching ${rule.mccmncPattern}` : "",
          ]
            .filter(Boolean)
            .join(" or ");
          return {
            condition: "MCCMNC",
            ok: hit !== rule.mccmncNegate,
            detail: `${code ?? "unknown network"} ${hit ? "is" : "is not"} ${what}${rule.mccmncNegate ? " (Not Match)" : ""}`,
          };
        })()
      : null,
    patternCheck("Message Body Text", rule.contentPattern, rule.contentPatternNegate, s.text),
    listCheck("Sender ID List", rule.senderListId, rule.senderListNegate, s.sender, ctx, senderCase),
    listCheck("Receiver ID List", rule.receiverListId, rule.receiverListNegate, s.receiver, ctx),
    lengthCheck("Sender ID length", s.sender, rule.senderMinLength, rule.senderMaxLength),
    lengthCheck("Receiver ID length", s.receiver, rule.receiverMinLength, rule.receiverMaxLength),
  ];
  return checks.filter((c): c is Check => c !== null);
}

const pick = <T>(xs: T[], ctx: EngineContext) => xs[Math.floor(ctx.rand() * xs.length)]!;

/**
 * Applies a Left/Right Strip, Prepend, Append, Translation or Regex Replace (`value` = pattern,
 * `replacement` = what each match becomes, $1..$9 = groups). Translation takes only the new value: the
 * sender or receiver the conditions matched becomes it (team trial round 1); "from=to" swaps a prefix.
 */
export function convert(kind: string, value: string | null, input: string, replacement: string | null = null): string {
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
      if (at < 0) return v || input;
      const from = v.slice(0, at);
      return input.startsWith(from) ? v.slice(at + 1) + input.slice(from.length) : input;
    }
    case "regex_replace": {
      const re = compile(v, "g");
      return re ? input.replace(re, replacement ?? "") : input;
    }
    default:
      return input;
  }
}

/** The code in a message (the first run of 4-8 digits), as {code} in a Sender ID template's content. */
export const codeIn = (text: string) => /(?<!\d)\d{4,8}(?!\d)/.exec(text)?.[0] ?? "";

/** A Sender ID template's content: {code} = the code in the original text, {text} = the original text. */
export const fillContentTemplate = (template: string, original: string) =>
  template.replaceAll("{code}", codeIn(original)).replaceAll("{text}", original);

/** Content rewrite: replace the Regex Index group (or the whole match), then the MSG Template. */
/**
 * Words or phrases replaced as typed (no regex; team trial round 1). Whole words (not part of a word) and exact case by default
 * (match case off ignores case; team trial round 1); removing a word also tidies the space it leaves.
 */
export function replaceWords(text: string, words: readonly ContentWordRule[] | null | undefined): string {
  let out = text;
  for (const w of words ?? []) {
    if (!w.find) continue;
    const esc = w.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Unicode-aware word edges, so Arabic or accented words count as words too.
    const body = w.wholeWord === false ? esc : `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`;
    const re = new RegExp(body, `gu${w.matchCase === false ? "i" : ""}`);
    out = out.replace(re, () => w.replace);
    if (!w.replace)
      out = out
        .replace(/[ \t]{2,}/g, " ")
        .replace(/ +([,.!?;:])/g, "$1")
        .trim();
  }
  return out;
}

export function rewriteText(rule: EngineRule, text: string): string {
  let out = replaceWords(text, rule.contentWords);
  if (rule.contentRegex && rule.contentReplacement !== null) {
    const re = compile(rule.contentRegex, "g");
    if (re) {
      const idx = rule.contentRegexIndex;
      out = out.replace(re, (match: string, ...rest: unknown[]) => {
        // The groups come before the match offset (a number), then the whole input.
        const groups = rest.slice(
          0,
          rest.findIndex((x) => typeof x === "number"),
        ) as (string | undefined)[];
        // Message Text can reuse what the pattern caught (team trial round 2): $1..$9 are its groups, $0 the
        // whole match; e.g. pattern ^.*?([0-9]{4,8}).*$ with Message Text "PIN $1 for you" keeps only the code.
        const text = rule.contentReplacement!.replace(/\$([0-9])/g, (_, d: string) =>
          d === "0" ? match : (groups[Number(d) - 1] ?? ""),
        );
        if (!idx) return text;
        const g = groups[idx - 1];
        if (g === undefined) return match;
        const at = match.indexOf(g);
        return match.slice(0, at) + text + match.slice(at + g.length);
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
      // A Sender ID template with content: our text, with the code taken from the original (team trial round 1).
      const contents =
        sc === "sender_id_template" ? ctx.templates?.get(rule.senderConversionListId!)?.get(picked) : undefined;
      if (contents?.length) set("text", fillContentTemplate(pick(contents, ctx), next.text));
    }
  } else if (sc) set("sender", convert(sc, rule.senderConversionValue, next.sender, rule.senderConversionReplacement));
  if (rule.receiverConversion) {
    set(
      "receiver",
      convert(rule.receiverConversion, rule.receiverConversionValue, next.receiver, rule.receiverConversionReplacement),
    );
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
