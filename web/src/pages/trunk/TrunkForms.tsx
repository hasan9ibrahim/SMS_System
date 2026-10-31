// Customer trunk form (§5.4, §13.1, §13.26) and vendor trunk form (§5.5, §13.26). Field
// names follow the reference platform. The password shows only on request, behind the eye button, for users who may
// edit the trunk (team trial round 12); exports of credentials stay admin-only and encrypted (§13.22).
import { useEffect, useState } from "react";
import { useCan, useTabShown } from "../../api/access";
import type { CustomerTrunkInput, RateTableRow, TrunkListRow, VendorTrunkInput } from "@sms/contract";
import { fetchTrunkPassword, useReference, type TrunkDetail, type TrunkKind } from "../../api/records";
import {
  CheckField,
  ChoiceField,
  FieldsAndChecks,
  FormField,
  ListField,
  MultiCheck,
  NumberField,
  ReadOnly,
  Section,
  SelectField,
  StatusField,
  SubHead,
  TextArea,
  TextField,
  type FormApi,
} from "../../form/form";
import { useDragOrder, moveItem } from "../../records/dragOrder";
import { ListLookup } from "../../records/parts";
import { ask, toast } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, IconButton } from "../../ui/primitives";
import { tzOptions } from "../../ui/timezones";
import { NewRateTableDialog } from "../rates/dialogs";
import { codesText, RuleCodesDialog, useDestinationTree } from "../rates/DestinationTree";

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
// A vendor trunk can be a service trunk (team trial round 12): it sends nothing, the client gets the set receipt.
const VENDOR_PROTOCOL = [...PROTOCOL, { value: "service", label: "Service" }];
const SSL = [
  { value: "none", label: "None" },
  { value: "tls1.0", label: "TLS 1.0 (legacy)" },
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

/**
 * The port a customer binds on, set by the connection type (product owner, 2026-10-24): 2775 without TLS, 2776 with.
 * The server works it out the same way; the form only shows it.
 */
export const customerPort = (sslType: string | null | undefined) => (!sslType || sslType === "none" ? 2775 : 2776);

export function toTrunkForm(d: TrunkDetail): TrunkForm {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (!NOT_INPUT.has(k)) out[k] = Array.isArray(v) ? [...v] : v;
  // A customer trunk's port is not part of its form: it follows the SSL type.
  if ("hostIps" in d) delete out.port;
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
      // A customer may bind TX, RX or TR: AUTO accepts any (team trial round 12); vendors stay on TR.
      bindType: "AUTO",
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
      loopDetection: false,
      reassemblyTimeoutS: 120,
      duplicateWindowS: 60,
      allowEmptyMessages: false,
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
    port: 2775,
    sourceHost: null,
    serviceType: null,
    tlsSkipVerify: false,
    submitIntervalMs: 0,
    submitTimeoutS: 30,
    enquireLinkTimeoutS: 30,
    // Bind policy defaults (team trial round 2).
    enquireLinkIntervalS: 30,
    reconnectScheduleS: [5, 10, 30, 60],
    bindAlertAfterMin: 2,
    authFailRetryMin: 15,
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
    allowedDataCodings: null,
    rerouteOn: [],
    allowedSrcTon: null,
    allowedDstTon: null,
    allowedSrcNpi: null,
    allowedDstNpi: null,
    maxMsgLen: null,
    supportMultipart: true,
    multipartFormat: "udh8",
    dlrTimeoutS: 172800,
    dlrTimeoutStat: "UNKNOWN",
    dlrTimeoutMccmncs: [],
    bindAddrTon: 0,
    bindAddrNpi: 0,
    bindAddrRange: null,
    costLimit: null,
    costLimitPeriod: null,
  } satisfies VendorTrunkInput;
}

/** Required fields checked before the round trip. */
/**
 * A service trunk has no connection (team trial round 12): its connection fields, still in the contract, get fixed
 * values so the form does not ask for them.
 */
export function fillService(kind: TrunkKind, v: TrunkForm, isNew: boolean): TrunkForm {
  if (kind !== "vendor" || v.protocol !== "service") return v;
  const x = v as VendorTrunkInput;
  return {
    ...v,
    username: v.username.trim() || "service",
    host: x.host.trim() || "service",
    ...(isNew && !v.password ? { password: generatePassword() } : {}),
  } as TrunkForm;
}

