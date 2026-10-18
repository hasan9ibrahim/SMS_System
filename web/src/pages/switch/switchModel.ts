// Pure helpers for the Switch pages (§6.4, §13.2): number list types, the blank translation
// rule, form ↔ API mapping, option lists and the one-line rule summary.
import type { NumberList, TranslationRuleDetail, TranslationRuleInput, TranslationTargetInput } from "@sms/contract";

export const LIST_TYPES: { value: NumberList["listType"]; label: string }[] = [
  { value: "tag", label: "Tag" },
  { value: "random", label: "Random" },
  { value: "sender_id_template", label: "Sender ID Template" },
];

export const listTypeLabel = (t: NumberList["listType"]) => LIST_TYPES.find((x) => x.value === t)?.label ?? t;

export function listTypeHint(t: NumberList["listType"]): string {
  if (t === "random") return "Numbers of 3-20 digits a Random Number conversion picks from.";
  if (t === "sender_id_template")
    return "A Sender ID (up to 11 characters, each {n} one random digit) and, after a |, the text the message becomes: {code} is the code found in the original text, {text} the original text.";
  return "Numbers or sender IDs that rules match (Sender / Receiver ID List, whitelists).";
}

/** Pasted text → distinct trimmed values (lines, commas, semicolons or tabs). */
export function splitValues(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\r\n,;\t]+/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

export const SENDER_CONVERSIONS = [
  { value: "left_strip", label: "Left Strip" },
  { value: "right_strip", label: "Right Strip" },
  { value: "prepend", label: "Prepend" },
  { value: "append", label: "Append" },
  { value: "translation", label: "Translation" },
  { value: "regex_replace", label: "Regex Replace" },
  { value: "random_number", label: "Random Number" },
  { value: "sender_id_template", label: "Sender ID Template" },
];
export const RECEIVER_CONVERSIONS = SENDER_CONVERSIONS.slice(0, 6);
export const conversionLabel = (v: string | null) => SENDER_CONVERSIONS.find((c) => c.value === v)?.label ?? "—";

/** Hint under a conversion value, and whether the conversion takes a list instead. */
export function conversionHint(kind: string | null): string | undefined {
  if (kind === "left_strip") return "Characters to remove from the start";
  if (kind === "right_strip") return "Characters to remove from the end";
  if (kind === "prepend") return "Text added in front";
  if (kind === "append") return "Text added at the end";
  if (kind === "translation")
    return 'The new value only: what the conditions match becomes it ("from=to" still swaps a prefix)';
  if (kind === "regex_replace") return "Regular expression, e.g. ^0(\\d+)";
  return undefined;
}
/** "left strip 2", "translation 00=+", "regex replace ^0(\d+) → 44$1". */
export function conversionText(kind: string, value: string | null, replacement: string | null): string {
  const label = conversionLabel(kind).toLowerCase();
  if (kind === "regex_replace") return `${label} ${value ?? ""} → ${replacement ? replacement : "(removed)"}`;
  return value ? `${label} ${value}` : label;
}

export const usesList = (kind: string | null) => kind === "random_number" || kind === "sender_id_template";

export const TON_OPTIONS = [
  { value: 0, label: "0 Unknown" },
  { value: 1, label: "1 International" },
  { value: 2, label: "2 National" },
  { value: 3, label: "3 Network specific" },
  { value: 4, label: "4 Subscriber number" },
  { value: 5, label: "5 Alphanumeric" },
  { value: 6, label: "6 Abbreviated" },
];
export const NPI_OPTIONS = [
  { value: 0, label: "0 Unknown" },
  { value: 1, label: "1 ISDN (E.164)" },
  { value: 3, label: "3 Data (X.121)" },
  { value: 4, label: "4 Telex" },
  { value: 6, label: "6 Land mobile" },
  { value: 8, label: "8 National" },
  { value: 9, label: "9 Private" },
  { value: 10, label: "10 ERMES" },
  { value: 14, label: "14 Internet (IP)" },
  { value: 18, label: "18 WAP client ID" },
];
export const BILLING_TYPES = [
  { value: "attempt", label: "Attempt" },
  { value: "submit", label: "Submit" },
  { value: "reported", label: "Reported" },
  { value: "delivery", label: "Delivery" },
];

export function blankRule(): TranslationRuleInput {
  return {
    name: "",
    direction: null,
    action: "allow",
    status: "active",
    continueAfter: true,
    senderPattern: null,
    senderPatternNegate: false,
    receiverPattern: null,
    receiverPatternNegate: false,
    mccmncs: [],
    mccmncNegate: false,
    contentPattern: null,
    contentPatternNegate: false,
    senderListId: null,
    senderListNegate: false,
    receiverListId: null,
    receiverListNegate: false,
    senderConversion: null,
    senderConversionValue: null,
    senderConversionReplacement: null,
    senderConversionListId: null,
    receiverConversion: null,
    receiverConversionValue: null,
    receiverConversionReplacement: null,
    senderTon: null,
    senderNpi: null,
    destTon: null,
    destNpi: null,
    billingType: null,
    registeredDelivery: null,
    dlrMap: [],
    contentRegex: null,
    contentRegexIndex: null,
    contentReplacement: null,
    msgTemplate: null,
    contentWords: [],
    senderMinLength: 0,
    senderMaxLength: 20,
    receiverMinLength: 0,
    receiverMaxLength: 20,
    startsAt: null,
    stopsAt: null,
    insertAt: "bottom",
    targets: [],
  };
}

