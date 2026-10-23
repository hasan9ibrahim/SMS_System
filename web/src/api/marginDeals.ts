// Margin calculator (team trial round 3): saved swap deals.
import { useMutation, useQuery } from "@tanstack/react-query";
import type { MarginDeal, MarginDealInput, MarginDealRow } from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

export function useMarginDeals(search: string, enabled = true) {
  return useQuery<MarginDealRow[]>({
    queryKey: ["record", "margin-deals", search],
    queryFn: () => unwrap(api.GET("/margin-deals", { params: { query: { search: search || undefined, limit: 50 } } })),
    enabled,
  });
}

export function fetchMarginDeal(id: number): Promise<MarginDeal> {
  return unwrap(api.GET("/margin-deals/{id}", { params: { path: { id } } }));
}

export function useSaveMarginDeal() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: MarginDealInput }): Promise<MarginDeal> =>
      id === null
        ? unwrap(api.POST("/margin-deals", { body: input }))
        : unwrap(api.PUT("/margin-deals/{id}", { params: { path: { id } }, body: input })),
    onSuccess: () => void refresh(),
  });
}

export function useDeleteMarginDeal() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: async (id: number): Promise<void> => {
      await unwrap(api.DELETE("/margin-deals/{id}", { params: { path: { id } } }));
    },
    onSuccess: () => void refresh(),
  });
}
