// Translation rules (§6.4) assigned straight to trunks (§13.2): the grid of §6.4 plus Applies
// To and Used by, a detail panel (Rule, Applies to, Test, History) and one form that holds every
// field of the old /digitrule/add page and the Applies To block, so a rule runs on its trunks as
// soon as it is saved: no group, no second trip to the trunk. Editing a shared rule confirms with
// the number of trunks it touches; "Duplicate to trunk" makes a variant for one partner.
import { useCan } from "../../api/access";
import { useEffect, useState, type ReactNode } from "react";
import { formatNumbers } from "./numberFormat";
import { api, unwrap } from "../../api/client";
import type {
  ContentWordRule,
  DlrMapEntry,
  Enterprise,
  NumberList,
  ProductCategory,
  TranslationRuleDetail,
  TranslationRuleInput,
  TranslationRuleRow,
  TranslationTargetInput,
  TrunkListRow,
  ValueMatch,
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
import { useMe } from "../../api/hooks";
import { useRestore } from "../../api/records";
import { isAdminUser, ListLookup, useDeleteRecord, type Unassign } from "../../records/parts";
import { useTabNavigate } from "../../shell/tabContext";
import { ask, confirmDialog, toast } from "../../ui/feedback";
import { HoverList } from "../../ui/HoverList";
import { Button, Modal } from "../../ui/primitives";
import { fmtWhen, RecordActions } from "../reference/shared";
import { problemText } from "../routing/dialogs";
import { MultiPick } from "../routing/pickers";
import { codesText, RuleCodesDialog, useDestinationTree } from "../rates/DestinationTree";
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
import { ValueRows } from "../routing/ValueRows";
import { valuesSummary } from "../routing/ruleModel";
import { CleanupBadge } from "../admin/cleanup/CleanupBadge";
import { DateTimeInput } from "../../ui/DateTimeInput";

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
  // A new list is a Number lists change (backend step 10).
  const canNewList = useCan("number-lists", "add");
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
        {canNewList && (
          <Button small variant="ghost" icon="plus" onClick={() => void newList()}>
            New list
          </Button>
        )}
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

/**
 * Case sensitive for the Sender ID conditions (team trial round 1): on (the default), the Sender ID pattern and
 * list must match the exact capitals; off, any case matches.
 */
function MatchCase({ form }: { form: FormApi<TranslationRuleInput> }) {
  return (
    <label
      className="toggle-inline match-case"
      title="On: the Sender ID pattern and Sender ID List must match the exact capitals. Off: any case. Each value row has its own."
    >
      <input
        type="checkbox"
        checked={form.get("senderMatchCase") !== false}
        onChange={(e) => form.set("senderMatchCase", e.target.checked)}
      />
      Case sensitive
    </label>
  );
}

/** A plain input bound to the form, for the compact match grid (the column titles are the labels). */
function BareText({
  form,
  path,
  placeholder,
  label,
}: {
  form: FormApi<TranslationRuleInput>;
  path: "senderPattern" | "receiverPattern" | "contentPattern" | "mccmncPattern";
  placeholder: string;
  label: string;
}) {
  const err = form.error(path);
  return (
    <span className="mg-cell">
      <input
        value={(form.get(path) as string | null) ?? ""}
        placeholder={placeholder}
        maxLength={path === "mccmncPattern" ? 200 : 500}
        aria-label={label}
        aria-invalid={!!err}
        onChange={(e) => form.set(path, e.target.value || null)}
      />
      {err && <small className="error-text">{err}</small>}
    </span>
  );
}

function BareList({
  form,
  path,
  label,
}: {
  form: FormApi<TranslationRuleInput>;
  path: "senderListId" | "receiverListId";
  label: string;
}) {
  const canNewList = useCan("number-lists", "add");
  const newList = async () => {
    const saved = await ask<NumberList>((done) => <NumberListDialog row={null} done={done} />);
    if (saved) form.set(path, saved.id);
  };
  return (
    <span className="mg-cell mg-list" aria-label={label}>
      <ListLookup<NumberList>
        list="number_lists"
        value={form.get(path) as number | null}
        onChange={(l) => form.set(path, l?.id ?? null)}
        labelOf={(l) => l.name}
        detailOf={(l) => `${listTypeLabel(l.listType)} · ${l.entries} entries`}
        placeholder="Any number list…"
      />
      {canNewList && (
        <Button small variant="ghost" icon="plus" title="New list" aria-label="New list" onClick={() => void newList()} />
      )}
      {form.error(path) && <small className="error-text">{form.error(path)}</small>}
    </span>
  );
}

/** The networks as a summary line with a button that opens the tree (team trial round 5). */
function NetworksCell({ form }: { form: FormApi<TranslationRuleInput> }) {
  const { tree } = useDestinationTree();
  const codes = (form.get("mccmncs") as string[]) ?? [];
  return (
    <span className="mg-cell mg-nets">
      <Button
        small
        icon="globe"
        onClick={async () => {
          const next = await ask<string[]>((done) => <RuleCodesDialog initial={codes} done={done} />);
          if (next) form.set("mccmncs", next);
        }}
      >
        {codes.length ? "Change…" : "Pick networks…"}
      </Button>
      <span className={codes.length ? "small" : "muted small"} title={codes.join(", ")}>
        {codes.length ? `${codes.length} · ${codesText(tree, codes, 2)}` : "Any network"}
      </span>
      {codes.length > 0 && (
        <button type="button" className="link small" onClick={() => form.set("mccmncs", [])}>
          Clear
        </button>
      )}
      {form.error("mccmncs") && <small className="error-text">{form.error("mccmncs")}</small>}
    </span>
  );
}

/**
 * Match conditions as one compact grid (team trial round 5): Sender ID, Receiver ID, Message text and MCCMNC rows;
 * columns Pattern (regex) and Number list. Every condition keeps its Match / Not Match switch. Sender ID and receiver
 * values are rows of their own, each with its match and case (team trial round 8); the length columns were removed.
 */
function MatchGrid({ form }: { form: FormApi<TranslationRuleInput> }) {
  const rows = (path: "senderValues" | "receiverValues", noun: string) => (
    <>
      <span className="mg-label mg-sub">values</span>
      <span className="mg-values">
        <ValueRows
          value={(form.get(path) as ValueMatch[] | undefined) ?? []}
          onChange={(v) => form.set(path, v)}
          noun={noun}
          showCase={path === "senderValues"}
        />
        {form.error(path) && <small className="error-text">{form.error(path)}</small>}
      </span>
    </>
  );
  return (
    <div className="match-grid">
      <span className="mg-head" />
      <span className="mg-head">Pattern (regex)</span>
      <span className="mg-head" />
      <span className="mg-head">Number list / networks</span>
      <span className="mg-head" />

      <span className="mg-label">
        Sender ID
        <MatchCase form={form} />
      </span>
      <BareText form={form} path="senderPattern" placeholder="^[A-Z]+$" label="Sender ID pattern" />
      <Negate form={form} path="senderPatternNegate" />
      <BareList form={form} path="senderListId" label="Sender ID list" />
      <Negate form={form} path="senderListNegate" />
      {rows("senderValues", "Sender ID")}

      <span className="mg-label">Receiver ID</span>
      <BareText form={form} path="receiverPattern" placeholder="^00" label="Receiver ID pattern" />
      <Negate form={form} path="receiverPatternNegate" />
      <BareList form={form} path="receiverListId" label="Receiver ID list" />
      <Negate form={form} path="receiverListNegate" />
      {rows("receiverValues", "Receiver")}

      <span className="mg-label">Message text</span>
      <span className="mg-span3">
        <BareText form={form} path="contentPattern" placeholder="bit\.ly" label="Message text pattern" />
      </span>
      <Negate form={form} path="contentPatternNegate" />

      <span className="mg-label">MCCMNC</span>
      <BareText form={form} path="mccmncPattern" placeholder="^415 or ^(415|420)" label="MCCMNC pattern" />
      <span className="muted small mg-or">or</span>
      <NetworksCell form={form} />
      <Negate form={form} path="mccmncNegate" />
    </div>
  );
}

type Side = "customer" | "vendor";
type TargetType = TranslationTargetInput["type"];

/** Applies To (§13.2): trunks, enterprises, categories or all trunks, per side. */
/**
 * Number format for the content (team trial round 6): a digit pattern (# = one digit) applied to every number of at
 * least N digits, with a live preview. Numbers of any length work: a longer one repeats the last group.
 */
function NumberFormatField({
  pattern,
  minDigits,
  error,
  onChange,
}: {
  pattern: string;
  minDigits: number | null;
  error?: string;
  onChange: (pattern: string, minDigits: number | null) => void;
}) {
  const [sample, setSample] = useState("Your number is 210271019");
  const PRESETS = ["### ### ###", "###-###-####", "(###) ###-####", "## ## ## ##"];
  return (
    <FormField label="Format numbers" wide error={error} hint="# = one digit">
      <div className="numfmt">
        <input
          className="input"
          aria-label="Number pattern"
          placeholder="Off · e.g. ### ### ###"
          maxLength={40}
          value={pattern}
          onChange={(e) => onChange(e.target.value, minDigits)}
        />
        <div className="numfmt-presets" role="group" aria-label="Common patterns">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={pattern === p ? "on" : undefined}
              onClick={() => onChange(pattern === p ? "" : p, minDigits)}
            >
              {p}
            </button>
          ))}
        </div>
        <label className="numfmt-min">
          From
          <input
            className="input num"
            type="number"
            min={2}
            max={20}
            aria-label="Shortest number to format"
            value={minDigits ?? 6}
            disabled={!pattern}
            onChange={(e) => onChange(pattern, e.target.value ? Number(e.target.value) : null)}
          />
          digits
        </label>
        {pattern && (
          <div className="numfmt-preview">
            <input
              className="input"
              aria-label="Sample text"
              value={sample}
              onChange={(e) => setSample(e.target.value)}
            />
            <span aria-hidden="true">→</span>
            <strong className="num">{formatNumbers(sample, pattern, minDigits)}</strong>
          </div>
        )}
      </div>
    </FormField>
  );
}

