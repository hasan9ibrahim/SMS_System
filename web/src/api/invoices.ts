// Finance part 2 (§7, §12.3, §13.31): invoices and invoice requests, vendor invoices with
// reconciliation, rules and the monthly summary. Saves answer {record, change} for the Undo toast
// (§13.10); invoice requests run in the background and are polled until they finish.
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ChangeResult,
  EmailPreview,
  InvoiceCharges,
  InvoiceDetail,
  InvoiceMarkInput,
  InvoiceRequestCreated,
  InvoiceRequestInput,
  InvoiceRequestRow,
  InvoiceSaved,
  InvoiceSendResult,
  InvoiceUpdate,
  ReconRuleInput,
  ReconRuleSaved,
  VendorInvoiceComparison,
  VendorInvoiceDecision,
  VendorInvoiceDetail,
  VendorInvoiceEmailInput,
  VendorInvoiceInput,
  VendorInvoiceSaved,
  VendorInvoiceSummary,
  VendorInvoiceSummaryInput,
} from "@sms/contract";
import { api, apiFetch, unwrap } from "./client";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}

// ---------------------------------------------------------------- invoices

export function useInvoice(id: number | null) {
  return useQuery<InvoiceDetail>({
    queryKey: ["record", "invoice", id],
    queryFn: () => unwrap(api.GET("/invoices/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

export function useInvoiceCharges(id: number | null) {
  return useQuery<InvoiceCharges>({
    queryKey: ["record", "invoice-charges", id],
    queryFn: () => unwrap(api.GET("/invoices/{id}/charges", { params: { path: { id: id! } } })),
    enabled: id !== null,
    staleTime: 60_000,
  });
}

export const useUpdateInvoice = () =>
  useWrite(({ id, input }: { id: number; input: InvoiceUpdate }): Promise<InvoiceSaved> =>
    unwrap(api.PUT("/invoices/{id}", { params: { path: { id } }, body: input })),
  );

export const useSendInvoices = () =>
  useWrite((ids: number[]): Promise<InvoiceSendResult> => unwrap(api.POST("/invoices/send", { body: { ids } })));

export const useMarkInvoices = () =>
  useWrite((body: InvoiceMarkInput): Promise<ChangeResult> => unwrap(api.POST("/invoices/mark", { body })));

export const useRegenerateInvoice = () =>
  useWrite((id: number): Promise<InvoiceRequestRow> =>
    unwrap(api.POST("/invoices/{id}/regenerate", { params: { path: { id } } })),
  );

export const createInvoiceRequest = (body: InvoiceRequestInput): Promise<InvoiceRequestCreated> =>
  unwrap(api.POST("/invoice-requests", { body }));

export const getInvoiceRequest = (id: number): Promise<InvoiceRequestRow> =>
  unwrap(api.GET("/invoice-requests/{id}", { params: { path: { id } } }));

/** Polls requests until each is completed or failed (every second, at most two minutes). */
export async function waitForRequests(ids: number[]): Promise<InvoiceRequestRow[]> {
  const done = new Map<number, InvoiceRequestRow>();
  for (let i = 0; i < 120 && done.size < ids.length; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const id of ids.filter((x) => !done.has(x))) {
      const r = await getInvoiceRequest(id);
      if (r.status === "completed" || r.status === "failed") done.set(id, r);
    }
  }
  return [...done.values()];
}

/** Downloads the invoice PDF ({invoiceNumber}.pdf). */
export async function downloadInvoicePdf(id: number) {
  const res = await apiFetch(`/api/v1/invoices/${id}/pdf`);
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new Error(problem.detail ?? problem.title ?? res.statusText);
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "invoice.pdf";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- vendor invoices

export function useVendorInvoice(id: number | null) {
  return useQuery<VendorInvoiceDetail>({
    queryKey: ["record", "vendor_invoice", id],
    queryFn: () => unwrap(api.GET("/vendor-invoices/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

export function useVendorComparison(id: number | null, checkedAt: string | null) {
  return useQuery<VendorInvoiceComparison>({
    queryKey: ["record", "vendor-comparison", id, checkedAt],
    queryFn: () => unwrap(api.GET("/vendor-invoices/{id}/comparison", { params: { path: { id: id! } } })),
    enabled: id !== null,
    staleTime: 60_000,
  });
}

export const useSaveVendorInvoice = () =>
  useWrite(({ id, input }: { id: number | null; input: VendorInvoiceInput }): Promise<VendorInvoiceSaved> =>
    id === null
      ? unwrap(api.POST("/vendor-invoices", { body: input }))
      : unwrap(api.PUT("/vendor-invoices/{id}", { params: { path: { id } }, body: input })),
  );

export const useRecheckVendorInvoice = () =>
  useWrite((id: number): Promise<VendorInvoiceSaved> =>
    unwrap(api.POST("/vendor-invoices/{id}/recheck", { params: { path: { id } } })),
  );

export const useDecideVendorInvoice = () =>
  useWrite(({ id, body }: { id: number; body: VendorInvoiceDecision }): Promise<VendorInvoiceSaved> =>
    unwrap(api.POST("/vendor-invoices/{id}/decide", { params: { path: { id } }, body })),
  );

export const useNoteVendorInvoice = () =>
  useWrite(({ id, note }: { id: number; note: string }): Promise<VendorInvoiceDetail> =>
    unwrap(api.POST("/vendor-invoices/{id}/notes", { params: { path: { id } }, body: { note } })),
  );

export const previewVendorEmail = (id: number, body: VendorInvoiceEmailInput): Promise<EmailPreview> =>
  unwrap(api.POST("/vendor-invoices/{id}/email-preview", { params: { path: { id } }, body }));

export const summariseVendorInvoices = (body: VendorInvoiceSummaryInput): Promise<VendorInvoiceSummary> =>
  unwrap(api.POST("/vendor-invoices/summary", { body }));

export const useSaveReconRule = () =>
  useWrite(({ id, input }: { id: number | null; input: ReconRuleInput }): Promise<ReconRuleSaved> =>
    id === null
      ? unwrap(api.POST("/recon-rules", { body: input }))
      : unwrap(api.PUT("/recon-rules/{id}", { params: { path: { id } }, body: input })),
  );
