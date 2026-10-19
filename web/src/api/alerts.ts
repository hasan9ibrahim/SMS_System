// Alert rules and incidents (§13.6, §13.7): record reads and writes. Lists go through fetchListPage;
// live incidents arrive on alerts:<userId> (live/store.ts).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  AlertRuleInput,
  AlertRuleSaved,
  AlertRuleTest,
  IncidentDetail,
  IncidentSnoozeInput,
  ListQuery,
  OpenIncidents,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { downloadFrom } from "./observation";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}
const path = (id: number) => ({ params: { path: { id } } });

export const useSaveAlertRule = () =>
  useWrite(({ id, input }: { id: number | null; input: AlertRuleInput }): Promise<AlertRuleSaved> =>
    id === null
      ? unwrap(api.POST("/alert-rules", { body: input }))
      : unwrap(api.PUT("/alert-rules/{id}", { ...path(id), body: input })),
  );
export const useSetAlertRuleStatus = () =>
  useWrite(({ id, status }: { id: number; status: "active" | "inactive" }): Promise<AlertRuleSaved> =>
    unwrap(api.POST("/alert-rules/{id}/status", { ...path(id), body: { status } })),
  );
export const useCloneAlertRule = () =>
  useWrite(({ id, name }: { id: number; name: string }): Promise<AlertRuleSaved> =>
    unwrap(api.POST("/alert-rules/{id}/clone", { ...path(id), body: { name } })),
  );
export const testAlertRule = (input: AlertRuleInput): Promise<AlertRuleTest> =>
  unwrap(api.POST("/alert-rules/test", { body: input }));

export function useIncident(id: number | null) {
  return useQuery<IncidentDetail>({
    queryKey: ["record", "incident", id],
    queryFn: () => unwrap(api.GET("/incidents/{id}", path(id!))),
    enabled: id !== null,
  });
}
export const fetchOpenIncidents = (): Promise<OpenIncidents> => unwrap(api.GET("/incidents/open"));
export const acknowledgeIncident = (id: number, note?: string): Promise<IncidentDetail> =>
  unwrap(api.POST("/incidents/{id}/acknowledge", { ...path(id), body: note ? { note } : {} }));
export const snoozeIncident = (id: number, span: IncidentSnoozeInput["for"]): Promise<IncidentDetail> =>
  unwrap(api.POST("/incidents/{id}/snooze", { ...path(id), body: { for: span } }));
export const useAcknowledge = () =>
  useWrite(({ id, note }: { id: number; note?: string }) => acknowledgeIncident(id, note));
export const useSnooze = () =>
  useWrite(({ id, span }: { id: number; span: IncidentSnoozeInput["for"] }) => snoozeIncident(id, span));
export const useAddIncidentNote = () =>
  useWrite(({ id, text }: { id: number; text: string }): Promise<IncidentDetail> =>
    unwrap(api.POST("/incidents/{id}/notes", { ...path(id), body: { text } })),
  );
export const exportIncidents = (body: ListQuery) => downloadFrom("/incidents/export", { body }, "incidents.csv");
