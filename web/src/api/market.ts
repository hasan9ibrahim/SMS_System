// Market rate movements (§13.14): record reads and writes. The list goes through fetchListPage
// (market_moves).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  MarketAutoRule,
  MarketAutoRuleInput,
  MarketAutoRuleList,
  MarketMoveAction,
  MarketMoveDetail,
  MarketMoveSettings,
  MarketMoveSummary,
  MarketScanResult,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}
const path = (id: number) => ({ params: { path: { id } } });

export const fetchMarketMove = (id: number): Promise<MarketMoveDetail> =>
  unwrap(api.GET("/market-moves/{id}", path(id)));
export function useMarketMove(id: number | null) {
  return useQuery<MarketMoveDetail>({
    queryKey: ["record", "market-move", id],
    queryFn: () => fetchMarketMove(id!),
    enabled: id !== null,
  });
}
export function useMarketSummary() {
  return useQuery<MarketMoveSummary>({
    queryKey: ["record", "market-summary"],
    queryFn: () => unwrap(api.GET("/market-moves/summary")),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
export const actOnMove = (id: number, body: MarketMoveAction): Promise<MarketMoveDetail> =>
  unwrap(api.POST("/market-moves/{id}/action", { ...path(id), body }));
export const useActOnMove = () =>
  useWrite(({ id, body }: { id: number; body: MarketMoveAction }) => actOnMove(id, body));
export const useScanMoves = () => useWrite((): Promise<MarketScanResult> => unwrap(api.POST("/market-moves/scan")));
export const useSendDigest = () => useWrite((): Promise<{ sent: number }> => unwrap(api.POST("/market-moves/digest")));

export function useMarketSettings() {
  return useQuery<MarketMoveSettings>({
    queryKey: ["record", "market-settings"],
    queryFn: () => unwrap(api.GET("/market-moves/settings")),
  });
}
export const useSaveMarketSettings = () =>
  useWrite((body: MarketMoveSettings): Promise<MarketMoveSettings> =>
    unwrap(api.PUT("/market-moves/settings", { body })),
  );
export function useAutoRules() {
  return useQuery<MarketAutoRuleList>({
    queryKey: ["record", "market-auto-rules"],
    queryFn: () => unwrap(api.GET("/market-moves/auto-rules")),
  });
}
export const useSaveAutoRule = () =>
  useWrite(({ id, body }: { id: number | null; body: MarketAutoRuleInput }): Promise<MarketAutoRule> =>
    id === null
      ? unwrap(api.POST("/market-moves/auto-rules", { body }))
      : unwrap(api.PUT("/market-moves/auto-rules/{id}", { ...path(id), body })),
  );
export const useArchiveAutoRule = () =>
  useWrite((id: number): Promise<MarketAutoRule> =>
    unwrap(api.POST("/market-moves/auto-rules/{id}/archive", path(id))),
  );