function TargetsEditor({
  value,
  direction,
  labels,
  onChange,
}: {
  value: TranslationTargetInput[];
  labels: Map<string, string>;
  direction: "ingress" | "egress" | null;
  onChange: (next: TranslationTargetInput[]) => void;
}) {
  // Team trial round 6: ingress shows customer trunks only, egress vendor trunks only; implied by the trunk can mix
  // both. Switching the type drops targets of the other side.
  const fixed: Side | null = direction === "ingress" ? "customer" : direction === "egress" ? "vendor" : null;
  const [picked0, setSide] = useState<Side>(value[0]?.trunkKind ?? "customer");
  const side = fixed ?? picked0;
  useEffect(() => {
    if (fixed && value.some((t) => t.trunkKind !== fixed)) onChange(value.filter((t) => t.trunkKind === fixed));
  }, [fixed]); // eslint-disable-line react-hooks/exhaustive-deps
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
          {(fixed ? [fixed] : (["customer", "vendor"] as const)).map((s) => (
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
          : `Applies to ${value.map(label).join(", ")}.`}
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

/** Words or phrases to replace in the content, as typed; an empty replacement removes them (team trial round 1). */
function ContentWordsEditor({
  value,
  onChange,
}: {
  value: ContentWordRule[];
  onChange: (v: ContentWordRule[]) => void;
}) {
  const patch = (i: number, p: Partial<ContentWordRule>) =>
    onChange(value.map((w, j) => (j === i ? { ...w, ...p } : w)));
  return (
    <div className="dlr-map">
      {value.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>Find word or phrase</th>
              <th />
              <th>Replace with (empty = remove)</th>
              <th>Not part of a word</th>
              <th>Case sensitive</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {value.map((w, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={w.find}
                    maxLength={200}
                    placeholder="e.g. free"
                    aria-label="Find"
                    onChange={(e) => patch(i, { find: e.target.value })}
                  />
                </td>
                <td className="muted">→</td>
                <td>
                  <input
                    value={w.replace}
                    maxLength={500}
                    placeholder="(remove)"
                    aria-label="Replace with"
                    onChange={(e) => patch(i, { replace: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label="Not part of a word"
                    checked={w.wholeWord !== false}
                    onChange={(e) => patch(i, { wholeWord: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label="Case sensitive"
                    checked={w.matchCase !== false}
                    onChange={(e) => patch(i, { matchCase: e.target.checked })}
                  />
                </td>
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
        onClick={() => onChange([...value, { find: "", replace: "", wholeWord: true, matchCase: true }])}
      >
        Add word
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- editor

/**
 * Add, edit, or Clone (team trial round 8, as route rules): `from` opens a new rule filled from that one, named
 * "… (copy)" and inactive until saved and switched on.
 */
function RuleEditor({
  detail,
  from,
  done,
}: {
  detail: TranslationRuleDetail | null;
  from?: TranslationRuleDetail;
  done: (id: number | null) => void;
}) {
  const form = useForm<TranslationRuleInput>(
    detail
      ? inputFromDetail(detail)
      : from
        ? // A clone keeps the rule's status: an active rule's copy is active too (team trial round 12).
          { ...inputFromDetail(from), name: `${from.name} (copy)`.slice(0, 100) }
        : blankRule(),
  );
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
      title={
        detail
          ? `Edit translation rule · ${detail.name}`
          : from
            ? `Clone translation rule · ${from.name}`
            : "Add translation rule"
      }
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
          {/* One line with Type, Status and Action; Is Continue, Start and Stop below (team trial round 8). */}
          <TextField form={form} path="name" label="Name" required maxLength={100} nullable={false} />
          <SelectField
            form={form}
            path="direction"
            label="Type"
            placeholder="Implied by the trunk"
            options={[
              { value: "ingress", label: "Ingress" },
              { value: "egress", label: "Egress" },
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
          <FormField label="Is Continue" hint="Apply further rules after this one">
            <label className="mini-switch">
              <input
                type="checkbox"
                checked={v.continueAfter}
                onChange={(e) => form.set("continueAfter", e.target.checked)}
              />
              <span className="mini-switch-track" aria-hidden="true" />
              <span className="mini-switch-text">{v.continueAfter ? "YES · next rules" : "STOP"}</span>
            </label>
          </FormField>
          <FormField label="Start" hint="Empty = now">
            <DateTimeInput
              value={v.startsAt ? v.startsAt.slice(0, 16) : ""}
              onChange={(e) =>
                form.set("startsAt", e.target.value ? new Date(`${e.target.value}Z`).toISOString() : null)
              }
            />
          </FormField>
          <FormField label="Stop" error={form.error("stopsAt")} hint="Empty = no end (UTC)">
            <DateTimeInput
              value={v.stopsAt ? v.stopsAt.slice(0, 16) : ""}
              onChange={(e) =>
                form.set("stopsAt", e.target.value ? new Date(`${e.target.value}Z`).toISOString() : null)
              }
            />
          </FormField>
        </Section>

        <Section title="Applies to" columns={1}>
          <FormField label="Targets" wide error={form.error("targets")}>
            <TargetsEditor
              value={v.targets}
              labels={labels}
              direction={v.direction}
              onChange={(t) => form.set("targets", t)}
            />
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
          />
        </Section>

        <Section title="Match conditions">
          {/* Compact grid (team trial round 5): a row per field, the pattern and the list each with Match / Not Match,
              the lengths last; the networks open in a dialog instead of a tree on the page. */}
          <MatchGrid form={form} />
        </Section>

        {!blocks && (
          <>
            <Section title="Sender and receiver conversion" columns={3}>
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
                  hint="$1..$9 = groups; empty removes the match"
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
                  hint="$1..$9 = groups; empty removes the match"
                />
              ) : (
                <div />
              )}
            </Section>
            <Section title="SMPP field overrides" columns={3}>
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
            <Section title="DLR Status & Error Code Convert" columns={1}>
              <FormField label="Conversions" wide error={form.error("dlrMap")}>
                <DlrMapEditor value={v.dlrMap} onChange={(m) => form.set("dlrMap", m)} />
              </FormField>
            </Section>
            <Section title="Content rewrite" columns={4}>
              <FormField
                label="Replace or remove words"
                wide
                error={form.error("contentWords")}
              >
                <ContentWordsEditor value={v.contentWords ?? []} onChange={(w) => form.set("contentWords", w)} />
              </FormField>
              <NumberFormatField
                pattern={v.contentNumberFormat ?? ""}
                minDigits={v.contentNumberMinDigits ?? null}
                error={form.error("contentNumberFormat")}
                onChange={(pattern, minDigits) => {
                  form.set("contentNumberFormat", pattern || null);
                  form.set("contentNumberMinDigits", minDigits);
                }}
              />
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
                hint="$1..$9 = groups, $0 = whole match"
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

/** Loads the rule (the detail panel's query) before a dialog opened from the list's record actions. */
function WithRule({
  id,
  done,
  render,
}: {
  id: number;
  done: (id: number | null) => void;
  render: (d: TranslationRuleDetail) => ReactNode;
}) {
  const q = useTranslationRule(id);
  useEffect(() => {
    if (!q.isError) return;
    toast({ tone: "error", message: problemText(q.error) });
    done(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.isError]);
  return q.data ? <>{render(q.data)}</> : null;
}

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
      <p className="muted">An independent copy for one trunk only.</p>
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
              onClick={() =>
                void ask<number>((done) => <RuleEditor detail={null} from={d} done={done} />).then(
                  (id) => id && select(id),
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

/** Destinations by name, the first two then "+N"; pointing at the cell lists them all (team trial round 1). */
function MccmncCell({ row }: { row: TranslationRuleRow }) {
  const names = row.mccmncNames.length ? row.mccmncNames : row.mccmncs;
  const rest = row.mccmncs.length - 2;
  return (
    <HoverList items={names} more={Math.max(0, row.mccmncs.length - names.length)}>
      <span className="rr-label num">
        <span className="rr-main">{names.slice(0, 2).join(", ")}</span>
        {rest > 0 && <span className="muted">+{rest}</span>}
      </span>
    </HoverList>
  );
}

/** Takes a rule off the trunks and enterprises it is assigned to, keeping category and all-trunk targets (round 6). */
function unassignRule(id: number): Unassign {
  const detail = () => unwrap(api.GET("/translation-rules/{id}", { params: { path: { id } } }));
  const direct = (t: { type: string }) => t.type === "trunk" || t.type === "enterprise";
  return {
    load: async () => (await detail()).targets.filter(direct).map((t) => t.label),
    run: async () => {
      const d = await detail();
      const input = toSave({ ...inputFromDetail(d), targets: inputFromDetail(d).targets.filter((t) => !direct(t)) });
      return unwrap(api.PUT("/translation-rules/{id}", { params: { path: { id } }, body: input }));
    },
  };
}

export function TranslationRulesPage() {
  const [selectId, setSelectId] = useState<number | null>(null);
  const deleteOne = useDeleteRecord();
  const notifySaved = useNotifySaved();
  const { data: me } = useMe();
  const restore = useRestore("translation_rule");
  const isAdmin = isAdminUser(me?.permissions);
  return (
    <ListScreen<TranslationRuleRow>
      list="translation_rules"
      listExport
      bulkDelete={{ noun: "translation rule", restore: true }}
      page={page}
      selectId={selectId}
      historyScope={{ entityTypes: ["translation_rule"] }}
      rowActions={(r) => [
        // The same Edit / Clone / Duplicate to trunk as the Rule tab of the detail panel (§13.2).
        {
          label: "Edit",
          icon: "file",
          main: true,
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted rule" : undefined,
          onSelect: () =>
            void ask<number>((done) => (
              <WithRule id={r.id} done={done} render={(d) => <RuleEditor detail={d} done={done} />} />
            )).then((id) => id && setSelectId(id)),
        },
        {
          label: "Clone",
          icon: "copy",
          disabled: !!r.archivedAt,
          hint: r.archivedAt ? "Deleted rule" : undefined,
          // Opens a new rule filled from this one (team trial round 8, as route rules).
          onSelect: () =>
            void ask<number>((done) => (
              <WithRule id={r.id} done={done} render={(d) => <RuleEditor detail={null} from={d} done={done} />} />
            )).then((id) => id && setSelectId(id)),
        },
        {
          label: "Duplicate to trunk…",
          icon: "copy",
          disabled: !!r.archivedAt || r.usedBy === 0,
          hint: r.archivedAt ? "Deleted rule" : r.usedBy === 0 ? "The rule runs on no trunk" : undefined,
          onSelect: () =>
            void ask<number>((done) => (
              <WithRule id={r.id} done={done} render={(d) => <DuplicateDialog rule={d} done={done} />} />
            )).then((id) => id && setSelectId(id)),
        },
        { label: "Show details", icon: "eye", onSelect: () => setSelectId(r.id) },
        "separator",
        r.archivedAt
          ? {
              label: "Restore",
              icon: "undo",
              disabled: !isAdmin || restore.isPending,
              hint: isAdmin ? undefined : "Deleted. An administrator can restore it.",
              onSelect: () =>
                restore.mutate(r.id, {
                  onSuccess: (res) => res.change && notifySaved(res.change, `Restored rule ${r.name}`),
                  onError: (e) => toast({ tone: "error", message: problemText(e) }),
                }),
            }
          : {
              label: "Delete",
              icon: "trash",
              danger: true,
              onSelect: () => void deleteOne("translation_rule", r.id, `rule ${r.name}`, unassignRule(r.id)),
            },
      ]}
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
        // The pattern and the value rows (team trial round 8).
        senderPattern: { width: 160, render: (r) => matchCell(r.senderPattern, r.senderValues, true) },
        receiverPattern: { width: 140, render: (r) => matchCell(r.receiverPattern, r.receiverValues, false) },
        mccmncs: {
          width: 220,
          render: (r) => (r.mccmncs.length ? <MccmncCell row={r} /> : muted("—")),
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
            r.appliesTo === "Not assigned" ? (
              <span className="tone-warning">Not assigned</span>
            ) : (
              <HoverList items={r.appliesToNames} more={r.appliesToCount - r.appliesToNames.length}>
                <span className="rr-label">
                  <span className="rr-main">{r.appliesTo}</span>
                </span>
              </HoverList>
            ),
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
              <TranslationTest run={(m) => testTranslationRule(r.id, m)} />
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

function matchCell(pattern: string | null, rows: ValueMatch[], showCase: boolean) {
  if (!pattern && !rows.length) return <span className="muted">—</span>;
  const text = rows.length ? valuesSummary(rows, showCase) : "";
  return (
    <span title={[pattern, text].filter(Boolean).join(" · ")}>
      {pattern && <code>{pattern}</code>}
      {pattern && text && " · "}
      {text}
    </span>
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
