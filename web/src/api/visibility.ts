// AM visibility (§13.17): policies, presets, assignments, shares and temporary access, and effective
// policies. Lists go through fetchListPage (visibility_policies, visibility_assignments, visibility_grants).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  EffectiveVisibility,
  VisibilityAssignment,
  VisibilityAssignmentInput,
  VisibilityGrant,
  VisibilityGrantInput,
  VisibilityPolicyInput,
  VisibilityPolicyRow,
  VisibilityPolicySaved,
  VisibilityPreset,
} from "@sms/contract";
import { api, getViewAs, unwrap } from "./client";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}
const path = (id: number) => ({ params: { path: { id } } });

export function useVisibilityPresets() {
  return useQuery<VisibilityPreset[]>({
    queryKey: ["record", "visibility-presets"],
    queryFn: () => unwrap(api.GET("/visibility-policies/presets")),
    staleTime: Infinity,
  });
}
export function useVisibilityPolicy(id: number | null) {
  return useQuery<VisibilityPolicyRow>({
    queryKey: ["record", "visibility-policy", id],
    queryFn: () => unwrap(api.GET("/visibility-policies/{id}", path(id!))),
    enabled: id !== null,
  });
}
export const useSaveVisibilityPolicy = () =>
  useWrite(({ id, input }: { id: number | null; input: VisibilityPolicyInput }): Promise<VisibilityPolicySaved> =>
    id === null
      ? unwrap(api.POST("/visibility-policies", { body: input }))
      : unwrap(api.PUT("/visibility-policies/{id}", { ...path(id), body: input })),
  );
export const useAssignVisibility = () =>
  useWrite((body: VisibilityAssignmentInput): Promise<VisibilityAssignment> =>
    unwrap(api.POST("/visibility-assignments", { body })),
  );
export const useRemoveVisibilityAssignment = () =>
  useWrite(async (id: number) => {
    await unwrap(api.DELETE("/visibility-assignments/{id}", path(id)));
    return null;
  });
export const useGrantVisibility = () =>
  useWrite((body: VisibilityGrantInput): Promise<VisibilityGrant> => unwrap(api.POST("/visibility-grants", { body })));
export const useRevokeVisibilityGrant = () =>
  useWrite((id: number): Promise<VisibilityGrant> => unwrap(api.POST("/visibility-grants/{id}/revoke", path(id))));

export function useUserVisibility(id: number | null) {
  return useQuery<EffectiveVisibility>({
    queryKey: ["record", "user-visibility", id],
    queryFn: () => unwrap(api.GET("/users/{id}/visibility", path(id!))),
    enabled: id !== null,
  });
}
/** The signed-in user's effective policy, or the previewed user's (X-View-As). */
export function useMyVisibility() {
  return useQuery<EffectiveVisibility>({
    queryKey: ["me", "visibility", getViewAs()],
    queryFn: () => unwrap(api.GET("/me/visibility")),
    staleTime: 30_000,
  });
}
