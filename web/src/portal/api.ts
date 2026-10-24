// Customer portal API (§1, team trial round 5): its own session cookie, separate from the staff system.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ListQuery,
  PortalListId,
  PortalMessageRow,
  PortalPasswordInput,
  PortalRateRow,
  PortalSignInInput,
  PortalTrafficQuery,
} from "@sms/contract";
import { api, ApiError, unwrap } from "../api/client";
import type { ListPage } from "../api/hooks";

const SESSION_KEY = ["portal", "session"];
/** Drops the portal's cached data except the session itself (its query stays observed by the app). */
const dropData = (qc: ReturnType<typeof useQueryClient>) =>
  qc.removeQueries({ predicate: (q) => q.queryKey[0] === "portal" && q.queryKey[1] !== "session" });

/** The signed-in portal user; null when signed out (401). */
export function usePortalSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: () =>
      unwrap(api.GET("/portal/session")).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PortalSignInInput) => unwrap(api.POST("/portal/session", { body })),
    onSuccess: (s) => {
      dropData(qc);
      qc.setQueryData(SESSION_KEY, s);
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.DELETE("/portal/session")),
    onSettled: () => {
      dropData(qc);
      qc.setQueryData(SESSION_KEY, null);
    },
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PortalPasswordInput) => unwrap(api.POST("/portal/password", { body })),
    onSuccess: (s) => qc.setQueryData(SESSION_KEY, s),
  });
}

export const useOverview = () =>
  useQuery({
    queryKey: ["portal", "overview"],
    queryFn: () => unwrap(api.GET("/portal/overview")),
    refetchInterval: 60_000,
  });

export const usePortalFields = (list: PortalListId) =>
  useQuery({
    queryKey: ["portal", "fields", list],
    queryFn: () => unwrap(api.GET("/portal/meta/lists/{list}/fields", { params: { path: { list } } })),
    staleTime: Infinity,
  });

export const fetchRates = (body: ListQuery) =>
  unwrap(api.POST("/portal/rates/query", { body })) as Promise<ListPage<PortalRateRow>>;
export const fetchMessages = (body: ListQuery) =>
  unwrap(api.POST("/portal/messages/query", { body })) as unknown as Promise<ListPage<PortalMessageRow>>;

export const useTraffic = (q: PortalTrafficQuery) =>
  useQuery({
    queryKey: ["portal", "traffic", q],
    queryFn: () => unwrap(api.POST("/portal/traffic", { body: q })),
    placeholderData: keepPreviousData,
  });

/** Downloads the filtered rates as a CSV rate sheet. */
export async function downloadRates(body: ListQuery) {
  const res = await fetch("/api/v1/portal/rates/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, { title: "The rate sheet could not be downloaded", status: res.status });
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "rates.csv";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
