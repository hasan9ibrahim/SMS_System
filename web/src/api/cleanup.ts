// Cleanup Center (§13.19, §13.20): finding detail, summary, scan, replay, apply / approve, ignore,
// settings and the duplicate warning on save. The list goes through fetchListPage (cleanup_findings).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  CleanupApplyResult,
  CleanupFinding,
  CleanupFindingDetail,
  CleanupScanResult,
  CleanupSelection,
  CleanupSettings,
  CleanupSimulation,
  CleanupSummary,
  DuplicateCheck,
  DuplicateCheckResult,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}
const path = (id: number) => ({ params: { path: { id } } });

export function useCleanupSummary() {
  return useQuery<CleanupSummary>({
    queryKey: ["record", "cleanup-summary"],
    queryFn: () => unwrap(api.GET("/cleanup/summary")),
    staleTime: 60_000,
  });
}
export function useCleanupFinding(id: number | null) {
  return useQuery<CleanupFindingDetail>({
    queryKey: ["record", "cleanup-finding", id],
    queryFn: () => unwrap(api.GET("/cleanup-findings/{id}", path(id!))),
    enabled: id !== null,
  });
}
export function useCleanupSimulation(sel: CleanupSelection | null) {
  return useQuery<CleanupSimulation>({
    queryKey: ["record", "cleanup-simulation", sel],
    queryFn: () => unwrap(api.POST("/cleanup/simulate", { body: sel! })),
    enabled: sel !== null,
    staleTime: 60_000,
  });
}
export const useScanCleanup = () =>
  useWrite((_: null): Promise<CleanupScanResult> => unwrap(api.POST("/cleanup/scan")));
export const useApplyCleanup = () =>
  useWrite((body: CleanupSelection): Promise<CleanupApplyResult> => unwrap(api.POST("/cleanup/apply", { body })));
export const useApproveCleanup = () =>
  useWrite((body: CleanupSelection): Promise<CleanupApplyResult> => unwrap(api.POST("/cleanup/approve", { body })));
export const useIgnoreFinding = () =>
  useWrite(({ id, reason }: { id: number; reason: string }): Promise<CleanupFinding> =>
    unwrap(api.POST("/cleanup-findings/{id}/ignore", { ...path(id), body: { reason } })),
  );
export const useReopenFinding = () =>
  useWrite((id: number): Promise<CleanupFinding> => unwrap(api.POST("/cleanup-findings/{id}/reopen", path(id))));
export function useCleanupSettings() {
  return useQuery<CleanupSettings>({
    queryKey: ["record", "cleanup-settings"],
    queryFn: () => unwrap(api.GET("/cleanup/settings")),
  });
}
export const useSaveCleanupSettings = () =>
  useWrite((body: CleanupSettings): Promise<CleanupSettings> => unwrap(api.PUT("/cleanup/settings", { body })));

/** Possible duplicates of what is being saved (§13.20); debounced by the caller. */
export const checkDuplicate = (body: DuplicateCheck): Promise<DuplicateCheckResult> =>
  unwrap(api.POST("/cleanup/check-duplicate", { body }));
