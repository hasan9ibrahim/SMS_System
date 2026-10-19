// Observation Deck (§9): EDR templates, trouble tickets, repush, EDR downloads, network status,
// signaling captures, the route simulator and network diagnosis. Lists go through fetchListPage.
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  BindSessionList,
  EdrDownloadInput,
  EdrDownloadRow,
  EdrTemplateInput,
  EdrTemplateRow,
  EdrTemplateSaved,
  EmailPreview,
  NetworkBindRow,
  NetworkDiagnosisInput,
  NetworkDiagnosisResult,
  NetworkExportInput,
  RepushInput,
  RepushRequestRow,
  RouteSimulatorInput,
  RecordingExtractInput,
  RecordingStatus,
  RouteSimulatorResult,
  SignalingCaptureInput,
  SignalingCaptureRow,
  TroubleTicketInput,
  TroubleTicketPreviewInput,
  TroubleTicketResult,
} from "@sms/contract";
import { api, ApiError, apiFetch, unwrap } from "./client";
import { fetchListPage } from "./hooks";
import { downloadBlob } from "./lookup";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}

/** Fetches a file the API answers and hands it to the browser as a download. */
export async function downloadFrom(path: string, init?: { body: unknown }, fallback = "download") {
  const res = await apiFetch(`/api/v1${path}`, {
    method: init ? "POST" : "GET",
    ...(init ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, { ...problem, title: problem.title ?? res.statusText, status: res.status });
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  downloadBlob(await res.blob(), name);
}

// ---------------------------------------------------------------- EDR templates

/** Every live EDR template (a short list), for pickers. */
export function useEdrTemplates() {
  return useQuery({
    queryKey: ["list", "edr-templates", "all"],
    queryFn: () => fetchListPage<EdrTemplateRow>("edr_templates", { limit: 500, withTotal: false }),
    select: (p) => p.rows,
    staleTime: 30_000,
  });
}

export const useSaveEdrTemplate = () =>
  useWrite(({ id, input }: { id: number | null; input: EdrTemplateInput }): Promise<EdrTemplateSaved> =>
    id === null
      ? unwrap(api.POST("/edr-templates", { body: input }))
      : unwrap(api.PUT("/edr-templates/{id}", { params: { path: { id } }, body: input })),
  );

// ---------------------------------------------------------------- trouble ticket / repush

export const previewTroubleTicket = (body: TroubleTicketPreviewInput): Promise<EmailPreview> =>
  unwrap(api.POST("/edrs/trouble-ticket/preview", { body }));
export const useSendTroubleTicket = () =>
  useWrite((body: TroubleTicketInput): Promise<TroubleTicketResult> =>
    unwrap(api.POST("/edrs/trouble-ticket", { body })),
  );
export const useRepush = () =>
  useWrite((body: RepushInput): Promise<RepushRequestRow> => unwrap(api.POST("/edrs/repush", { body })));

// ---------------------------------------------------------------- downloads

export const useRequestEdrDownload = () =>
  useWrite((body: EdrDownloadInput): Promise<EdrDownloadRow> => unwrap(api.POST("/edr-downloads", { body })));
export const useCancelEdrDownload = () =>
  useWrite((id: number): Promise<EdrDownloadRow> =>
    unwrap(api.POST("/edr-downloads/{id}/cancel", { params: { path: { id } } })),
  );
export const downloadEdrFile = (id: number) => downloadFrom(`/edr-downloads/${id}/file`, undefined, `edr_${id}.csv`);

// ---------------------------------------------------------------- network status

export function useBindSessions(side: "customer" | "vendor", id: number) {
  return useQuery<BindSessionList>({
    queryKey: ["record", "bind-sessions", side, id],
    queryFn: () => unwrap(api.GET("/network-binds/{side}/{id}/sessions", { params: { path: { side, id } } })),
    refetchInterval: 10_000,
  });
}
export const useTrunkBind = () =>
  useWrite(
    ({
      side,
      id,
      action,
    }: {
      side: "customer" | "vendor";
      id: number;
      action: "start" | "stop";
    }): Promise<NetworkBindRow> =>
      action === "start"
        ? unwrap(api.POST("/network-binds/{side}/{id}/start", { params: { path: { side, id } } }))
        : unwrap(api.POST("/network-binds/{side}/{id}/stop", { params: { path: { side, id } } })),
  );
export const exportNetworkBinds = (body: NetworkExportInput) =>
  downloadFrom(
    "/network-binds/export",
    { body },
    body.fileType === "excel" ? "network_status.xls" : "network_status.csv",
  );

// ---------------------------------------------------------------- signaling

export const useStartCapture = () =>
  useWrite((body: SignalingCaptureInput): Promise<SignalingCaptureRow> =>
    unwrap(api.POST("/signaling-captures", { body })),
  );
export const useStopCapture = () =>
  useWrite((id: number): Promise<SignalingCaptureRow> =>
    unwrap(api.POST("/signaling-captures/{id}/stop", { params: { path: { id } } })),
  );
/** Keep a capture file, or let it be deleted 30 days after it ended (team trial round 1). */
export const useKeepCapture = () =>
  useWrite(({ id, keep }: { id: number; keep: boolean }): Promise<SignalingCaptureRow> =>
    unwrap(api.POST("/signaling-captures/{id}/keep", { params: { path: { id } }, body: { keep } })),
  );
/** Traffic recording (§9, team trial round 1): every packet kept 60 days; cut a PCAP for a past window. */
export const useRecordingStatus = () =>
  useQuery<RecordingStatus>({
    queryKey: ["signaling-recording"],
    queryFn: () => unwrap(api.GET("/signaling-recording")),
    staleTime: 60_000,
  });
export const useExtractRecording = () =>
  useWrite((body: RecordingExtractInput): Promise<SignalingCaptureRow> =>
    unwrap(api.POST("/signaling-captures/extract", { body })),
  );
export const downloadCapture = (id: number) =>
  downloadFrom(`/signaling-captures/${id}/file`, undefined, `capture_${id}.pcap`);

// ---------------------------------------------------------------- simulator / diagnosis

export const runRouteSimulator = (body: RouteSimulatorInput): Promise<RouteSimulatorResult> =>
  unwrap(api.POST("/route-simulator", { body }));
export const runNetworkDiagnosis = (body: NetworkDiagnosisInput): Promise<NetworkDiagnosisResult> =>
  unwrap(api.POST("/network-diagnosis", { body }));
