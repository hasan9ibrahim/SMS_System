// Customer trunk form (§5.4, §13.1, §13.26) and vendor trunk form (§5.5, §13.26). Field
// names follow the reference platform; passwords are write-only (never shown, §13.22).
import type { CustomerTrunkInput, RateTableRow, TrunkListRow, VendorTrunkInput } from "@sms/contract";
import { useReference, type TrunkDetail, type TrunkKind } from "../../api/records";
import {
  CheckField,
  FormField,
  ListField,
  MultiCheck,
  NumberField,
  Section,
  SelectField,
  TextArea,
  TextField,
  type FormApi,
} from "../../form/form";
import { ListLookup } from "../../records/parts";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/primitives";
import { tzOptions } from "../../ui/timezones";

export type TrunkForm = (CustomerTrunkInput | VendorTrunkInput) & { password?: string };

const STATUS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];
const BILLING = [
  { value: "submit", label: "Submit" },
  { value: "delivery", label: "Delivery" },
  { value: "reported", label: "Reported" },
  { value: "attempt", label: "Attempt" },
];
const PROTOCOL = [
  { value: "smpp", label: "SMPP" },
  { value: "http", label: "HTTP" },
];
const SSL = [
  { value: "none", label: "None" },
  { value: "tls1.2", label: "TLS 1.2" },
  { value: "tls1.3", label: "TLS 1.3" },
];
const PERIOD = [
  { value: "hour", label: "Per hour" },
  { value: "day", label: "Per day" },
  { value: "week", label: "Per week" },
  { value: "month", label: "Per month" },
  { value: "billing_cycle", label: "Per billing cycle" },
];
const TON = [0, 1, 2, 3, 4, 5, 6].map((v) => ({ value: v, label: String(v) }));
const NPI = [0, 1, 3, 4, 6, 8, 9, 10, 14, 18].map((v) => ({ value: v, label: String(v) }));
const CODINGS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 14].map((v) => ({ value: v, label: String(v) }));
const DLR_STATS = ["DELIVRD", "EXPIRED", "UNDELIV", "REJECTD", "UNKNOWN"].map((v) => ({ value: v, label: v }));

/** Fields of the detail record that are not part of the form. */
const NOT_INPUT = new Set([
  "id",
  "enterpriseName",
  "passwordSet",
  "archived",
  "ownRateTableId",
  "createdBy",
  "createdAt",
  "updatedBy",
  "updatedAt",
]);

export function toTrunkForm(d: TrunkDetail): TrunkForm {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (!NOT_INPUT.has(k)) out[k] = Array.isArray(v) ? [...v] : v;
  if (out.http && typeof out.http === "object") out.http = { ...(out.http as object) };
  return out as TrunkForm;
}

export function blankTrunk(kind: TrunkKind, enterpriseId: number, categoryId: number | null): TrunkForm {
  const common = {
    enterpriseId,
    name: "",
    protocol: "smpp" as const,
    billingType: "submit" as const,
    status: "active" as const,
    username: "",
    password: "",
    // Defaults agreed in the team trial (2026-10-18): 2 sessions, 50 TPS each, 10K overflow buffer.
    maxConnections: 2,
    port: 2775,
    systemType: null,
    sslType: "none" as const,
    tps: 50,
    overflowBuffer: 10_000,
    billingTimezone: null,
  };
  if (kind === "customer")
    return {
      ...common,
      categoryId,
      bindType: "TR",
      hostIps: [],
      considerHlrRate: false,
      serviceTypeRouting: false,
      partWiseRouting: false,
      dlrPushUrl: null,
      moPushUrl: null,
      delayedSubmit: false,
      sendBind: false,
      dlrSessionAffinity: "strict",
      dlrHoldHours: 72,
      loopDetection: true,
      defaultCoding: 0,
      rateTableIds: [],
      expressVendorTrunkId: null,
      expressMargin: null,
      revenueLimit: null,
      revenueLimitPeriod: null,
    } satisfies CustomerTrunkInput;
  return {
    ...common,
    categoryId: categoryId ?? 0,
    bindType: "TR",
    host: "",
    sourceHost: null,
    serviceType: null,
    submitIntervalMs: 0,
    submitTimeoutS: 30,
    enquireLinkTimeoutS: 30,
    msgIdType: "default",
    http: {
      url: null,
      receiverPort: null,
      successRegex: null,
      messageIdRegex: null,
      callbackUrl: null,
      callbackIntervalS: null,
      dlrStatusRegex: null,
      dlrMidRegex: null,
      dlrSuccessStats: null,
      dlrFailStats: null,
      extraHeaders: null,
      postData: null,
      callbackExtraHeaders: null,
      callbackPostData: null,
    },
    windowSize: 10,
    allowedDataCodings: [0, 1, 3, 8],
    rerouteOn: [],
    allowedSrcTon: [0, 1, 2, 5],
    allowedDstTon: [1],
    allowedSrcNpi: [0, 1],
    allowedDstNpi: [1],
    maxMsgLen: 160,
    supportMultipart: true,
    dlrTimeoutS: 172800,
    dlrTimeoutStat: "UNKNOWN",
    bindAddrTon: 0,
    bindAddrNpi: 0,
    bindAddrRange: null,
    costLimit: null,
    costLimitPeriod: null,
  } satisfies VendorTrunkInput;
}

