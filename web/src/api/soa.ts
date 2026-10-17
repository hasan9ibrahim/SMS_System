// SOA and SOA report (§7, §13.31, §13.33): search, the statement preview, manual adds / removes /
// entries (undoable, §13.10), the Send SOA e-mail preview, Send Email and Queue SOA Export (both
// run as SOA reports in the background), and the report list actions.
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  EmailPreview,
  SoaAdjustmentInput,
  SoaAdjustmentSaved,
  SoaEmailPreviewInput,
  SoaExportInput,
  SoaQuery,
  SoaReportRow,
  SoaReportsCreated,
  SoaSearchResult,
  SoaSendInput,
  SoaStatement,
  SoaStatementQuery,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

export function useSoaSearch(q: SoaQuery | null) {
  return useQuery<SoaSearchResult>({
    queryKey: ["record", "soa-search", q],
    queryFn: () => unwrap(api.POST("/soa/search", { body: q! })),
    enabled: q !== null,
  });
}

export function useSoaStatement(q: SoaStatementQuery | null) {
  return useQuery<SoaStatement>({
    queryKey: ["record", "soa-statement", q],
    queryFn: () => unwrap(api.POST("/soa/statement", { body: q! })),
    enabled: q !== null,
  });
}

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}

export const useSoaAdjustment = () =>
  useWrite((body: SoaAdjustmentInput): Promise<SoaAdjustmentSaved> => unwrap(api.POST("/soa/adjustments", { body })));

export const useTakeBackAdjustment = () =>
  useWrite((id: number): Promise<SoaAdjustmentSaved> =>
    unwrap(api.POST("/soa/adjustments/{id}/archive", { params: { path: { id } }, body: {} })),
  );

export const previewSoaEmail = (body: SoaEmailPreviewInput): Promise<EmailPreview> =>
  unwrap(api.POST("/soa/email-preview", { body }));

export const sendSoa = (body: SoaSendInput): Promise<SoaReportsCreated> => unwrap(api.POST("/soa/send", { body }));

export const exportSoa = (body: SoaExportInput): Promise<SoaReportsCreated> =>
  unwrap(api.POST("/soa/export", { body }));

export const getSoaReport = (id: number): Promise<SoaReportRow> =>
  unwrap(api.GET("/soa-reports/{id}", { params: { path: { id } } }));

export const useSendSoaReport = () =>
  useWrite(({ id, templateId }: { id: number; templateId: number }): Promise<SoaReportRow> =>
    unwrap(api.POST("/soa-reports/{id}/send", { params: { path: { id } }, body: { templateId } })),
  );

/** Polls reports until each succeeded or failed (every second, at most five minutes). */
export async function waitForReports(ids: number[]): Promise<SoaReportRow[]> {
  const done = new Map<number, SoaReportRow>();
  for (let i = 0; i < 300 && done.size < ids.length; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const id of ids.filter((x) => !done.has(x))) {
      const r = await getSoaReport(id);
      if (r.status === "success" || r.status === "failed") done.set(id, r);
    }
  }
  return [...done.values()];
}

/** Downloads a finished report (SOA_<alias>_<from>_<to>.pdf or .xls). */
export async function downloadSoaReport(id: number) {
  const res = await fetch(`/api/v1/soa-reports/${id}/file`);
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new Error(problem.detail ?? problem.title ?? res.statusText);
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "soa";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
