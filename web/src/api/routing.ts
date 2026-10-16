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
  TrafficWindow,
} from "@sms/contract";
import { api, ApiError, unwrap } from "./client";
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
  const res = await fetch("/api/v1/route-rules/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, { ...problem, title: problem.title ?? res.statusText, status: res.status });
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