export function checkTrunk(kind: TrunkKind, v: TrunkForm, isNew: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!v.name.trim()) e.name = "Required.";
  if (!v.username.trim()) e.username = "Required.";
  if (isNew && !v.password) e.password = "Required for a new trunk.";
  if (!v.enterpriseId) e.enterpriseId = "Required.";
  if (kind === "customer") {
    const c = v as CustomerTrunkInput;
    if (!c.hostIps.length) e.hostIps = "Add at least one IP address.";
    if ((c.revenueLimit == null) !== (c.revenueLimitPeriod == null)) e.revenueLimitPeriod = "Set both or neither.";
  } else {
    const x = v as VendorTrunkInput;
    if (!x.host.trim()) e.host = "Required.";
    if (!x.categoryId) e.categoryId = "Required.";
    if (x.protocol === "http" && !x.http?.url) e["http.url"] = "Required for an HTTP trunk.";
    if ((x.costLimit == null) !== (x.costLimitPeriod == null)) e.costLimitPeriod = "Set both or neither.";
  }
  return e;
}

/** Who the trunk is, for the password buttons: none for a new trunk. */
export interface TrunkRef {
  kind: TrunkKind;
  id: number | null;
}

const copyText = (text: string, what: string) =>
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast({ tone: "good", message: `${what} copied` }))
    .catch(() => toast({ tone: "error", message: `Could not copy the ${what.toLowerCase()}` }));

/** 8 characters (SMPP allows up to 8 + NUL) from letters and digits that cannot be mistaken for each other. */
export function generatePassword(length = 8): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/**
 * The password (team trial round 12): hidden as dots, the eye shows it (a saved one is fetched once, and the look is in
 * the Audit Trail), it can be edited in place, copied, or generated.
 */
function PasswordField({
  form,
  isNew,
  passwordSet,
  trunk,
}: {
  form: FormApi<TrunkForm>;
  isNew: boolean;
  passwordSet: boolean;
  trunk: TrunkRef;
}) {
  const [shown, setShown] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const typed = (form.get("password") as string | undefined) ?? "";
  const canFetch = !isNew && passwordSet && trunk.id !== null;
  const current = typed || saved || "";
  const load = async (): Promise<string | null> => {
    if (typed) return typed;
    if (saved !== null || !canFetch) return saved;
    try {
      const p = await fetchTrunkPassword(trunk.kind, trunk.id!);
      setSaved(p);
      setProblem(null);
      return p;
    } catch (err) {
      setProblem((err as Error).message);
      return null;
    }
  };
  const error = form.error("password");
  return (
    <FormField
      label="Password"
      required={isNew}
      error={error ?? problem ?? undefined}
      hint="Max 9 characters. The eye shows it; Generate makes a new one."
    >
      <span className="input-actions">
        <input
          type={shown ? "text" : "password"}
          value={typed || (shown ? (saved ?? "") : "")}
          maxLength={9}
          autoComplete="new-password"
          aria-invalid={!!error}
          placeholder={canFetch && !shown ? "•••••••• (set)" : ""}
          onChange={(e) => form.set("password", e.target.value)}
        />
        <span className="input-actions-buttons">
          <IconButton
            icon="eye"
            label={shown ? "Hide the password" : "Show the password"}
            className={shown ? "on" : undefined}
            onClick={() => {
              if (shown) return setShown(false);
              void load().then(() => setShown(true));
            }}
          />
          <IconButton
            icon="copy"
            label="Copy the password"
            disabled={!current && !canFetch}
            onClick={() => void load().then((p) => p && copyText(p, "Password"))}
          />
          <IconButton
            icon="refresh"
            label="Generate a new password"
            onClick={() => {
              form.set("password", generatePassword());
              setShown(true);
            }}
          />
        </span>
      </span>
    </FormField>
  );
}

/** The username (system_id) with a copy button (team trial round 12). */
function UsernameField({ form }: { form: FormApi<TrunkForm> }) {
  const v = (form.get("username") as string | undefined) ?? "";
  return (
    <TextField
      form={form}
      path="username"
      label="Username (system_id)"
      required
      maxLength={16}
      nullable={false}
      trailing={
        <IconButton icon="copy" label="Copy the username" disabled={!v} onClick={() => copyText(v, "Username")} />
      }
    />
  );
}

