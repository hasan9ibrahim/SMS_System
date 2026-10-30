// Pure helpers for the Observation Deck pages (§9): EDR row keys, message ID lists, UTC date inputs,
// sizes, statuses, and the message size counter of the Route Simulator.
import type { EdrRow, FilterCondition, MaskedCell } from "@sms/contract";

/** EDRs are keyed by UUID; the grid needs a number, so the key is the first 52 bits of the UUID. */
export const uuidKey = (uuid: string) => parseInt(uuid.replace(/-/g, "").slice(0, 13), 16);

export type EdrGridRow = Omit<EdrRow, "id"> & { id: number; uuid: string };
export const toGridRow = (r: EdrRow): EdrGridRow => ({ ...r, id: uuidKey(r.id), uuid: r.id });

/** Fields of an EDR the viewer's visibility policy can withhold (§13.17): null in the row when withheld. */
const WITHHELD = [
  "customerRate",
  "customerSysRate",
  "revenue",
  "revenueSys",
  "vendorRate",
  "vendorSysRate",
  "cost",
  "costSys",
  "customerIp",
  "vendorIp",
] as const;

/** The grid's "Hidden" cells for the withheld values of a page of EDR rows. */
export const withheldCells = (rows: { id: number }[]): MaskedCell[] =>
  rows.flatMap((r) =>
    WITHHELD.filter((f) => f in r && (r as Record<string, unknown>)[f] === null).map((field) => ({
      id: r.id,
      field,
      text: "Hidden",
    })),
  );

/** Comma, space or line separated message IDs, without blanks and repeats. */
/**
 * Numbers and message IDs in one box (team trial round 2, §9.1): split on commas, semicolons and new lines; a
 * piece with spaces stays whole when it is a number written with spaces (`+44 7700 900123`), else splits on them.
 */
