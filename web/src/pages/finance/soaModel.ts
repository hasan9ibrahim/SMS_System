// Pure helpers for the SOA pages (§7, §13.31, §13.33): line labels, which manual action a line
// offers, the default period, the tab URL parameters and the manual entry's signed amount.
import type { SoaInvoiceType, SoaLine } from "@sms/contract";

export const LINE_KIND: Record<string, string> = {
  opening: "Opening balance",
  invoice: "Invoice",
  vendor_invoice: "Vendor invoice",
  receipt: "Payment received",
  adjustment: "Adjustment",
  dispute: "Dispute",
  credit_note: "Credit note",
  bank_charges: "Bank charges",
  bill_payment: "Payment made",
  reprocess: "Re-rating",
  manual_payment: "Payment",
  manual_credit_note: "Credit note",
  manual_adjustment: "Adjustment",
  manual_opening: "Opening balance",
};

export const SIDE_TITLE = {
  customer: "Customer side · our invoices to them",
  vendor: "Vendor side · their invoices to us",
};

/** What billing can do with a main line by hand (§13.31): remove an automatic invoice, or take back a manual line. */
export function lineAction(l: SoaLine): "remove_invoice" | "remove_vendor_invoice" | "take_back" | null {
  if (l.adjustmentId !== null) return "take_back";
  if (l.refType === "invoice") return "remove_invoice";
  if (l.refType === "vendor_invoice") return "remove_vendor_invoice";
  return null;
}

/** Default SOA period: the last calendar month. */
export function defaultPeriod(today = new Date()): { from: string; to: string } {
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** ?enterprises=1,2 from the Send SOA buttons on other pages. */
export const enterprisesParam = (search: string): number[] =>
  (new URLSearchParams(search).get("enterprises") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

export const soaLink = (ids: number[]) => `/finance/soa?enterprises=${[...new Set(ids)].join(",")}`;

export const INVOICE_TYPES: { value: SoaInvoiceType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "auto", label: "Auto" },
  { value: "manual", label: "Manual" },
];

/** A manual entry's amount in the balance sign: "raises" (payment in, credit) or "lowers" (a charge). */
export const signedAmount = (amount: number, effect: "raises" | "lowers") =>
  (effect === "raises" ? 1 : -1) * Math.abs(amount);

/** Default effect of a manual entry kind on the balance. */
export const entryEffect = (kind: string): "raises" | "lowers" =>
  kind === "payment" || kind === "credit_note" ? "raises" : "lowers";
