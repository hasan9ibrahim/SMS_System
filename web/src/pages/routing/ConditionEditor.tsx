// Editor for one condition of a route rule (§6.3 General Information, §13.8 TPS, §13.9
// revenue, §13.24 HLR action). Opened from a condition chip or "+ Add condition"; Save
// writes the whole rule once, so every edit is one undoable change (§13.10).
import { useState, type ReactNode } from "react";
import type {
  CompareOp,
  HlrAction,
  HlrPolicyRow,
  MatchMode,
  RevenueCondition,
  RouteRuleDetail,
  RouteRuleInput,
  TpsCondition,
} from "@sms/contract";
import { useReference } from "../../api/records";
import { ListLookup } from "../../records/parts";
import { Button, Modal } from "../../ui/primitives";
import {
  buildPattern,
  CONDITION_LABELS,
  parsePattern,
  PATTERN_KINDS,
  type ConditionKey,
  type PatternKind,
} from "./ruleModel";
import { Icon } from "../../ui/Icon";
import { DestinationPick, TrunkPick, type Picked } from "./pickers";

const OPS: { value: CompareOp; label: string }[] = [
  { value: ">", label: ">" },
  { value: ">=", label: "≥" },
  { value: "=", label: "=" },
  { value: "<=", label: "≤" },
  { value: "<", label: "<" },
  { value: "between", label: "between" },
];

const SCOPES = [
  { value: "customer_trunk", label: "Customer trunk" },
  { value: "customer_enterprise", label: "Customer (all its trunks)" },
  { value: "destination", label: "Destination" },
  { value: "sender_id", label: "Sender ID" },
  { value: "rule", label: "This rule" },
] as const;

