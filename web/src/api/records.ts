// Record hooks for the Enterprise and trunk screens (§5). Every record query lives under
// ["record", ...] so a save, an archive or an undo can refresh them all (§13.10).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AmPeriod,
  ArchiveRequest,
  Change,
  CustomerTrunkDetail,
  CustomerTrunkInput,
  Dependencies,
  EnterpriseBilling,
  EnterpriseBillingInput,
  EnterpriseDetail,
  EnterpriseDoc,
  EnterpriseDocUpload,
  EnterpriseInput,
  HandoverRequest,
  RateLineChanges,
  RateLineChangesSaved,
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

export type TrunkKind = "customer" | "vendor";
export type TrunkDetail = CustomerTrunkDetail | VendorTrunkDetail;
export type TrunkInput = CustomerTrunkInput | VendorTrunkInput;
export type RecordKind = "enterprise" | TrunkKind | "rate_table" | "route_rule";

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

// ---------------------------------------------------------------- safe delete (§13.29)

export function fetchDependencies(kind: RecordKind, id: number): Promise<Dependencies> {
  const params = { params: { path: { id } } };
  if (kind === "enterprise") return unwrap(api.GET("/enterprises/{id}/dependencies", params));
  if (kind === "rate_table") return unwrap(api.GET("/rate-tables/{id}/dependencies", params));
  if (kind === "route_rule") return unwrap(api.GET("/route-rules/{id}/dependencies", params));
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

export const rateExportUrl = (id: number, view: "current" | "scheduled" | "closed") =>
  `/api/v1/rate-tables/${id}/export?view=${view}`;
