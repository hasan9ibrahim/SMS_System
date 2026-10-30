// Record hooks for the Enterprise and trunk screens (§5). Every record query lives under
// ["record", ...] so a save, an archive or an undo can refresh them all (§13.10).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Enterprise,
  AmPeriod,
  ArchiveRequest,
  Change,
  CustomerTrunkDetail,
  CustomerTrunkInput,
  Dependencies,
  EnterpriseRules,
  EnterpriseRulesInput,
  EnterpriseRulesSaved,
  DestinationSaved,
  EnterpriseBilling,
  EnterpriseBillingInput,
  EnterpriseDetail,
  EnterpriseDoc,
  EnterpriseDocUpload,
  EnterpriseInput,
  HandoverRequest,
  RateLineChanges,
  RateLineChangesSaved,
  RateBulkApply,
  RateBulkPreview,
  RateBulkSaved,
  RateBulkScope,
  RateTableDetail,
  RateTableInput,
  RateTableUpdate,
  ReferenceData,
  TrunkRules,
  TrunkRulesInput,
  VendorTrunkDetail,
  VendorTrunkInput,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { fetchPickPage } from "./hooks";

export type TrunkKind = "customer" | "vendor";
export type TrunkDetail = CustomerTrunkDetail | VendorTrunkDetail;
export type TrunkInput = CustomerTrunkInput | VendorTrunkInput;
export type RecordKind =
  | "enterprise"
  | TrunkKind
  | "rate_table"
  | "route_rule"
  | "product_category"
  | "destination"
  | "dial_code_profile"
  | "mo_number"
  | "number_list"
  | "translation_rule"
  | "hlr_provider"
  | "hlr_rule"
  | "hlr_policy"
  | "transaction"
  | "billing_cycle"
  | "invoice"
  | "vendor_invoice"
  | "recon_rule"
  | "firewall_rule"
  | "traffic_alert"
  | "sms_voice_rule"
  | "edr_template"
  | "scheduled_report"
  | "daily_traffic_alert"
  | "user"
  | "department"
  | "access_group"
  | "email_template"
  | "business_company"
  | "portal_user"
  | "alert_rule";

export interface Saved<T> {
  record: T;
  change: Change | null;
}

/** Refreshes record views and lists after a write. */
export function useRefreshRecords() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["record"] }),
      qc.invalidateQueries({ queryKey: ["list"] }),
      qc.invalidateQueries({ queryKey: ["history"] }),
    ]);
}

export function useReference() {
  return useQuery<ReferenceData>({
    queryKey: ["reference"],
    queryFn: () => unwrap(api.GET("/meta/reference")),
    staleTime: 10 * 60_000,
  });
}

/** Margins, converted rates and totals are in the platform currency (decided 2026-10-16: EUR by default). */
export function usePlatformCurrency(): string {
  return useReference().data?.platformCurrency ?? "EUR";
}

// ---------------------------------------------------------------- enterprise

export function useEnterprise(id: number | null) {
  return useQuery<EnterpriseDetail>({
    queryKey: ["record", "enterprise", id],
    queryFn: () => unwrap(api.GET("/enterprises/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
    retry: false,
  });
}

/** An enterprise's name, alias and type by id, names only (backend step 10: no Enterprises page needed). */
export function useEnterpriseName(id: number | null) {
  return useQuery({
    queryKey: ["lookup", "enterprises", "id", id],
    queryFn: () =>
      fetchPickPage<Pick<Enterprise, "id" | "name" | "alias" | "type">>("enterprises", {
        filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: id! }] },
        limit: 1,
        withTotal: false,
      }),
    select: (p) => p.rows[0] ?? null,
    enabled: id !== null,
    staleTime: 60_000,
  });
}

export function useSaveEnterprise() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: EnterpriseInput }) =>
      (id === null
        ? unwrap(api.POST("/enterprises", { body: input }))
        : unwrap(api.PUT("/enterprises/{id}", { params: { path: { id } }, body: input }))) as Promise<
        Saved<EnterpriseDetail>
      >,
    onSuccess: () => void refresh(),
  });
}

export function useBilling(id: number) {
  return useQuery<EnterpriseBilling>({
    queryKey: ["record", "billing", id],
    queryFn: () => unwrap(api.GET("/enterprises/{id}/billing", { params: { path: { id } } })),
    retry: false,
  });
}