/** Required fields checked before the round trip. */
export function checkTrunk(kind: TrunkKind, v: TrunkForm, isNew: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!v.name.trim()) e.name = "Required";
  if (!v.username.trim()) e.username = "Required";
  if (isNew && !v.password) e.password = "Required for a new trunk";
  if (!v.enterpriseId) e.enterpriseId = "Required";
  if (kind === "customer") {
    const c = v as CustomerTrunkInput;
    if (!c.hostIps.length) e.hostIps = "At least one IP address";
    if ((c.revenueLimit == null) !== (c.revenueLimitPeriod == null)) e.revenueLimitPeriod = "Set both or neither";
  } else {
    const x = v as VendorTrunkInput;
    if (!x.host.trim()) e.host = "Required";
    if (!x.categoryId) e.categoryId = "Required";
    if (x.protocol === "http" && !x.http?.url) e["http.url"] = "Required for an HTTP trunk";
    if ((x.costLimit == null) !== (x.costLimitPeriod == null)) e.costLimitPeriod = "Set both or neither";
  }
  return e;
}

function PasswordField({
  form,
  isNew,
  passwordSet,
}: {
  form: FormApi<TrunkForm>;
  isNew: boolean;
  passwordSet: boolean;
}) {
  return (
    <TextField
      form={form}
      path="password"
      label="Password"
      type="password"
      required={isNew}
      maxLength={9}
      nullable={false}
      autoComplete="new-password"
      placeholder={!isNew && passwordSet ? "•••••••• (set; type to change)" : ""}
      hint="Never shown again after saving (§13.22). SMPP allows 9 characters."
    />
  );
}

function CommonTrunkFields({ form, kind }: { form: FormApi<TrunkForm>; kind: TrunkKind }) {
  const ref = useReference();
  return (
    <>
      <TextField form={form} path="name" label="Trunk name" required maxLength={100} nullable={false} />
      <SelectField form={form} path="protocol" label="Protocol" required options={PROTOCOL} />
      <SelectField
        form={form}
        path="categoryId"
        label="Product category"
        required={kind === "vendor"}
        options={(ref.data?.productCategories ?? []).map((c) => ({ value: c.id, label: c.name }))}
      />
      <SelectField
        form={form}
        path="billingType"
        label="Billing type"
        required
        options={BILLING}
        hint="The event that makes a message billable"
      />
      <SelectField form={form} path="status" label="Status" required options={STATUS} />
      <SelectField
        form={form}
        path="bindType"
        label="Bind type"
        required
        options={["TX", "RX", "TR", ...(kind === "customer" ? ["AUTO"] : [])].map((v) => ({ value: v, label: v }))}
      />
      <SelectField
        form={form}
        path="billingTimezone"
        label="Billing time zone"
        placeholder="The enterprise's"
        options={tzOptions(ref.data?.timezones ?? ["UTC"])}
        hint="Day and month totals in the Enterprise report are cut at midnight here (§13.31)"
      />
    </>
  );
}

