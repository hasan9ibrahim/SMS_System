// General Info form of an enterprise (§5.1): identity, address, company details, alerts and
// the four contacts. Add creates the record with its first account manager (§13.30).
import { useEffect, useState } from "react";
import type { EnterpriseDetail, EnterpriseInput } from "@sms/contract";
import { useReference, useSaveEnterprise } from "../../api/records";
import {
  CheckField,
  FormBanner,
  ListField,
  NumberField,
  ReadOnly,
  Section,
  SelectField,
  TextField,
  useForm,
} from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { useTabNavigate } from "../../shell/tabContext";
import { Button } from "../../ui/primitives";
import { HeaderAction, type SectionProps } from "../../records/parts";

const CONTACTS = [
  ["commercial", "Commercial"],
  ["technical", "Technical"],
  ["rates", "Rates"],
  ["finance", "Finance"],
] as const;

type Form = EnterpriseInput;

const blankContact = () => ({ name: null, phone: null, emails: [] as string[] });

function blank(): Form {
  return {
    name: "",
    alias: "",
    type: "customer",
    tier: "tier2",
    status: "active",
    businessCompanyId: 0,
    bindAlert: true,
    creditAlert: true,
    creditAlertPercent: { notice: 50, warning: 70, critical: 90 },
    address: { line1: "", line2: null, city: null, state: null, countryId: null, zip: null },
    website: null,
    fax: null,
    registrationNumber: null,
    vatNumber: null,
    billingTimezone: "UTC",
    rateNoticeDays: 7,
    contacts: {
      commercial: blankContact(),
      technical: blankContact(),
      rates: blankContact(),
      finance: blankContact(),
    },
  };
}

/** The editable part of a record, in the shape PUT expects. */
export function toInput(e: EnterpriseDetail): Form {
  return {
    name: e.name,
    alias: e.alias,
    type: e.type,
    tier: e.tier,
    status: e.status,
    businessCompanyId: e.businessCompanyId,
    bindAlert: e.bindAlert,
    creditAlert: e.creditAlert,
    creditAlertPercent: { ...e.creditAlertPercent },
    address: {
      line1: e.address.line1,
      line2: e.address.line2 ?? null,
      city: e.address.city ?? null,
      state: e.address.state ?? null,
      countryId: e.address.countryId ?? null,
      zip: e.address.zip ?? null,
    },
    website: e.website ?? null,
    fax: e.fax ?? null,
    registrationNumber: e.registrationNumber ?? null,
    vatNumber: e.vatNumber ?? null,
    billingTimezone: e.billingTimezone,
    rateNoticeDays: e.rateNoticeDays,
    contacts: Object.fromEntries(
      CONTACTS.map(([k]) => [
        k,
        { name: e.contacts[k].name ?? null, phone: e.contacts[k].phone ?? null, emails: [...e.contacts[k].emails] },
      ]),
    ) as Form["contacts"],
  };
}

/** Required fields checked before the round trip, with plain messages. */
function check(v: Form, isNew: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!v.name.trim()) errors.name = "Required";
  if (!v.alias.trim()) errors.alias = "Required";
  if (!v.businessCompanyId) errors.businessCompanyId = "Required";
  if (!v.address.line1.trim()) errors["address.line1"] = "Required";
  if (isNew && v.accountManagerId == null) errors.accountManagerId = "Required";
  for (const [k] of CONTACTS) if (!v.contacts[k].emails.length) errors[`contacts.${k}.emails`] = "At least one email";
  const p = v.creditAlertPercent;
  if (!(p.notice < p.warning && p.warning < p.critical))
    errors.creditAlertPercent = "Levels must rise: notice < warning < critical";
  return errors;
}

