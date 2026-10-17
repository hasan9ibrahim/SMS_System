// Pure helpers for the Invoice and Vendor invoice pages (§7, §12.3, §13.31): labels and tones,
// the blank Generate Request, per-destination lines typed as text, and month ranges.
import type {
  InvoiceRequestInput,
  ReconComparison,
  ReconRuleValues,
  ReconStatus,
  VendorInvoiceDetail,
  VendorInvoiceInput,
  VendorInvoiceLine,
} from "@sms/contract";

type Tone = "good" | "warning" | "error" | "neutral" | "accent";

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "neutral" },
  inprogress: { label: "Inprogress", tone: "accent" },
  completed: { label: "Completed", tone: "good" },
  failed: { label: "Failed", tone: "error" },
};

export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  unpaid: { label: "Unpaid", tone: "warning" },
  partial: { label: "Partly paid", tone: "warning" },
  paid: { label: "Paid", tone: "good" },
};

/** Vendor invoice status after the comparison (§13.31). */
export const RECON_STATUS: Record<ReconStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "neutral" },
  accepted: { label: "Accepted", tone: "good" },
  disputed: { label: "Disputed", tone: "warning" },
  rejected: { label: "Rejected", tone: "error" },
};

export function comparisonInfo(c: ReconComparison): { label: string; tone: Tone } {
  if (c === "match") return { label: "Match", tone: "good" };
  if (c === "mismatch") return { label: "Mismatch", tone: "warning" };
  if (c === "no_data") return { label: "No EDR data", tone: "neutral" };
  return { label: "Not checked", tone: "neutral" };
}

export const EMAIL_STATUS: Record<string, string> = {
  none: "—",
  waiting: "Waiting to confirm",
  sent: "Sent",
  failed: "Failed",
};

export const SOA_LABEL: Record<VendorInvoiceDetail["inSoa"], string> = {
  included: "Included in the SOA",
  disputed_block: "In the SOA's disputed block",
  excluded: "Left off the SOA",
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Generate Request defaults: last calendar month, each enterprise's time zone, auto due date. */
export function blankRequest(today = new Date()): InvoiceRequestInput {
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  return {
    kind: "traffic",
    enterpriseIds: [],
    timezone: null,
    usageStart: ymd(first),
    usageEnd: ymd(last),
    dueDateType: "auto",
    dueDate: null,
    invoiceNumber: null,
    amount: null,
    volume: null,
    currency: null,
    invoiceDate: ymd(today),
    remarks: null,
  };
}

/** Request body from the form: proforma fields only for proforma, the due date only when manual. */
export function requestInput(v: InvoiceRequestInput): InvoiceRequestInput {
  const proforma = v.kind === "proforma";
  return {
    ...v,
    amount: proforma ? v.amount : null,
    volume: proforma ? v.volume : null,
    currency: proforma ? v.currency : null,
    dueDate: v.dueDateType === "manual" ? v.dueDate : null,
    invoiceNumber: v.enterpriseIds.length === 1 ? v.invoiceNumber?.trim() || null : null,
    remarks: v.remarks?.trim() || null,
  };
}

/**
 * Per-destination lines typed or pasted as text, one "mccmnc, volume, amount" per line (comma,
 * semicolon or tab; volume may be empty). Returns the lines or the first problem.
 */
export function parseLines(text: string): { lines: VendorInvoiceLine[]; error: string | null } {
  const lines: VendorInvoiceLine[] = [];
  const seen = new Set<string>();
  const rows = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row || /^mccmnc/i.test(row)) continue;
    const [code = "", vol = "", amt = ""] = row.split(/[,;\t]/).map((c) => c.trim());
    if (!/^\d{5,6}$/.test(code)) return { lines, error: `Line ${i + 1}: "${code}" is not an MCCMNC (5 or 6 digits)` };
    if (seen.has(code)) return { lines, error: `Line ${i + 1}: ${code} is listed twice` };
    const volume = vol === "" ? null : Number(vol);
    if (volume !== null && (!Number.isInteger(volume) || volume < 0))
      return { lines, error: `Line ${i + 1}: volume must be a whole number` };
    const amount = Number(amt);
    if (amt === "" || !Number.isFinite(amount)) return { lines, error: `Line ${i + 1}: amount is missing` };
    seen.add(code);
    lines.push({ mccmnc: code, volume, amount });
  }
  return { lines, error: null };
}

export const linesText = (lines: VendorInvoiceLine[]) =>
  lines.map((l) => `${l.mccmnc},${l.volume ?? ""},${l.amount}`).join("\n");

export function blankVendorInvoice(today = new Date()): VendorInvoiceInput {
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  return {
    enterpriseId: 0,
    invoiceNumber: "",
    chargeVolume: null,
    chargeAmount: 0,
    currency: null,
    invoiceDate: ymd(today),
    dueDate: null,
    periodFrom: ymd(first),
    periodTo: ymd(last),
    timezone: null,
    remarks: null,
  };
}

export function vendorInvoiceInput(d: VendorInvoiceDetail): VendorInvoiceInput {
  return {
    enterpriseId: d.enterpriseId,
    invoiceNumber: d.invoiceNumber,
    chargeVolume: d.chargeVolume,
    chargeAmount: d.chargeAmount,
    currency: d.currency,
    invoiceDate: d.invoiceDate,
    dueDate: d.dueDate,
    periodFrom: d.periodFrom,
    periodTo: d.periodTo,
    timezone: d.timezone,
    remarks: d.remarks,
  };
}

/** "1 % and 50.00 USD" — the tolerance in words, as the check reasons print it. */
export function toleranceWords(pct: number | null, fixed: number | null, combine: string, unit: string): string {
  const parts = [
    pct !== null ? `${pct} %` : null,
    fixed !== null ? `${fixed.toLocaleString("en-US")} ${unit}` : null,
  ].filter(Boolean);
  if (!parts.length) return "no check";
  return parts.join(combine === "stricter" ? " and " : " or ");
}

export const DEFAULT_RULE: ReconRuleValues = {
  amountPct: 1,
  amountFixed: 50,
  amountCombine: "stricter",
  countPct: 1,
  countFixed: 1000,
  countCombine: "looser",
  destinationPct: null,
  autoSend: "auto",
  disputedInSoa: "separate_block",
};

/** The last `n` months up to and including this month, as YYYY-MM (oldest first). */
export function lastMonths(n: number, today = new Date()): { from: string; to: string } {
  const m = (offset: number) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return { from: m(-(n - 1)), to: m(0) };
}

/** Tone for a difference share: within 1 % neutral, up to 5 % amber, beyond red. */
export const diffTone = (pct: number | null) =>
  pct === null ? "" : Math.abs(pct) <= 1 ? "" : Math.abs(pct) <= 5 ? "tone-warning" : "tone-error";