function RateTablesField({ form }: { form: FormApi<TrunkForm> }) {
  const ids = ((form.values as CustomerTrunkInput).rateTableIds ?? []) as number[];
  const move = (i: number, d: number) => {
    const next = [...ids];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    form.set("rateTableIds", next);
  };
  return (
    <FormField
      label="Rate tables"
      wide
      error={form.error("rateTableIds")}
      hint="In order: the first table with a line for the destination prices the message (§5.4)"
    >
      <ol className="ordered-list">
        {ids.map((id, i) => (
          <li key={id}>
            <span className="pos">{i + 1}</span>
            <ListLookup<RateTableRow>
              list="rate_tables"
              value={id}
              disabled
              clearable={false}
              onChange={() => {}}
              labelOf={(r) => `${r.name} (${r.currency})`}
            />
            <span className="move-btns">
              <Button small variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </Button>
              <Button
                small
                variant="ghost"
                aria-label="Move down"
                disabled={i === ids.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </Button>
              <Button
                small
                variant="ghost"
                aria-label="Remove rate table"
                onClick={() =>
                  form.set(
                    "rateTableIds",
                    ids.filter((x) => x !== id),
                  )
                }
              >
                <Icon name="x" size={12} />
              </Button>
            </span>
          </li>
        ))}
        <li>
          <span className="pos">+</span>
          <ListLookup<RateTableRow>
            list="rate_tables"
            value={null}
            placeholder="Add a customer rate table…"
            fixed={[{ field: "kind", op: "eq", value: "customer" }]}
            exclude={ids}
            onChange={(r) => r && form.set("rateTableIds", [...ids, r.id])}
            labelOf={(r) => `${r.name} (${r.currency})`}
            detailOf={(r) => `${r.category} · ${r.activeLines.toLocaleString("en-US")} lines`}
          />
        </li>
      </ol>
    </FormField>
  );
}

export function CustomerTrunkFields({
  form,
  isNew,
  passwordSet,
}: {
  form: FormApi<TrunkForm>;
  isNew: boolean;
  passwordSet: boolean;
}) {
  const v = form.values as CustomerTrunkInput;
  return (
    <>
      <Section title="Trunk">
        <CommonTrunkFields form={form} kind="customer" />
      </Section>
      <Section title="Connection" note="What the client binds with">
        <ListField
          form={form}
          path="hostIps"
          label="Allowed host IPs"
          required
          wide
          placeholder="192.0.2.10, 2001:db8::1"
          hint="Binds from other addresses are refused"
        />
        <TextField form={form} path="username" label="Username (system_id)" required maxLength={16} nullable={false} />
        <PasswordField form={form} isNew={isNew} passwordSet={passwordSet} />
        <NumberField form={form} path="port" label="Port" required min={1} max={65535} step={1} />
        <NumberField form={form} path="maxConnections" label="Max connections" required min={1} max={10} step={1} />
        <TextField form={form} path="systemType" label="System type" maxLength={13} />
        <SelectField form={form} path="sslType" label="SSL" required options={SSL} />
      </Section>
      <Section title="Delivery receipts" note="§13.1 session affinity">
        <SelectField
          form={form}
          path="dlrSessionAffinity"
          label="Receipt routing"
          required
          options={[
            { value: "strict", label: "Same session only (hold)" },
            { value: "same_ip", label: "Any session from the same IP" },
            { value: "same_trunk", label: "Any session of the trunk" },
          ]}
          hint="Receipts go at once on the session the message came from; if it is gone, on another bound receiver session of the trunk, else they wait until the customer binds again (SMPP 3.4). This setting only picks which session first."
        />
        <NumberField
          form={form}
          path="dlrHoldHours"
          label="Hold receipts for"
          min={0}
          max={720}
          step={1}
          suffix="hours"
        />
        <TextField form={form} path="dlrPushUrl" label="DLR push URL" type="url" maxLength={500} />
        <TextField form={form} path="moPushUrl" label="MO push URL" type="url" maxLength={500} />
        <CheckField form={form} path="delayedSubmit" label="Delayed submit" />
        <CheckField form={form} path="sendBind" label="Send bind" />
      </Section>
      <Section title="Routing">
        <CheckField form={form} path="considerHlrRate" label="Consider HLR rate" />
        <CheckField form={form} path="serviceTypeRouting" label="Service type routing" />
        <CheckField form={form} path="partWiseRouting" label="Part-wise routing" />
        <CheckField form={form} path="loopDetection" label="Loop detection" />
        <SelectField
          form={form}
          path="defaultCoding"
          label="Default data coding"
          required
          options={[
            { value: 0, label: "0 – SMSC default (GSM 7-bit)" },
            { value: 3, label: "3 – Latin-1" },
          ]}
        />
        <FormField
          label="Express vendor trunk"
          hint="Bypasses routing for every message (§5.4)"
          error={form.error("expressVendorTrunkId")}
        >
          <ListLookup<TrunkListRow>
            list="vendor_trunks"
            value={v.expressVendorTrunkId ?? null}
            placeholder="None – route normally"
            onChange={(r) => form.set("expressVendorTrunkId", r?.id ?? null)}
            labelOf={(r) => r.name}
            detailOf={(r) => `${r.enterpriseName} · ${r.category ?? ""}`}
          />
        </FormField>
        {v.expressVendorTrunkId != null && (
          <NumberField form={form} path="expressMargin" label="Express margin" step={0.0001} />
        )}
      </Section>
      <Section title="Capacity and limits" note="§13.26">
        <NumberField
          form={form}
          path="tps"
          label="TPS per session"
          required
          min={1}
          max={100000}
          step={1}
          hint={`Trunk total: ${((v.tps ?? 0) * (v.maxConnections ?? 1)).toLocaleString("en-US")} TPS (${v.maxConnections ?? 1} sessions)`}
        />
        <NumberField form={form} path="overflowBuffer" label="Overflow buffer" min={0} step={1} suffix="messages" />
        <span />
        <NumberField
          form={form}
          path="revenueLimit"
          label="Revenue limit"
          min={0}
          step={1}
          hint="Traffic stops when reached"
        />
        <SelectField form={form} path="revenueLimitPeriod" label="Limit period" options={PERIOD} />
      </Section>
      <Section title="Pricing" columns={1}>
        <RateTablesField form={form} />
      </Section>
    </>
  );
}

export function VendorTrunkFields({
  form,
  isNew,
  passwordSet,
}: {
  form: FormApi<TrunkForm>;
  isNew: boolean;
  passwordSet: boolean;
}) {
  const v = form.values as VendorTrunkInput;
  return (
    <>
      <Section title="Trunk">
        <CommonTrunkFields form={form} kind="vendor" />
      </Section>
      <Section title="Connection" note="How we bind to the vendor">
        <TextField form={form} path="host" label="Host" required maxLength={255} nullable={false} />
        <NumberField form={form} path="port" label="Port" required min={1} max={65535} step={1} />
        <TextField
          form={form}
          path="sourceHost"
          label="Source IP"
          maxLength={64}
          hint="Our address the bind comes from"
        />
        <TextField form={form} path="username" label="Username (system_id)" required maxLength={16} nullable={false} />
        <PasswordField form={form} isNew={isNew} passwordSet={passwordSet} />
        <NumberField form={form} path="maxConnections" label="Max connections" required min={1} max={10} step={1} />
        <TextField form={form} path="systemType" label="System type" maxLength={13} />
        <TextField form={form} path="serviceType" label="Service type" maxLength={6} />
        <SelectField form={form} path="sslType" label="SSL" required options={SSL} />
      </Section>
      {v.protocol === "http" ? (
        <Section title="HTTP API" note="Generic HTTP adapter (§5.5)">
          <TextField form={form} path="http.url" label="Submit URL" required wide type="url" maxLength={1000} />
          <TextField form={form} path="http.successRegex" label="Success regex" />
          <TextField form={form} path="http.messageIdRegex" label="Message ID regex" />
          <NumberField form={form} path="http.receiverPort" label="Receiver port" min={1} max={65535} step={1} />
          <TextArea
            form={form}
            path="http.extraHeaders"
            label="Extra headers"
            rows={2}
            placeholder="Header: value, one per line"
          />
          <TextArea
            form={form}
            path="http.postData"
            label="POST body"
            rows={2}
            placeholder='{"to":"{dst}","from":"{src}","text":"{text}"}'
          />
          <TextField form={form} path="http.callbackUrl" label="Receipt callback URL" type="url" />
          <NumberField
            form={form}
            path="http.callbackIntervalS"
            label="Callback interval"
            min={1}
            step={1}
            suffix="s"
          />
          <TextField form={form} path="http.dlrStatusRegex" label="Receipt status regex" />
          <TextField form={form} path="http.dlrMidRegex" label="Receipt message ID regex" />
          <TextField form={form} path="http.dlrSuccessStats" label="Success statuses" placeholder="DELIVRD,DELIVERED" />
          <TextField form={form} path="http.dlrFailStats" label="Failure statuses" placeholder="UNDELIV,REJECTD" />
          <TextArea form={form} path="http.callbackExtraHeaders" label="Callback extra headers" rows={2} />
          <TextArea form={form} path="http.callbackPostData" label="Callback POST body" rows={2} />
        </Section>
      ) : (
        <Section title="SMPP session">
          <NumberField form={form} path="windowSize" label="Window size" min={1} max={1000} step={1} />
          <NumberField form={form} path="submitIntervalMs" label="Submit interval" min={0} step={1} suffix="ms" />
          <NumberField form={form} path="submitTimeoutS" label="Submit timeout" min={1} step={1} suffix="s" />
          <NumberField form={form} path="enquireLinkTimeoutS" label="Enquire link" min={1} step={1} suffix="s" />
          <SelectField
            form={form}
            path="msgIdType"
            label="Message ID type"
            required
            options={[
              { value: "default", label: "Default" },
              { value: "decimal", label: "Decimal" },
              { value: "hexadecimal", label: "Hexadecimal" },
            ]}
          />
          <NumberField form={form} path="bindAddrTon" label="Bind address TON" min={0} max={6} step={1} />
          <NumberField form={form} path="bindAddrNpi" label="Bind address NPI" min={0} max={18} step={1} />
          <TextField form={form} path="bindAddrRange" label="Bind address range" maxLength={41} />
        </Section>
      )}
      <Section title="Messages" columns={2}>
        <MultiCheck form={form} path="allowedDataCodings" label="Allowed data codings" options={CODINGS} />
        <MultiCheck
          form={form}
          path="rerouteOn"
          label="Re-route on receipt status"
          options={DLR_STATS.filter((s) => s.value !== "DELIVRD")}
          hint="Failed receipts with these statuses are retried on the next vendor"
        />
        <MultiCheck form={form} path="allowedSrcTon" label="Allowed source TON" options={TON} />
        <MultiCheck form={form} path="allowedDstTon" label="Allowed destination TON" options={TON} />
        <MultiCheck form={form} path="allowedSrcNpi" label="Allowed source NPI" options={NPI} />
        <MultiCheck form={form} path="allowedDstNpi" label="Allowed destination NPI" options={NPI} />
        <NumberField form={form} path="maxMsgLen" label="Max message length" min={1} max={2000} step={1} />
        <CheckField form={form} path="supportMultipart" label="Supports multipart" />
        <NumberField form={form} path="dlrTimeoutS" label="Receipt timeout" min={0} step={60} suffix="s" />
        <SelectField form={form} path="dlrTimeoutStat" label="Status on receipt timeout" required options={DLR_STATS} />
      </Section>
      <Section title="Capacity and limits" note="§13.26">
        <NumberField
          form={form}
          path="tps"
          label="TPS per session"
          required
          min={1}
          max={100000}
          step={1}
          hint={`Trunk total: ${((v.tps ?? 0) * (v.maxConnections ?? 1)).toLocaleString("en-US")} TPS (${v.maxConnections ?? 1} sessions)`}
        />
        <NumberField form={form} path="overflowBuffer" label="Overflow buffer" min={0} step={1} suffix="messages" />
        <span />
        <NumberField
          form={form}
          path="costLimit"
          label="Cost limit"
          min={0}
          step={1}
          hint="Traffic stops when reached"
        />
        <SelectField form={form} path="costLimitPeriod" label="Limit period" options={PERIOD} />
      </Section>
    </>
  );
}
