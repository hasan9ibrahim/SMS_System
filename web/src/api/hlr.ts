// HLR providers, rules and policies (§6.5, §13.24): records, saves, prices and the policy
// Test. Every save answers {record, change} so the Undo toast works (§13.10).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ChangeResult,
  HlrPolicyDetail,
  HlrPolicyInput,
  HlrPolicySaved,
  HlrPolicyTestResult,
  HlrProviderDetail,
  HlrProviderInput,
  HlrProviderRateInput,
  HlrProviderRateSaved,
  HlrProviderSaved,
  HlrRuleDetail,
  HlrRuleInput,
  HlrRuleSaved,
  RuleUsedBy,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

export function useHlrProvider(id: number | null) {
  return useQuery<HlrProviderDetail>({
    queryKey: ["record", "hlr_provider", id],
    queryFn: () => unwrap(api.GET("/hlr-providers/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

export function useHlrRule(id: number | null) {
  return useQuery<HlrRuleDetail>({
    queryKey: ["record", "hlr_rule", id],
    queryFn: () => unwrap(api.GET("/hlr-rules/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

export function useHlrRuleUsedBy(id: number | null) {
  return useQuery<RuleUsedBy>({
    queryKey: ["record", "hlr_rule", id, "used-by"],
    queryFn: () => unwrap(api.GET("/hlr-rules/{id}/used-by", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

export function useHlrPolicy(id: number | null) {
  return useQuery<HlrPolicyDetail>({
    queryKey: ["record", "hlr_policy", id],
    queryFn: () => unwrap(api.GET("/hlr-policies/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

function useSave<In, Out>(save: (id: number | null, input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: In }) => save(id, input),
    onSuccess: () => void refresh(),
  });
}

export const useSaveHlrProvider = () =>
  useSave<HlrProviderInput, HlrProviderSaved>((id, body) =>
    id === null
      ? unwrap(api.POST("/hlr-providers", { body }))
      : unwrap(api.PUT("/hlr-providers/{id}", { params: { path: { id } }, body })),
  );

export const useSaveHlrRule = () =>
  useSave<HlrRuleInput, HlrRuleSaved>((id, body) =>
    id === null
      ? unwrap(api.POST("/hlr-rules", { body }))
      : unwrap(api.PUT("/hlr-rules/{id}", { params: { path: { id } }, body })),
  );

export const useSaveHlrPolicy = () =>
  useSave<HlrPolicyInput, HlrPolicySaved>((id, body) =>
    id === null
      ? unwrap(api.POST("/hlr-policies", { body }))
      : unwrap(api.PUT("/hlr-policies/{id}", { params: { path: { id } }, body })),
  );

export function useSetHlrRate(providerId: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (body: HlrProviderRateInput): Promise<HlrProviderRateSaved> =>
      unwrap(api.PUT("/hlr-providers/{id}/rates", { params: { path: { id: providerId } }, body })),
    onSuccess: () => void refresh(),
  });
}

export function useDeleteHlrRates(providerId: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (ids: number[]): Promise<ChangeResult> =>
      unwrap(api.POST("/hlr-providers/{id}/rates/delete", { params: { path: { id: providerId } }, body: { ids } })),
    onSuccess: () => void refresh(),
  });
}

export const testHlrPolicy = (id: number, receiver: string): Promise<HlrPolicyTestResult> =>
  unwrap(api.POST("/hlr-policies/{id}/test", { params: { path: { id } }, body: { receiver } }));
