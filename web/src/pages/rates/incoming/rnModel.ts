// Incoming RNs (§13.13 A, §13.32) without React: status and change labels, the flags of a line, and
// the links behind "Accept and reroute" (Route Rules on the vendor trunk) and "Accept and update
// customers" (Bulk rating on the affected client tables and destinations).
import type { RnDetail, RnLineRow, RnRow } from "@sms/contract";
import { emptyState, encodeState } from "../../../grid/filterModel";
import { scopeUrl } from "../bulkModel";

type Tone = "good" | "warning" | "error" | "neutral";

export const STATUS: Record<RnRow["status"], { label: string; tone: Tone }> = {
  pending: { label: "Pending review", tone: "warning" },
  accepted: { label: "Accepted", tone: "good" },
  partly_accepted: { label: "Partly accepted", tone: "warning" },
  rejected: { label: "Rejected", tone: "error" },
  failed: { label: "Failed", tone: "error" },
  unmatched: { label: "Unmatched", tone: "warning" },
};

export const CHANGE: Record<RnLineRow["change"], string> = {
  new: "New",
  increase: "Increase",
  decrease: "Decrease",
  unchanged: "Unchanged",
  closed: "Closed",
};

export const decidable = (s: RnRow["status"]) => s === "pending";

/** The chips shown on a line, most serious first (§13.32). */
export function lineFlags(l: RnLineRow): { label: string; tone: Tone; title: string }[] {
  const out: { label: string; tone: Tone; title: string }[] = [];
  if (l.flagged)
    out.push({
      label: l.change === "closed" ? "Closed on live traffic" : "Increase on live traffic",
      tone: "error",
      title: `${l.traffic24h.toLocaleString("en-US")} msgs in 24 h, ${l.traffic7d.toLocaleString("en-US")} in 7 days`,
    });
  if (l.turnsNegative)
    out.push({ label: "Turns negative", tone: "error", title: "Margin at the new cost is below zero" });
  if (l.noticeBreach)
    out.push({ label: "Notice breach", tone: "warning", title: `${l.noticeDaysGiven} days' notice given` });
  if (l.backdated)
    out.push({
      label: "Back-dated",
      tone: "warning",
      title: `Stated ${l.statedFrom.slice(0, 10)}, applied from ${l.appliedFrom.slice(0, 10)}; ${l.sentBetween.toLocaleString("en-US")} msgs sent in between keep the old rate`,
    });
  return out;
}

/** Route Rules filtered on the vendor trunk, for moving traffic before the date (§13.11 bulk routing). */
export const rerouteUrl = (rn: Pick<RnRow, "vendorTrunk">) =>
  `/routing/rules?g=${encodeState({
    ...emptyState(),
    columns: rn.vendorTrunk ? { vendors: { field: "vendors", op: "like", value: rn.vendorTrunk } } : {},
  })}`;

/** Bulk rating on the client tables that send traffic to the flagged destinations (§13.14). */
export const updateCustomersUrl = (rn: Pick<RnDetail, "affectedRateTableIds" | "affectedMccmncs">) =>
  scopeUrl({ tables: rn.affectedRateTableIds.slice(0, 200), mccmncs: rn.affectedMccmncs.slice(0, 500) });

/** "3 increases · 1 closed" style summary of an RN. */
export function changeSummary(r: RnRow): string {
  const parts: [number, string][] = [
    [r.increases, "up"],
    [r.decreases, "down"],
    [r.newLines, "new"],
    [r.closed, "closed"],
    [r.unchanged, "same"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, l]) => `${n.toLocaleString("en-US")} ${l}`)
    .join(" · ");
}