export function useSaveBilling(id: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (input: EnterpriseBillingInput) =>
      unwrap(api.PUT("/enterprises/{id}/billing", { params: { path: { id } }, body: input })) as Promise<
        Saved<EnterpriseBilling>
      >,
    onSuccess: () => void refresh(),
  });
}

export function useAmHistory(id: number) {
  return useQuery<AmPeriod[]>({
    queryKey: ["record", "am", id],
    queryFn: () => unwrap(api.GET("/enterprises/{id}/account-managers", { params: { path: { id } } })),
    retry: false,
  });
}

export function useHandover(id: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (input: HandoverRequest) =>
      unwrap(api.POST("/enterprises/{id}/handover", { params: { path: { id } }, body: input })),
    onSuccess: () => void refresh(),
  });
}

export function useDocs(id: number) {
  return useQuery<EnterpriseDoc[]>({
    queryKey: ["record", "docs", id],
    queryFn: () => unwrap(api.GET("/enterprises/{id}/docs", { params: { path: { id } } })),
    retry: false,
  });
}

export function useUploadDoc(id: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (input: EnterpriseDocUpload) =>
      unwrap(api.POST("/enterprises/{id}/docs", { params: { path: { id } }, body: input })),
    onSuccess: () => void refresh(),
  });
}

export function useDeleteDoc(id: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (docId: number) =>
      unwrap(api.DELETE("/enterprises/{id}/docs/{docId}", { params: { path: { id, docId } } })),
    onSuccess: () => void refresh(),
  });
}

export const docUrl = (id: number, docId: number) => `/api/v1/enterprises/${id}/docs/${docId}/file`;

// ---------------------------------------------------------------- trunks

export function useTrunk(kind: TrunkKind, id: number | null) {
  return useQuery<TrunkDetail>({
    queryKey: ["record", kind, id],
    queryFn: () =>
      kind === "customer"
        ? unwrap(api.GET("/customer-trunks/{id}", { params: { path: { id: id! } } }))
        : unwrap(api.GET("/vendor-trunks/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
    retry: false,
  });
}

export function useSaveTrunk(kind: TrunkKind) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: TrunkInput }): Promise<Saved<TrunkDetail>> => {
      if (kind === "customer") {
        const body = input as CustomerTrunkInput;
        return id === null
          ? unwrap(api.POST("/customer-trunks", { body }))
          : unwrap(api.PUT("/customer-trunks/{id}", { params: { path: { id } }, body }));
      }
      const body = input as VendorTrunkInput;
      return id === null
        ? unwrap(api.POST("/vendor-trunks", { body }))
        : unwrap(api.PUT("/vendor-trunks/{id}", { params: { path: { id } }, body }));
    },
    onSuccess: () => void refresh(),
  });
}

/** A saved trunk's password, on request (the form's eye and copy buttons, team trial round 12). */
export const fetchTrunkPassword = (kind: TrunkKind, id: number): Promise<string> =>
  (kind === "customer"
    ? unwrap(api.GET("/customer-trunks/{id}/password", { params: { path: { id } } }))
    : unwrap(api.GET("/vendor-trunks/{id}/password", { params: { path: { id } } }))
  ).then((r) => r.password);

export function useTrunkRules(kind: TrunkKind, id: number) {
  return useQuery<TrunkRules>({
    queryKey: ["record", kind, id, "rules"],
    queryFn: () =>
      kind === "customer"
        ? unwrap(api.GET("/customer-trunks/{id}/rules", { params: { path: { id } } }))
        : unwrap(api.GET("/vendor-trunks/{id}/rules", { params: { path: { id } } })),
    retry: false,
  });
}

export function useSaveTrunkRules(kind: TrunkKind, id: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (body: TrunkRulesInput): Promise<Saved<TrunkRules>> =>
      kind === "customer"
        ? unwrap(api.PUT("/customer-trunks/{id}/rules", { params: { path: { id } }, body }))
        : unwrap(api.PUT("/vendor-trunks/{id}/rules", { params: { path: { id } }, body })),
    onSuccess: () => void refresh(),
  });
}

/** An enterprise's merged rule order over its trunks of one kind (team trial round 4). */
export function useEnterpriseRules(id: number, kind: TrunkKind) {
  return useQuery<EnterpriseRules>({
    queryKey: ["record", "enterprise", id, "rules", kind],
    queryFn: () => unwrap(api.GET("/enterprises/{id}/rules", { params: { path: { id }, query: { kind } } })),
    retry: false,
  });
}

