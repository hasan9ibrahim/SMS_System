// Translation rules (§6.4) assigned straight to trunks (§13.2): the grid of §6.4 plus Applies
// To and Used by, a detail panel (Rule, Applies to, Test, History) and one form that holds every
// field of the old /digitrule/add page and the Applies To block, so a rule runs on its trunks as
// soon as it is saved: no group, no second trip to the trunk. Editing a shared rule confirms with
// the number of trunks it touches; "Duplicate to trunk" makes a variant for one partner.
import { useState, type ReactNode } from "react";
import type {
  DlrMapEntry,
  Enterprise,
  NumberList,
  ProductCategory,
  TranslationRuleDetail,
  TranslationRuleInput,
  TranslationRuleRow,
  TranslationTargetInput,
  TrunkListRow,
} from "@sms/contract";
import {
  testTranslationRule,
  useCloneTranslationRule,
  useRuleUsedBy,
  useSaveTranslationRule,
  useTranslationRule,
} from "../../api/switchRules";
import {
  CheckField,
  FormField,
  NumberField,
  Section,
  SelectField,
  TextField,
  useForm,
  type FormApi,
} from "../../form/form";
import { HistoryList, useNotifySaved } from "../../history/undo";
import { pageForPath } from "../../nav/registry";
import { ListScreen } from "../../page/ListScreen";
import { ListLookup } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { Button, Modal } from "../../ui/primitives";
import { fmtWhen, RecordActions } from "../reference/shared";
import { problemText } from "../routing/dialogs";
import { DestinationPick, MultiPick } from "../routing/pickers";
import { NumberListDialog } from "./NumberListsPage";
import {
  BILLING_TYPES,
  blankRule,
  conversionHint,
  conversionLabel,
  impliedDirection,
  inputFromDetail,
  listTypeLabel,
  NPI_OPTIONS,
  RECEIVER_CONVERSIONS,
  ruleSummary,
  SENDER_CONVERSIONS,
  targetKey,
  toSave,
  TON_OPTIONS,
  usesList,
} from "./switchModel";
import { TranslationTest } from "./TranslationTest";
import { CleanupBadge } from "../admin/cleanup/CleanupBadge";

const page = pageForPath("/switch/translation-rules")!;
const muted = (v: ReactNode) => <span className="muted">{v}</span>;

// ---------------------------------------------------------------- editor parts

/** A Number List picker with "+ New list" inline (§13.2: lists are no longer created first). */
function ListPick({
  form,
  path,
  label,
  listType,
  hint,
}: {
  form: FormApi<TranslationRuleInput>;
  path: "senderListId" | "receiverListId" | "senderConversionListId";
  label: string;
  /** Conversion lists are one type; match lists take any type (decided 2026-10-17). */
  listType?: NumberList["listType"];
  hint?: string;
}) {
  const value = form.get(path) as number | null;
  const newList = async () => {
    const saved = await ask<NumberList>((done) => <NumberListDialog row={null} fixedType={listType} done={done} />);
    if (saved) form.set(path, saved.id);
  };
  return (
    <FormField label={label} error={form.error(path)} hint={hint}>
      <div className="pick-with-new">
        <ListLookup<NumberList>
          list="number_lists"
          value={value}
          onChange={(l) => form.set(path, l?.id ?? null)}
          labelOf={(l) => l.name}
          detailOf={(l) => `${listType ? "" : `${listTypeLabel(l.listType)} · `}${l.entries} entries`}
          fixed={listType ? [{ field: "listType", op: "eq", value: listType }] : undefined}
          placeholder="Any number list…"
        />
        <Button small variant="ghost" icon="plus" onClick={() => void newList()}>
          New list
        </Button>
      </div>
    </FormField>
  );
}

