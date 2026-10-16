// Rate Lookup hooks (§13.16): destination search as you type, the easy-mode panels, the
// advanced matrix (server-paged) and saved lookups.
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type {
  LookupResolution,
  RateLookupRequest,
  RateLookupResult,
  RateMatrix,
  RateMatrixRequest,
  SavedLookup,
  SavedLookupInput,
} from "@sms/contract";
import { api, ApiError, unwrap } from "./client";

export function useLookupResolve(q: string, live: boolean) {
  const text = q.trim();
  return useQuery<LookupResolution>({
    queryKey: ["lookup", "resolve", text, live],
    queryFn: () => unwrap(api.GET("/rate-lookup/destinations", { params: { query: { q: text, live } } })),
    enabled: text.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useRateLookup(req: RateLookupRequest | null) {
  return useQuery<RateLookupResult>({
    queryKey: ["lookup", "rates", req],
    queryFn: () => unwrap(api.POST("/rate-lookup", { body: req! })),
    enabled: req !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export const fetchMatrixPage = (body: RateMatrixRequest): Promise<RateMatrix> =>
  unwrap(api.POST("/rate-lookup/matrix", { body }));

/** Downloads the whole advanced lookup as CSV. */
export async function exportMatrix(body: RateMatrixRequest) {
  const res = await fetch("/api/v1/rate-lookup/matrix/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, { ...problem, title: problem.title ?? res.statusText, status: res.status });
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "rate-lookup.csv";
  downloadBlob(await res.blob(), name);
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useSavedLookups() {
  return useQuery<SavedLookup[]>({
    queryKey: ["lookup", "saved"],
    queryFn: () => unwrap(api.GET("/rate-lookups")),
    staleTime: 60_000,
  });
}

export function useSaveLookup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: SavedLookupInput }): Promise<SavedLookup> =>
      id === null
        ? unwrap(api.POST("/rate-lookups", { body: input }))
        : unwrap(api.PUT("/rate-lookups/{id}", { params: { path: { id } }, body: input })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["lookup", "saved"] }),
  });
}

export function useDeleteLookup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const r = await api.DELETE("/rate-lookups/{id}", { params: { path: { id } } });
      if (!r.response.ok)
        throw new ApiError(r.response.status, { title: r.response.statusText, status: r.response.status });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["lookup", "saved"] }),
  });
}
