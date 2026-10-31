// Route rule hooks (§6.3, §13.8–13.11, §13.27). Records live under ["record", ...] and
// lists under ["list", ...], so a save, a bulk edit or an undo refreshes both (§13.10).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ListQuery,
  RouteBulkRequest,
  RouteBulkSaved,
  RouteDecision,
  RouteRuleDetail,
  RouteRuleInput,
  RouteRuleSaved,
  RouteSimulation,
  RouteTestRequest,
  RouteTraffic,
  RouteVendorCost,
  RouteVendorCostRequest,
  TrafficWindow,
} from "@sms/contract";
import { api, ApiError, apiFetch, unwrap } from "./client";
import { useRefreshRecords } from "./records";

export function useRouteRule(id: number | null) {
  return useQuery<RouteRuleDetail>({
    queryKey: ["record", "route_rule", id],
    queryFn: () => unwrap(api.GET("/route-rules/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
    retry: false,
  });
}

export function useSaveRouteRule() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: RouteRuleInput }): Promise<RouteRuleSaved> =>
      id === null
        ? unwrap(api.POST("/route-rules", { body: input }))
        : unwrap(api.PUT("/route-rules/{id}", { params: { path: { id } }, body: input })),
    onSuccess: () => void refresh(),
  });
}

/** Starts one vendor's warm-up count again from 0 now (team trial round 6, §13.27); not a change of the rule. */
export function useResetWarmup() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, vendorTrunkId }: { id: number; vendorTrunkId: number }): Promise<RouteRuleSaved> =>
      unwrap(api.POST("/route-rules/{id}/warmup-reset", { params: { path: { id } }, body: { vendorTrunkId } })),
    onSuccess: () => void refresh(),
  });
}

/** Removes a New rule draft that was never saved (team trial round 3). */
export function useDiscardRouteRule() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: async (id: number): Promise<void> => {
      await unwrap(api.POST("/route-rules/{id}/discard", { params: { path: { id } } }));
    },
    onSuccess: () => void refresh(),
  });
}

/**
 * Discards a New rule draft while the page goes away (reload, leaving the app, window closed: QA round 13, §6.3).
 * React's cleanup never runs then, and a keepalive request outlives the page.
 */
export function discardRouteRuleOnLeave(id: number) {
  void api.POST("/route-rules/{id}/discard", { params: { path: { id } }, keepalive: true }).catch(() => undefined);
}

export function useCloneRouteRule() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (id: number): Promise<RouteRuleSaved> =>
      unwrap(api.POST("/route-rules/{id}/clone", { params: { path: { id } } })),
    onSuccess: () => void refresh(),
  });
}

export function useBulkRouteRules() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (body: RouteBulkRequest): Promise<RouteBulkSaved> => unwrap(api.POST("/route-rules/bulk", { body })),
    onSuccess: () => void refresh(),
  });
}

/** Traffic of one rule over a time frame (§13.27); refreshed with the live cache every minute. */
export function useRouteTraffic(id: number | null, window: TrafficWindow) {
  return useQuery<RouteTraffic>({
    queryKey: ["traffic", "route_rule", id, window],
    queryFn: () => unwrap(api.GET("/route-rules/{id}/traffic", { params: { path: { id: id! }, query: { window } } })),
    enabled: id !== null,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

export const testRouteRule = (id: number, body: RouteTestRequest): Promise<RouteDecision> =>
  unwrap(api.POST("/route-rules/{id}/test", { params: { path: { id } }, body }));

export const simulateRoute = (body: RouteTestRequest): Promise<RouteSimulation> =>
  unwrap(api.POST("/route-rules/simulate", { body }));

/** Downloads the rules matching the list query as CSV (POST /route-rules/export). */
export async function exportRouteRules(query: Pick<ListQuery, "filter" | "search" | "sort">) {
  const res = await apiFetch("/api/v1/route-rules/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, { ...problem, title: problem.title ?? (res.statusText || `Request failed (HTTP ${res.status})`), status: res.status });
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "route-rules.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** What each vendor charges for a rule's destinations, in its currency and in EUR (team trial round 4). */
export function useVendorCosts(vendorTrunkIds: number[], dest: Omit<RouteVendorCostRequest, "vendorTrunkIds">) {
  const ids = [...new Set(vendorTrunkIds.filter((id) => id > 0))].sort((a, b) => a - b);
  const body: RouteVendorCostRequest = {
    vendorTrunkIds: ids,
    mccmncMode: dest.mccmncMode,
    mccmncs: dest.mccmncMode === "all" ? [] : dest.mccmncs,
    mccmncPattern: dest.mccmncPattern || null,
  };
  const q = useQuery<RouteVendorCost[]>({
    queryKey: ["route-vendor-costs", body],
    queryFn: () => unwrap(api.POST("/route-rules/vendor-costs", { body })),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
  return new Map((q.data ?? []).map((c) => [c.vendorTrunkId, c]));
}
