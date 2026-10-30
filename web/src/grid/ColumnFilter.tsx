// Filter under a column header (§15.1): a text box for text and numbers (typed shorthand,
// see parseColumnFilter) or a dropdown with Select All for fixed values (§1). A filter in
// use turns accent-coloured.
import { useEffect, useRef, useState } from "react";
import type { FieldDescriptor, FilterCondition } from "@sms/contract";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/primitives";
import { filterPlaceholder, formatColumnFilter, isChoice, parseColumnFilter } from "./filterModel";

function ChoiceFilter({
  field,
  condition,
  onChange,
}: {
  field: FieldDescriptor;
  condition: FilterCondition | undefined;
  onChange: (c: FilterCondition | null) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const options =
    field.type === "boolean"
      ? [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ]
      : (field.enumValues ?? []);
  const selected = new Set(
    condition?.op === "in"
      ? (condition.values ?? []).map(String)
      : condition?.op === "eq"
        ? [String(condition.value)]
        : [],
  );
  const apply = (next: Set<string>) => {
    if (next.size === 0 || next.size === options.length) return onChange(null);
    if (field.type === "boolean") return onChange({ field: field.field, op: "eq", value: next.has("true") });
    onChange({ field: field.field, op: "in", values: [...next] });
  };
  // What the boxes show while the list is open (team trial round 12): a ticked box, "Select all" included, unticks on a
  // second click, down to none ticked. None ticked filters nothing (same as All) until a value is ticked.
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const ticked = draft ?? (selected.size === 0 ? new Set(options.map((o) => o.value)) : selected);
  const set = (next: Set<string>) => {
    setDraft(next);
    apply(next);
  };
  const close = () => {
    setOpen(false);
    setDraft(null);
  };
  const label =
    selected.size === 0
      ? "All"
      : selected.size === 1
        ? (options.find((o) => selected.has(o.value))?.label ?? "1")
        : `${selected.size} of ${options.length}`;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`gf-select${selected.size ? " in-use" : ""}`}
        aria-label={`Filter ${field.label}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span>{label}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      <Popover anchor={ref} open={open} onClose={close} className="choice-pop">
        <label className="choice-row strong">
          <input
            type="checkbox"
            checked={ticked.size === options.length}
            ref={(el) => {
              if (el) el.indeterminate = ticked.size > 0 && ticked.size < options.length;
            }}
            onChange={() => set(ticked.size === options.length ? new Set() : new Set(options.map((o) => o.value)))}
          />
          Select all
        </label>
        <div className="menu-sep" />
        {options.map((o) => (
          <label key={o.value} className="choice-row">
            <input
              type="checkbox"
              checked={ticked.has(o.value)}
              onChange={() => {
                const next = new Set(ticked);
                if (next.has(o.value)) next.delete(o.value);
                else next.add(o.value);
                set(next);
              }}
            />
            {o.label}
          </label>
        ))}
        <div className="muted small pad-x">
          {ticked.size ? `Selected ${ticked.size} of ${options.length}` : "None ticked: showing all"}
        </div>
      </Popover>
    </>
  );
}

function TextFilter({
  field,
  condition,
  onChange,
}: {
  field: FieldDescriptor;
  condition: FilterCondition | undefined;
  onChange: (c: FilterCondition | null) => void;
}) {
  const [text, setText] = useState(() => formatColumnFilter(field, condition));
  const [error, setError] = useState<string | null>(null);
  const applied = useRef(formatColumnFilter(field, condition));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Outside changes (chip removed, view applied, Clear all) update the box.
  useEffect(() => {
    const shown = formatColumnFilter(field, condition);
    if (shown !== applied.current) {
      applied.current = shown;
      setText(shown);
      setError(null);
    }
  }, [condition, field]);

  useEffect(() => {
    if (text === applied.current) return;
    const t = setTimeout(() => {
      const parsed = parseColumnFilter(field, text);
      if (parsed instanceof Error) return setError(parsed.message);
      setError(null);
      applied.current = text;
      onChangeRef.current(parsed);
    }, 350);
    return () => clearTimeout(t);
  }, [text, field]);

  return (
    <input
      className={`gf-input${condition ? " in-use" : ""}${error ? " invalid" : ""}`}
      value={text}
      placeholder={filterPlaceholder(field)}
      aria-label={`Filter ${field.label}`}
      aria-invalid={!!error}
      title={
        error ?? "Type to filter. % = any text, _ = one character; numbers: >5, 5..10; dates: 2026-10-01..2026-10-16"
      }
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setText("");
      }}
    />
  );
}

export function ColumnFilter(props: {
  field: FieldDescriptor;
  condition: FilterCondition | undefined;
  onChange: (c: FilterCondition | null) => void;
}) {
  // Conditions the box cannot show (e.g. from a saved view) stay editable in the builder.
  return isChoice(props.field) ? <ChoiceFilter {...props} /> : <TextFilter {...props} />;
}
