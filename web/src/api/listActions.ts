// The generic list calls (§13.22, §13.29): one CSV export for any list page, and bulk delete / restore of a list's
// selected records as one change in History (§13.10).
import type { BulkRecordsRequest, BulkRecordsResult, ListExportRequest, ListId, ListQuery } from "@sms/contract";
import { api, ApiError, apiFetch, unwrap } from "./client";

export interface ExportAnswer {
  /** Rows that matched the query. */
  total: number;
  /** Set when more rows matched than an export holds: the rows written. */
  capped: number | null;
}

/** The export's body without the list query's paging (the server takes every matching row). */
export type ListExportBody = Omit<ListExportRequest, "query"> & { query: Pick<ListQuery, "filter" | "search" | "sort"> };

/** POST /lists/{list}/export and saves the CSV under the server's file name. */
export async function downloadListExport(list: ListId, body: ListExportBody): Promise<ExportAnswer> {
  const res = await apiFetch(`/api/v1/lists/${list}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, {
      ...problem,
      title: problem.title ?? (res.statusText || `Request failed (HTTP ${res.status})`),
      status: res.status,
    });
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${list}.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const capped = res.headers.get("x-export-capped");
  return { total: Number(res.headers.get("x-total-rows") ?? 0), capped: capped ? Number(capped) : null };
}

/** Bulk delete or restore (a dry run changes nothing and answers what would be done and refused). */
export function bulkRecords(
  list: ListId,
  mode: "delete" | "restore",
  body: BulkRecordsRequest,
): Promise<BulkRecordsResult> {
  const params = { params: { path: { list } }, body };
  return unwrap(
    mode === "delete" ? api.POST("/lists/{list}/bulk-delete", params) : api.POST("/lists/{list}/bulk-restore", params),
  ) as Promise<BulkRecordsResult>;
}
