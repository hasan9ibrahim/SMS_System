// Billing of an enterprise (§5.3): a customer side and/or a vendor side by type, each with
// currency, billing cycle, time zone and opening balance, the live balance, and the
// beneficiary (bank) details. Credit use is coloured only past the alert levels (§15.3).
import { useEffect, useState } from "react";
import type {
  BillingSide,
  BillingSideInput,
  EnterpriseBilling,
  EnterpriseBillingInput,
  EnterpriseDetail,
} from "@sms/contract";
import { useBilling, useReference, useSaveBilling } from "../../api/records";
import {
  CheckField,
  FormBanner,
  NumberField,
  ReadOnly,
  Section,
  SelectField,
  TextArea,
  TextField,
  useForm,
  type FormApi,
} from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { Button } from "../../ui/primitives";
import { HeaderAction, type SectionProps } from "../../records/parts";

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
});

const toForm = (b: EnterpriseBilling): Form => ({
  customer: b.customer ? sideInput(b.customer) : null,
  vendor: b.vendor ? sideInput(b.vendor) : null,
  beneficiary: { ...b.beneficiary },
});

const money = (n: number, ccy: string) =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;

function CreditUse({ side, enterprise }: { side: BillingSide; enterprise: EnterpriseDetail }) {
  if (side.billingType !== "postpaid" || !side.creditLimit) return null;
  const pct = Math.max(0, (side.balance / side.creditLimit) * 100);
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
                currency: bc?.baseCurrency ?? "USD",
                billingCycleId: ref.data?.billingCycles[0]?.id ?? 1,
                timezone: enterprise.billingTimezone,
                billingType: side === "customer" ? "postpaid" : null,
                creditLimit: null,
                openingBalance: 0,
                autoInvoicing: side === "customer",
                sendPaymentConfirmation: false,
                description: null,
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
  return (
    <Section
      title={title}
      note={
        saved
          ? `Updated ${saved.updatedAt.slice(0, 10)}${saved.updatedBy ? ` by ${saved.updatedBy}` : ""}`
          : "Not saved yet"
      }
    >
      <SelectField
        form={form}
        path={p("currency")}
        label="Currency"
        required
        options={(ref.data?.currencies ?? []).map((c) => ({ value: c.iso, label: `${c.iso} – ${c.name}` }))}
        hint={saved ? "Fixed once invoices exist" : undefined}
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
        options={(ref.data?.timezones ?? ["UTC"]).map((z) => ({ value: z, label: z }))}
      />
      {side === "customer" && (
        <SelectField
          form={form}
          path={p("billingType")}
          label="Billing type"
          required
          options={[
            { value: "postpaid", label: "Postpaid" },
            { value: "prepaid", label: "Prepaid" },
          ]}
        />
      )}
      {side === "customer" && v.billingType === "postpaid" && (
        <NumberField form={form} path={p("creditLimit")} label="Credit limit" min={0} step={100} suffix={v.currency} />
      )}
      <NumberField
        form={form}
        path={p("openingBalance")}
        label="Opening balance"
        required
        step={0.01}
        suffix={v.currency}
      />
      {saved && (
        <ReadOnly label="Balance" hint={side === "customer" ? "What the client owes us" : "What we owe the vendor"}>
          <span className="balance">{money(saved.balance, saved.currency)}</span>
          <CreditUse side={saved} enterprise={enterprise} />
        </ReadOnly>
      )}
      {side === "customer" && <CheckField form={form} path={p("autoInvoicing")} label="Auto invoicing" />}
      <CheckField
        form={form}
        path={p("sendPaymentConfirmation")}
        label="Send payment confirmation"
        hint="Default for new payments (§13.33)"
      />
      <TextArea form={form} path={p("description")} label="Description" rows={2} />
    </Section>
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
      <fieldset disabled={readOnly} className="plain-fieldset">
        {sides.map((s) => (
          <SideSection key={s} form={form} side={s} saved={q.data?.[s] ?? null} enterprise={enterprise} />
        ))}
        <Section title="Beneficiary" note="Bank details for payments to this partner">
          <TextField form={form} path="beneficiary.beneficiaryName" label="Beneficiary name" />
          <TextField form={form} path="beneficiary.bank" label="Bank" />
          <TextField form={form} path="beneficiary.bankAddress" label="Bank address" />
          <TextField form={form} path="beneficiary.address" label="Beneficiary address" />
          <TextField form={form} path="beneficiary.accountNumber" label="Account number" />
          <TextField form={form} path="beneficiary.iban" label="IBAN" />
          <TextField form={form} path="beneficiary.swift" label="SWIFT / BIC" />
          <TextField form={form} path="beneficiary.currency" label="Account currency" maxLength={3} />
          <TextField form={form} path="beneficiary.walletAddress" label="Crypto wallet" />
        </Section>
      </fieldset>
    </>
  );
}