function CommonTrunkFields({ form, kind }: { form: FormApi<TrunkForm>; kind: TrunkKind }) {
  const ref = useReference();
  // Record redesign (team trial round 4): protocol and bind type as joined buttons, status as a checkbox card.
  return (
    <>
      <TextField form={form} path="name" label="Trunk name" required maxLength={100} nullable={false} />
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
      <SelectField
        form={form}
        path="billingTimezone"
        label="Billing time zone"
        placeholder="The enterprise's"
        options={tzOptions(ref.data?.timezones ?? ["UTC"])}
        hint="Day and month totals are cut at midnight here (§13.31)"
      />
      <ChoiceField
        form={form}
        path="protocol"
        label="Protocol"
        required
        options={kind === "vendor" ? VENDOR_PROTOCOL : PROTOCOL}
      />
      <ChoiceField
        form={form}
        path="bindType"
        label="Bind type"
        required
        disabled={form.values.protocol === "service"}
        options={["TR", "TX", "RX", ...(kind === "customer" ? ["AUTO"] : [])].map((v) => ({ value: v, label: v }))}
      />
      <StatusField form={form} path="status" required onText="Active" />
    </>
  );
}

/** The bind at a glance (team trial round 4): our side, the far side and whether the bind is up. */
function BindLine({ from, to, up }: { from: string; to: string; up: boolean | null }) {
  return (
    <div className="bind-line wide">
      <code>{from}</code>
      <span className="bind-arrow" aria-hidden="true" />
      <code>{to}</code>
      {up !== null && <span className={up ? "tone-good small" : "muted small"}>· bind {up ? "up" : "down"}</span>}
    </div>
  );
}

function RateTablesField({ form }: { form: FormApi<TrunkForm> }) {
  const canAddTable = useCan("rate-manager", "add");
  const ids = ((form.values as CustomerTrunkInput).rateTableIds ?? []) as number[];
  const setIds = (next: number[]) => form.set("rateTableIds", next);
  // Drag a row by its handle to reorder (team trial round 5); ↑ / ↓ and Alt+↑ / Alt+↓ still work.
  const { rowProps } = useDragOrder(ids, setIds);
  const move = (i: number, d: number) => setIds(moveItem(ids, i, i + d));
  // Quick create (team trial round 5): a new customer table, named after the trunk, added at the end.
  const createTable = async () => {
    const v = form.values as CustomerTrunkInput;
    const id = await ask<number>((done) => (
      <NewRateTableDialog
        done={done}
        initial={{ name: v.name ? `${v.name}_RATES` : "", categoryId: v.categoryId || null }}
      />
    ));
    if (id) setIds([...ids, id]);
  };
  return (
    <FormField
      label="Rate tables"
      wide
      error={form.error("rateTableIds")}
      hint="The first table with a rate wins. Drag ⠿ to reorder."
    >
      <ol className="ordered-list">
        {ids.map((id, i) => (
          <li key={id} {...rowProps(i)} aria-label={`Rate table ${i + 1}`}>
            <span className="drag-handle" title="Drag to reorder (or Alt+↑ / Alt+↓)" aria-hidden="true">
              ⠿
            </span>
            <span className="pos">{i + 1}</span>
            {/* Swap the table in place, keeping its position (team trial round 12). */}
            <ListLookup<RateTableRow>
              list="rate_tables"
              value={id}
              clearable={false}
              fixed={[{ field: "kind", op: "eq", value: "customer" }]}
              exclude={ids.filter((x) => x !== id)}
              onChange={(r) => r && r.id !== id && setIds(ids.map((x, j) => (j === i ? r.id : x)))}
              labelOf={(r) => `${r.name} (${r.currency})`}
              detailOf={(r) => `${r.category} · ${r.activeLines.toLocaleString("en-US")} rates`}
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
                onClick={() => setIds(ids.filter((x) => x !== id))}
              >
                <Icon name="x" size={12} />
              </Button>
            </span>
          </li>
        ))}
        <li>
          <span className="drag-handle" aria-hidden="true" />
          <span className="pos">+</span>
          <ListLookup<RateTableRow>
            list="rate_tables"
            value={null}
            placeholder="Add a customer rate table…"
            fixed={[{ field: "kind", op: "eq", value: "customer" }]}
            exclude={ids}
            onChange={(r) => r && setIds([...ids, r.id])}
            labelOf={(r) => `${r.name} (${r.currency})`}
            detailOf={(r) => `${r.category} · ${r.activeLines.toLocaleString("en-US")} rates`}
          />
          {/* Creating a table is a Rate manager change (backend step 10). */}
          {canAddTable && (
            <Button small variant="ghost" icon="plus" onClick={() => void createTable()}>
              Create new rate table
            </Button>
          )}
        </li>
      </ol>
    </FormField>
  );
}