/** A match condition with its Match / Not Match switch (§6.4). */
function Negate({ form, path }: { form: FormApi<TranslationRuleInput>; path: keyof TranslationRuleInput }) {
  const on = form.get(path) === true;
  return (
    <div className="segmented small negate" role="radiogroup" aria-label="Match or Not Match">
      <button
        type="button"
        role="radio"
        aria-checked={!on}
        className={on ? "" : "on"}
        onClick={() => form.set(path, false)}
      >
        Match
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={on}
        className={on ? "on" : ""}
        onClick={() => form.set(path, true)}
      >
        Not Match
      </button>
    </div>
  );
}

function PatternField({
  form,
  path,
  negate,
  label,
  placeholder,
}: {
  form: FormApi<TranslationRuleInput>;
  path: "senderPattern" | "receiverPattern" | "contentPattern";
  negate: keyof TranslationRuleInput;
  label: string;
  placeholder: string;
}) {
  return (
    <div className="cond-field">
      <TextField form={form} path={path} label={label} placeholder={placeholder} maxLength={500} />
      <Negate form={form} path={negate} />
    </div>
  );
}

type Side = "customer" | "vendor";
type TargetType = TranslationTargetInput["type"];

/** Applies To (§13.2): trunks, enterprises, categories or all trunks, per side. */
function TargetsEditor({
  value,
  labels,
  onChange,
}: {
  value: TranslationTargetInput[];
  labels: Map<string, string>;
  onChange: (next: TranslationTargetInput[]) => void;
}) {
  const [side, setSide] = useState<Side>(value[0]?.trunkKind ?? "customer");
  const [type, setType] = useState<TargetType>("trunk");
  const [names, setNames] = useState(labels);
  const of = (t: TargetType) => value.filter((v) => v.trunkKind === side && v.type === t);
  const label = (t: TranslationTargetInput) =>
    t.type === "all" ? `All ${t.trunkKind} trunks` : (names.get(targetKey(t)) ?? `#${t.id}`);
  const replace = (t: TargetType, picked: { key: number; label: string }[]) => {
    const next = new Map(names);
    for (const p of picked) next.set(targetKey({ type: t, trunkKind: side, id: p.key }), p.label);
    setNames(next);
    onChange([
      ...value.filter((v) => !(v.trunkKind === side && v.type === t)),
      ...picked.map((p) => ({ type: t, trunkKind: side, id: p.key })),
    ]);
  };
  const allOn = of("all").length > 0;
  const picked = (t: TargetType) => of(t).map((v) => ({ key: v.id!, label: label(v) }));
  return (
    <div className="targets">
      <div className="targets-bar">
        <div className="segmented small" role="radiogroup" aria-label="Side">
          {(["customer", "vendor"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={side === s}
              className={side === s ? "on" : ""}
              onClick={() => setSide(s)}
            >
              {s === "customer" ? "Customer trunks (ingress)" : "Vendor trunks (egress)"}
            </button>
          ))}
        </div>
        <label className="toggle-inline">
          <input
            type="checkbox"
            checked={allOn}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, { type: "all", trunkKind: side, id: null }]
                  : value.filter((v) => !(v.trunkKind === side && v.type === "all")),
              )
            }
          />
          All {side} trunks
        </label>
      </div>
      {!allOn && (
        <>
          <div className="segmented small" role="radiogroup" aria-label="Target type">
            {(
              [
                ["trunk", "Trunks"],
                ["enterprise", "Enterprises"],
                ["category", "Product categories"],
              ] as const
            ).map(([t, l]) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={type === t}
                className={type === t ? "on" : ""}
                onClick={() => setType(t)}
              >
                {l} {of(t).length > 0 && <span className="num">({of(t).length})</span>}
              </button>
            ))}
          </div>
          {type === "trunk" && (
            <MultiPick<TrunkListRow, number>
              key={`t-${side}`}
              list={side === "customer" ? "customer_trunks" : "vendor_trunks"}
              value={picked("trunk")}
              onChange={(p) => replace("trunk", p)}
              toPicked={(r) => ({ key: r.id, label: r.name })}
              detailOf={(r) => r.enterpriseName}
              placeholder="Trunk name or enterprise…"
            />
          )}
          {type === "enterprise" && (
            <MultiPick<Enterprise, number>
              key={`e-${side}`}
              list="enterprises"
              value={picked("enterprise")}
              onChange={(p) => replace("enterprise", p)}
              toPicked={(r) => ({ key: r.id, label: r.name })}
              detailOf={(r) => r.alias}
              placeholder="Enterprise name or alias…"
            />
          )}
          {type === "category" && (
            <MultiPick<ProductCategory, number>
              key={`c-${side}`}
              list="product_categories"
              value={picked("category")}
              onChange={(p) => replace("category", p)}
              toPicked={(r) => ({ key: r.id, label: r.name })}
              placeholder="Product category…"
            />
          )}
        </>
      )}
      <p className="muted small">
        {value.length === 0
          ? "Not assigned: the rule runs nowhere until it applies to something."
          : `Applies to ${value.map(label).join(", ")}. Trunks added later to a targeted enterprise or category get the rule too.`}
      </p>
    </div>
  );
}

