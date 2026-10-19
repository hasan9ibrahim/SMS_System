// Multi-field filter builder (§13.25): as many "field + operator + value" conditions as
// needed, on any field of the list (hidden ones too), combined with AND or with OR groups.
import { useState } from "react";
import type {
  FieldDescriptor,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  FilterValue,
  ListFields,
} from "@sms/contract";
import { Button, IconButton, Modal } from "../ui/primitives";
import { OP_LABEL, isChoice, isNumeric, isTime } from "./filterModel";

const NO_VALUE: FilterOperator[] = ["empty", "not_empty"];
const LIST_OPS: FilterOperator[] = ["in", "not_in"];

function newCondition(fields: FieldDescriptor[]): FilterCondition {
  const f = fields[0]!;
  return { field: f.field, op: f.defaultOperator ?? f.operators[0]! };
}

/** Problems that would make the server reject the tree, in plain words. */
export function treeProblems(group: FilterGroup, fields: ListFields): string[] {
  const byName = new Map(fields.fields.map((f) => [f.field, f]));
  const out: string[] = [];
  const walk = (g: FilterGroup) => {
    for (const node of g.conditions) {
      if ("logic" in node) {
        walk(node);
        continue;
      }
      const f = byName.get(node.field);
      const name = f?.label ?? node.field;
      if (NO_VALUE.includes(node.op)) continue;
      if (node.op === "between") {
        if (node.values?.length !== 2 || node.values.some((v) => v === "" || v === undefined))
          out.push(`${name}: enter both ends of the range`);
      } else if (LIST_OPS.includes(node.op)) {
        if (!node.values?.length) out.push(`${name}: choose at least one value`);
      } else if (node.value === undefined || node.value === "") out.push(`${name}: enter a value`);
      const vals = node.values ?? (node.value === undefined ? [] : [node.value]);
      if (f && isNumeric(f) && vals.some((v) => typeof v !== "number")) out.push(`${name}: values must be numbers`);
      if (node.op === "regex" && typeof node.value === "string") {
        try {
          new RegExp(node.value, "i");
        } catch {
          out.push(`${name}: invalid regular expression`);
        }
      }
    }
  };
  walk(group);
  return out;
}

function toValue(f: FieldDescriptor, raw: string): FilterValue {
  if (isNumeric(f)) {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
  }
  if (isTime(f)) return raw ? new Date(`${raw}${raw.length === 16 ? ":00" : ""}Z`).toISOString() : "";
  return raw;
}

const fromValue = (f: FieldDescriptor, v: FilterValue | undefined) =>
  v === undefined ? "" : isTime(f) && typeof v === "string" ? v.slice(0, 16) : String(v);