/**
 * Reconnect schedule (team trial round 2): seconds before each retry after a drop or a refused bind, typed as a
 * list ("5, 10, 30, 60"); the last value repeats until the bind is up or the trunk is stopped.
 */
function ReconnectField({ form }: { form: FormApi<TrunkForm> }) {
  const value = ((form.values as VendorTrunkInput).reconnectScheduleS ?? []).join(", ");
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const list = draft
      .split(/[,;\s]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 3600)
      .slice(0, 10);
    if (list.length) form.set("reconnectScheduleS", list);
    else setDraft(value);
  };
  return (
    <FormField label="Reconnect after" error={form.error("reconnectScheduleS")} hint="Seconds; the last one repeats">
      <input
        value={draft}
        inputMode="numeric"
        placeholder="5, 10, 30, 60"
        aria-label="Reconnect schedule in seconds"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </FormField>
  );
}

export function CustomerTrunkFields({
  form,
  isNew,
  passwordSet,
  trunkId = null,
}: {
  form: FormApi<TrunkForm>;
  isNew: boolean;
  passwordSet: boolean;
  trunkId?: number | null;
}) {
  const trunk: TrunkRef = { kind: "customer", id: trunkId };
  const v = form.values as CustomerTrunkInput;
  const shown = useTabShown(); // sections an access group can hide (§11, trial round 2)
  return (
    <>
      <Section title="Trunk" columns={4}>
        <CommonTrunkFields form={form} kind="customer" />
      </Section>
      {shown("customer-trunks.connection") && (
        <Section title="Connection" columns={4}>
          <SubHead>Access</SubHead>
          <ListField
            form={form}
            path="hostIps"
            label="Allowed host IPs"
            required
            wide
            item="ip"
            placeholder="192.0.2.10, 192.0.2.0/24, 192.0.2.10-192.0.2.50"
            hint="An address, a network (IP/prefix, e.g. 192.0.2.0/24) or a range (a-b). Binds from anywhere else are refused"
          />
          <SelectField form={form} path="sslType" label="SSL" required options={SSL} />
          <ReadOnly label="Port" hint="Set by SSL: 2775 without TLS, 2776 with TLS">
            {customerPort(v.sslType)}
          </ReadOnly>
          <SubHead>Credentials</SubHead>
          <UsernameField form={form} />
          <PasswordField form={form} isNew={isNew} passwordSet={passwordSet} trunk={trunk} />
          <NumberField form={form} path="maxConnections" label="Max connections" required min={1} max={10} step={1} />
          <TextField form={form} path="systemType" label="System type" maxLength={13} />
        </Section>
      )}
      {shown("customer-trunks.receipts") && (
        <Section title="Delivery receipts" columns={1}>
          {/* The two boxes beside the fields, one under the other (team trial round 12). */}
          <FieldsAndChecks
            fields={
              <>
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
                  hint="Which session is tried first"
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
              </>
            }
            checks={
              <>
                <CheckField form={form} path="delayedSubmit" label="Delayed submit" />
                <CheckField form={form} path="sendBind" label="Send bind" />
              </>
            }
          />
        </Section>
      )}
      {shown("customer-trunks.routing") && (
        <Section title="Routing" columns={1}>
          {/* Fields on the left, the boxes stacked on the right (team trial round 12). */}
          <FieldsAndChecks
            checks={
              <>
                <CheckField form={form} path="considerHlrRate" label="Consider HLR rate" />
                <CheckField form={form} path="serviceTypeRouting" label="Service type routing" />
                <CheckField form={form} path="partWiseRouting" label="Part-wise routing" />
                <CheckField form={form} path="loopDetection" label="Loop detection" />
                <CheckField form={form} path="allowEmptyMessages" label="Allow empty messages" />
              </>
            }
            fields={
              <>
                <NumberField
                  form={form}
                  path="reassemblyTimeoutS"
                  label="Multipart wait"
                  min={10}
                  max={600}
                  step={10}
                  suffix="s"
                  hint="How long the parts of a long message wait for the rest"
                />
                <NumberField
                  form={form}
                  path="duplicateWindowS"
                  label="Duplicate filter"
                  min={0}
                  max={3600}
                  step={10}
                  suffix="s"
                  hint="The same message again within this time is not sent twice. 0 = off"
                />
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
                  hint="Bypasses routing for every message"
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
                  // R5 (2026-10-24): a % per message on the express vendor's cost.
                  <NumberField
                    form={form}
                    path="expressMargin"
                    label="Express margin"
                    min={0}
                    max={1000}
                    step={0.1}
                    suffix="%"
                    hint="Added on the express vendor's cost, per message"
                  />
                )}
              </>
            }
          />
        </Section>
      )}
      {shown("customer-trunks.capacity") && (
        <Section title="Capacity and limits">
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
      )}
      {shown("customer-trunks.pricing") && (
        <Section title="Pricing" columns={1}>
          <RateTablesField form={form} />
        </Section>
      )}
    </>
  );
}