export function GeneralTab({
  record,
  slot,
  onDirty,
  onOpenSection,
}: SectionProps & { record: EnterpriseDetail | null; onOpenSection: (key: string) => void }) {
  const ref = useReference();
  const isNew = record === null;
  const form = useForm<Form>(
    record ? toInput(record) : { ...blank(), accountManagerId: undefined as unknown as number },
  );
  const save = useSaveEnterprise();
  const notifySaved = useNotifySaved();
  const navigate = useTabNavigate();
  const [banner, setBanner] = useState<string | null>(null);
  const readOnly = !!record?.archived;

  // A newer version of the record (another save, an undo) replaces a clean form.
  const version = record ? `${record.id}:${record.updatedAt}:${record.archived?.at ?? ""}` : "new";
  useEffect(() => {
    if (record && !form.dirty) form.reset(toInput(record));
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDirty(form.dirty), [form.dirty, onDirty]);
  // New enterprises default to the first business company.
  useEffect(() => {
    // Applied as the starting value, so an untouched new form is not "unsaved".
    if (isNew && ref.data && !form.values.businessCompanyId && ref.data.businessCompanies[0] && !form.dirty)
      form.reset({ ...form.values, businessCompanyId: ref.data.businessCompanies[0].id });
  }, [isNew, ref.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const errors = check(form.values, isNew);
    if (Object.keys(errors).length) {
      form.setErrors(errors);
      setBanner(`Check the highlighted fields (${Object.keys(errors).length})`);
      return;
    }
    setBanner(null);
    const input = { ...form.values };
    if (!isNew) delete (input as Partial<Form>).accountManagerId;
    save.mutate(
      { id: record?.id ?? null, input },
      {
        onSuccess: (r) => {
          form.reset(toInput(r.record));
          if (r.change) notifySaved(r.change, isNew ? `Added ${r.record.name}` : "Saved");
          if (isNew) navigate(`/enterprises/${r.record.id}`, { replace: true });
        },
        onError: (err) => setBanner(form.fail(err)),
      },
    );
  };

  const opts = <T extends { id: number }>(list: T[] | undefined, label: (x: T) => string) =>
    (list ?? []).map((x) => ({ value: x.id, label: label(x) }));

  return (
    <>
      <HeaderAction slot={slot}>
        <Button
          variant="primary"
          icon="save"
          disabled={readOnly || save.isPending || (!isNew && !form.dirty)}
          onClick={submit}
          title={readOnly ? "Restore the enterprise to edit it" : undefined}
        >
          {isNew ? "Add enterprise" : "Save"}
        </Button>
        {form.dirty && !isNew && (
          <Button variant="ghost" onClick={() => record && form.reset(toInput(record))}>
            Discard
          </Button>
        )}
      </HeaderAction>
      <FormBanner message={banner} onClose={() => setBanner(null)} />
      <fieldset disabled={readOnly} className="plain-fieldset">
        <Section title="General information">
          <TextField form={form} path="name" label="Name" required maxLength={200} nullable={false} />
          <TextField
            form={form}
            path="alias"
            label="Alias"
            required
            maxLength={100}
            nullable={false}
            hint="Short name used in trunk names and reports"
          />
          <SelectField
            form={form}
            path="businessCompanyId"
            label="Business company"
            required
            options={opts(ref.data?.businessCompanies, (b) => `${b.name} (${b.baseCurrency})`)}
          />
          <SelectField
            form={form}
            path="type"
            label="Type"
            required
            options={[
              { value: "customer", label: "Customer" },
              { value: "vendor", label: "Vendor" },
              { value: "reciprocal", label: "Reciprocal (both)" },
            ]}
          />
          <SelectField
            form={form}
            path="tier"
            label="Category"
            required
            options={[
              { value: "tier1", label: "Tier 1" },
              { value: "tier2", label: "Tier 2" },
              { value: "tier3", label: "Tier 3" },
            ]}
          />
          <SelectField
            form={form}
            path="status"
            label="Status"
            required
            options={[
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ]}
          />
          {isNew ? (
            <SelectField
              form={form}
              path="accountManagerId"
              label="Account manager"
              required
              options={opts(ref.data?.accountManagers, (u) => u.displayName)}
              hint="Later changes go through Hand over, so past results stay with the AM who earned them (§13.30)"
            />
          ) : (
            <ReadOnly label="Account manager">
              {record?.accountManagerName ?? "—"}
              <button type="button" className="link" onClick={() => onOpenSection("account-managers")}>
                Hand over…
              </button>
            </ReadOnly>
          )}
        </Section>

        <Section title="Address">
          <TextField
            form={form}
            path="address.line1"
            label="Address line 1"
            required
            nullable={false}
            maxLength={200}
          />
          <TextField form={form} path="address.line2" label="Address line 2" maxLength={200} />
          <TextField form={form} path="address.city" label="City" maxLength={100} />
          <TextField form={form} path="address.state" label="State / region" maxLength={100} />
          <SelectField
            form={form}
            path="address.countryId"
            label="Country"
            options={opts(ref.data?.countries, (c) => `${c.name} (${c.iso})`)}
          />
          <TextField form={form} path="address.zip" label="ZIP / postcode" maxLength={20} />
        </Section>

        <Section title="Company details">
          <TextField form={form} path="website" label="Website" maxLength={300} placeholder="https://" />
          <TextField form={form} path="fax" label="Fax" maxLength={50} />
          <TextField form={form} path="registrationNumber" label="Registration number" maxLength={100} />
          <TextField form={form} path="vatNumber" label="VAT number" maxLength={100} />
          <SelectField
            form={form}
            path="billingTimezone"
            label="Billing time zone"
            required
            options={(ref.data?.timezones ?? ["UTC"]).map((z) => ({ value: z, label: z }))}
            hint="Day and month totals are cut at midnight in this zone (§13.31)"
          />
          <NumberField
            form={form}
            path="rateNoticeDays"
            label="Rate notice period"
            min={0}
            max={90}
            step={1}
            suffix="days"
            hint="Notice for rate increases (§13.14)"
          />
        </Section>

        <Section title="Alerts" columns={4} note="Credit alert levels are % of the credit limit">
          <CheckField form={form} path="bindAlert" label="Bind alert" hint="Alert when a trunk's binds drop" />
          <CheckField form={form} path="creditAlert" label="Credit alert" />
          <NumberField
            form={form}
            path="creditAlertPercent.notice"
            label="Notice at"
            min={1}
            max={100}
            step={1}
            suffix="%"
            required
          />
          <NumberField
            form={form}
            path="creditAlertPercent.warning"
            label="Warning at"
            min={1}
            max={100}
            step={1}
            suffix="%"
            required
          />
          <NumberField
            form={form}
            path="creditAlertPercent.critical"
            label="Critical at"
            min={1}
            max={100}
            step={1}
            suffix="%"
            required
          />
          {form.error("creditAlertPercent") && !form.errors["creditAlertPercent.notice"] && (
            <span className="ff-error wide">{form.errors.creditAlertPercent}</span>
          )}
        </Section>

        <Section title="Contacts" columns={1}>
          <div className="contact-grid">
            {CONTACTS.map(([k, label]) => (
              <div key={k}>
                <h3>{label}</h3>
                <TextField form={form} path={`contacts.${k}.name`} label="Name" maxLength={200} />
                <TextField form={form} path={`contacts.${k}.phone`} label="Phone" type="tel" maxLength={50} />
                <ListField
                  form={form}
                  path={`contacts.${k}.emails`}
                  label="Emails"
                  required
                  placeholder="name@company.com"
                />
              </div>
            ))}
          </div>
        </Section>
      </fieldset>
      {record && (
        <p className="muted small">
          Added {record.createdAt?.slice(0, 10) ?? "—"}
          {record.createdBy ? ` by ${record.createdBy}` : ""} · last updated{" "}
          {record.updatedAt.slice(0, 16).replace("T", " ")} UTC by {record.updatedBy}
        </p>
      )}
    </>
  );
}
