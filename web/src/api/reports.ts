// Report hooks (§10, §13.31). The Enterprise report pages on the server like any list; its
// settings travel with every page request.
import type { EnterpriseReportPage, EnterpriseReportParams, EnterpriseReportRow, ListQuery } from "@sms/contract";
import { api, ApiError, apiFetch, unwrap } from "./client";
import { downloadBlob } from "./lookup";

export const fetchEnterpriseReport = (
  report: EnterpriseReportParams,
  query: ListQuery,
): Promise<EnterpriseReportPage> => unwrap(api.POST("/reports/enterprise/query", { body: { ...query, report } }));

export type ReportRow = EnterpriseReportRow;

/** Downloads the whole report as CSV (the time zone is printed at the top, §13.31). */
export async function exportEnterpriseReport(report: EnterpriseReportParams, query: ListQuery, columns: string[]) {
  const { filter, search, sort } = query;
  const res = await apiFetch("/api/v1/reports/enterprise/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      report,
      columns,
      ...(filter ? { filter } : {}),
      ...(search ? { search } : {}),
      ...(sort ? { sort } : {}),
    }),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string };
    throw new ApiError(res.status, { ...problem, title: problem.title ?? res.statusText, status: res.status });
  }
  const name =
    /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "enterprise-report.csv";
  downloadBlob(await res.blob(), name);
}
