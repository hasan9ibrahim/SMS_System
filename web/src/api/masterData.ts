// Product reference data (§6.1): saves, imports and exports for categories, countries,
// MCCMNC codes, Master Table profiles and dial codes, and the MO reference book. Every save
// answers {record, change} so the Undo toast works (§13.10).
import { useMutation } from "@tanstack/react-query";
import type {
  ChangeResult,
  Country,
  CountryInput,
  Destination,
  DestinationInput,
  DialCode,
  DialCodeInput,
  DialCodeProfile,
  DialCodeProfileInput,
  DialCodeUpdate,
  ImportRequest,
  ImportResult,
  ListQuery,
  MoNumber,
  MoNumberInput,
  ProductCategory,
  ProductCategoryInput,
} from "@sms/contract";
import { api, ApiError, unwrap } from "./client";
import { useRefreshRecords, type Saved } from "./records";

/** A save hook: POST when id is null, else PUT; refreshes lists and history afterwards. */
function useSave<In, Out>(save: (id: number | null, input: In) => Promise<Saved<Out>>) {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: In }) => save(id, input),
    onSuccess: () => void refresh(),
  });
}

export const useSaveCategory = () =>
  useSave<ProductCategoryInput, ProductCategory>((id, body) =>
    id === null
      ? unwrap(api.POST("/product-categories", { body }))
      : unwrap(api.PUT("/product-categories/{id}", { params: { path: { id } }, body })),
  );

export const useSaveCountry = () =>
  useSave<CountryInput, Country>((id, body) =>
    id === null
      ? unwrap(api.POST("/countries", { body }))
      : unwrap(api.PUT("/countries/{id}", { params: { path: { id } }, body })),
  );

export const useSaveDestination = () =>
  useSave<DestinationInput, Destination>((id, body) =>
    id === null
      ? unwrap(api.POST("/destinations", { body }))
      : unwrap(api.PUT("/destinations/{id}", { params: { path: { id } }, body })),
  );

export const useSaveProfile = () =>
  useSave<DialCodeProfileInput, DialCodeProfile>((id, body) =>
    id === null
      ? unwrap(api.POST("/dial-code-profiles", { body }))
      : unwrap(api.PUT("/dial-code-profiles/{id}", { params: { path: { id } }, body: { name: body.name } })),
  );

export const useSaveDialCode = () =>
  useSave<DialCodeInput, DialCode>((id, body) =>
    id === null
      ? unwrap(api.POST("/dial-codes", { body }))
      : unwrap(
          api.PUT("/dial-codes/{id}", {
            params: { path: { id } },
            body: { prefix: body.prefix, destinationId: body.destinationId } satisfies DialCodeUpdate,
          }),
        ),
  );

export const useSaveMoNumber = () =>
  useSave<MoNumberInput, MoNumber>((id, body) =>
    id === null
      ? unwrap(api.POST("/mo-numbers", { body }))
      : unwrap(api.PUT("/mo-numbers/{id}", { params: { path: { id } }, body })),
  );

export function useDeleteDialCodes() {
  const refresh = useRefreshRecords();
  return useMutation({
    mutationFn: (ids: number[]): Promise<ChangeResult> => unwrap(api.POST("/dial-codes/delete", { body: { ids } })),
    onSuccess: () => void refresh(),
  });
}

/** What an import dialog loads into. */
export type ImportTarget =
  | { kind: "destinations" }
  | { kind: "dial_codes"; profileId: number; profile: string }
  | { kind: "mo_numbers" }
  | { kind: "number_list"; listId: number }
  | { kind: "hlr_rates"; providerId: number }
  | { kind: "vendor_invoices" };

export function runImport(target: ImportTarget, body: ImportRequest): Promise<ImportResult> {
  if (target.kind === "destinations") return unwrap(api.POST("/destinations/import", { body }));
  if (target.kind === "mo_numbers") return unwrap(api.POST("/mo-numbers/import", { body }));
  if (target.kind === "vendor_invoices") return unwrap(api.POST("/vendor-invoices/import", { body }));
  if (target.kind === "hlr_rates")
    return unwrap(api.POST("/hlr-providers/{id}/rates/import", { params: { path: { id: target.providerId } }, body }));
  if (target.kind === "number_list")
    return unwrap(api.POST("/number-lists/{id}/import", { params: { path: { id: target.listId } }, body }));
  return unwrap(api.POST("/dial-code-profiles/{id}/import", { params: { path: { id: target.profileId } }, body }));
}

/** Downloads a CSV export: POST with the list query, or GET for a profile's dial codes. */
export async function downloadCsv(path: string, query?: Pick<ListQuery, "filter" | "search" | "sort">) {
  const res = await fetch(`/api/v1${path}`, {
    method: query ? "POST" : "GET",
    ...(query ? { headers: { "content-type": "application/json" }, body: JSON.stringify(query) } : {}),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, { ...problem, title: problem.title ?? res.statusText, status: res.status });
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
