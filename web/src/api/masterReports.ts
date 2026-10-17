// Master Report, department reports, scheduled reports and daily traffic alerts (§10, §13.15).
// The Enterprise report has its own module (reports.ts).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  BillingReportPage,
  BillingReportParams,
  CronPreview,
  DailyTrafficAlertInput,
  DailyTrafficAlertSaved,
  EmailPreview,
  ListQuery,
  MasterReportExportInput,
  MasterReportPage,
  MasterReportQuery,
  NocInsights,
  NocInsightsInput,
  ReportPresetList,
  SalesInsights,
  SalesInsightsInput,
  ScheduledReportInput,
  ScheduledReportRow,
  ScheduledReportSaved,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { downloadFrom } from "./observation";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}

export const runMasterReport = (body: MasterReportQuery): Promise<MasterReportPage> =>
  unwrap(api.POST("/reports/master", { body }));
export const exportMasterReport = (body: MasterReportExportInput) =>
  downloadFrom(
    "/reports/master/export",
    { body },
    `master_report.${body.fileType === "excel" ? "xls" : body.fileType}`,
  );

export function useReportPresets() {
  return useQuery<ReportPresetList>({
    queryKey: ["report-presets"],
    queryFn: () => unwrap(api.GET("/reports/presets")),
    staleTime: Infinity,
  });
}

export function useSalesInsights(body: SalesInsightsInput) {
  return useQuery<SalesInsights>({
    queryKey: ["list", "sales-insights", body],
    queryFn: () => unwrap(api.POST("/reports/sales/insights", { body })),
  });
}
export function useNocInsights(body: NocInsightsInput) {
  return useQuery<NocInsights>({
    queryKey: ["list", "noc-insights", body],
    queryFn: () => unwrap(api.POST("/reports/noc/insights", { body })),
    refetchInterval: 60_000,
  });
}
export const fetchBillingReport = (params: BillingReportParams, query: ListQuery): Promise<BillingReportPage> =>
  unwrap(api.POST("/reports/billing/query", { body: { params, query } }));

export const useSaveScheduledReport = () =>
  useWrite(({ id, input }: { id: number | null; input: ScheduledReportInput }): Promise<ScheduledReportSaved> =>
    id === null
      ? unwrap(api.POST("/scheduled-reports", { body: input }))
      : unwrap(api.PUT("/scheduled-reports/{id}", { params: { path: { id } }, body: input })),
  );
export const useRunScheduledReport = () =>
  useWrite((id: number): Promise<ScheduledReportRow> =>
    unwrap(api.POST("/scheduled-reports/{id}/run", { params: { path: { id } } })),
  );
export const previewCron = (expression: string): Promise<CronPreview> =>
  unwrap(api.POST("/scheduled-reports/cron-preview", { body: { expression, count: 5 } }));

export const useSaveDailyAlert = () =>
  useWrite(({ id, input }: { id: number | null; input: DailyTrafficAlertInput }): Promise<DailyTrafficAlertSaved> =>
    id === null
      ? unwrap(api.POST("/daily-traffic-alerts", { body: input }))
      : unwrap(api.PUT("/daily-traffic-alerts/{id}", { params: { path: { id } }, body: input })),
  );
export const useSendDailyAlert = () =>
  useWrite((id: number): Promise<EmailPreview> =>
    unwrap(api.POST("/daily-traffic-alerts/{id}/send", { params: { path: { id } } })),
  );
