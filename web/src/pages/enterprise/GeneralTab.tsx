// General Info form of an enterprise (§5.1): identity, address, company details, alerts and
// the four contacts. Add creates the record with its first account manager (§13.30).
import { useEffect, useState } from "react";
import type { EnterpriseDetail, EnterpriseInput } from "@sms/contract";
import { useReference, useSaveEnterprise } from "../../api/records";
import {
  CheckField,
  FormField,
  type FormApi,
  FormBanner,
  ListField,
  NumberField,
  Section,
  SelectField,
  TextField,
  useForm,
} from "../../form/form";
import { useNotifySaved } from "../../history/undo";
import { useTabNavigate } from "../../shell/tabContext";
import { Button } from "../../ui/primitives";
import { HeaderAction, type SectionProps } from "../../records/parts";
import { DuplicateWarning } from "../admin/cleanup/DuplicateWarning";
import { tzOptions } from "../../ui/timezones";

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
    creditAlert: false, // ticked when a non-zero credit limit is set (team trial round 2)
    creditAlertPercent: { notice: 50, warning: 70, critical: 90 },
    address: { line1: "", line2: null, city: null, state: null, countryId: null, zip: null },
    website: null,
    fax: null,
    registrationNumber: null,
    vatNumber: null,
    billingTimezone: "UTC",
    rateNoticeDays: 7,
    rateNoticeDaysDecrease: 0,
    rateNoticeDaysNew: 0,
    allNetworksCode: "mcc",
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
    rateNoticeDaysDecrease: e.rateNoticeDaysDecrease,
    rateNoticeDaysNew: e.rateNoticeDaysNew,
    allNetworksCode: e.allNetworksCode,
    contacts: Object.fromEntries(
      CONTACTS.map(([k]) => [
        k,
        { name: e.contacts[k].name ?? null, phone: e.contacts[k].phone ?? null, emails: [...e.contacts[k].emails] },
      ]),
    ) as Form["contacts"],
  };
}

const ALL_NETWORKS = [
  { value: "mcc", label: "MCC (e.g. 262)" },
  { value: "mcc0", label: "MCC0 (e.g. 2620)" },
  { value: "mcc00", label: "MCC00 (e.g. 26200)" },
  { value: "mcc000", label: "MCC000 (e.g. 262000)" },
  { value: "mccStar", label: "MCC* (e.g. 262*)" },
];

/**
 * How the partner writes a country's all-networks rate: one of the usual forms, or Custom: MCC plus any suffix
 * ("MCC99" = 26299; team trial round 3).
 */
function AllNetworksField({ form }: { form: FormApi<Form> }) {
  const v = String(form.get("allNetworksCode") ?? "mcc");
  const custom = v.startsWith("MCC");
  const suffix = custom ? v.slice(3) : "";
  const error = form.error("allNetworksCode");
  return (
    <FormField
      label="'All networks' code"
      required
      error={error}
      hint={custom ? `e.g. 262${suffix || "…"} for Germany` : "How this partner writes a country's all-networks rate"}
    >
      <div className="allnet">
        <select
          aria-label="'All networks' code"
          value={custom ? "custom" : v}
          onChange={(e) => form.set("allNetworksCode", e.target.value === "custom" ? "MCC99" : e.target.value)}
        >
          {ALL_NETWORKS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {custom && (
          <span className="allnet-custom">
            <span className="muted">MCC</span>
            <input
              aria-label="Custom suffix after the MCC"
              value={suffix}
              maxLength={6}
              placeholder="99"
              onChange={(e) => form.set("allNetworksCode", `MCC${e.target.value.replace(/[^0-9A-Za-z*#._-]/g, "")}`)}
            />
          </span>
        )}
      </div>
    </FormField>
  );
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
      <DuplicateWarning
        what="enterprise"
        check={
          isNew || form.dirty
            ? {
                kind: "enterprise",
                excludeId: record?.id ?? null,
                enterprise: {
                  name: form.values.name || null,
                  vatNumber: form.values.vatNumber ?? null,
                  emails: Object.values(form.values.contacts ?? {}).flatMap((c) => c?.emails ?? []),
                },
              }
            : null
        }
      />
      <fieldset disabled={readOnly} className="plain-fieldset">
        <Section title="General information">
          <TextField form={form} path="name" label="Full legal name" required maxLength={200} nullable={false} />
          <TextField
            form={form}
            path="alias"
            label="Brand name"
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
              { value: "reciprocal", label: "Bilateral (both)" },
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
          {/* The account manager is picked once, when adding; afterwards it lives on the Account managers tab only
              (team trial round 3), where Hand over keeps past results with the AM who earned them (§13.30). */}
          {isNew && (
            <SelectField
              form={form}
              path="accountManagerId"
              label="Account manager"
              required
              options={opts(ref.data?.accountManagers, (u) => u.displayName)}
              hint="Later changes go through the Account managers tab (§13.30)"
            />
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
            options={tzOptions(ref.data?.timezones ?? ["UTC"])}
            hint="Day and month totals are cut at midnight in this zone (§13.31)"
          />
          <AllNetworksField form={form} />
          {/* The three notice periods on one line, last (team trial round 3). */}
          <NumberField
            form={form}
            path="rateNoticeDays"
            label="Notice: increase"
            min={0}
            max={90}
            step={1}
            suffix="days"
            hint="Notice for rate increases (§13.14)"
          />
          <NumberField
            form={form}
            path="rateNoticeDaysDecrease"
            label="Notice: decrease"
            min={0}
            max={90}
            step={1}
            suffix="days"
            hint="Notice for rate decreases; 0 = none"
          />
          <NumberField
            form={form}
            path="rateNoticeDaysNew"
            label="Notice: new destination"
            min={0}
            max={90}
            step={1}
            suffix="days"
            hint="Notice for new destinations; 0 = none"
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
