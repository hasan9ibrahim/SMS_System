// Cleanup Center (§13.19, §13.20): labels, the filter a badge opens, and how a result reads.
import type { CleanupAction, CleanupApplyResult, CleanupArea } from "@sms/contract";
import { emptyState, encodeState } from "../../../grid/filterModel";

export const AREAS: { key: CleanupArea; label: string }[] = [
  { key: "rules", label: "Rules" },
  { key: "rates", label: "Rate tables" },
  { key: "trunks", label: "Trunks" },
  { key: "enterprises", label: "Enterprises" },
  { key: "lists", label: "Lists" },
  { key: "users", label: "Users" },
];
export const ACTION_LABEL: Record<CleanupAction, string> = {
  merge: "Merge",
  archive: "Delete (archive)",
  deactivate: "Deactivate",
  reassign: "Reassign",
  reorder: "Reorder",
  review: "Review by hand",
};

/** Cleanup Center filtered on open findings of these kinds (the badges on the rules pages). */
export function cleanupUrl(filter: { area?: CleanupArea; kinds?: string[] }): string {
  const columns: ReturnType<typeof emptyState>["columns"] = {
    state: { field: "state", op: "in", values: ["open"] },
  };
  if (filter.area) columns.area = { field: "area", op: "in", values: [filter.area] };
  if (filter.kinds?.length) columns.kind = { field: "kind", op: "in", values: filter.kinds };
  return `/admin/cleanup?g=${encodeState({ ...emptyState(), columns })}`;
}

export function resultText(r: CleanupApplyResult): string {
  const parts = [];
  if (r.applied)
    parts.push(
      `Applied ${r.applied} finding${r.applied === 1 ? "" : "s"} as change #${r.change?.id} (undo in History)`,
    );
  if (r.awaitingApproval) parts.push(`${r.awaitingApproval} waiting for an administrator's approval`);
  if (r.skipped.length)
    parts.push(`${r.skipped.length} skipped: ${[...new Set(r.skipped.map((s) => s.reason))].join("; ")}`);
  return parts.join(" · ") || "Nothing to apply";
}
