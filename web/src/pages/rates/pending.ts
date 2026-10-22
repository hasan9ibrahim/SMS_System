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
 * the routed cost (route rules) plus a margin amount. Null when it can't apply (no routed cost) or goes below zero.
 */
export function changeRate(
  row: Pick<RateLineRow, "rate" | "routedCost">,
  mode: ChangeMode,
  value: number,
): number | null {
  // A rate withheld by the visibility policy (§13.17) cannot be changed by a percentage or amount.
  if (row.rate === null && mode !== "margin") return null;
  const rate = row.rate ?? 0;
  const next =
    mode === "percent"
      ? rate * (1 + value / 100)
      : mode === "amount"
        ? rate + value
        : row.routedCost === null
          ? null
          : row.routedCost + value;
  return next === null || next < 0 ? null : round6(next);
}

export function merge(pending: Pending, ids: Iterable<number>, edit: PendingEdit): Map<number, PendingEdit> {
  const next = new Map(pending);
  for (const id of ids) next.set(id, { ...next.get(id), ...edit });
  return next;
}

/** Edits that change something: a rate typed back to its current value, or a cell opened and left, is not a change. */
export function changeCount(
  pending: Pending,
  rowsById: ReadonlyMap<number, Pick<RateLineRow, "rate" | "isBlocked">>,
): number {
  let n = 0;
  for (const [lineId, e] of pending) {
    const row = rowsById.get(lineId);
    if (
      e.close ||
      (e.blocked !== undefined && e.blocked !== row?.isBlocked) ||
      (e.rate !== undefined && e.rate !== row?.rate)
    )
      n++;
  }
  return n;
}

/** Sets the rate of one line, or drops the edit when it is back to the current rate. */
export function setRate(
  pending: Pending,
  row: Pick<RateLineRow, "id" | "rate">,
  rate: number,
): Map<number, PendingEdit> {
  const next = new Map(pending);
  const { rate: _old, ...rest } = next.get(row.id) ?? {};
  const edit: PendingEdit = rate === row.rate ? rest : { ...rest, rate };
  if (Object.keys(edit).length) next.set(row.id, edit);
  else next.delete(row.id);
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
  /** False when the date is the default (today 00:00): a scheduled line then keeps its own later start. */
  chosen = true,
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
      const from = chosen ? (effectiveFrom ?? scheduled) : (scheduled ?? effectiveFrom);
      rest.push({ action: "set", lineId, rate: e.rate, ...(from ? { effectiveFrom: from } : {}) });
    }
  }
  return [...blocks, ...rest];
}

export type SummaryKind = "increase" | "decrease" | "same" | "close" | "block" | "unblock";

export interface SummaryRow {
  lineId: number;
  kind: SummaryKind;
  row: Pick<RateLineRow, "mccmnc" | "country" | "network" | "senderId" | "rate"> | undefined;
  newRate: number | null;
  changePct: number | null;
}

/** What a save will do, for the summary shown before saving (team trial round 2). */
export function summarize(
  pending: Pending,
  rowsById: ReadonlyMap<
    number,
    Pick<RateLineRow, "mccmnc" | "country" | "network" | "senderId" | "rate" | "isBlocked">
  >,
): { counts: Record<SummaryKind, number>; rows: SummaryRow[] } {
  const counts: Record<SummaryKind, number> = { increase: 0, decrease: 0, same: 0, close: 0, block: 0, unblock: 0 };
  const rows: SummaryRow[] = [];
  for (const [lineId, e] of pending) {
    const row = rowsById.get(lineId);
    const add = (kind: SummaryKind, newRate: number | null, changePct: number | null) => {
      counts[kind]++;
      rows.push({ lineId, kind, row, newRate, changePct });
    };
    if (e.close) {
      add("close", null, null);
      continue;
    }
    if (e.blocked !== undefined && e.blocked !== row?.isBlocked) add(e.blocked ? "block" : "unblock", null, null);
    if (e.rate !== undefined && e.rate !== row?.rate) {
      const old = row?.rate ?? null;
      const kind = old === null ? "same" : e.rate > old ? "increase" : e.rate < old ? "decrease" : "same";
      add(kind, e.rate, old ? round6(((e.rate - old) / old) * 100) : null);
    }
  }
  const order: SummaryKind[] = ["increase", "decrease", "close", "block", "unblock", "same"];
  rows.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0),
  );
  return { counts, rows };
}
