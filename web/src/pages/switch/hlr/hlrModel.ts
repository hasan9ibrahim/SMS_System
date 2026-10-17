// Pure helpers for the HLR page (§6.5, §13.24): blank records, form <-> API mapping, labels,
// the response-mapping captions and one-line summaries.
import type {
  HlrLiveStatus,
  HlrPolicyDetail,
  HlrPolicyEntry,
  HlrPolicyInput,
  HlrProviderDetail,
  HlrProviderInput,
  HlrProviderType,
  HlrResponseMapping,
  HlrRuleDetail,
  HlrRuleInput,
} from "@sms/contract";

export const PROVIDER_TYPES: { value: HlrProviderType; label: string }[] = [
  { value: "hlr", label: "HLR" },
  { value: "mnp", label: "MNP / NPQ" },
  { value: "number_check", label: "Number check" },
];
export const providerTypeLabel = (t: HlrProviderType) => PROVIDER_TYPES.find((x) => x.value === t)?.label ?? t;

export const LIVE: Record<HlrLiveStatus, { label: string; tone: "good" | "warning" | "error" | "neutral" }> = {
  up: { label: "Up", tone: "good" },
  slow: { label: "Slow", tone: "warning" },
  down: { label: "Down", tone: "error" },
  inactive: { label: "Inactive", tone: "neutral" },
};

/** §6.5 response-mapping captions in form order; the first three are required. */
export const MAPPING_FIELDS: { key: keyof HlrResponseMapping; label: string; required?: boolean }[] = [
  { key: "mcc", label: "MCC", required: true },
  { key: "mnc", label: "MNC", required: true },
  { key: "mccmnc", label: "MCCMNC", required: true },
  { key: "oldMcc", label: "Old MCC" },
  { key: "oldMnc", label: "Old MNC" },
  { key: "oldMccmnc", label: "Old MCCMNC" },
  { key: "ported", label: "Ported" },
  { key: "errorCode", label: "Error Code" },
  { key: "errorString", label: "Error String" },
  { key: "successCodes", label: "Success Codes" },
  { key: "numberCheck", label: "Number Check" },
  { key: "dnidScore", label: "DNID Score" },
];

export function blankProvider(): HlrProviderInput {
  return {
    name: "",
    providerType: "hlr",
    url: "https://",
    username: null,
    password: null,
    extraHeaders: null,
    postData: null,
    currency: "USD",
    defaultRate: 0.002,
    cacheDays: 1,
    timeoutMs: 1500,
    dailyBudget: null,
    status: "active",
    responseMapping: {
      mcc: "mcc",
      mnc: "mnc",
      mccmnc: "mccmnc",
      oldMcc: null,
      oldMnc: null,
      oldMccmnc: null,
      ported: "ported",
      errorCode: null,
      errorString: null,
      successCodes: "0",
      numberCheck: null,
      dnidScore: null,
    },
  };
}

/** The editable input of a saved provider; the password stays as it is unless typed. */
export function providerInput(d: HlrProviderDetail): HlrProviderInput {
  return {
    name: d.name,
    providerType: d.providerType,
    url: d.url,
    username: d.username,
    password: null,
    extraHeaders: d.extraHeaders,
    postData: d.postData,
    currency: d.currency,
    defaultRate: d.defaultRate,
    cacheDays: d.cacheDays,
    timeoutMs: d.timeoutMs,
    dailyBudget: d.dailyBudget,
    status: d.status,
    responseMapping: d.responseMapping,
  };
}

export function blankHlrRule(): HlrRuleInput {
  return { name: "", providerId: 0, dnidPattern: "^", status: "active", insertAt: "bottom", targets: [] };
}

export function hlrRuleInput(d: HlrRuleDetail): HlrRuleInput {
  return {
    name: d.name,
    providerId: d.providerId,
    dnidPattern: d.dnidPattern,
    status: d.status,
    insertAt: d.insertAt,
    targets: d.targets.map((t) => ({ type: t.type, id: t.id })),
  };
}

export const blankEntry = (code: string | null): HlrPolicyEntry => ({
  code,
  mode: "ordered",
  providerIds: [],
  minSuccessPct: null,
  cacheHoursPorted: 168,
  cacheHoursNotPorted: 336,
});

export function blankPolicy(): HlrPolicyInput {
  return { name: "", status: "active", entries: [blankEntry(null)] };
}

export function policyInput(d: HlrPolicyDetail): HlrPolicyInput {
  return { name: d.name, status: d.status, entries: d.entries.map((e) => ({ ...e })) };
}

/** "7 days" / "36 h" / "no cache" */
export function hoursText(h: number): string {
  if (h === 0) return "no cache";
  return h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} h`;
}

/** One line per entry: "Lookupia → Portacheck · cache 7 days ported / 14 days not ported". */
export function entrySummary(e: HlrPolicyEntry, names: Map<number, string>): string {
  const list = e.providerIds.map((id) => names.get(id) ?? `#${id}`);
  const who =
    e.mode === "auto"
      ? `auto: cheapest of ${list.join(", ")} with success ≥ ${e.minSuccessPct ?? "?"} %`
      : list.join(" → ") || "no provider";
  return `${who} · cache ${hoursText(e.cacheHoursPorted)} ported / ${hoursText(e.cacheHoursNotPorted)} not ported`;
}

/** Entries sorted as the server keeps them: by code, the catch-all last. */
export const sortEntries = (entries: HlrPolicyEntry[]) =>
  [...entries].sort((a, b) => (a.code === null ? 1 : b.code === null ? -1 : a.code.localeCompare(b.code)));

/** Whether a DNID pattern compiles, and whether a sample number matches it (rule form preview). */
export function dnidPreview(pattern: string, sample: string): "invalid" | "match" | "no_match" {
  try {
    return new RegExp(pattern).test(sample) ? "match" : "no_match";
  } catch {
    return "invalid";
  }
}
