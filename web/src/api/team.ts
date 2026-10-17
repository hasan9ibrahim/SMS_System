// Team report (§13.18): the report, one member, targets, online users and the page-view feed. The
// timeline goes through fetchListPage (team_timeline).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  OnlineUsers,
  TeamMemberDetail,
  TeamReport,
  TeamReportQuery,
  TeamTarget,
  TeamTargetsUpdate,
} from "@sms/contract";
import { api, apiFetch, getViewAs, unwrap } from "./client";

export function useTeamReport(q: TeamReportQuery) {
  return useQuery<TeamReport>({
    queryKey: ["team", "report", q, getViewAs()],
    queryFn: () => unwrap(api.POST("/reports/team", { body: q })),
    staleTime: 60_000,
  });
}
export function useTeamMember(id: number | null, q: TeamReportQuery) {
  return useQuery<TeamMemberDetail>({
    queryKey: ["team", "member", id, q, getViewAs()],
    queryFn: () => unwrap(api.POST("/reports/team/users/{id}", { params: { path: { id: id! } }, body: q })),
    enabled: id !== null,
    staleTime: 60_000,
  });
}
export function useTeamTargets(month: string) {
  return useQuery<TeamTarget[]>({
    queryKey: ["team", "targets", month],
    queryFn: () => unwrap(api.GET("/team-targets", { params: { query: { month } } })),
  });
}
export function useSaveTeamTargets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TeamTargetsUpdate): Promise<TeamTarget[]> => unwrap(api.PUT("/team-targets", { body })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["team"] }),
  });
}
export function useOnlineUsers() {
  return useQuery<OnlineUsers>({
    queryKey: ["team", "online", getViewAs()],
    queryFn: () => unwrap(api.GET("/online-users")),
    refetchInterval: 30_000,
  });
}

/** The Team report as CSV, downloaded in the browser. */
export async function downloadTeamCsv(q: TeamReportQuery): Promise<void> {
  const res = await apiFetch("/api/v1/reports/team/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(q),
  });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "team.csv";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Pages opened, for pages most used and the current page (§13.18). Fire and forget. */
export function recordPageView(path: string): void {
  void api.POST("/me/page-views", { body: { path } }).catch(() => undefined);
}
