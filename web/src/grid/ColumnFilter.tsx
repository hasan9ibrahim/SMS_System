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
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="choice-pop">
        <label className="choice-row strong">
          <input
            type="checkbox"
            checked={selected.size === 0}
            onChange={() => {
              apply(new Set());
              setOpen(false);
            }}
          />
          Select all
        </label>
        <div className="menu-sep" />
        {options.map((o) => (
          <label key={o.value} className="choice-row">
            <input
              type="checkbox"
              checked={selected.size === 0 || selected.has(o.value)}
              onChange={(e) => {
                const base = selected.size === 0 ? new Set(options.map((x) => x.value)) : new Set(selected);
                if (e.target.checked) base.add(o.value);
                else base.delete(o.value);
                apply(base);
              }}
            />
            {o.label}
          </label>
        ))}
        <div className="muted small pad-x">
          Selected {selected.size || options.length} of {options.length}
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
