// Number lists and Translation rules (§6.4, §13.2): saves, entries, imports, the rule Test and
// the trunk Rules tab Test. Every save answers {record, change} so the Undo toast works (§13.10).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ChangeResult,
  NumberList,
  NumberListEntriesInput,
  NumberListEntriesResult,
  NumberListInput,
  RuleUsedBy,
  TestMessage,
  TranslationCloneInput,
  TranslationRuleDetail,
  TranslationRuleInput,
  TranslationRuleSaved,
  TranslationTestResult,
  TrunkRulesTestResult,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords, type Saved, type TrunkKind } from "./records";

export function useSaveNumberList() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: NumberListInput }): Promise<Saved<NumberList>> =>
      id === null
        ? unwrap(api.POST("/number-lists", { body: input }))
        : unwrap(api.PUT("/number-lists/{id}", { params: { path: { id } }, body: input })),
    onSuccess: () => void refresh(),
  });
}

export function useAddEntries(listId: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (body: NumberListEntriesInput): Promise<NumberListEntriesResult> =>
      unwrap(api.POST("/number-lists/{id}/entries", { params: { path: { id: listId } }, body })),
    onSuccess: () => void refresh(),
  });
}

export function useDeleteEntries(listId: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (ids: number[]): Promise<ChangeResult> =>
      unwrap(api.POST("/number-lists/{id}/entries/delete", { params: { path: { id: listId } }, body: { ids } })),
    onSuccess: () => void refresh(),
  });
}

export function useTranslationRule(id: number | null) {
  return useQuery<TranslationRuleDetail>({
    queryKey: ["record", "translation_rule", id],
    queryFn: () => unwrap(api.GET("/translation-rules/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

export function useRuleUsedBy(id: number | null) {
  return useQuery<RuleUsedBy>({
    queryKey: ["record", "translation_rule", id, "used-by"],
    queryFn: () => unwrap(api.GET("/translation-rules/{id}/used-by", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

export function useSaveTranslationRule() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: TranslationRuleInput }): Promise<TranslationRuleSaved> =>
      id === null
        ? unwrap(api.POST("/translation-rules", { body: input }))
        : unwrap(api.PUT("/translation-rules/{id}", { params: { path: { id } }, body: input })),
    onSuccess: () => void refresh(),
  });
}

export function useCloneTranslationRule() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: TranslationCloneInput }): Promise<TranslationRuleSaved> =>
      unwrap(api.POST("/translation-rules/{id}/clone", { params: { path: { id } }, body })),
    onSuccess: () => void refresh(),
  });
}

export const testTranslationRule = (
  id: number,
  message: TestMessage,
  rule?: TranslationRuleInput,
): Promise<TranslationTestResult> =>
  unwrap(
    api.POST("/translation-rules/{id}/test", {
      params: { path: { id } },
      body: { message, ...(rule ? { rule } : {}) },
    }),
  );

export const testTrunkRules = (kind: TrunkKind, id: number, message: TestMessage): Promise<TrunkRulesTestResult> =>
  kind === "customer"
    ? unwrap(api.POST("/customer-trunks/{id}/rules/test", { params: { path: { id } }, body: { message } }))
    : unwrap(api.POST("/vendor-trunks/{id}/rules/test", { params: { path: { id } }, body: { message } }));
