// Billing of an enterprise (§5.3): a customer side and/or a vendor side by type, each with
// currency, billing cycle, time zone and opening balance, the live balance, and the
// beneficiary (bank) details. Credit use is coloured only past the alert levels (§15.3).
import { useCan } from "../../api/access";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  BillingSide,
  BillingSideInput,
  EnterpriseBilling,
  EnterpriseBillingInput,
  EnterpriseDetail,
  InvoiceRow,
} from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { useBilling, useReference, useSaveBilling } from "../../api/records";
import { emptyState, encodeState } from "../../grid/filterModel";
import { useTabNavigate } from "../../shell/tabContext";
import {
  CheckField,
  FormBanner,
  FormField,
  NumberField,
  Section,
  SelectField,
  SubHead,
  TextArea,
  TextField,
  useForm,
  type FormApi,
} from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { Button } from "../../ui/primitives";
import { HeaderAction, type SectionProps } from "../../records/parts";
import { balanceWords } from "../finance/financeModel";
import { tzOptions } from "../../ui/timezones";
import { levelBands } from "./GeneralTab";

type Side = "customer" | "vendor";
interface Form {
  customer: BillingSideInput | null;
  vendor: BillingSideInput | null;
  beneficiary: NonNullable<EnterpriseBillingInput["beneficiary"]>;
}

const sideInput = (s: BillingSide): BillingSideInput => ({
  currency: s.currency,
  billingCycleId: s.billingCycleId,
  timezone: s.timezone,
  billingType: s.billingType ?? null,
  creditLimit: s.creditLimit ?? null,
  openingBalance: s.openingBalance,
  autoInvoicing: s.autoInvoicing ?? false,
  sendPaymentConfirmation: s.sendPaymentConfirmation ?? false,
  description: s.description ?? null,
  balanceAlert: s.balanceAlert ?? true,
  balanceAlertPercent: { ...(s.balanceAlertPercent ?? { notice: 50, warning: 70, critical: 90 }) },
});

const toForm = (b: EnterpriseBilling): Form => ({
  customer: b.customer ? sideInput(b.customer) : null,
  vendor: b.vendor ? sideInput(b.vendor) : null,
  beneficiary: { ...b.beneficiary },
});

