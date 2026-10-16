// Unsaved rate edits of the rate grid (§13.12 Editing): in-place sell rates and bulk-bar
// actions collect here and are sent as one batch, which is one undoable change (§13.10).
import type { RateLineEdit, RateLineRow } from "@sms/contract";

export interface PendingEdit {
  rate?: number;
  blocked?: boolean;
  close?: boolean;
}

export type Pending = ReadonlyMap<number, PendingEdit>;

export const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export type ChangeMode = "percent" | "amount" | "margin";

/**
 * New sell rate for a bulk "change by" action: by % of the current rate, by an amount, or
 * best buy plus a margin amount. Null when it can't apply (no best buy) or goes below zero.
 */
export function changeRate(row: Pick<RateLineRow, "rate" | "bestBuy">, mode: ChangeMode, value: number): number | null {
  const next =
    mode === "percent"
      ? row.rate * (1 + value / 100)
      : mode === "amount"
        ? row.rate + value
        : row.bestBuy === null
          ? null
          : row.bestBuy + value;
  return next === null || next < 0 ? null : round6(next);
}

export function merge(pending: Pending, ids: Iterable<number>, edit: PendingEdit): Map<number, PendingEdit> {
  const next = new Map(pending);
  for (const id of ids) next.set(id, { ...next.get(id), ...edit });
  return next;
}

/**
 * The request items. Blocks go before rate changes, because a new rate opens a new version
 * that inherits the block flag of the line it replaces. A scheduled line keeps its own start
 * date unless an effective date is chosen for the batch.
 */
export function buildItems(
  pending: Pending,
  rowsById: ReadonlyMap<number, Pick<RateLineRow, "rate" | "validFrom" | "isBlocked">>,
  effectiveFrom: string | null,
  now = Date.now(),
): RateLineEdit[] {
  const blocks: RateLineEdit[] = [];
  const rest: RateLineEdit[] = [];
  for (const [lineId, e] of pending) {
    const row = rowsById.get(lineId);
    if (e.close) {
      rest.push({ action: "close", lineId, ...(effectiveFrom ? { at: effectiveFrom } : {}) });
      continue;
    }
    if (e.blocked !== undefined && e.blocked !== row?.isBlocked)
      blocks.push({ action: "block", lineId, blocked: e.blocked });
    if (e.rate !== undefined && e.rate !== row?.rate) {
      const scheduled = row && Date.parse(row.validFrom) > now ? row.validFrom : null;
      const from = effectiveFrom ?? scheduled;
      rest.push({ action: "set", lineId, rate: e.rate, ...(from ? { effectiveFrom: from } : {}) });
    }
  }
  return [...blocks, ...rest];
}