function regexError(p: string): string | null {
  if (!p) return null;
  try {
    new RegExp(p);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Values instead of a regex (team trial round 1): type a Sender ID, receiver or phrase and press + (or
 * Enter); "Regex" keeps the free pattern for anything else.
 */
function PatternBuilder({
  field,
  kinds,
  kind,
  setKind,
  values,
  setValues,
  pattern,
  setPattern,
}: {
  field: ConditionKey;
  kinds: PatternKind[];
  kind: PatternKind;
  setKind: (k: PatternKind) => void;
  values: string[];
  setValues: (v: string[]) => void;
  pattern: string;
  setPattern: (p: string) => void;
}) {
  const [draft, setDraft] = useState("");
  // Sender IDs and numbers can be pasted as a list; content phrases keep their commas.
  const add = () => {
    const parts = (field === "content" ? draft.split(/\n/) : draft.split(/[\n,;]/)).map((x) => x.trim());
    const next = [...values, ...parts.filter((x) => x && !values.includes(x))];
    if (next.length !== values.length) setValues(next);
    setDraft("");
  };
  const noun = field === "content" ? "word or phrase" : field === "sender" ? "Sender ID" : "receiver number";
  return (
    <div className="pattern-builder">
      <div className="segmented small" role="radiogroup" aria-label={`${CONDITION_LABELS[field]} match`}>
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? "on" : ""}
            onClick={() => setKind(k)}
          >
            {k === "regex" ? "Regex" : PATTERN_KINDS[k][0]!.toUpperCase() + PATTERN_KINDS[k].slice(1)}
          </button>
        ))}
      </div>
      {kind === "regex" ? (
        <label className="field">
          <span>{CONDITION_LABELS[field]} pattern (regular expression)</span>
          <input
            autoFocus
            value={pattern}
            maxLength={200}
            placeholder={field === "content" ? "e.g. code|otp" : "e.g. ^(TEST|DEMO)"}
            onChange={(e) => setPattern(e.target.value)}
          />
          {regexError(pattern) && <small className="error-text">{regexError(pattern)}</small>}
        </label>
      ) : (
        <>
          <div className="chips">
            {values.map((v) => (
              <span key={v} className="chip">
                {v}
                <button
                  type="button"
                  aria-label={`Remove ${v}`}
                  onClick={() => setValues(values.filter((x) => x !== v))}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
            {values.length === 0 && <span className="muted small">Nothing added yet.</span>}
          </div>
          <div className="pattern-add">
            <input
              autoFocus
              value={draft}
              maxLength={200}
              placeholder={`Type a ${noun} and press + or Enter`}
              aria-label={`Add a ${noun}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button small icon="plus" onClick={add} disabled={!draft.trim()} aria-label={`Add ${noun}`} />
          </div>
          <small className="muted">Upper and lower case match alike.</small>
        </>
      )}
    </div>
  );
}

function Mode({
  value,
  onChange,
  allowAll,
}: {
  value: MatchMode;
  onChange: (m: MatchMode) => void;
  allowAll?: boolean;
}) {
  const modes: { value: MatchMode; label: string }[] = [
    ...(allowAll ? [{ value: "all" as const, label: "Any" }] : []),
    { value: "inclusive", label: "In the list" },
    { value: "exclusive", label: "Not in the list" },
  ];
  return (
    <div className="segmented" role="radiogroup">
      {modes.map((m) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={value === m.value}
          className={value === m.value ? "on" : ""}
          onClick={() => onChange(m.value)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function Negate({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {[false, true].map((v) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? "on" : ""}
          onClick={() => onChange(v)}
        >
          {v ? "Not match" : "Match"}
        </button>
      ))}
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
  max,
  hint,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={value ?? ""}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={String(value)}
        onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)!.value)}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const toLocal = (iso: string) => iso.slice(0, 16);
const fromLocal = (v: string) => new Date(`${v}:00Z`).toISOString();

/** The form for one condition; `patch` is what Save writes. */
function useConditionForm(key: ConditionKey, rule: RouteRuleDetail): { form: ReactNode; patch: () => Patch } {
  const ref = useReference();
  const named = (ids: number[], list: { id: number; name: string }[]) =>
    ids.map((id) => ({ key: id, label: list.find((x) => x.id === id)?.name ?? `#${id}` }));
  const [mode, setMode] = useState<MatchMode>(
    key === "trunk" ? rule.customerTrunkMode : key === "category" ? rule.categoryMode : rule.mccmncMode,
  );
  const [trunks, setTrunks] = useState<Picked<number>[]>(named(rule.customerTrunkIds, rule.labels.customerTrunks));
  const [categories, setCategories] = useState<number[]>(rule.categoryIds);
  const [codes, setCodes] = useState<string[]>(rule.mccmncs);
  const [mccPattern, setMccPattern] = useState(rule.mccmncPattern ?? "");
  const pat = key === "sender" || key === "receiver" || key === "content" ? key : "sender";
  const [pattern, setPattern] = useState(rule[`${pat}Pattern`] ?? "");
  // A stored pattern opens as its value list when it was built from one (team trial round 1).
  const kinds: PatternKind[] = key === "content" ? ["contains", "starts", "regex"] : ["is", "starts", "regex"];
  const initial = pattern ? parsePattern(pattern) : { kind: kinds[0]!, values: [] as string[] };
  const [patternKind, setPatternKind] = useState<PatternKind>(
    kinds.includes(initial.kind) ? initial.kind : pattern ? "regex" : kinds[0]!,
  );
  const [patternValues, setPatternValues] = useState<string[]>(kinds.includes(initial.kind) ? initial.values : []);
  const [negate, setNegate] = useState(rule[`${pat}PatternNegate`]);
  const [listId, setListId] = useState<number | null>(
    key === "sender" ? rule.senderListId : key === "receiver" ? rule.receiverListId : null,
  );
  const [tps, setTps] = useState<TpsCondition>(
    rule.tps ?? { op: ">", value: 50, scope: "customer_trunk", windowS: 5, releasePct: 10, holdS: 30 },
  );
  const [revenue, setRevenue] = useState<RevenueCondition>(
    rule.revenue ?? { type: "per_message", op: ">=", value: 0.04 },
  );
  const [startsAt, setStartsAt] = useState(toLocal(rule.startsAt));
  const [stopsAt, setStopsAt] = useState(toLocal(rule.stopsAt));
  const [ported, setPorted] = useState<boolean>(rule.hlrPorted ?? true);
  // policyId 0 = not chosen yet
  const [hlr, setHlr] = useState<HlrAction>(rule.hlrAction ?? { policyId: 0, customerTrunkIds: [] });

  const between = (op: CompareOp) => op === "between";
  switch (key) {
    case "trunk":
      return {
        form: (
          <>
            <Mode value={mode === "all" ? "inclusive" : mode} onChange={setMode} />
            <TrunkPick kind="customer" value={trunks} onChange={setTrunks} />
          </>
        ),
        patch: () =>
          trunks.length
            ? { customerTrunkMode: mode === "all" ? "inclusive" : mode, customerTrunkIds: trunks.map((t) => t.key) }
            : "Choose at least one trunk.",
      };
    case "category":
      return {
        form: (
          <>
            <Mode value={mode === "all" ? "inclusive" : mode} onChange={setMode} />
            <div className="check-grid">
              {ref.data?.productCategories.map((c) => (
                <label key={c.id} className="toggle-inline">
                  <input
                    type="checkbox"
                    checked={categories.includes(c.id)}
                    onChange={(e) =>
                      setCategories(e.target.checked ? [...categories, c.id] : categories.filter((x) => x !== c.id))
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </>
        ),
        patch: () =>
          categories.length
            ? { categoryMode: mode === "all" ? "inclusive" : mode, categoryIds: categories }
            : "Choose at least one category.",
      };
    case "destination":
      return {
        form: (
          <>
            <Mode value={mode} onChange={setMode} allowAll />
            {mode !== "all" && <DestinationPick value={codes} onChange={setCodes} />}
            <label className="field">
              <span>MCCMNC pattern (regular expression)</span>
              <input
                value={mccPattern}
                maxLength={200}
                placeholder="e.g. ^50(5|6)"
                onChange={(e) => setMccPattern(e.target.value)}
              />
              {regexError(mccPattern) && <small className="error-text">{regexError(mccPattern)}</small>}
            </label>
          </>
        ),
        patch: () => {
          if (regexError(mccPattern)) return "Fix the pattern.";
          if (mode !== "all" && !codes.length) return "Choose at least one destination.";
          if (mode === "all" && !mccPattern.trim()) return "Choose destinations or enter a pattern.";
          return { mccmncMode: mode, mccmncs: mode === "all" ? [] : codes, mccmncPattern: mccPattern.trim() || null };
        },
      };
    case "sender":
    case "receiver":
    case "content": {
      const lists = ref.data?.numberLists ?? [];
      return {
        form: (
          <>
            <Negate value={negate} onChange={setNegate} />
            <PatternBuilder
              field={key}
              kinds={kinds}
              kind={patternKind}
              setKind={(k) => {
                // Switching to Regex keeps what the list stood for, so it can be fine-tuned.
                if (k === "regex" && patternKind !== "regex")
                  setPattern(buildPattern(patternKind, patternValues) ?? pattern);
                setPatternKind(k);
              }}
              values={patternValues}
              setValues={setPatternValues}
              pattern={pattern}
              setPattern={setPattern}
            />
            {key !== "content" && (
              <label className="field">
                <span>{key === "sender" ? "Sender ID list" : "Receiver ID list"}</span>
                <select
                  value={listId ?? ""}
                  onChange={(e) => setListId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">—</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        ),
        patch: () => {
          const built = patternKind === "regex" ? pattern.trim() || null : buildPattern(patternKind, patternValues);
          if (patternKind === "regex" && regexError(pattern)) return "Fix the pattern.";
          if (!built && !listId)
            return patternKind === "regex"
              ? "Enter a pattern or choose a list."
              : "Add at least one value or choose a list.";
          const p = { [`${key}Pattern`]: built, [`${key}PatternNegate`]: negate };
          return key === "content" ? p : { ...p, [`${key}ListId`]: listId };
        },
      };
    }
    case "tps":
      return {
        form: (
          <>
            <div className="fgrid cols-3">
              <Select
                label="Average over"
                value={tps.windowS ?? 5}
                options={[1, 5, 10, 60].map((s) => ({ value: s as 1 | 5 | 10 | 60, label: `${s} s` }))}
                onChange={(windowS) => setTps({ ...tps, windowS })}
              />
              <Select label="Operator" value={tps.op} options={OPS} onChange={(op) => setTps({ ...tps, op })} />
              <Select
                label="Measured on"
                value={tps.scope}
                options={SCOPES}
                onChange={(scope) => setTps({ ...tps, scope })}
              />
              <Num label="TPS" value={tps.value} onChange={(v) => setTps({ ...tps, value: v ?? 0 })} />
              {between(tps.op) && (
                <Num label="and TPS" value={tps.value2} onChange={(v) => setTps({ ...tps, value2: v })} />
              )}
              {tps.op === "=" && (
                <Num
                  label="Tolerance ±%"
                  value={tps.tolerancePct ?? 5}
                  max={50}
                  onChange={(v) => setTps({ ...tps, tolerancePct: v ?? 5 })}
                />
              )}
              <Num
                label="Release at −%"
                value={tps.releasePct}
                max={100}
                hint="Switch back only this far past the value"
                onChange={(v) => setTps({ ...tps, ...(v === null ? { releasePct: 0 } : { releasePct: v }) })}
              />
              <Num
                label="Hold (s)"
                value={tps.holdS}
                max={3600}
                hint="Stay past the value this long first"
                onChange={(v) => setTps({ ...tps, holdS: v ?? 0 })}
              />
            </div>
            <p className="muted small">
              The rule applies while live TPS meets the condition. Release and hold stop it flapping (§13.8).
            </p>
          </>
        ),
        patch: () =>
          between(tps.op) && (tps.value2 ?? -1) < tps.value ? "The upper TPS must be at least the lower." : { tps },
      };
    case "revenue":
      return {
        form: (
          <>
            <div className="fgrid cols-3">
              <Select
                label="Type"
                value={revenue.type}
                options={[
                  { value: "per_message", label: "Per message" },
                  { value: "accumulated", label: "Accumulated" },
                ]}
                onChange={(type) =>
                  setRevenue(
                    type === "accumulated"
                      ? { period: "today", scope: "customer_trunk", ...revenue, type }
                      : { type, op: revenue.op, value: revenue.value, value2: revenue.value2 ?? null },
                  )
                }
              />
              <Select
                label="Operator"
                value={revenue.op}
                options={OPS}
                onChange={(op) => setRevenue({ ...revenue, op })}
              />
              <Num
                label="Revenue (base currency)"
                value={revenue.value}
                step={0.001}
                onChange={(v) => setRevenue({ ...revenue, value: v ?? 0 })}
              />
              {between(revenue.op) && (
                <Num
                  label="and"
                  value={revenue.value2}
                  step={0.001}
                  onChange={(v) => setRevenue({ ...revenue, value2: v })}
                />
              )}
              {revenue.type === "accumulated" && (
                <>
                  <Select
                    label="Period"
                    value={revenue.period ?? "today"}
                    options={[
                      { value: "15m", label: "Last 15 min" },
                      { value: "60m", label: "Last 60 min" },
                      { value: "today", label: "Today" },
                      { value: "week", label: "This week" },
                      { value: "month", label: "This month" },
                      { value: "billing_cycle", label: "Billing cycle" },
                    ]}
                    onChange={(period) => setRevenue({ ...revenue, period })}
                  />
                  <Select
                    label="Measured on"
                    value={revenue.scope ?? "customer_trunk"}
                    options={SCOPES}
                    onChange={(scope) => setRevenue({ ...revenue, scope })}
                  />
                </>
              )}
              <Num
                label="And margin at least"
                value={revenue.minMargin}
                step={0.001}
                onChange={(v) => setRevenue({ ...revenue, minMargin: v })}
              />
              <Select
                label="Margin unit"
                value={revenue.minMarginUnit ?? "amount"}
                options={[
                  { value: "amount", label: "Amount" },
                  { value: "percent", label: "Percent" },
                ]}
                onChange={(minMarginUnit) => setRevenue({ ...revenue, minMarginUnit })}
              />
            </div>
            <p className="muted small">Revenue in the base currency, from the customer rate at send time (§13.9).</p>
          </>
        ),
        patch: () =>
          between(revenue.op) && (revenue.value2 ?? -1) < revenue.value
            ? "The upper value must be at least the lower."
            : { revenue },
      };
    case "time":
      return {
        form: (
          <div className="fgrid cols-2">
            <label className="field">
              <span>Start (UTC)</span>
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </label>
            <label className="field">
              <span>Stop (UTC)</span>
              <input type="datetime-local" value={stopsAt} onChange={(e) => setStopsAt(e.target.value)} />
            </label>
          </div>
        ),
        patch: () =>
          !startsAt || !stopsAt || stopsAt <= startsAt
            ? "Stop must be after start."
            : { startsAt: fromLocal(startsAt), stopsAt: fromLocal(stopsAt) },
      };
    case "hlrPorted":
      return {
        form: (
          <div className="segmented" role="radiogroup">
            {[true, false].map((v) => (
              <button
                key={String(v)}
                type="button"
                className={ported === v ? "on" : ""}
                aria-checked={ported === v}
                role="radio"
                onClick={() => setPorted(v)}
              >
                {v ? "Only ported numbers" : "Only not ported"}
              </button>
            ))}
          </div>
        ),
        patch: () => ({ hlrPorted: ported }),
      };
    case "hlrAction": {
      const own = rule.labels.customerTrunks.filter((t) => rule.customerTrunkIds.includes(t.id));
      return {
        form: (
          <>
            <div className="field">
              <span>HLR policy</span>
              <ListLookup<HlrPolicyRow>
                list="hlr_policies"
                value={hlr.policyId || null}
                onChange={(p) => setHlr({ ...hlr, policyId: p?.id ?? 0 })}
                labelOf={(p) => p.name}
                detailOf={(p) => `${p.destinations} destinations${p.hasCatchAll ? " + catch-all" : ""} · ${p.status}`}
                placeholder="Choose a policy…"
              />
              <small className="muted">Which providers are asked per destination: Switch › HLR › Policies.</small>
            </div>
            <div className="field">
              <span>For the rule's customer trunks</span>
              {own.length === 0 ? (
                <p className="muted small">The rule matches every trunk; the HLR lookup runs for all of them.</p>
              ) : (
                <div className="check-grid">
                  {own.map((t) => (
                    <label key={t.id} className="toggle-inline">
                      <input
                        type="checkbox"
                        checked={hlr.customerTrunkIds.includes(t.id)}
                        onChange={(e) =>
                          setHlr({
                            ...hlr,
                            customerTrunkIds: e.target.checked
                              ? [...hlr.customerTrunkIds, t.id]
                              : hlr.customerTrunkIds.filter((x) => x !== t.id),
                          })
                        }
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
              )}
              <small className="muted">None ticked = all of the rule's trunks (§13.24).</small>
            </div>
          </>
        ),
        patch: () => (hlr.policyId ? { hlrAction: hlr } : "Choose the HLR policy."),
      };
    }
    case "multipart":
      return {
        form: <p>Multipart messages (concatenated SMS) will not match this rule.</p>,
        patch: () => ({ denyMultipart: true }),
      };
  }
}

type Patch = Partial<RouteRuleInput> | string;

export function ConditionEditor({
  conditionKey,
  rule,
  saving,
  onSave,
  onClose,
}: {
  conditionKey: ConditionKey;
  rule: RouteRuleDetail;
  saving: boolean;
  onSave: (patch: Partial<RouteRuleInput>) => Promise<string | null>;
  onClose: () => void;
}) {
  const { form, patch } = useConditionForm(conditionKey, rule);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const p = patch();
    if (typeof p === "string") return setError(p);
    setError(await onSave(p));
  };
  return (
    <Modal
      title={`${CONDITION_LABELS[conditionKey]} condition · #${rule.id} ${rule.name}`}
      width={conditionKey === "tps" || conditionKey === "revenue" ? 600 : 540}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="cond-form">{form}</div>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