export function VendorTrunkFields({
  form,
  isNew,
  passwordSet,
  connected,
  trunkId = null,
}: {
  form: FormApi<TrunkForm>;
  isNew: boolean;
  passwordSet: boolean;
  /** Whether the bind is up now (null: unknown, e.g. a new trunk). */
  connected?: boolean | null;
  trunkId?: number | null;
}) {
  const trunk: TrunkRef = { kind: "vendor", id: trunkId };
  const v = form.values as VendorTrunkInput;
  const shown = useTabShown(); // sections an access group can hide (§11, trial round 2)
  const service = v.protocol === "service";
  // Made a service trunk: its receipt comes at once and reads delivered, until changed.
  const [wasService, setWasService] = useState(service);
  useEffect(() => {
    if (service === wasService) return;
    setWasService(service);
    if (service) {
      form.set("dlrTimeoutS", 0);
      form.set("dlrTimeoutStat", "DELIVRD");
    }
  }, [service]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Section title="Trunk" columns={4}>
        <CommonTrunkFields form={form} kind="vendor" />
      </Section>
      {service && (
        <Section
          title="Service outcome"
          columns={2}
          note="Nothing is sent to a network: the switch ends the message and sends the client this receipt. One outcome per trunk; add a trunk for each other outcome."
        >
          <SelectField form={form} path="dlrTimeoutStat" label="Receipt status" required options={DLR_STATS} />
          <NumberField
            form={form}
            path="dlrTimeoutS"
            label="Receipt after"
            required
            min={0}
            step={1}
            suffix="s"
            hint="0 = at once"
          />
        </Section>
      )}
      {!service && shown("vendor-trunks.connection") && (
        <Section title="Connection" columns={4}>
          <BindLine
            from={`Us · ${v.sourceHost || "any address"}`}
            to={`Vendor · ${v.host || "host"}:${v.port ?? ""}`}
            up={connected ?? null}
          />
          <SubHead>Endpoint</SubHead>
          <TextField form={form} path="host" label="Host" required maxLength={255} nullable={false} />
          <NumberField form={form} path="port" label="Port" required min={1} max={65535} step={1} />
          <TextField
            form={form}
            path="sourceHost"
            label="Source IP"
            maxLength={64}
            hint="Our address the bind comes from"
          />
          <SelectField form={form} path="sslType" label="SSL" required options={SSL} />
          {v.sslType && v.sslType !== "none" && (
            <CheckField
              form={form}
              path="tlsSkipVerify"
              label="Skip certificate check"
              hint="Only for a self-signed certificate"
            />
          )}
          <SubHead>Credentials</SubHead>
          <UsernameField form={form} />
          <PasswordField form={form} isNew={isNew} passwordSet={passwordSet} trunk={trunk} />
          <NumberField form={form} path="maxConnections" label="Max connections" required min={1} max={10} step={1} />
          <TextField form={form} path="systemType" label="System type" maxLength={13} />
          <TextField form={form} path="serviceType" label="Service type" maxLength={6} />
        </Section>
      )}
      {service
        ? null
        : v.protocol === "http"
        ? shown("vendor-trunks.http") && (
            <Section title="HTTP API">
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
              <TextField
                form={form}
                path="http.dlrSuccessStats"
                label="Success statuses"
                placeholder="DELIVRD,DELIVERED"
              />
              <TextField form={form} path="http.dlrFailStats" label="Failure statuses" placeholder="UNDELIV,REJECTD" />
              <TextArea form={form} path="http.callbackExtraHeaders" label="Callback extra headers" rows={2} />
              <TextArea form={form} path="http.callbackPostData" label="Callback POST body" rows={2} />
            </Section>
          )
        : shown("vendor-trunks.smpp") && (
            <Section title="SMPP session">
              <NumberField form={form} path="windowSize" label="Window size" min={1} max={1000} step={1} />
              <NumberField form={form} path="submitIntervalMs" label="Submit interval" min={0} step={1} suffix="ms" />
              <NumberField form={form} path="submitTimeoutS" label="Submit timeout" min={1} step={1} suffix="s" />
              <NumberField
                form={form}
                path="enquireLinkIntervalS"
                label="Enquire link every"
                min={5}
                max={3600}
                step={1}
                suffix="s"
                hint="Keep-alive on an idle session"
              />
              <NumberField
                form={form}
                path="enquireLinkTimeoutS"
                label="Enquire link response"
                min={1}
                step={1}
                suffix="s"
                hint="No answer in time drops the session; it is then retried"
              />
              <ReconnectField form={form} />
              <NumberField
                form={form}
                path="bindAlertAfterMin"
                label="Bind down alert after"
                min={1}
                max={1440}
                step={1}
                suffix="min"
                hint="A refused login alerts at once"
              />
              <NumberField
                form={form}
                path="authFailRetryMin"
                label="Retry after wrong login"
                min={1}
                max={1440}
                step={1}
                suffix="min"
                hint="Saving retries at once"
              />
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
      {!service && shown("vendor-trunks.messages") && (
        <Section title="Messages" columns={2}>
          <MultiCheck form={form} path="allowedDataCodings" any label="Allowed data codings" options={CODINGS} />
          <MultiCheck
            form={form}
            path="rerouteOn"
            label="Re-route on receipt status"
            options={DLR_STATS.filter((s) => s.value !== "DELIVRD")}
            hint="Failed receipts with these statuses are retried on the next vendor"
          />
          <MultiCheck form={form} path="allowedSrcTon" any label="Allowed source TON" options={TON} />
          <MultiCheck form={form} path="allowedDstTon" any label="Allowed destination TON" options={TON} />
          <MultiCheck form={form} path="allowedSrcNpi" any label="Allowed source NPI" options={NPI} />
          <MultiCheck form={form} path="allowedDstNpi" any label="Allowed destination NPI" options={NPI} />
          <NumberField
            form={form}
            path="maxMsgLen"
            label="Max message length"
            min={1}
            max={2000}
            step={1}
            placeholder="Any"
            hint="Empty = any length"
          />
          <CheckField form={form} path="supportMultipart" label="Supports multipart" />
          <SelectField
            form={form}
            path="multipartFormat"
            label="Multipart format"
            required
            options={[
              { value: "udh8", label: "UDH, 8-bit reference" },
              { value: "udh16", label: "UDH, 16-bit reference" },
              { value: "sar", label: "SAR parameters" },
              { value: "payload", label: "Whole text in message_payload" },
            ]}
          />
          <NumberField form={form} path="dlrTimeoutS" label="Receipt timeout" min={0} step={60} suffix="s" />
          <SelectField
            form={form}
            path="dlrTimeoutStat"
            label="Status on receipt timeout"
            required
            options={DLR_STATS}
          />
          <TimeoutDestinations form={form} />
        </Section>
      )}
      {shown("vendor-trunks.capacity") && (
        <Section title="Capacity and limits">
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
      )}
    </>
  );
}

/**
 * The destinations the Receipt timeout applies to (team trial round 12): none = the whole trunk; a message to another
 * destination waits the default 48 hours, then gets UNKNOWN.
 */
function TimeoutDestinations({ form }: { form: FormApi<TrunkForm> }) {
  const { tree } = useDestinationTree();
  const codes = ((form.values as VendorTrunkInput).dlrTimeoutMccmncs ?? []) as string[];
  return (
    <FormField
      label="Receipt timeout applies to"
      wide
      error={form.error("dlrTimeoutMccmncs")}
      hint={codes.length ? "Other destinations wait 48 hours, then get UNKNOWN" : undefined}
    >
      <span className="bulk-row">
        <Button
          small
          icon="globe"
          onClick={async () => {
            const next = await ask<string[]>((done) => <RuleCodesDialog initial={codes} done={done} />);
            if (next) form.set("dlrTimeoutMccmncs", next);
          }}
        >
          {codes.length ? "Change…" : "Pick destinations…"}
        </Button>
        <span className={codes.length ? "small" : "muted small"} title={codes.join(", ")}>
          {codes.length ? `${codes.length} · ${codesText(tree, codes, 2)}` : "Every destination"}
        </span>
        {codes.length > 0 && (
          <button type="button" className="link small" onClick={() => form.set("dlrTimeoutMccmncs", [])}>
            Every destination
          </button>
        )}
      </span>
    </FormField>
  );
}