export const parseMixedList = (text: string) => [
  ...new Set(
    text
      .split(/[,;\n]+/)
      .flatMap((piece) => {
        const p = piece.trim();
        return /^\+?[\d\s()-]+$/.test(p) ? [p] : p.split(/\s+/);
      })
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

export const parseIdList = (text: string) => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

/** `<input type="datetime-local">` value for a UTC instant, and back (the pages work in UTC, §15.1). */
export const toLocalInput = (iso: string | undefined) => (iso ? iso.slice(0, 16) : "");
export const fromLocalInput = (v: string) => (v ? `${v}:00.000Z` : "");

/** The From / To boxes as a condition on Start Time (between, ≥ or ≤). */
export function timeCondition(field: string, from: string, to: string): FilterCondition | null {
  if (from && to) return { field, op: "between", values: [fromLocalInput(from), fromLocalInput(to)] };
  if (from) return { field, op: "gte", value: fromLocalInput(from) };
  if (to) return { field, op: "lte", value: fromLocalInput(to) };
  return null;
}
/** EDR search's toolbar filters (period, numbers or IDs, destinations, status, final attempt): page switches there. */
export const EDR_SWITCH_FIELDS = ["startTime", "numberOrMsgId", "customerMccmnc", "msgStatus", "isFinalAttempt"];

/**
 * Conditions for a list of EDRs opened from elsewhere (reports, Live analytics): the toolbar's fields as its switches,
 * the others in their header boxes (team trial round 10).
 */
export function edrFilters(conditions: Record<string, FilterCondition>): {
  columns: Record<string, FilterCondition>;
  switches: Record<string, FilterCondition>;
} {
  const columns: Record<string, FilterCondition> = {};
  const switches: Record<string, FilterCondition> = {};
  for (const [k, c] of Object.entries(conditions)) (EDR_SWITCH_FIELDS.includes(k) ? switches : columns)[k] = c;
  return { columns, switches };
}

export function timeBounds(c: FilterCondition | undefined): { from: string; to: string } {
  if (!c) return { from: "", to: "" };
  if (c.op === "between") return { from: toLocalInput(String(c.values?.[0])), to: toLocalInput(String(c.values?.[1])) };
  if (c.op === "gte" || c.op === "gt") return { from: toLocalInput(String(c.value)), to: "" };
  if (c.op === "lte" || c.op === "lt") return { from: "", to: toLocalInput(String(c.value)) };
  return { from: "", to: "" };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 2026-10-16 21:29:59 (UTC, seconds kept: EDR times are read to the second). */
export const fmtSeconds = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").slice(0, 19) : "—");

export type Tone = "good" | "warning" | "error" | "neutral" | "accent";
export function msgStatusTone(s: string): Tone {
  if (s === "DELIVRD") return "good";
  if (["UNDELIV", "REJECTD", "EXPIRED", "DELETED"].includes(s)) return "error";
  if (s === "UNKNOWN") return "warning";
  return "neutral";
}
export const bindTone = (s: string): Tone => (s === "online" ? "good" : s === "stopped" ? "warning" : "error");
export const jobTone = (s: string): Tone =>
  s === "success" || s === "done"
    ? "good"
    : s === "failed"
      ? "error"
      : s === "cancelled" || s === "stopped"
        ? "neutral"
        : "accent";

// GSM 03.38 extension table: these characters take two septets.
const GSM_EXT = "^{}\\[~]|€\f";
const LABELS = [
  "GSM 7-bit (SMSC default)",
  "IA5 (ASCII)",
  "8-bit binary",
  "Latin-1",
  "8-bit binary",
  "JIS",
  "Cyrillic",
  "Latin/Hebrew",
  "UCS-2",
];

/** Live counter of the Route Simulator: characters, bits per character, SMS per message, size. */
export function messageEncoding(text: string, dataCoding: number) {
  const label = LABELS[dataCoding] ?? `data_coding ${dataCoding}`;
  if (dataCoding === 0 || dataCoding === 1) {
    let septets = 0;
    for (const ch of text) septets += GSM_EXT.includes(ch) ? 2 : 1;
    return {
      dataCoding,
      label,
      chars: septets,
      bitsPerChar: 7,
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
      bytes: Math.ceil((septets * 7) / 8),
    };
  }
  if (dataCoding === 8) {
    const units = text.length;
    return {
      dataCoding,
      label,
      chars: units,
      bitsPerChar: 16,
      segments: units <= 70 ? 1 : Math.ceil(units / 67),
      bytes: units * 2,
    };
  }
  const bytes = new TextEncoder().encode(text).length;
  return {
    dataCoding,
    label,
    chars: bytes,
    bitsPerChar: 8,
    segments: bytes <= 140 ? 1 : Math.ceil(bytes / 134),
    bytes,
  };
}

/** Suggests UCS-2 when the text has characters outside the GSM alphabet and Latin-1. */
export const needsUcs2 = (text: string) =>
  [...text].some((ch) => ch.charCodeAt(0) > 0xff && !GSM_EXT.includes(ch) && !"ΔΦΓΛΩΠΨΣΘΞ".includes(ch));

/** EDR detail sections: which fields each one shows (§9.1 EDR schema, both legs). */
export const EDR_SECTIONS: { key: string; label: string; fields: string[] }[] = [
  {
    key: "customer",
    label: "Customer leg",
    fields: [
      "customerEnterprise",
      "customerTrunk",
      "customerIp",
      "customerPort",
      "customerSessionId",
      "customerBindType",
      "protocol",
      "customerMsgId",
      "senderId",
      "dnid",
      "routedDnid",
      "srcTon",
      "srcNpi",
      "dstTon",
      "dstNpi",
      "coding",
      "messageText",
      "customerMccmnc",
      "country",
      "customerDestination",
      "productCategory",
      "customerBillingType",
      "customerRateTableId",
      "customerRate",
      "customerCurrency",
      "customerSysRate",
      "translationRuleIds",
      "customerMsgStatus",
    ],
  },
  {
    key: "vendor",
    label: "Vendor leg",
    fields: [
      "vendorEnterprise",
      "vendorTrunk",
      "vendorIp",
      "vendorPort",
      "vendorMsgId",
      "vendorMccmnc",
      "vendorDestination",
      "vendorBillingType",
      "vendorRateTableId",
      "vendorRate",
      "vendorCurrency",
      "vendorSysRate",
      "vendorExRate",
      "vendorTranslationRuleIds",
      "routeRuleId",
      "routeDecidedBy",
      "dlrReroute",
      "repushRequestId",
    ],
  },
  {
    key: "outcome",
    label: "Outcome",
    fields: [
      "startTime",
      "submitTime",
      "submitRespTime",
      "deliveryTime",
      "attemptNo",
      "isFinalAttempt",
      "isSubmitSuccess",
      "causeCode",
      "causeText",
      "msgStatus",
      "deliveryError",
      "networkError",
      "registeredDelivery",
      "msgCount",
      "udh",
      "deliveryDelaySeconds",
      "isBuffered",
      "id",
    ],
  },
  {
    key: "money",
    label: "Money & HLR",
    fields: [
      "isCustomerBillable",
      "isVendorBillable",
      "revenue",
      "cost",
      "revenueSys",
      "costSys",
      "hlrProvider",
      "hlrFetchType",
      "hlrIsPorted",
      "hlrIsAccomplished",
      "hlrErrorCode",
      "hlrErrorText",
      "hlrCostSys",
    ],
  },
];

/** A field value as text for the detail panel. */
export function fieldText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
}

// ---------------------------------------------------------------- Route simulator defaults (team trial round 1)

/** Receivers typed as a list: commas, semicolons or lines (spaces inside a number are fine); digits only, once each. */
export function parseReceivers(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,;\n]+/)
        .map((x) => x.replace(/\D/g, ""))
        .filter(Boolean),
    ),
  ];
}

/** Data coding from the text: UCS-2 (8) when a character is outside GSM 7-bit, else the default (0). */
export const autoCoding = (text: string) => (needsUcs2(text) ? 8 : 0);

/**
 * TON / NPI from an address, as SMPP clients usually send them: letters → 5 Alphanumeric / 0 Unknown;
 * a short code (up to 8 digits) → 3 Network specific / 0 Unknown; a longer number → 1 International / 1 ISDN.
 */
export function autoTonNpi(address: string): { ton: number; npi: number } {
  const a = address.trim();
  if (!a) return { ton: 0, npi: 0 };
  if (/[^\d+]/.test(a)) return { ton: 5, npi: 0 };
  const digits = a.replace(/\D/g, "");
  return digits.length <= 8 ? { ton: 3, npi: 0 } : { ton: 1, npi: 1 };
}