const money = (n: number, ccy: string) =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${ccy}`;

function CreditUse({ side, enterprise }: { side: BillingSide; enterprise: EnterpriseDetail }) {
  if (side.billingType !== "postpaid" || !side.creditLimit) return null;
  // A negative balance is what the client owes us (§7 balance sign).
  const pct = Math.max(0, (-side.balance / side.creditLimit) * 100);
  const p = enterprise.creditAlertPercent;
  const tone = pct >= p.critical ? "error" : pct >= p.warning ? "warning" : null;
  return (
    <span className={tone ? `tone-${tone}` : "muted"}>
      {pct.toFixed(0)}% of credit limit used{tone ? (tone === "error" ? " · critical" : " · warning") : ""}
    </span>
  );
}

function SideSection({
  form,
  side,
  saved,
  enterprise,
}: {
  form: FormApi<Form>;
  side: Side;
  saved: BillingSide | null;
  enterprise: EnterpriseDetail;
}) {
  const ref = useReference();
  const v = form.values[side];
  const title = side === "customer" ? "Customer billing" : "Vendor billing";
  if (!v) {
    const bc = ref.data?.businessCompanies.find((b) => b.id === enterprise.businessCompanyId);
    // A bilateral partner's second side starts from the first: one currency (locked), and the same billing cycle and
    // time zone, which can be changed (team trial round 12).
    const other = form.values[side === "customer" ? "vendor" : "customer"];
    return (
      <Section title={title} columns={1}>
        <p className="muted">
          No {side} billing yet.{" "}
          <button
            type="button"
            className="link"
            disabled={!!enterprise.archived}
            onClick={() =>
              form.set(side, {
                currency: other?.currency ?? bc?.baseCurrency ?? "EUR",
                billingCycleId: other?.billingCycleId ?? ref.data?.billingCycles[0]?.id ?? 1,
                timezone: other?.timezone ?? enterprise.billingTimezone,
                billingType: "postpaid",
                creditLimit: null,
                openingBalance: 0,
                autoInvoicing: side === "customer",
                sendPaymentConfirmation: false,
                description: null,
                balanceAlert: true,
                balanceAlertPercent: { notice: 50, warning: 70, critical: 90 },
              } satisfies BillingSideInput)
            }
          >
            Set up {side} billing
          </button>
        </p>
      </Section>
    );
  }
  const p = (k: string) => `${side}.${k}`;
  // The vendor side of a bilateral partner bills in the customer side's currency (team trial round 12).
  const lockedTo = side === "vendor" ? form.values.customer?.currency : undefined;
  return (
    <Section
      title={title}
      subtitle={saved ? undefined : "Not saved yet"}
      columns={4}
    >
      <SelectField
        form={form}
        path={p("currency")}
        label="Currency"
        required
        disabled={!!lockedTo}
        options={(ref.data?.currencies ?? []).map((c) => ({ value: c.iso, label: `${c.iso} – ${c.name}` }))}
        hint={lockedTo ? "Same as the customer billing" : saved ? "Locked: fixed once invoices exist" : undefined}
      />
      <SelectField
        form={form}
        path={p("billingCycleId")}
        label="Billing cycle"
        required
        options={(ref.data?.billingCycles ?? []).map((c) => ({ value: c.id, label: c.name }))}
      />
      <SelectField
        form={form}
        path={p("timezone")}
        label="Time zone"
        required
        options={tzOptions(ref.data?.timezones ?? ["UTC"])}
      />
      <SelectField
        form={form}
        path={p("billingType")}
        label="Billing type"
        required
        hint={side === "vendor" ? "Prepaid: we pay this vendor in advance" : undefined}
        options={[
          { value: "postpaid", label: "Postpaid" },
          { value: "prepaid", label: "Prepaid" },
        ]}
      />
      {side === "customer" && v.billingType === "postpaid" && (
        <NumberField form={form} path={p("creditLimit")} label="Credit limit" min={0} step={100} suffix={v.currency} />
      )}
      <NumberField
        form={form}
        path={p("openingBalance")}
        label="Opening balance"
        hint="Positive = starts in credit, negative = starts owing"
        required
        step={0.0001}
        suffix={v.currency}
      />
      {side === "customer" && <CheckField form={form} path={p("autoInvoicing")} label="Auto invoicing" />}
      <CheckField
        form={form}
        path={p("sendPaymentConfirmation")}
        // To a vendor it is the payment itself (team trial round 7).
        label={side === "vendor" ? "Send payment" : "Send payment confirmation"}
        hint="Default for new payments"
      />
      {side === "vendor" && v.billingType === "prepaid" && (
        <>
          {/* Q22, product owner 2026-10-25: alerts as the prepaid funds are used; traffic never stops. */}
          <CheckField
            form={form}
            path={p("balanceAlert")}
            label="Balance alert"
            hint="Alert as the prepaid funds are used up"
          />
          {/* The same coloured bands as the credit alert levels (team trial round 7). */}
          {v.balanceAlert && v.balanceAlertPercent && (
            <div className="credit-bar wide" aria-hidden="true" style={{ background: levelBands(v.balanceAlertPercent) }}>
              {(["notice", "warning", "critical"] as const).map((k) => (
                <span key={k} className={`cb-${k}`} style={{ left: `${Math.min(100, v.balanceAlertPercent![k])}%` }} />
              ))}
            </div>
          )}
          {v.balanceAlert &&
            (["notice", "warning", "critical"] as const).map((k) => (
              <NumberField
                key={k}
                form={form}
                path={p(`balanceAlertPercent.${k}`)}
                label={`${k[0]!.toUpperCase()}${k.slice(1)} at`}
                hint={k === "notice" ? "% of the prepaid funds used" : undefined}
                min={1}
                max={100}
                step={1}
                suffix="%"
                required
              />
            ))}
        </>
      )}
      {/* In the row with the boxes above, not on a line of its own (team trial round 12). */}
      <TextArea
        form={form}
        path={p("description")}
        label="Description"
        rows={1}
        wide={false}
        placeholder="Optional notes about this partner's billing"
      />
    </Section>
  );
}

/** The latest invoice: what is due, by when and whether it is paid (team trial round 4; replaces the formula). */
function LastInvoiceCard({ enterpriseId }: { enterpriseId: number }) {
  const navigate = useTabNavigate();
  const q = useQuery({
    queryKey: ["list", "invoices", "last", enterpriseId],
    queryFn: () =>
      fetchListPage<InvoiceRow>("invoices", {
        filter: { logic: "and", conditions: [{ field: "enterpriseId", op: "eq", value: enterpriseId }] },
        sort: [
          { field: "invoiceDate", dir: "desc" },
          { field: "id", dir: "desc" },
        ],
        limit: 1,
        withTotal: false,
      }),
    staleTime: 60_000,
  });
  const inv = q.data?.rows[0];
  const overdue = inv && inv.paymentStatus !== "paid" && inv.dueDate < new Date().toISOString().slice(0, 10);
  const all = `/finance/invoices?g=${encodeState({
    ...emptyState(),
    columns: { enterpriseId: { field: "enterpriseId", op: "eq", value: enterpriseId } },
  })}`;
  return (
    <div className="bill-card">
      <span className="bill-card-label">Last invoice</span>
      {!inv ? (
        <span className="muted">{q.isLoading ? "Loading…" : "No invoices yet"}</span>
      ) : (
        <>
          <span className="bill-card-value small-value">
            {(inv.dueAmount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}{" "}
            <small>{inv.currency}</small>
          </span>
          <span className="small">
            {inv.invoiceNumber} · due {inv.dueDate} ·{" "}
            <span className={inv.paymentStatus === "paid" ? "tone-good" : overdue ? "tone-error" : "tone-warning"}>
              {inv.paymentStatus === "paid"
                ? "Paid"
                : overdue
                  ? "Overdue"
                  : inv.paymentStatus === "partial"
                    ? "Partly paid"
                    : "Unpaid"}
            </span>
          </span>
        </>
      )}
      <button type="button" className="link small bill-card-link" onClick={() => navigate(all, { newTab: true })}>
        All invoices of this partner
      </button>
    </div>
  );
}

/** The billing summary (record redesign, team trial round 4): balance, how it is worked out, billing cycle. */
function BillingSummary({ billing, enterprise }: { billing: EnterpriseBilling; enterprise: EnterpriseDetail }) {
  const canInvoices = useCan("invoices");
  const ref = useReference();
  const sides = (["customer", "vendor"] as const).filter((k) => billing[k]);
  const first = billing[sides[0] ?? "customer"];
  const cycle = first ? ref.data?.billingCycles.find((c) => c.id === first.billingCycleId)?.name : null;
  return (
    <div className="bill-summary">
      {sides.map((k) => {
        const b = billing[k]!;
        const words = balanceWords(b.balance, k);
        return (
          <div key={k} className={`bill-card balance ${b.balance >= 0 ? "credit" : "owed"}`}>
            <span className="bill-card-label">
              Current balance{sides.length > 1 ? ` · ${k === "customer" ? "customer" : "vendor"}` : ""}
            </span>
            <span className="bill-card-value">
              {b.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}{" "}
              <small>{b.currency}</small>
            </span>
            <span className="small">
              {words.text} <CreditUse side={b} enterprise={enterprise} />
            </span>
          </div>
        );
      })}
      {/* Only for users who may open Invoices (backend step 10). */}
      {canInvoices && <LastInvoiceCard enterpriseId={enterprise.id} />}
      {first && (
        <div className="bill-card">
          <span className="bill-card-label">Billing cycle</span>
          <span className="bill-card-value small-value">{cycle ?? `#${first.billingCycleId}`}</span>
          <span className="muted small">
            Updated {first.updatedAt.slice(0, 10)}
            {first.updatedBy ? ` by ${first.updatedBy}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/** The bank account's currency: one of the system's or typed, any length (e.g. USDT; team trial round 12). */
function AccountCurrency({ form }: { form: FormApi<Form> }) {
  const ref = useReference();
  const id = "beneficiary-currency";
  const v = form.values.beneficiary.currency;
  return (
    <FormField label="Account currency" htmlFor={id} error={form.error("beneficiary.currency")}>
      <input
        id={id}
        list={`${id}-list`}
        maxLength={20}
        value={v ?? ""}
        placeholder="Pick or type"
        autoComplete="off"
        onChange={(e) => form.set("beneficiary.currency", e.target.value.trim() === "" ? null : e.target.value)}
      />
      <datalist id={`${id}-list`}>
        {(ref.data?.currencies ?? []).map((c) => (
          <option key={c.iso} value={c.iso}>
            {c.name}
          </option>
        ))}
      </datalist>
    </FormField>
  );
}

export function BillingTab({ enterprise, slot, onDirty }: SectionProps & { enterprise: EnterpriseDetail }) {
  const q = useBilling(enterprise.id);
  const form = useForm<Form>({ customer: null, vendor: null, beneficiary: {} });
  const save = useSaveBilling(enterprise.id);
  const notifySaved = useNotifySaved();
  const [banner, setBanner] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const readOnly = !!enterprise.archived;

  useEffect(() => {
    if (q.data && (!loaded || !form.dirty)) {
      form.reset(toForm(q.data));
      setLoaded(true);
    }
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDirty(form.dirty), [form.dirty, onDirty]);

  // The vendor side follows the customer side's currency, and its billing cycle while the two were the same (team
  // trial round 12): a change on the customer side is copied; the vendor's cycle stays changeable.
  const prev = useRef<{ currency?: string; cycle?: number } | null>(null);
  const cust = form.values.customer;
  useEffect(() => {
    const before = prev.current;
    prev.current = { currency: cust?.currency, cycle: cust?.billingCycleId };
    const vendor = form.values.vendor;
    if (!before || !cust || !vendor) return;
    if (before.currency !== cust.currency && vendor.currency !== cust.currency)
      form.set("vendor.currency", cust.currency);
    if (before.cycle !== cust.billingCycleId && vendor.billingCycleId === before.cycle)
      form.set("vendor.billingCycleId", cust.billingCycleId);
  }, [cust?.currency, cust?.billingCycleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sides: Side[] = enterprise.type === "reciprocal" ? ["customer", "vendor"] : [enterprise.type as Side];
  const submit = () => {
    const v = form.values;
    const body: EnterpriseBillingInput = { beneficiary: v.beneficiary };
    for (const s of sides) if (v[s]) body[s] = v[s]!;
    setBanner(null);
    save.mutate(body, {
      onSuccess: (r) => {
        form.reset(toForm(r.record));
        if (r.change) notifySaved(r.change, "Billing saved");
      },
      onError: (err) => setBanner(form.fail(err)),
    });
  };

  if (q.isError) return <p className="error-text">{(q.error as Error).message}</p>;
  if (!loaded) return <p className="muted">Loading…</p>;
  return (
    <>
      <HeaderAction slot={slot}>
        <Button variant="primary" icon="save" disabled={readOnly || !form.dirty || save.isPending} onClick={submit}>
          Save billing
        </Button>
        {form.dirty && (
          <Button variant="ghost" onClick={() => q.data && form.reset(toForm(q.data))}>
            Discard
          </Button>
        )}
      </HeaderAction>
      <FormBanner message={banner} onClose={() => setBanner(null)} />
      {q.data && <BillingSummary billing={q.data} enterprise={enterprise} />}
      <fieldset disabled={readOnly} className="plain-fieldset form-main">
        {sides.map((s) => (
          <SideSection key={s} form={form} side={s} saved={q.data?.[s] ?? null} enterprise={enterprise} />
        ))}
        <Section title="Beneficiary" columns={1}>
          <SubHead>Account holder</SubHead>
          <div className="fgrid cols-2">
            <TextField form={form} path="beneficiary.beneficiaryName" label="Beneficiary name" />
            <TextField form={form} path="beneficiary.address" label="Beneficiary address" />
          </div>
          <SubHead>Bank</SubHead>
          <div className="fgrid cols-3">
            <TextField form={form} path="beneficiary.bank" label="Bank" />
            <TextField form={form} path="beneficiary.bankAddress" label="Bank address" />
            <TextField form={form} path="beneficiary.swift" label="SWIFT / BIC" />
          </div>
          <div className="sub-panel">
            <SubHead>Account</SubHead>
            <div className="fgrid cols-4">
              <TextField form={form} path="beneficiary.iban" label="IBAN" />
              <TextField form={form} path="beneficiary.accountNumber" label="Account number" />
              <AccountCurrency form={form} />
              <TextField form={form} path="beneficiary.walletAddress" label="Crypto wallet" placeholder="Optional" />
            </div>
          </div>
        </Section>
      </fieldset>
    </>
  );
}