/** The editable input of a saved rule (labels and audit fields dropped). */
export function inputFromDetail(d: TranslationRuleDetail): TranslationRuleInput {
  const out = blankRule();
  for (const k of Object.keys(out) as (keyof TranslationRuleInput)[]) {
    if (k === "targets") continue;
    (out as Record<string, unknown>)[k] = d[k as keyof TranslationRuleDetail];
  }
  out.targets = d.targets.map((t) => ({ type: t.type, trunkKind: t.trunkKind, id: t.id }));
  return out;
}

/** Cleans what the form holds before saving: values a conversion does not use are dropped. */
export function toSave(v: TranslationRuleInput): TranslationRuleInput {
  return {
    ...v,
    name: v.name.trim(),
    senderConversionValue: v.senderConversion && !usesList(v.senderConversion) ? v.senderConversionValue : null,
    senderConversionListId: usesList(v.senderConversion) ? v.senderConversionListId : null,
    receiverConversionValue: v.receiverConversion ? v.receiverConversionValue : null,
    senderConversionReplacement: v.senderConversion === "regex_replace" ? (v.senderConversionReplacement ?? "") : null,
    receiverConversionReplacement:
      v.receiverConversion === "regex_replace" ? (v.receiverConversionReplacement ?? "") : null,
    contentRegexIndex: v.contentRegex ? v.contentRegexIndex : null,
    contentReplacement: v.contentRegex ? (v.contentReplacement ?? "") : null,
    // Blank rows are left out (team trial round 1).
    contentWords: (v.contentWords ?? []).filter((w) => w.find.trim() !== ""),
  };
}

export const targetKey = (t: TranslationTargetInput) => `${t.trunkKind}:${t.type}:${t.id ?? ""}`;

/** "Ingress" / "Egress" for a rule: its override, else what its targets imply (§13.2). */
export function impliedDirection(v: Pick<TranslationRuleInput, "direction" | "targets">): string {
  if (v.direction) return v.direction === "ingress" ? "Ingress" : "Egress";
  const kinds = new Set(v.targets.map((t) => t.trunkKind));
  if (kinds.size === 0) return "Implied by the trunk";
  if (kinds.size === 2) return "Ingress and egress (implied)";
  return kinds.has("customer") ? "Ingress (implied)" : "Egress (implied)";
}

/** One line: what the rule matches and does, for the detail panel and confirmations. */
export function ruleSummary(v: TranslationRuleInput): string {
  const not = (n: boolean) => (n ? "not " : "");
  const when = [
    v.senderPattern && `sender ${not(v.senderPatternNegate)}~ ${v.senderPattern}`,
    v.receiverPattern && `receiver ${not(v.receiverPatternNegate)}~ ${v.receiverPattern}`,
    v.mccmncs.length &&
      `MCCMNC ${not(v.mccmncNegate)}in ${v.mccmncs.slice(0, 3).join(", ")}${v.mccmncs.length > 3 ? "…" : ""}`,
    v.contentPattern && `text ${not(v.contentPatternNegate)}~ ${v.contentPattern}`,
    v.senderListId && `sender ${not(v.senderListNegate)}in list #${v.senderListId}`,
    v.receiverListId && `receiver ${not(v.receiverListNegate)}in list #${v.receiverListId}`,
  ].filter(Boolean);
  const does =
    v.action === "block"
      ? ["block"]
      : [
          v.senderConversion &&
            `sender ${conversionText(v.senderConversion, v.senderConversionValue, v.senderConversionReplacement)}`,
          v.receiverConversion &&
            `receiver ${conversionText(v.receiverConversion, v.receiverConversionValue, v.receiverConversionReplacement)}`,
          (v.senderTon !== null || v.senderNpi !== null) &&
            `sender TON/NPI ${v.senderTon ?? "-"}/${v.senderNpi ?? "-"}`,
          (v.destTon !== null || v.destNpi !== null) && `dest TON/NPI ${v.destTon ?? "-"}/${v.destNpi ?? "-"}`,
          v.billingType && `billing ${v.billingType}`,
          v.registeredDelivery !== null && `registered delivery ${v.registeredDelivery}`,
          v.dlrMap.length && `DLR ${v.dlrMap.map((m) => `${m.fromStatus}→${m.toStatus}`).join(", ")}`,
          v.contentWords?.length && `replace ${v.contentWords.length} word${v.contentWords.length === 1 ? "" : "s"}`,
          v.contentRegex && "rewrite text",
          v.msgTemplate && "text template",
        ].filter(Boolean);
  return `${when.length ? `When ${when.join(" and ")}` : "Every message"}: ${does.length ? does.join(", ") : "no change"}${
    v.continueAfter ? "" : ", then stop"
  }`;
}

/** Sender ID template lines "SENDER | content" (team trial round 1); the content is optional. */
export function splitTemplates(text: string): { value: string; content: string | null }[] {
  const seen = new Set<string>();
  const out: { value: string; content: string | null }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("|");
    const value = (at < 0 ? line : line.slice(0, at)).trim();
    const content = at < 0 ? null : line.slice(at + 1).trim() || null;
    const key = `${value}\u0000${content ?? ""}`;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push({ value, content });
  }
  return out;
}
