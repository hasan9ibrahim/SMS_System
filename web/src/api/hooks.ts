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
    case "product_categories":
      return unwrap(api.POST("/product-categories/query", { body })) as Promise<ListPage<Row>>;
    case "countries":
      return unwrap(api.POST("/countries/query", { body })) as Promise<ListPage<Row>>;
    case "dial_code_profiles":
      return unwrap(api.POST("/dial-code-profiles/query", { body })) as Promise<ListPage<Row>>;
    case "dial_codes":
      // Needs a profileId condition: the Master Table page adds it (rule 4).
      return unwrap(api.POST("/dial-codes/query", { body })) as Promise<ListPage<Row>>;
    case "mo_numbers":
      return unwrap(api.POST("/mo-numbers/query", { body })) as Promise<ListPage<Row>>;
    case "route_map":
      // Needs a customerTrunkId condition: the Route map page adds it.
      return unwrap(api.POST("/route-map/query", { body })) as Promise<ListPage<Row>>;
    case "rerating_requests":
      return unwrap(api.POST("/rerating-requests/query", { body })) as Promise<ListPage<Row>>;
    case "qbr_stats":
      // Needs a side condition: the QBR stats page adds it.
      return unwrap(api.POST("/qbr-stats/query", { body })) as Promise<ListPage<Row>>;
    case "number_lists":
      return unwrap(api.POST("/number-lists/query", { body })) as Promise<ListPage<Row>>;
    case "number_list_entries":
      // Needs a numberListId condition: the entries view adds it.
      return unwrap(api.POST("/number-list-entries/query", { body })) as Promise<ListPage<Row>>;
    case "translation_rules":
      return unwrap(api.POST("/translation-rules/query", { body })) as Promise<ListPage<Row>>;
    case "hlr_providers":
      return unwrap(api.POST("/hlr-providers/query", { body })) as Promise<ListPage<Row>>;
    case "hlr_provider_rates":
      // Needs a providerId condition: the provider's Prices section adds it.
      return unwrap(api.POST("/hlr-provider-rates/query", { body })) as Promise<ListPage<Row>>;
    case "hlr_rules":
      return unwrap(api.POST("/hlr-rules/query", { body })) as Promise<ListPage<Row>>;
    case "hlr_policies":
      return unwrap(api.POST("/hlr-policies/query", { body })) as Promise<ListPage<Row>>;
    case "transactions":
      return unwrap(api.POST("/transactions/query", { body })) as Promise<ListPage<Row>>;
    case "invoices":
      return unwrap(api.POST("/invoices/query", { body })) as Promise<ListPage<Row>>;
    case "invoice_requests":
      return unwrap(api.POST("/invoice-requests/query", { body })) as Promise<ListPage<Row>>;
    case "vendor_invoices":
      return unwrap(api.POST("/vendor-invoices/query", { body })) as Promise<ListPage<Row>>;
    case "email_logs":
      return unwrap(api.POST("/email-logs/query", { body })) as Promise<ListPage<Row>>;
    case "firewall_rules":
      return unwrap(api.POST("/firewall-rules/query", { body })) as Promise<ListPage<Row>>;
    case "firewall_filters":
      return unwrap(api.POST("/firewall-filters/query", { body })) as Promise<ListPage<Row>>;
    case "traffic_alerts":
      return unwrap(api.POST("/traffic-alerts/query", { body })) as Promise<ListPage<Row>>;
    case "sms_voice_rules":
      return unwrap(api.POST("/sms-voice-rules/query", { body })) as Promise<ListPage<Row>>;
    case "edrs":
      return unwrap(api.POST("/edrs/query", { body })) as Promise<ListPage<Row>>;
    case "failed_edrs":
      return unwrap(api.POST("/failed-edrs/query", { body })) as Promise<ListPage<Row>>;
    case "edr_templates":
      return unwrap(api.POST("/edr-templates/query", { body })) as Promise<ListPage<Row>>;
    case "edr_downloads":
      return unwrap(api.POST("/edr-downloads/query", { body })) as Promise<ListPage<Row>>;
    case "repush_requests":
      return unwrap(api.POST("/repush-requests/query", { body })) as Promise<ListPage<Row>>;
    case "network_binds":
      return unwrap(api.POST("/network-binds/query", { body })) as Promise<ListPage<Row>>;
    case "signaling_captures":
      return unwrap(api.POST("/signaling-captures/query", { body })) as Promise<ListPage<Row>>;
    case "scheduled_reports":
      return unwrap(api.POST("/scheduled-reports/query", { body })) as Promise<ListPage<Row>>;
    case "daily_traffic_alerts":
      return unwrap(api.POST("/daily-traffic-alerts/query", { body })) as Promise<ListPage<Row>>;
    case "broadcasts":
      return unwrap(api.POST("/broadcasts/query", { body })) as Promise<ListPage<Row>>;
    case "soa_reports":
      return unwrap(api.POST("/soa-reports/query", { body })) as Promise<ListPage<Row>>;
    case "email_templates":
      return unwrap(api.POST("/email-templates/query", { body })) as Promise<ListPage<Row>>;
    case "recon_rules":
      return unwrap(api.POST("/recon-rules/query", { body })) as Promise<ListPage<Row>>;
    case "currencies":
      return unwrap(api.POST("/currencies/query", { body })) as Promise<ListPage<Row>>;
    case "currency_rates":
      return unwrap(api.POST("/currency-rates/query", { body })) as Promise<ListPage<Row>>;
    case "currency_rate_history":
      return unwrap(api.POST("/currency-rate-history/query", { body })) as Promise<ListPage<Row>>;
    case "billing_cycles":
      return unwrap(api.POST("/billing-cycles/query", { body })) as Promise<ListPage<Row>>;
    case "enterprise_balances":
      return unwrap(api.POST("/enterprise-balances/query", { body })) as Promise<ListPage<Row>>;
    case "departments":
      return unwrap(api.POST("/departments/query", { body })) as Promise<ListPage<Row>>;
    case "access_groups":
      return unwrap(api.POST("/access-groups/query", { body })) as Promise<ListPage<Row>>;
    case "user_sessions":
      return unwrap(api.POST("/user-sessions/query", { body })) as Promise<ListPage<Row>>;
    case "audit_log":
      return unwrap(api.POST("/audit-log/query", { body })) as Promise<ListPage<Row>>;
    case "business_companies":
      return unwrap(api.POST("/business-companies/query", { body })) as Promise<ListPage<Row>>;
    case "customer_portal_users":
      return unwrap(api.POST("/customer-portal-users/query", { body })) as Promise<ListPage<Row>>;
    case "alert_rules":
      return unwrap(api.POST("/alert-rules/query", { body })) as Promise<ListPage<Row>>;
    case "incidents":
      return unwrap(api.POST("/incidents/query", { body })) as Promise<ListPage<Row>>;
    case "rate_notifications":
      return unwrap(api.POST("/rate-notifications/query", { body })) as Promise<ListPage<Row>>;
    case "lcr_profiles":
      return unwrap(api.POST("/lcr-profiles/query", { body })) as Promise<ListPage<Row>>;
    case "lcr_changes":
      return unwrap(api.POST("/lcr-changes/query", { body })) as Promise<ListPage<Row>>;
    case "market_moves":
      return unwrap(api.POST("/market-moves/query", { body })) as Promise<ListPage<Row>>;
    case "rate_notification_lines":
      // Needs an rnId condition: the review view adds it.
      return unwrap(api.POST("/rate-notification-lines/query", { body })) as Promise<ListPage<Row>>;
    case "enterprise_report":
      // The report needs its settings with every query: the page passes its own fetchPage.
      return Promise.reject(new Error("The Enterprise report is fetched with its settings"));
    case "master_report":
    case "billing_report":
      // Like the Enterprise report: these pages pass their own fetchPage with the report settings.
      return Promise.reject(new Error("This report is fetched with its settings"));
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
