// Incoming vendor rate notifications (§13.13 A, §13.32): record reads and writes. Lists go through
// fetchListPage (rate_notifications, rate_notification_lines).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  RnDecision,
  RnDecisionResult,
  RnDetail,
  RnIntake,
  RnIntakeResult,
  RnReplySend,
  RnSettings,
  VendorRnSettings,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}
const path = (id: number) => ({ params: { path: { id } } });

export function useRn(id: number | null) {
  return useQuery<RnDetail>({
    queryKey: ["record", "rn", id],
    queryFn: () => unwrap(api.GET("/rate-notifications/{id}", path(id!))),
    enabled: id !== null,
  });
}
export const useIntakeRn = () =>
  useWrite((body: RnIntake): Promise<RnIntakeResult> => unwrap(api.POST("/rate-notifications/intake", { body })));
export const useDecideRn = () =>
  useWrite(
    ({ id, kind, body }: { id: number; kind: "accept" | "reject"; body: RnDecision }): Promise<RnDecisionResult> =>
      kind === "accept"
        ? unwrap(api.POST("/rate-notifications/{id}/accept", { ...path(id), body }))
        : unwrap(api.POST("/rate-notifications/{id}/reject", { ...path(id), body })),
  );
export const useAssignRn = () =>
  useWrite(({ id, vendorTrunkId }: { id: number; vendorTrunkId: number }): Promise<RnDetail> =>
    unwrap(api.POST("/rate-notifications/{id}/assign", { ...path(id), body: { vendorTrunkId } })),
  );
export const useRecheckRn = () =>
  useWrite((id: number): Promise<RnDetail> => unwrap(api.POST("/rate-notifications/{id}/recheck", path(id))));
export const useSendRnReply = () =>
  useWrite(({ id, replyId, body }: { id: number; replyId: number; body: RnReplySend }): Promise<RnDetail> =>
    unwrap(api.POST("/rate-notifications/{id}/replies/{replyId}/send", { params: { path: { id, replyId } }, body })),
  );
export const rnFileUrl = (id: number) => `/api/v1/rate-notifications/${id}/file`;

export function useRnSettings() {
  return useQuery<RnSettings>({
    queryKey: ["record", "rn-settings"],
    queryFn: () => unwrap(api.GET("/rate-notifications/settings")),
  });
}
export const useSaveRnSettings = () =>
  useWrite((body: RnSettings): Promise<RnSettings> => unwrap(api.PUT("/rate-notifications/settings", { body })));
export function useVendorRnSettings(id: number | null) {
  return useQuery<VendorRnSettings>({
    queryKey: ["record", "vendor-rn-settings", id],
    queryFn: () => unwrap(api.GET("/enterprises/{id}/rn-settings", path(id!))),
    enabled: id !== null,
  });
}
export const useSaveVendorRnSettings = () =>
  useWrite(({ id, body }: { id: number; body: VendorRnSettings }): Promise<VendorRnSettings> =>
    unwrap(api.PUT("/enterprises/{id}/rn-settings", { ...path(id), body })),
  );