export function useSaveEnterpriseRules(id: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (body: EnterpriseRulesInput): Promise<EnterpriseRulesSaved> =>
      unwrap(api.PUT("/enterprises/{id}/rules", { params: { path: { id } }, body })),
    onSuccess: () => void refresh(),
  });
}

// ---------------------------------------------------------------- destinations (§6.1)

/** Set or remove a destination's DLR target (decided 2026-10-16); one undoable change. */
export function useSetDlrTarget() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, targetPct }: { id: number; targetPct: number | null }): Promise<DestinationSaved> =>
      unwrap(api.PUT("/destinations/{id}/dlr-target", { params: { path: { id } }, body: { targetPct } })),
    onSuccess: () => void refresh(),
  });
}

// ---------------------------------------------------------------- safe delete (§13.29)

export function fetchDependencies(kind: RecordKind, id: number): Promise<Dependencies> {
  const params = { params: { path: { id } } };
  if (kind === "enterprise") return unwrap(api.GET("/enterprises/{id}/dependencies", params));
  if (kind === "rate_table") return unwrap(api.GET("/rate-tables/{id}/dependencies", params));
  if (kind === "route_rule") return unwrap(api.GET("/route-rules/{id}/dependencies", params));
  if (kind === "product_category") return unwrap(api.GET("/product-categories/{id}/dependencies", params));
  if (kind === "destination") return unwrap(api.GET("/destinations/{id}/dependencies", params));
  // Nothing depends on a dial-code profile or an MO entry (§6.1).
  if (kind === "dial_code_profile" || kind === "mo_number") return Promise.resolve({ blocked: false, items: [] });
  if (kind === "number_list") return unwrap(api.GET("/number-lists/{id}/dependencies", params));
  // Assigned to a live trunk or enterprise: cannot be deleted (team trial round 3).
  if (kind === "translation_rule") return unwrap(api.GET("/translation-rules/{id}/dependencies", params));
  if (kind === "hlr_rule") return unwrap(api.GET("/hlr-rules/{id}/dependencies", params));
  if (kind === "hlr_provider") return unwrap(api.GET("/hlr-providers/{id}/dependencies", params));
  if (kind === "hlr_policy") return unwrap(api.GET("/hlr-policies/{id}/dependencies", params));
  if (kind === "transaction") return Promise.resolve({ blocked: false, items: [] });
  if (kind === "billing_cycle") return unwrap(api.GET("/billing-cycles/{id}/dependencies", params));
  if (kind === "invoice") return unwrap(api.GET("/invoices/{id}/dependencies", params));
  if (kind === "vendor_invoice") return unwrap(api.GET("/vendor-invoices/{id}/dependencies", params));
  // Removing a partner's own rule only brings the default rule back (§13.31).
  if (kind === "recon_rule") return Promise.resolve({ blocked: false, items: [] });
  // Nothing depends on a firewall IP, a traffic alert or an SMS to voice rule (§8), or an EDR template
  // (downloads keep their own columns, §9.2).
  if (
    kind === "firewall_rule" ||
    kind === "traffic_alert" ||
    kind === "sms_voice_rule" ||
    kind === "edr_template" ||
    kind === "scheduled_report" ||
    kind === "daily_traffic_alert"
  )
    return Promise.resolve({ blocked: false, items: [] });
  // Admin (§11): what blocks a delete is checked by the server.
  if (kind === "user") return unwrap(api.GET("/users/{id}/dependencies", params));
  if (kind === "department") return unwrap(api.GET("/departments/{id}/dependencies", params));
  if (kind === "access_group") return unwrap(api.GET("/access-groups/{id}/dependencies", params));
  if (kind === "email_template") return unwrap(api.GET("/email-templates/{id}/dependencies", params));
  if (kind === "business_company") return unwrap(api.GET("/business-companies/{id}/dependencies", params));
  if (kind === "portal_user") return Promise.resolve({ blocked: false, items: [] });
  // Deleting an alert rule only closes its open incidents (§13.6); nothing blocks it.
  if (kind === "alert_rule") return Promise.resolve({ blocked: false, items: [] });
  if (kind === "customer") return unwrap(api.GET("/customer-trunks/{id}/dependencies", params));
  return unwrap(api.GET("/vendor-trunks/{id}/dependencies", params));
}