function DlrMapEditor({ value, onChange }: { value: DlrMapEntry[]; onChange: (v: DlrMapEntry[]) => void }) {
  const patch = (i: number, p: Partial<DlrMapEntry>) => onChange(value.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const cell = (i: number, k: keyof DlrMapEntry, placeholder: string, nullable: boolean) => (
    <input
      value={value[i]![k] ?? ""}
      maxLength={10}
      placeholder={placeholder}
      aria-label={k}
      onChange={(e) => {
        const v = e.target.value.toUpperCase();
        patch(i, { [k]: v === "" && nullable ? null : v });
      }}
    />
  );
  return (
    <div className="dlr-map">
      {value.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Vendor stat</th>
              <th>Vendor err</th>
              <th />
              <th>Customer stat</th>
              <th>Customer err</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {value.map((_, i) => (
              <tr key={i}>
                <td>{cell(i, "fromStatus", "UNKNOWN", false)}</td>
                <td>{cell(i, "fromError", "any", true)}</td>
                <td className="muted">→</td>
                <td>{cell(i, "toStatus", "UNDELIV", false)}</td>
                <td>{cell(i, "toError", "keep", true)}</td>
                <td>
                  <Button
                    small
                    variant="ghost"
                    icon="x"
                    aria-label="Remove"
                    onClick={() => onChange(value.filter((__, j) => j !== i))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Button
        small
        icon="plus"
        disabled={value.length >= 50}
        onClick={() => onChange([...value, { fromStatus: "", fromError: null, toStatus: "", toError: null }])}
      >
        Add DLR conversion
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- editor

function RuleEditor({ detail, done }: { detail: TranslationRuleDetail | null; done: (id: number | null) => void }) {
  const form = useForm<TranslationRuleInput>(detail ? inputFromDetail(detail) : blankRule());
  const save = useSaveTranslationRule();
  const notifySaved = useNotifySaved();
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const v = form.values;
  const labels = new Map((detail?.targets ?? []).map((t) => [targetKey(t), t.label]));
  const submit = async () => {
    const input = toSave(v);
    if (detail && detail.usedBy > 1) {
      const ok = await confirmDialog({
        title: "Save a shared rule?",
        message: (
          <p>
            <strong>{detail.name}</strong> runs on <strong>{detail.usedBy} trunks</strong>. Saving changes it on all of
            them. Use “Duplicate to trunk” instead when one partner needs a variant.
          </p>
        ),
        ok: `Save on ${detail.usedBy} trunks`,
      });
      if (!ok) return;
    }
    save.mutate(
      { id: detail?.id ?? null, input },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `${detail ? "Saved" : "Added"} ${r.record.name}`);
          else toast({ tone: "info", message: "Nothing changed" });
          done(r.record.id);
        },
        onError: (e) => setError(form.fail(e)),
      },
    );
  };
  const blocks = v.action === "block";
  return (
    <Modal
      title={detail ? `Edit translation rule · ${detail.name}` : "Add translation rule"}
      width={1040}
      onClose={() => done(null)}
      footer={
        <>
          {error && <span className="error-text small">{error}</span>}
          <span className="fb-spacer" />
          {detail && (
            <Button icon="play" onClick={() => setTesting((t) => !t)}>
              {testing ? "Hide test" : "Test this form"}
            </Button>
          )}
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="save" disabled={save.isPending} onClick={() => void submit()}>
            {detail ? "Save" : "Add rule"}
          </Button>
        </>
      }
    >
      <form
        className="tr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Section title="Rule" columns={4} note={impliedDirection(v)}>
          <TextField form={form} path="name" label="Name" required wide maxLength={100} nullable={false} />
          <SelectField
            form={form}
            path="direction"
            label="Type"
            placeholder="Implied by the trunk"
            options={[
              { value: "ingress", label: "Ingress" },
              { value: "egress", label: "Egress" },
            ]}
            hint="Override only: a customer trunk means ingress, a vendor trunk egress"
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
          <SelectField
            form={form}
            path="action"
            label="Action"
            required
            options={[
              { value: "allow", label: "Allow (rewrite)" },
              { value: "block", label: "Block" },
            ]}
          />
          <CheckField
            form={form}
            path="continueAfter"
            label="Is Continue"
            hint="Apply further rules after this one (a trunk can override)"
          />
          <FormField label="Start" hint="Empty = now">
            <input
              type="datetime-local"
              value={v.startsAt ? v.startsAt.slice(0, 16) : ""}
              onChange={(e) =>
                form.set("startsAt", e.target.value ? new Date(`${e.target.value}Z`).toISOString() : null)
              }
            />
          </FormField>
          <FormField label="Stop" error={form.error("stopsAt")} hint="Empty = no end (UTC)">
            <input
              type="datetime-local"
              value={v.stopsAt ? v.stopsAt.slice(0, 16) : ""}
              onChange={(e) =>
                form.set("stopsAt", e.target.value ? new Date(`${e.target.value}Z`).toISOString() : null)
              }
            />
          </FormField>
        </Section>

        <Section title="Applies to" columns={1} note="Saving applies the rule everywhere it targets (§13.2)">
          <FormField label="Targets" wide error={form.error("targets")}>
            <TargetsEditor value={v.targets} labels={labels} onChange={(t) => form.set("targets", t)} />
          </FormField>
          <SelectField
            form={form}
            path="insertAt"
            label="Position on trunks"
            required
            options={[
              { value: "bottom", label: "After the ordered rules" },
              { value: "top", label: "Before the ordered rules" },
            ]}
            hint="Where the rule runs on a trunk that has not ordered it yet"
          />
        </Section>

        <Section title="Match conditions" columns={2} note="All set conditions must hold">
          <PatternField
            form={form}
            path="senderPattern"
            negate="senderPatternNegate"
            label="Sender ID (regex)"
            placeholder="^[A-Z]+$"
          />
          <PatternField
            form={form}
            path="receiverPattern"
            negate="receiverPatternNegate"
            label="Receiver ID (regex)"
            placeholder="^00"
          />
          <PatternField
            form={form}
            path="contentPattern"
            negate="contentPatternNegate"
            label="Message Body Text (regex)"
            placeholder="bit\.ly"
          />
          <div className="cond-field">
            <ListPick form={form} path="senderListId" label="Sender ID List" />
            <Negate form={form} path="senderListNegate" />
          </div>
          <div className="cond-field">
            <ListPick form={form} path="receiverListId" label="Receiver ID List" />
            <Negate form={form} path="receiverListNegate" />
          </div>
          <div className="cond-field wide">
            <FormField label="MCCMNC" error={form.error("mccmncs")} hint="A 3-digit MCC means the whole country">
              <DestinationPick value={v.mccmncs} onChange={(c) => form.set("mccmncs", c)} />
            </FormField>
            <Negate form={form} path="mccmncNegate" />
          </div>
          <div className="fgrid cols-4 wide">
            <NumberField
              form={form}
              path="senderMinLength"
              label="Sender ID Min Length"
              required
              min={0}
              max={20}
              step={1}
            />
            <NumberField
              form={form}
              path="senderMaxLength"
              label="Sender ID Max Length"
              required
              min={1}
              max={20}
              step={1}
            />
            <NumberField
              form={form}
              path="receiverMinLength"
              label="Receiver ID Min Length"
              required
              min={0}
              max={20}
              step={1}
            />
            <NumberField
              form={form}
              path="receiverMaxLength"
              label="Receiver ID Max Length"
              required
              min={1}
              max={20}
              step={1}
            />
          </div>
        </Section>

        {!blocks && (
          <>
            <Section
              title="Sender and receiver conversion"
              columns={3}
              note="Translation swaps a prefix; Regex Replace rewrites any part"
            >
              <SelectField
                form={form}
                path="senderConversion"
                label="Sender ID Conversion"
                placeholder="None"
                options={SENDER_CONVERSIONS}
              />
              {usesList(v.senderConversion) ? (
                <ListPick
                  form={form}
                  path="senderConversionListId"
                  label={v.senderConversion === "random_number" ? "Random list" : "Template list"}
                  listType={v.senderConversion === "random_number" ? "random" : "sender_id_template"}
                />
              ) : (
                <TextField
                  form={form}
                  path="senderConversionValue"
                  label={v.senderConversion === "regex_replace" ? "Pattern" : "Value"}
                  maxLength={200}
                  disabled={!v.senderConversion}
                  hint={conversionHint(v.senderConversion)}
                />
              )}
              {v.senderConversion === "regex_replace" ? (
                <TextField
                  form={form}
                  path="senderConversionReplacement"
                  label="Replace with"
                  maxLength={100}
                  hint="$1..$9 insert the pattern's groups; empty removes the match"
                />
              ) : (
                <div />
              )}
              <SelectField
                form={form}
                path="receiverConversion"
                label="Receiver ID Conversion"
                placeholder="None"
                options={RECEIVER_CONVERSIONS}
              />
              <TextField
                form={form}
                path="receiverConversionValue"
                label={v.receiverConversion === "regex_replace" ? "Pattern" : "Value"}
                maxLength={200}
                disabled={!v.receiverConversion}
                hint={conversionHint(v.receiverConversion)}
              />
              {v.receiverConversion === "regex_replace" ? (
                <TextField
                  form={form}
                  path="receiverConversionReplacement"
                  label="Replace with"
                  maxLength={100}
                  placeholder="44$1"
                  hint="$1..$9 insert the pattern's groups; empty removes the match"
                />
              ) : (
                <div />
              )}
            </Section>
            <Section title="SMPP field overrides" columns={3} note="Empty = keep what the message has">
              <SelectField form={form} path="senderTon" label="Sender TON" placeholder="Keep" options={TON_OPTIONS} />
              <SelectField form={form} path="senderNpi" label="Sender NPI" placeholder="Keep" options={NPI_OPTIONS} />
              <SelectField
                form={form}
                path="billingType"
                label="Billing Type"
                placeholder="Keep"
                options={BILLING_TYPES}
              />
              <SelectField
                form={form}
                path="destTon"
                label="Destination TON"
                placeholder="Keep"
                options={TON_OPTIONS}
              />
              <SelectField
                form={form}
                path="destNpi"
                label="Destination NPI"
                placeholder="Keep"
                options={NPI_OPTIONS}
              />
              <SelectField
                form={form}
                path="registeredDelivery"
                label="Registered Delivery"
                placeholder="Keep"
                options={[
                  { value: 0, label: "0 No receipt" },
                  { value: 1, label: "1 Receipt" },
                ]}
              />
            </Section>
            <Section
              title="DLR Status & Error Code Convert"
              columns={1}
              note="The vendor's stat and error as the customer gets them"
            >
              <FormField label="Conversions" wide error={form.error("dlrMap")}>
                <DlrMapEditor value={v.dlrMap} onChange={(m) => form.set("dlrMap", m)} />
              </FormField>
            </Section>
            <Section title="Content rewrite" columns={4}>
              <TextField
                form={form}
                path="contentRegex"
                label="Regex Pattern"
                maxLength={500}
                placeholder="code ([0-9]+)"
              />
              <NumberField
                form={form}
                path="contentRegexIndex"
                label="Regex Index"
                min={1}
                max={5}
                step={1}
                hint="Group to replace; empty = the whole match"
              />
              <TextField
                form={form}
                path="contentReplacement"
                label="Message Text"
                maxLength={1000}
                disabled={!v.contentRegex}
              />
              <TextField
                form={form}
                path="msgTemplate"
                label="MSG Template"
                maxLength={1000}
                placeholder="[Brand] {text}"
                hint="Replaces the whole text; {text} = the original"
              />
            </Section>
          </>
        )}
        <p className="muted small">{ruleSummary(toSave(v))}</p>
        <button type="submit" hidden />
      </form>
      {testing && detail && (
        <Section title="Test this form (not saved)" columns={1}>
          <TranslationTest run={(m) => testTranslationRule(detail.id, m, toSave(v))} />
        </Section>
      )}
    </Modal>
  );
}

const openEditor = (detail: TranslationRuleDetail | null) =>
  ask<number>((done) => <RuleEditor detail={detail} done={done} />);

// ---------------------------------------------------------------- detail panel

function DuplicateDialog({ rule, done }: { rule: TranslationRuleDetail; done: (id: number | null) => void }) {
  const usedBy = useRuleUsedBy(rule.id);
  const clone = useCloneTranslationRule();
  const notifySaved = useNotifySaved();
  const [pick, setPick] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const trunks = usedBy.data?.trunks ?? [];
  const submit = () => {
    const [kind, id] = pick.split(":");
    if (!id) return setError("Pick the trunk that needs its own variant.");
    clone.mutate(
      { id: rule.id, body: { targetTrunk: { kind: kind as Side, id: Number(id) } } },
      {
        onSuccess: (r) => {
          if (r.change) notifySaved(r.change, `Duplicated to ${r.record.name}`);
          done(r.record.id);
        },
        onError: (e) => setError(problemText(e)),
      },
    );
  };
  return (
    <Modal
      title={`Duplicate ${rule.name} to a trunk`}
      width={560}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" icon="copy" disabled={clone.isPending || !pick} onClick={submit}>
            Duplicate
          </Button>
        </>
      }
    >
      <p className="muted">
        An independent copy for one trunk only (§13.2): the trunk runs the copy where it ran this rule, and this rule no
        longer runs there. Edit the copy afterwards; the other trunks keep this rule.
      </p>
      <label className="field">
        <span>Trunk</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)} autoFocus>
          <option value="">{usedBy.isPending ? "Loading…" : "Choose a trunk the rule runs on"}</option>
          {trunks.map((t) => (
            <option key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>
              {t.name} · {t.enterpriseName} ({t.kind})
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

function UsedByList({ id }: { id: number }) {
  const q = useRuleUsedBy(id);
  const navigate = useTabNavigate();
  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) return <p className="error-text">{problemText(q.error)}</p>;
  if (!q.data.trunks.length) return <p className="muted">No live trunk is reached by the targets.</p>;
  const shown = q.data.trunks.slice(0, 200);
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>Trunk</th>
          <th>Enterprise</th>
          <th>Through</th>
          <th>On</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((t) => (
          <tr key={`${t.kind}:${t.id}`} className={t.enabled ? "" : "off"}>
            <td>
              <button
                type="button"
                className="link"
                onClick={() => navigate(`/enterprises/${t.kind}-trunks/${t.id}?tab=rules`)}
              >
                {t.name}
              </button>{" "}
              <span className="muted small">{t.kind}</span>
            </td>
            <td>{t.enterpriseName}</td>
            <td className="muted">{t.via === "all" ? "all trunks" : t.via}</td>
            <td>{t.enabled ? "Yes" : muted("Off here")}</td>
          </tr>
        ))}
        {q.data.trunks.length > shown.length && (
          <tr>
            <td colSpan={4} className="muted">
              and {q.data.trunks.length - shown.length} more
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function RuleDetail({ row, select }: { row: TranslationRuleRow; select: (id: number) => void }) {
  const q = useTranslationRule(row.id);
  const clone = useCloneTranslationRule();
  const notifySaved = useNotifySaved();
  const d = q.data;
  if (!d) return <p className="muted">{q.isError ? problemText(q.error) : "Loading…"}</p>;
  const input = inputFromDetail(d);
  const conv = d.senderConversion
    ? d.senderConversion === "regex_replace"
      ? `Regex Replace ${d.senderConversionValue ?? ""} → ${d.senderConversionReplacement || "(removed)"}`
      : `${conversionLabel(d.senderConversion)} ${row.senderConversionValue ?? ""}`.trim()
    : null;
  return (
    <div className="tr-detail">
      <div className="detail-actions">
        {!d.archivedAt && (
          <>
            <Button small icon="file" onClick={() => void openEditor(d).then((id) => id && select(id))}>
              Edit
            </Button>
            <Button
              small
              icon="copy"
              disabled={clone.isPending}
              onClick={() =>
                clone.mutate(
                  { id: d.id, body: {} },
                  {
                    onSuccess: (r) => {
                      if (r.change) notifySaved(r.change, `Cloned to ${r.record.name} (inactive)`);
                      select(r.record.id);
                    },
                    onError: (e) => toast({ tone: "error", message: problemText(e) }),
                  },
                )
              }
            >
              Clone
            </Button>
            {d.usedBy > 0 && (
              <Button
                small
                icon="copy"
                onClick={() =>
                  void ask<number>((done) => <DuplicateDialog rule={d} done={done} />).then((id) => id && select(id))
                }
              >
                Duplicate to trunk
              </Button>
            )}
          </>
        )}
        <RecordActions kind="translation_rule" id={d.id} name={`rule ${d.name}`} archived={!!d.archivedAt} />
      </div>
      <p>{ruleSummary(input)}</p>
      <dl className="kv">
        <dt>Type</dt>
        <dd>{impliedDirection(input)}</dd>
        <dt>Action</dt>
        <dd>{d.action === "block" ? "Block" : "Allow"}</dd>
        <dt>Continues</dt>
        <dd>{d.continueAfter ? "Yes" : "No (stop after this rule)"}</dd>
        {conv && (
          <>
            <dt>Sender ID conversion</dt>
            <dd>{conv}</dd>
          </>
        )}
        <dt>Window</dt>
        <dd>
          {d.startsAt || d.stopsAt ? `${fmtWhen(d.startsAt)} → ${d.stopsAt ? fmtWhen(d.stopsAt) : "no end"}` : "Always"}
        </dd>
        <dt>Updated</dt>
        <dd>
          {d.updatedBy ?? "seed data"} · {fmtWhen(d.updatedAt)}
          {d.createdBy ? ` · created by ${d.createdBy}` : ""}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------- page

export function TranslationRulesPage() {
  const [selectId, setSelectId] = useState<number | null>(null);
  return (
    <ListScreen<TranslationRuleRow>
      list="translation_rules"
      page={page}
      selectId={selectId}
      historyScope={{ entityTypes: ["translation_rule"] }}
      actions={<CleanupBadge kinds={["translation_rule_unassigned"]} />}
      primary={{
        label: "Add rule",
        icon: "plus",
        onClick: () => void openEditor(null).then((id) => id && setSelectId(id)),
      }}
      columns={{
        id: { width: 70 },
        name: { width: 260, render: (r) => <strong>{r.name}</strong> },
        direction: {
          width: 90,
          render: (r) => (r.direction ? (r.direction === "ingress" ? "Ingress" : "Egress") : muted("implied")),
        },
        action: {
          width: 80,
          render: (r) => (r.action === "block" ? <span className="tone-error strong">Block</span> : "Allow"),
        },
        continueAfter: { width: 90, render: (r) => (r.continueAfter ? "Yes" : <span className="strong">No</span>) },
        senderPattern: { width: 140, render: (r) => (r.senderPattern ? <code>{r.senderPattern}</code> : muted("—")) },
        receiverPattern: {
          width: 120,
          render: (r) => (r.receiverPattern ? <code>{r.receiverPattern}</code> : muted("—")),
        },
        mccmncs: {
          width: 110,
          render: (r) => (r.mccmncs.length ? <span className="num">{r.mccmncs.join(", ")}</span> : muted("—")),
        },
        contentPattern: {
          width: 140,
          render: (r) => (r.contentPattern ? <code>{r.contentPattern}</code> : muted("—")),
        },
        senderConversion: {
          width: 150,
          render: (r) => (r.senderConversion ? conversionLabel(r.senderConversion) : muted("—")),
        },
        senderConversionValue: { width: 160, render: (r) => r.senderConversionValue ?? muted("—") },
        status: {
          width: 90,
          render: (r) => (r.status === "active" ? "Active" : <span className="muted">Inactive</span>),
        },
        appliesTo: {
          width: 200,
          render: (r) =>
            r.appliesTo === "Not assigned" ? <span className="tone-warning">Not assigned</span> : r.appliesTo,
        },
        usedBy: { width: 90, align: "right" },
        updatedBy: { width: 140, render: (r) => r.updatedBy ?? muted("—") },
      }}
      rowClass={(r) => (r.status === "inactive" ? "row-muted" : undefined)}
      onOpen={(r) =>
        !r.archivedAt &&
        void ask<number>((done) => <EditLoader id={r.id} done={done} />).then((id) => id && setSelectId(id))
      }
      detail={(r) => ({
        title: (
          <>
            <strong>{r.name}</strong>
            <span className="muted">
              #{r.id} · {r.appliesTo} · {r.usedBy} trunk{r.usedBy === 1 ? "" : "s"}
            </span>
          </>
        ),
        sections: [
          { key: "rule", label: "Rule", content: <RuleDetail row={r} select={setSelectId} /> },
          { key: "used-by", label: `Used by (${r.usedBy})`, content: <UsedByList id={r.id} /> },
          {
            key: "test",
            label: "Test",
            content: (
              <TranslationTest
                run={(m) => testTranslationRule(r.id, m)}
                note="Runs the saved rule on a sample message, whatever its status and targets."
              />
            ),
          },
          {
            key: "history",
            label: "History",
            content: <HistoryList scope={{ entityTypes: ["translation_rule"], entityId: r.id }} />,
          },
        ],
      })}
      shortcuts="↑↓ move · Enter edits · Ctrl+Z undo · a Sender ID filter like ^TEST finds patterns"
    />
  );
}

/** Opens the editor once the full rule is loaded (the grid row holds a summary only). */
function EditLoader({ id, done }: { id: number; done: (id: number | null) => void }) {
  const q = useTranslationRule(id);
  if (q.data) return <RuleEditor detail={q.data} done={done} />;
  return (
    <Modal title="Loading rule…" onClose={() => done(null)} width={360}>
      <p className={q.isError ? "error-text" : "muted"}>{q.isError ? problemText(q.error) : "Loading…"}</p>
    </Modal>
  );
}
