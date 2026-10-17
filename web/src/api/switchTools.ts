// Switch utilities (§8): notifications, e-mail logs, firewall, traffic alerts, SMS to voice and
// broadcast. Saves answer {record, change} for the Undo toast (§13.10).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  BroadcastAudience,
  BroadcastAudienceInput,
  BroadcastInput,
  BroadcastRow,
  CompanyMailboxList,
  EmailLogDetail,
  EmailPreview,
  FirewallCheckResult,
  FirewallFilterInput,
  FirewallFilterSaved,
  FirewallRuleInput,
  FirewallRuleSaved,
  NotificationResult,
  SendRateInput,
  SmsVoiceRuleInput,
  SmsVoiceRuleSaved,
  SmsVoiceTestInput,
  SmsVoiceTestResult,
  TrafficAlertCheck,
  TrafficAlertInput,
  TrafficAlertSaved,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}

export function useEmailLog(id: number | null) {
  return useQuery<EmailLogDetail>({
    queryKey: ["record", "email-log", id],
    queryFn: () => unwrap(api.GET("/email-logs/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

// ---------------------------------------------------------------- notifications

export const useSendRate = () =>
  useWrite((body: SendRateInput): Promise<NotificationResult> =>
    unwrap(api.POST("/notifications/send-rate", { body })),
  );

export const useSendTechInfo = () =>
  useWrite((trunkIds: number[]): Promise<NotificationResult> =>
    unwrap(api.POST("/notifications/send-tech-info", { body: { trunkIds } })),
  );

export function useNotificationPreview(trunkId: number | null, kind: "send_rate" | "send_tech_info") {
  return useQuery<EmailPreview>({
    queryKey: ["notification-preview", trunkId, kind],
    queryFn: () => unwrap(api.POST("/notifications/preview", { body: { trunkId: trunkId!, kind } })),
    enabled: trunkId !== null,
    retry: false,
  });
}

/** Downloads a trunk's rate sheet (View Rate). */
export async function downloadRateSheet(trunkId: number, fileType: "excel" | "csv") {
  const res = await fetch(`/api/v1/customer-trunks/${trunkId}/rate-sheet?fileType=${fileType}`);
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new Error(problem.detail ?? problem.title ?? res.statusText);
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "rates";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- firewall

export const useAddFirewallRule = () =>
  useWrite((body: FirewallRuleInput): Promise<FirewallRuleSaved> => unwrap(api.POST("/firewall-rules", { body })));

export const useRemoveFirewallRule = () =>
  useWrite((id: number): Promise<FirewallRuleSaved> =>
    unwrap(api.POST("/firewall-rules/{id}/archive", { params: { path: { id } }, body: {} })),
  );

export const useSaveFirewallFilter = () =>
  useWrite(({ id, input }: { id: number | null; input: FirewallFilterInput }): Promise<FirewallFilterSaved> =>
    id === null
      ? unwrap(api.POST("/firewall-filters", { body: input }))
      : unwrap(api.PUT("/firewall-filters/{id}", { params: { path: { id } }, body: input })),
  );

export const checkFirewallIp = (ip: string): Promise<FirewallCheckResult> =>
  unwrap(api.POST("/firewall/check", { body: { ip } }));

// ---------------------------------------------------------------- traffic alerts

export const useSaveTrafficAlert = () =>
  useWrite(({ id, input }: { id: number | null; input: TrafficAlertInput }): Promise<TrafficAlertSaved> =>
    id === null
      ? unwrap(api.POST("/traffic-alerts", { body: input }))
      : unwrap(api.PUT("/traffic-alerts/{id}", { params: { path: { id } }, body: input })),
  );

export const useCloneTrafficAlert = () =>
  useWrite((id: number): Promise<TrafficAlertSaved> =>
    unwrap(api.POST("/traffic-alerts/{id}/clone", { params: { path: { id } } })),
  );

export const useCheckTrafficAlert = () =>
  useWrite((id: number): Promise<TrafficAlertCheck> =>
    unwrap(api.POST("/traffic-alerts/{id}/check", { params: { path: { id } } })),
  );

// ---------------------------------------------------------------- sms to voice

export const useSaveSmsVoiceRule = () =>
  useWrite(({ id, input }: { id: number | null; input: SmsVoiceRuleInput }): Promise<SmsVoiceRuleSaved> =>
    id === null
      ? unwrap(api.POST("/sms-voice-rules", { body: input }))
      : unwrap(api.PUT("/sms-voice-rules/{id}", { params: { path: { id } }, body: input })),
  );

export const testSmsVoice = (body: SmsVoiceTestInput): Promise<SmsVoiceTestResult> =>
  unwrap(api.POST("/sms-voice-rules/test", { body }));

// ---------------------------------------------------------------- broadcast

export function useMailboxes(businessCompanyId: number | null) {
  return useQuery<CompanyMailboxList>({
    queryKey: ["mailboxes", businessCompanyId],
    queryFn: () =>
      unwrap(api.GET("/business-companies/{id}/mailboxes", { params: { path: { id: businessCompanyId! } } })),
    enabled: businessCompanyId !== null,
  });
}

export function useBroadcastAudience(body: BroadcastAudienceInput | null) {
  return useQuery<BroadcastAudience>({
    queryKey: ["broadcast-audience", body],
    queryFn: () => unwrap(api.POST("/broadcasts/preview", { body: body! })),
    enabled: body !== null,
  });
}

export const useSendBroadcast = () =>
  useWrite((body: BroadcastInput): Promise<BroadcastRow> => unwrap(api.POST("/broadcasts", { body })));