export function useArchive(kind: RecordKind) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ArchiveRequest }): Promise<Saved<unknown>> => {
      const req = { params: { path: { id } }, body };
      if (kind === "enterprise") return unwrap(api.POST("/enterprises/{id}/archive", req));
      if (kind === "rate_table") return unwrap(api.POST("/rate-tables/{id}/archive", req));
      if (kind === "route_rule") return unwrap(api.POST("/route-rules/{id}/archive", req));
      if (kind === "product_category") return unwrap(api.POST("/product-categories/{id}/archive", req));
      if (kind === "destination") return unwrap(api.POST("/destinations/{id}/archive", req));
      if (kind === "dial_code_profile") return unwrap(api.POST("/dial-code-profiles/{id}/archive", req));
      if (kind === "mo_number") return unwrap(api.POST("/mo-numbers/{id}/archive", req));
      if (kind === "number_list") return unwrap(api.POST("/number-lists/{id}/archive", req));
      if (kind === "translation_rule") return unwrap(api.POST("/translation-rules/{id}/archive", req));
      if (kind === "hlr_provider") return unwrap(api.POST("/hlr-providers/{id}/archive", req));
      if (kind === "hlr_rule") return unwrap(api.POST("/hlr-rules/{id}/archive", req));
      if (kind === "hlr_policy") return unwrap(api.POST("/hlr-policies/{id}/archive", req));
      if (kind === "transaction") return unwrap(api.POST("/transactions/{id}/archive", req));
      if (kind === "billing_cycle") return unwrap(api.POST("/billing-cycles/{id}/archive", req));
      if (kind === "invoice") return unwrap(api.POST("/invoices/{id}/archive", req));
      if (kind === "vendor_invoice") return unwrap(api.POST("/vendor-invoices/{id}/archive", req));
      if (kind === "recon_rule") return unwrap(api.POST("/recon-rules/{id}/archive", req));
      if (kind === "firewall_rule") return unwrap(api.POST("/firewall-rules/{id}/archive", req));
      if (kind === "traffic_alert") return unwrap(api.POST("/traffic-alerts/{id}/archive", req));
      if (kind === "sms_voice_rule") return unwrap(api.POST("/sms-voice-rules/{id}/archive", req));
      if (kind === "edr_template") return unwrap(api.POST("/edr-templates/{id}/archive", req));
      if (kind === "scheduled_report") return unwrap(api.POST("/scheduled-reports/{id}/archive", req));
      if (kind === "daily_traffic_alert") return unwrap(api.POST("/daily-traffic-alerts/{id}/archive", req));
      if (kind === "user") return unwrap(api.POST("/users/{id}/archive", req));
      if (kind === "department") return unwrap(api.POST("/departments/{id}/archive", req));
      if (kind === "access_group") return unwrap(api.POST("/access-groups/{id}/archive", req));
      if (kind === "email_template") return unwrap(api.POST("/email-templates/{id}/archive", req));
      if (kind === "business_company") return unwrap(api.POST("/business-companies/{id}/archive", req));
      if (kind === "portal_user") return unwrap(api.POST("/customer-portal-users/{id}/archive", req));
      if (kind === "alert_rule") return unwrap(api.POST("/alert-rules/{id}/archive", req));
      if (kind === "customer") return unwrap(api.POST("/customer-trunks/{id}/archive", req));
      return unwrap(api.POST("/vendor-trunks/{id}/archive", req));
    },
    onSuccess: () => void refresh(),
  });
}

