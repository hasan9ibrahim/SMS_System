// Pure helpers for the Finance pages (§7, §13.33): labels, the blank payment, form ↔ API
// mapping, money formatting and what a payment does to a balance.
import type { PaymentMode, TransactionDetail, TransactionInput, TransactionType } from "@sms/contract";

export const PAYMENT_MODES: { value: PaymentMode; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "By Cheque" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "paypal", label: "Paypal" },
  { value: "credit_card", label: "Credit Card" },
  { value: "debit_card", label: "Debit Card" },
  { value: "wire_transfer", label: "Wire Transfer" },
  { value: "crypto", label: "Crypto" },
];
export const TRANSACTION_TYPES: { value: TransactionType; label: string }[] = [
  { value: "receipt", label: "Receipt" },
  { value: "adjustment", label: "Adjustment" },
  { value: "dispute", label: "Disputes" },
  { value: "credit_note", label: "Credit Note" },
  { value: "bank_charges", label: "Bank Charges" },
  { value: "bill_payment", label: "Bill Payment" },
  { value: "reprocess", label: "Reprocess" },
];
export const modeLabel = (m: PaymentMode | null) => PAYMENT_MODES.find((x) => x.value === m)?.label ?? "—";
export const typeLabel = (t: TransactionType) => TRANSACTION_TYPES.find((x) => x.value === t)?.label ?? t;

/** A new payment: a customer pays us (credit), we pay a vendor (debit). */
export function blankTransaction(side: "customer" | "vendor" = "customer", today = new Date()): TransactionInput {
  return {
    side,
    enterpriseId: 0,
    invoiceId: null,
    paymentMode: "bank_transfer",
    transactionType: side === "customer" ? "receipt" : "bill_payment",
    paymentType: side === "customer" ? "credit" : "debit",
    paymentDate: today.toISOString().slice(0, 10),
    amount: 0,
    currency: "USD",
    description: null,
    sendConfirmation: false,
    includeInSoa: true,
    excludeReason: null,
  };
}

export function transactionInput(d: TransactionDetail): TransactionInput {
  return {
    side: d.side,
    enterpriseId: d.enterpriseId,
    invoiceId: d.invoiceId,
    paymentMode: d.paymentMode,
    transactionType: d.transactionType,
    paymentType: d.paymentType,
    paymentDate: d.paymentDate,
    amount: d.amount,
    currency: d.currency,
    description: d.description,
    sendConfirmation: d.sendConfirmation,
    includeInSoa: d.includeInSoa,
    excludeReason: d.excludeReason,
  };
}

/**
 * What the payment does to the side's balance (owed convention): a customer credit lowers what
 * the client owes us, a vendor debit lowers what we owe the vendor; the opposite raises it.
 */
export function balanceEffect(t: Pick<TransactionInput, "side" | "paymentType" | "amount">): number {
  const lowers = (t.side === "customer") === (t.paymentType === "credit");
  return lowers ? -t.amount : t.amount;
}

export const money = (v: number | null | undefined, currency?: string | null) =>
  v === null || v === undefined
    ? "—"
    : `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`;

/** Inclusive day count of a period, for the Charges Calculator header. */
export const periodDays = (from: string, to: string) =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1);
