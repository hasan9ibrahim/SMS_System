// General Info form of an enterprise (§5.1): identity, address, company details, alerts and
// the four contacts. Add creates the record with its first account manager (§13.30).
import { useEffect, useState } from "react";
import type { EnterpriseDetail, EnterpriseInput } from "@sms/contract";
import { useReference, useSaveEnterprise } from "../../api/records";
import {
  ChoiceField,
  FormField,
  type FormApi,
  FormBanner,
  ListField,
  NumberField,
  Section,
  SelectField,
  StatusField,
  TextField,
  ToggleCard,
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
    bindAlert: false,
    creditAlert: false, // ticked when a non-zero credit limit is set (team trial round 2)
    creditAlertPercent: { notice: 50, warning: 70, critical: 90 },
    address: { line1: "", line2: null, city: null, state: null, countryId: null, zip: null },
    website: null,
    fax: null,
    registrationNumber: null,
    vatNumber: null,
    accountNumber: null,
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
/** Why a saved enterprise can't switch to this type, or null when it can (team trial rounds 4 and 6). */
function typeLock(
  record: { type: "customer" | "vendor" | "reciprocal"; trunkCounts: { customer: number; vendor: number } } | null | undefined,
  t: "customer" | "vendor" | "reciprocal",
): string | null {
  if (!record || t === record.type || t === "reciprocal") return null;
  if (record.type !== "reciprocal") return "A customer or a vendor can only be changed to Bilateral";
  const other = t === "customer" ? record.trunkCounts.vendor : record.trunkCounts.customer;
  return other > 0 ? `Has ${other} ${t === "customer" ? "vendor" : "customer"} trunks; archive them first` : null;
}

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
    accountNumber: e.accountNumber ?? null,
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

/** A notice period as a tinted tile: increase amber, decrease green, new destination blue (team trial round 4). */
function NoticeTile({
  form,
  path,
  label,
  tone,
}: {
  form: FormApi<Form>;
  path: string;
  label: string;
  tone: "up" | "down" | "new";
}) {
  const icon = tone === "up" ? "↑" : tone === "down" ? "↓" : "+";
  return (
    <div className={`notice-tile ${tone}`}>
      <span className="notice-tile-label">
        <span aria-hidden="true">{icon}</span> {label}
      </span>
      <span className="input-suffix">
        <input
          type="number"
          className="num"
          min={0}
          max={90}
          step={1}
          aria-label={`${label}: days of notice`}
          value={(form.get(path) as number | null) ?? ""}
          onChange={(e) => form.set(path, e.target.value === "" ? 0 : Number(e.target.value))}
        />
        <span className="muted">days</span>
      </span>
      {form.error(path) && <span className="ff-error">{form.error(path)}</span>}
    </div>
  );
}

/** Required fields checked before the round trip, with plain messages. */
function check(v: Form, isNew: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!v.name.trim()) errors.name = "Required";
  if (!v.alias.trim()) errors.alias = "Required";
  if (!v.businessCompanyId) errors.businessCompanyId = "Required";
  if (!v.address.line1.trim()) errors["address.line1"] = "Required";
  if (v.address.countryId == null) errors["address.countryId"] = "Required";
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

  const levels = form.values.creditAlertPercent;
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
      {/* Record redesign (team trial round 4): cards with a purpose line, choices as cards and joined buttons,
          notice periods and alert levels as tiles. */}
      <fieldset disabled={readOnly} className="plain-fieldset form-main">
        <Section id="ent-general" title="General information" subtitle="Who this partner is and how it's classified.">
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
          <ChoiceField
            form={form}
            path="type"
            label="Type"
            required
            variant="cards"
            // A saved customer or vendor can only become Bilateral (team trial round 4); a Bilateral partner can
            // become a customer without vendor trunks, or a vendor without customer trunks (round 6).
            options={(["customer", "vendor", "reciprocal"] as const).map((t) => ({
              value: t,
              label: { customer: "Customer", vendor: "Vendor", reciprocal: "Bilateral" }[t],
              ...(typeLock(record, t) ? { disabled: true, hint: typeLock(record, t)! } : {}),
            }))}
          />
          <ChoiceField
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
          <StatusField form={form} path="status" required onText="Active · can send and receive traffic" />
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

        <Section id="ent-address" title="Address" columns={4}>
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
          <TextField form={form} path="address.state" label="State / region" maxLength={100} placeholder="Optional" />
          <SelectField
            form={form}
            path="address.countryId"
            label="Country"
            required
            options={opts(ref.data?.countries, (c) => `${c.name} (${c.iso})`)}
          />
          <TextField form={form} path="address.zip" label="ZIP / postcode" maxLength={20} />
        </Section>

        <Section id="ent-company" title="Company details" columns={4}>
          <TextField form={form} path="website" label="Website" maxLength={300} placeholder="https://" />
          <TextField form={form} path="registrationNumber" label="Registration number" maxLength={100} />
          <TextField form={form} path="vatNumber" label="VAT number" maxLength={100} />
          <TextField form={form} path="fax" label="Fax" maxLength={50} placeholder="Optional" />
          <SelectField
            form={form}
            path="billingTimezone"
            label="Billing time zone"
            required
            options={tzOptions(ref.data?.timezones ?? ["UTC"])}
            hint="Day and month totals are cut at midnight in this zone"
          />
          <AllNetworksField form={form} />
          {/* Clients only: our account number for them, printed on their invoices (team trial round 4). */}
          {form.values.type !== "vendor" && (
            <TextField
              form={form}
              path="accountNumber"
              label="Account number"
              maxLength={50}
              placeholder="Optional"
              hint="Shown in the invoice header"
            />
          )}
        </Section>

        <Section
          id="ent-notice"
          title="Rate notice periods"
          subtitle="Days of notice before a rate change takes effect. 0 = no notice needed."
          columns={3}
        >
          <NoticeTile form={form} path="rateNoticeDays" label="Rate increase" tone="up" />
          <NoticeTile form={form} path="rateNoticeDaysDecrease" label="Rate decrease" tone="down" />
          <NoticeTile form={form} path="rateNoticeDaysNew" label="New destination" tone="new" />
        </Section>

        <Section id="ent-alerts" title="Alerts" subtitle="Get notified when something needs attention." columns={2}>
          <ToggleCard form={form} path="bindAlert" label="Bind alert" hint="Alert when a trunk's binds drop" />
          <ToggleCard
            form={form}
            path="creditAlert"
            label="Credit alert"
            hint="Alert as usage approaches the credit limit"
          />
          <div className="credit-levels wide">
            <div className="credit-levels-head">
              <span className="strong">Credit alert levels</span>
              <span className="muted small">% of the credit limit</span>
            </div>
            <div className="credit-bar" aria-hidden="true">
              <span className="cb-notice" style={{ left: `${Math.min(100, levels.notice)}%` }} />
              <span className="cb-warning" style={{ left: `${Math.min(100, levels.warning)}%` }} />
              <span className="cb-critical" style={{ left: `${Math.min(100, levels.critical)}%` }} />
            </div>
            <div className="fgrid cols-3">
              {(["notice", "warning", "critical"] as const).map((k) => (
                <div key={k} className={`credit-level ${k}`}>
                  <NumberField
                    form={form}
                    path={`creditAlertPercent.${k}`}
                    label={`${k[0]!.toUpperCase()}${k.slice(1)} at`}
                    min={1}
                    max={100}
                    step={1}
                    suffix="%"
                    required
                  />
                </div>
              ))}
            </div>
            {form.error("creditAlertPercent") && !form.errors["creditAlertPercent.notice"] && (
              <span className="ff-error">{form.errors.creditAlertPercent}</span>
            )}
          </div>
        </Section>

        <Section
          id="ent-contacts"
          title="Contacts"
          subtitle="Who we reach for each topic. Each role needs at least one email."
          columns={1}
        >
          <div className="contact-grid">
            {CONTACTS.map(([k, label]) => (
              <div key={k} className={`contact-card role-${k}`}>
                <span className="role-tag">{label}</span>
                <TextField form={form} path={`contacts.${k}.name`} label="Name" maxLength={200} />
                <TextField form={form} path={`contacts.${k}.phone`} label="Phone" type="tel" maxLength={50} />
                <ListField
                  form={form}
                  path={`contacts.${k}.emails`}
                  label="Emails"
                  required
                  placeholder="+ Add email"
                  keepPlaceholder
                />
              </div>
            ))}
          </div>
        </Section>
        {record && (
          <p className="muted small">
            Added {record.createdAt?.slice(0, 10) ?? "—"}
            {record.createdBy ? ` by ${record.createdBy}` : ""} · last updated{" "}
            {record.updatedAt.slice(0, 16).replace("T", " ")} UTC by {record.updatedBy}
          </p>
        )}
      </fieldset>
    </>
  );
}