export function useRestore(kind: RecordKind) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (id: number): Promise<Saved<unknown>> => {
      const req = { params: { path: { id } } };
      if (kind === "enterprise") return unwrap(api.POST("/enterprises/{id}/restore", req));
      if (kind === "rate_table") return unwrap(api.POST("/rate-tables/{id}/restore", req));
      if (kind === "route_rule") return unwrap(api.POST("/route-rules/{id}/restore", req));
      if (kind === "product_category") return unwrap(api.POST("/product-categories/{id}/restore", req));
      if (kind === "destination") return unwrap(api.POST("/destinations/{id}/restore", req));
      if (kind === "dial_code_profile") return unwrap(api.POST("/dial-code-profiles/{id}/restore", req));
      if (kind === "mo_number") return unwrap(api.POST("/mo-numbers/{id}/restore", req));
      if (kind === "number_list") return unwrap(api.POST("/number-lists/{id}/restore", req));
      if (kind === "translation_rule") return unwrap(api.POST("/translation-rules/{id}/restore", req));
      if (kind === "hlr_provider") return unwrap(api.POST("/hlr-providers/{id}/restore", req));
      if (kind === "hlr_rule") return unwrap(api.POST("/hlr-rules/{id}/restore", req));
      if (kind === "hlr_policy") return unwrap(api.POST("/hlr-policies/{id}/restore", req));
      if (kind === "transaction") return unwrap(api.POST("/transactions/{id}/restore", req));
      if (kind === "billing_cycle") return unwrap(api.POST("/billing-cycles/{id}/restore", req));
      if (kind === "invoice") return unwrap(api.POST("/invoices/{id}/restore", req));
      if (kind === "vendor_invoice") return unwrap(api.POST("/vendor-invoices/{id}/restore", req));
      if (kind === "recon_rule") return unwrap(api.POST("/recon-rules/{id}/restore", req));
      if (kind === "firewall_rule") return unwrap(api.POST("/firewall-rules/{id}/restore", req));
      if (kind === "traffic_alert") return unwrap(api.POST("/traffic-alerts/{id}/restore", req));
      if (kind === "sms_voice_rule") return unwrap(api.POST("/sms-voice-rules/{id}/restore", req));
      if (kind === "edr_template") return unwrap(api.POST("/edr-templates/{id}/restore", req));
      if (kind === "scheduled_report") return unwrap(api.POST("/scheduled-reports/{id}/restore", req));
      if (kind === "daily_traffic_alert") return unwrap(api.POST("/daily-traffic-alerts/{id}/restore", req));
      if (kind === "user") return unwrap(api.POST("/users/{id}/restore", req));
      if (kind === "department") return unwrap(api.POST("/departments/{id}/restore", req));
      if (kind === "access_group") return unwrap(api.POST("/access-groups/{id}/restore", req));
      if (kind === "email_template") return unwrap(api.POST("/email-templates/{id}/restore", req));
      if (kind === "business_company") return unwrap(api.POST("/business-companies/{id}/restore", req));
      if (kind === "portal_user") return unwrap(api.POST("/customer-portal-users/{id}/restore", req));
      if (kind === "alert_rule") return unwrap(api.POST("/alert-rules/{id}/restore", req));
      if (kind === "customer") return unwrap(api.POST("/customer-trunks/{id}/restore", req));
      return unwrap(api.POST("/vendor-trunks/{id}/restore", req));
    },
    onSuccess: () => void refresh(),
  });
}

// ---------------------------------------------------------------- Rate Manager (§13.12)

export function useRateTable(id: number | null) {
  return useQuery<RateTableDetail>({
    queryKey: ["record", "rate_table", id],
    queryFn: () => unwrap(api.GET("/rate-tables/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
    retry: false,
  });
}

export function useSaveRateTable() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (
      arg: { id: null; input: RateTableInput } | { id: number; input: RateTableUpdate },
    ): Promise<Saved<RateTableDetail>> =>
      arg.id === null
        ? unwrap(api.POST("/rate-tables", { body: arg.input }))
        : unwrap(api.PUT("/rate-tables/{id}", { params: { path: { id: arg.id } }, body: arg.input })),
    onSuccess: () => void refresh(),
  });
}

/** One batch of rate edits = one undoable change. A 409 carries the notice breaches. */
export function useChangeRateLines(id: number) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (body: RateLineChanges): Promise<RateLineChangesSaved> =>
      unwrap(api.POST("/rate-tables/{id}/lines/changes", { params: { path: { id } }, body })),
    onSuccess: () => void refresh(),
  });
}

/** Bulk rating across tables (§13.11): preview changes nothing; apply is one undoable change. */
export const previewRateBulk = (body: RateBulkScope): Promise<RateBulkPreview> =>
  unwrap(api.POST("/rate-bulk/preview", { body }));
export function useApplyRateBulk() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (body: RateBulkApply): Promise<RateBulkSaved> => unwrap(api.POST("/rate-bulk/apply", { body })),
    onSuccess: () => void refresh(),
  });
}

export const rateExportUrl = (id: number, view: "current" | "scheduled" | "closed") =>
  `/api/v1/rate-tables/${id}/export?view=${view}`;