function ValueEditor({
  field,
  cond,
  onChange,
}: {
  field: FieldDescriptor;
  cond: FilterCondition;
  onChange: (c: FilterCondition) => void;
}) {
  const type = isNumeric(field) ? "number" : isTime(field) ? "datetime-local" : "text";
  if (NO_VALUE.includes(cond.op)) return <span className="muted small">no value</span>;
  if (field.type === "boolean") {
    return (
      <select
        value={String(cond.value ?? "")}
        onChange={(e) => onChange({ ...cond, value: e.target.value === "true" })}
        aria-label="Value"
      >
        <option value="" disabled>
          Choose…
        </option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (isChoice(field) && LIST_OPS.includes(cond.op)) {
    const chosen = new Set((cond.values ?? []).map(String));
    return (
      <div className="fb-choices">
        {(field.enumValues ?? []).map((o) => (
          <label key={o.value} className={`fb-choice${chosen.has(o.value) ? " on" : ""}`}>
            <input
              type="checkbox"
              checked={chosen.has(o.value)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(o.value);
                else next.delete(o.value);
                onChange({ ...cond, values: [...next] });
              }}
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  }
  if (isChoice(field)) {
    return (
      <select
        value={String(cond.value ?? "")}
        onChange={(e) => onChange({ ...cond, value: e.target.value })}
        aria-label="Value"
      >
        <option value="" disabled>
          Choose…
        </option>
        {(field.enumValues ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (cond.op === "between") {
    const [a, b] = cond.values ?? [];
    return (
      <span className="fb-range">
        <input
          type={type}
          value={fromValue(field, a)}
          aria-label="From"
          onChange={(e) => onChange({ ...cond, values: [toValue(field, e.target.value), b ?? ""] })}
        />
        <span className="muted">to</span>
        <input
          type={type}
          value={fromValue(field, b)}
          aria-label="To"
          onChange={(e) => onChange({ ...cond, values: [a ?? "", toValue(field, e.target.value)] })}
        />
      </span>
    );
  }
  if (LIST_OPS.includes(cond.op)) {
    return (
      <input
        type="text"
        placeholder="Values, separated by commas"
        value={(cond.values ?? []).join(", ")}
        aria-label="Values"
        onChange={(e) =>
          onChange({
            ...cond,
            values: e.target.value
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
              .map((x) => toValue(field, x)),
          })
        }
      />
    );
  }
  return (
    <input
      type={type}
      value={fromValue(field, cond.value)}
      placeholder={
        cond.op === "like" || cond.op === "not_like"
          ? "% any text, _ one character"
          : cond.op === "regex"
            ? "regular expression"
            : "value"
      }
      aria-label="Value"
      onChange={(e) => onChange({ ...cond, value: toValue(field, e.target.value) })}
    />
  );
}

function ConditionRow({
  fields,
  cond,
  onChange,
  onRemove,
}: {
  fields: FieldDescriptor[];
  cond: FilterCondition;
  onChange: (c: FilterCondition) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.field === cond.field) ?? fields[0]!;
  return (
    <div className="fb-row">
      <select
        value={field.field}
        aria-label="Field"
        onChange={(e) => {
          const f = fields.find((x) => x.field === e.target.value)!;
          onChange({ field: f.field, op: f.defaultOperator ?? f.operators[0]! });
        }}
      >
        {fields.map((f) => (
          <option key={f.field} value={f.field}>
            {f.label}
            {f.hidden ? " (hidden column)" : ""}
          </option>
        ))}
      </select>
      <select
        value={cond.op}
        aria-label="Operator"
        onChange={(e) => {
          const op = e.target.value as FilterOperator;
          const { value, values, ...rest } = cond;
          const keepSingle = !NO_VALUE.includes(op) && op !== "between" && !LIST_OPS.includes(op);
          onChange({
            ...rest,
            op,
            ...(keepSingle && value !== undefined ? { value } : {}),
            ...(LIST_OPS.includes(op) && values ? { values } : {}),
          });
        }}
      >
        {field.operators.map((op) => (
          <option key={op} value={op}>
            {OP_LABEL[op]}
          </option>
        ))}
      </select>
      <ValueEditor field={field} cond={cond} onChange={onChange} />
      <IconButton icon="x" label="Remove condition" onClick={onRemove} />
    </div>
  );
}

function GroupEditor({
  fields,
  group,
  depth,
  onChange,
  onRemove,
}: {
  fields: FieldDescriptor[];
  group: FilterGroup;
  depth: number;
  onChange: (g: FilterGroup) => void;
  onRemove?: () => void;
}) {
  const set = (i: number, node: FilterGroup["conditions"][number] | null) => {
    const conditions = [...group.conditions];
    if (node) conditions[i] = node;
    else conditions.splice(i, 1);
    onChange({ ...group, conditions });
  };
  return (
    <div className={`fb-group depth-${depth}`}>
      <div className="fb-group-head">
        <span>Match</span>
        <div className="segmented" role="radiogroup" aria-label="Combine with">
          {(["and", "or"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={group.logic === l}
              className={group.logic === l ? "on" : ""}
              onClick={() => onChange({ ...group, logic: l })}
            >
              {l === "and" ? "all (AND)" : "any (OR)"}
            </button>
          ))}
        </div>
        <span>of these:</span>
        <span className="fb-spacer" />
        {onRemove && <IconButton icon="trash" label="Remove group" onClick={onRemove} />}
      </div>
      {group.conditions.map((node, i) =>
        "logic" in node ? (
          <GroupEditor
            key={i}
            fields={fields}
            group={node}
            depth={depth + 1}
            onChange={(g) => set(i, g)}
            onRemove={() => set(i, null)}
          />
        ) : (
          <ConditionRow key={i} fields={fields} cond={node} onChange={(c) => set(i, c)} onRemove={() => set(i, null)} />
        ),
      )}
      <div className="fb-add">
        <Button
          small
          icon="plus"
          onClick={() => onChange({ ...group, conditions: [...group.conditions, newCondition(fields)] })}
        >
          Condition
        </Button>
        {depth < 3 && (
          <Button
            small
            icon="plus"
            onClick={() =>
              onChange({
                ...group,
                conditions: [
                  ...group.conditions,
                  { logic: group.logic === "and" ? "or" : "and", conditions: [newCondition(fields)] },
                ],
              })
            }
          >
            Group
          </Button>
        )}
      </div>
    </div>
  );
}

export function FilterBuilder({
  fields,
  value,
  onApply,
  onClose,
}: {
  fields: ListFields;
  value: FilterGroup | null;
  onApply: (g: FilterGroup | null) => void;
  onClose: () => void;
}) {
  // Fields without operators (e.g. figures from the EDR store) can't be filtered.
  const filterable = fields.fields.filter((f) => f.operators.length > 0);
  const [draft, setDraft] = useState<FilterGroup>(value ?? { logic: "and", conditions: [newCondition(filterable)] });
  const [tried, setTried] = useState(false);
  const problems = treeProblems(draft, fields);
  return (
    <Modal
      title="Filter"
      width={760}
      onClose={onClose}
      footer={
        <>
          <Button
            onClick={() => {
              onApply(null);
              onClose();
            }}
          >
            Clear builder
          </Button>
          <span className="fb-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              setTried(true);
              if (problems.length) return;
              onApply(draft.conditions.length ? draft : null);
              onClose();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <p className="muted small fb-help">
        Text is case-insensitive. In "matches", <code>%</code> stands for any text and <code>_</code> for one character:{" "}
        <code>re%</code> starts with re, <code>%re</code> ends with re. These conditions combine with the filters under
        the column headers.
      </p>
      <GroupEditor fields={filterable} group={draft} depth={0} onChange={setDraft} />
      {tried && problems.length > 0 && (
        <ul className="fb-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
