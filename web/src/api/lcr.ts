// Advanced LCR (§13.23): the LCR table, client view, profiles and change alert settings. Lists go
// through fetchListPage (lcr_profiles, lcr_changes).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  LcrAlertSettings,
  LcrClientPage,
  LcrClientQuery,
  LcrProfileInput,
  LcrProfileRow,
  LcrProfileSaved,
  LcrQuery,
  LcrTable,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}
const path = (id: number) => ({ params: { path: { id } } });

export function useLcrTable(body: LcrQuery | null) {
  return useQuery<LcrTable>({
    queryKey: ["lcr", "table", body],
    queryFn: () => unwrap(api.POST("/lcr/table", { body: body! })),
    enabled: body !== null,
    staleTime: 30_000,
  });
}
export const fetchClientView = (body: LcrClientQuery): Promise<LcrClientPage> =>
  unwrap(api.POST("/lcr/client-view", { body }));

export function useLcrProfile(id: number | null) {
  return useQuery<LcrProfileRow>({
    queryKey: ["record", "lcr-profile", id],
    queryFn: () => unwrap(api.GET("/lcr-profiles/{id}", path(id!))),
    enabled: id !== null,
  });
}
export const useSaveLcrProfile = () =>
  useWrite(({ id, input }: { id: number | null; input: LcrProfileInput }): Promise<LcrProfileSaved> =>
    id === null
      ? unwrap(api.POST("/lcr-profiles", { body: input }))
      : unwrap(api.PUT("/lcr-profiles/{id}", { ...path(id), body: input })),
  );
export function useLcrAlertSettings() {
  return useQuery<LcrAlertSettings>({
    queryKey: ["record", "lcr-alerts"],
    queryFn: () => unwrap(api.GET("/lcr/alert-settings")),
  });
}
export const useSaveLcrAlertSettings = () =>
  useWrite((body: LcrAlertSettings): Promise<LcrAlertSettings> => unwrap(api.PUT("/lcr/alert-settings", { body })));
