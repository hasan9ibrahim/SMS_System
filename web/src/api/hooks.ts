// TanStack Query hooks over the contract. Server state lives here; UI state (tabs,
// theme toggle in flight) lives in Zustand stores.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CurrentUser,
  ListFields,
  ListId,
  ListPageMeta,
  ListQuery,
  PreferencesUpdate,
  SavedView,
  SavedViewInput,
  SearchResults,
} from "@sms/contract";
import { api, unwrap } from "./client";

export interface ListPage<Row> extends ListPageMeta {
  rows: Row[];
}

/** POST /{list}/query for any list in the contract (§13.25). */
export function fetchListPage<Row>(list: ListId, body: ListQuery): Promise<ListPage<Row>> {
  switch (list) {
    case "enterprises":
      return unwrap(api.POST("/enterprises/query", { body })) as Promise<ListPage<Row>>;
    case "users":
      return unwrap(api.POST("/users/query", { body })) as Promise<ListPage<Row>>;
    case "changes":
      return unwrap(api.POST("/changes/query", { body })) as Promise<ListPage<Row>>;
    case "customer_trunks":
      return unwrap(api.POST("/customer-trunks/query", { body })) as Promise<ListPage<Row>>;
    case "vendor_trunks":
      return unwrap(api.POST("/vendor-trunks/query", { body })) as Promise<ListPage<Row>>;
    case "rate_tables":
      return unwrap(api.POST("/rate-tables/query", { body })) as Promise<ListPage<Row>>;
    case "rate_lines":
      return unwrap(api.POST("/rate-lines/query", { body })) as Promise<ListPage<Row>>;
    case "destinations":
      return unwrap(api.POST("/destinations/query", { body })) as Promise<ListPage<Row>>;
    case "route_rules":
      return unwrap(api.POST("/route-rules/query", { body })) as Promise<ListPage<Row>>;
    case "enterprise_report":
      // The report needs its settings with every query: the page passes its own fetchPage.
      return Promise.reject(new Error("The Enterprise report is fetched with its settings"));
  }
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => unwrap(api.GET("/me")), staleTime: 5 * 60_000 });
}

export function useListFields(list: ListId) {
  return useQuery<ListFields>({
    queryKey: ["fields", list],
    queryFn: () => unwrap(api.GET("/meta/lists/{list}/fields", { params: { path: { list } } })),
    staleTime: Infinity,
  });
}

/** Server clock offset for the status bar (§15.1: server time, UTC). */
export function useServerOffset() {
  return useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const sent = Date.now();
      const h = await unwrap(api.GET("/health"));
      const received = Date.now();
      return {
        offset: Date.parse(h.serverTime) - (sent + received) / 2,
        backend: h.backend,
        contract: h.contractVersion,
      };
    },
    refetchInterval: 10 * 60_000,
    retry: false,
  });
}

export function useRecordSearch(q: string) {
  return useQuery<SearchResults>({
    queryKey: ["search", q],
    queryFn: () => unwrap(api.GET("/search", { params: { query: { q, limit: 12 } } })),
    enabled: q.trim().length > 0,
    staleTime: 30_000,
    retry: false,
  });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PreferencesUpdate) => unwrap(api.PATCH("/me/preferences", { body })),
    onMutate: async (body) => {
      // A /me read still in flight must not overwrite the optimistic value.
      await qc.cancelQueries({ queryKey: ["me"] });
      const prev = qc.getQueryData<CurrentUser>(["me"]);
      if (prev) qc.setQueryData<CurrentUser>(["me"], { ...prev, preferences: { ...prev.preferences, ...body } });
      return { prev };
    },
    onError: (_err, _body, ctx) => ctx?.prev && qc.setQueryData(["me"], ctx.prev),
    onSuccess: (user) => qc.setQueryData(["me"], user),
  });
}

export function useViews(list: ListId) {
  return useQuery<SavedView[]>({
    queryKey: ["views", list],
    queryFn: () => unwrap(api.GET("/views", { params: { query: { list } } })),
    retry: false,
  });
}

export function useSaveView(list: ListId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: number; input: SavedViewInput }) =>
      id
        ? unwrap(api.PUT("/views/{id}", { params: { path: { id } }, body: input }))
        : unwrap(api.POST("/views", { body: input })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views", list] }),
  });
}

export function useDeleteView(list: ListId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => unwrap(api.DELETE("/views/{id}", { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views", list] }),
  });
}
