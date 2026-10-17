// Route map, Re-rating and QBR stats (§6.3, §12.2): queries and writes for the three pages.
// Re-rating requests follow maker-checker: the server says what the signed-in user may do
// (canEdit, canDecide); saves answer {record, change}.
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  QbrOverrideInput,
  QbrStatSaved,
  ReratingDetail,
  ReratingInput,
  ReratingPreview,
  ReratingSaved,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

/** One request with its summary; refreshed every 2 s while it is queued or processing. */
export function useRerating(id: number | null) {
  return useQuery<ReratingDetail>({
    queryKey: ["record", "rerating", id],
    queryFn: () => unwrap(api.GET("/rerating-requests/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
    retry: false,
    refetchInterval: (q) =>
      q.state.data && ["in_queue", "in_process"].includes(q.state.data.reprocessStatus) ? 2000 : false,
  });
}

export const previewRerating = (body: ReratingInput): Promise<ReratingPreview> =>
  unwrap(api.POST("/rerating-requests/preview", { body }));

export function useSaveRerating() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: ReratingInput }): Promise<ReratingSaved> =>
      id === null
        ? unwrap(api.POST("/rerating-requests", { body: input }))
        : unwrap(api.PUT("/rerating-requests/{id}", { params: { path: { id } }, body: input })),
    onSuccess: () => void refresh(),
  });
}

export function useDecideRerating() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, approve, reason }: { id: number; approve: boolean; reason?: string }): Promise<ReratingSaved> =>
      approve
        ? unwrap(api.POST("/rerating-requests/{id}/approve", { params: { path: { id } } }))
        : unwrap(api.POST("/rerating-requests/{id}/decline", { params: { path: { id } }, body: { reason: reason! } })),
    onSuccess: () => void refresh(),
  });
}

export function useQbrOverride() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (body: QbrOverrideInput): Promise<QbrStatSaved> =>
      unwrap(api.PUT("/qbr-stats/vendor-override", { body })),
    onSuccess: () => void refresh(),
  });
}

export function useClearQbrOverride() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (id: number): Promise<QbrStatSaved> =>
      unwrap(api.POST("/qbr-stats/{id}/clear-override", { params: { path: { id } } })),
    onSuccess: () => void refresh(),
  });
}
