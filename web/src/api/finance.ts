// Finance part 1 (§7, §13.33): transactions (confirmation, In SOA), currencies and exchange
// rates, billing cycles and the Charges Calculator. Every save answers {record, change} so the
// Undo toast works (§13.10).
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  BillingCycleInput,
  BillingCycleSaved,
  ChangeResult,
  ChargesInput,
  ChargesResult,
  ConfirmationPreview,
  ConvertInput,
  ConvertResult,
  CurrencyInput,
  CurrencyRateSaved,
  CurrencySaved,
  CurrencySyncResult,
  CurrencyUpdate,
  EnterpriseBilling,
  TransactionBulkInput,
  TransactionDetail,
  TransactionInput,
  TransactionSaved,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { useRefreshRecords } from "./records";

export function useTransaction(id: number | null) {
  return useQuery<TransactionDetail>({
    queryKey: ["record", "transaction", id],
    queryFn: () => unwrap(api.GET("/transactions/{id}", { params: { path: { id: id! } } })),
    enabled: id !== null,
  });
}

/** An enterprise's billing settings (currency and confirmation default per side), when picked. */
export function useEnterpriseBillingOf(id: number | null) {
  return useQuery<EnterpriseBilling>({
    queryKey: ["record", "billing", id],
    queryFn: () => unwrap(api.GET("/enterprises/{id}/billing", { params: { path: { id: id! } } })),
    enabled: id !== null,
    retry: false,
  });
}

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}

export const useSaveTransaction = () =>
  useWrite(({ id, input }: { id: number | null; input: TransactionInput }): Promise<TransactionSaved> =>
    id === null
      ? unwrap(api.POST("/transactions", { body: input }))
      : unwrap(api.PUT("/transactions/{id}", { params: { path: { id } }, body: input })),
  );

export const useSendConfirmation = () =>
  useWrite((id: number): Promise<TransactionSaved> =>
    unwrap(api.POST("/transactions/{id}/send-confirmation", { params: { path: { id } } })),
  );

export const useBulkTransactions = () =>
  useWrite((body: TransactionBulkInput): Promise<ChangeResult> => unwrap(api.POST("/transactions/bulk", { body })));

export const previewConfirmation = (input: TransactionInput): Promise<ConfirmationPreview> =>
  unwrap(api.POST("/transactions/confirmation-preview", { body: input }));

export const convertAmount = (body: ConvertInput): Promise<ConvertResult> =>
  unwrap(api.POST("/transactions/convert", { body }));

export const useSaveCurrency = () =>
  useWrite(({ id, input }: { id: number | null; input: CurrencyInput }): Promise<CurrencySaved> =>
    id === null
      ? unwrap(api.POST("/currencies", { body: input }))
      : unwrap(
          api.PUT("/currencies/{id}", {
            params: { path: { id } },
            body: { name: input.name, symbol: input.symbol } satisfies CurrencyUpdate,
          }),
        ),
  );

export const useSetRate = () =>
  useWrite(({ iso, ratePerUsd }: { iso: string; ratePerUsd: number }): Promise<CurrencyRateSaved> =>
    unwrap(api.PUT("/currency-rates/{iso}", { params: { path: { iso } }, body: { ratePerUsd } })),
  );

export const useSyncRates = () => useWrite((): Promise<CurrencySyncResult> => unwrap(api.POST("/currency-rates/sync")));

export const useSaveBillingCycle = () =>
  useWrite(({ id, input }: { id: number | null; input: BillingCycleInput }): Promise<BillingCycleSaved> =>
    id === null
      ? unwrap(api.POST("/billing-cycles", { body: input }))
      : unwrap(api.PUT("/billing-cycles/{id}", { params: { path: { id } }, body: input })),
  );

export const calculateCharges = (body: ChargesInput): Promise<ChargesResult> =>
  unwrap(api.POST("/charges/calculate", { body }));
