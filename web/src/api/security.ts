// Security settings (§13.28): the password policy, the overview, reminders and my password status.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PasswordReminderRun,
  PasswordStatus,
  SecurityOverview,
  SecuritySettingsInput,
  SecuritySettingsSaved,
} from "@sms/contract";
import { api, unwrap } from "./client";

export function useMyPasswordStatus() {
  return useQuery<PasswordStatus>({
    queryKey: ["password-status"],
    queryFn: () => unwrap(api.GET("/me/password-status")),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}
export function useSecurityOverview() {
  return useQuery<SecurityOverview>({
    queryKey: ["record", "security-overview"],
    queryFn: () => unwrap(api.GET("/security/overview")),
  });
}
export function useSaveSecuritySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SecuritySettingsInput): Promise<SecuritySettingsSaved> =>
      unwrap(api.PUT("/security/settings", { body })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["record"] });
      void qc.invalidateQueries({ queryKey: ["list"] });
      void qc.invalidateQueries({ queryKey: ["password-status"] });
      void qc.invalidateQueries({ queryKey: ["history"] });
    },
  });
}
export function useRunReminders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<PasswordReminderRun> => unwrap(api.POST("/security/reminders/run")),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["record", "security-overview"] }),
  });
}
