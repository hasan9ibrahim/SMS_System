// Quick search with field pills (team trial round 3, §13.25): typing searches the list's text columns as before;
// clicking the box opens a card of the page's fields by category. Picking one adds a pill "Field = …" whose value
// takes the column filter shorthand (% and _ wildcards, >5, 5..10, dates, =exact, !not, /regex/). Pills are column
// filters, so they show under the headers too and all apply together (AND). × on a pill removes it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { FieldDescriptor, FilterCondition } from "@sms/contract";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/primitives";
import { ColumnFilter } from "./ColumnFilter";
import { isChoice, isNumeric, isTime } from "./filterModel";

/** The card's category of a field: the side for "Customer …" / "Vendor …" fields, else the kind of value. */
export function fieldGroup(f: FieldDescriptor): string {
  if (/^customer\b/i.test(f.label)) return "Customer";
  if (/^vendor\b/i.test(f.label)) return "Vendor";
  if (isTime(f)) return "Dates and times";
  if (isNumeric(f)) return "Numbers and money";
  if (isChoice(f)) return "Choices";
  return "Text";
}

const GROUP_ORDER = ["Text", "Customer", "Vendor", "Choices", "Numbers and money", "Dates and times"];

/** Fields offered in the card: the visible columns and filter-only fields, without the ones already picked. */
export function pickableFields(
  fields: FieldDescriptor[],
  visible: string[] | null,
  taken: Set<string>,
  exclude: string[],
): { group: string; fields: FieldDescriptor[] }[] {
  const shown = new Set(visible ?? fields.filter((f) => !f.hidden).map((f) => f.field));
  const offered = fields.filter(
    (f) =>
      (shown.has(f.field) || f.filterOnly) &&
      !taken.has(f.field) &&
      !exclude.includes(f.field) &&
      f.field !== "archived",
  );
  const groups = new Map<string, FieldDescriptor[]>();
  for (const f of offered) groups.set(fieldGroup(f), [...(groups.get(fieldGroup(f)) ?? []), f]);
  return [...groups.entries()]
    .sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]))
    .map(([group, list]) => ({ group, fields: list }));
}

function Pill({
  field,
  condition,
  onChange,
  onRemove,
  focus,
}: {
  field: FieldDescriptor;
  condition: FilterCondition | undefined;
  onChange: (c: FilterCondition | null) => void;
  onRemove: () => void;
  focus: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!focus) return;
    const el = ref.current?.querySelector<HTMLElement>("input, button.gf-select");
    el?.focus();
    if (el instanceof HTMLButtonElement) el.click();
  }, [focus]);
  return (
    <span ref={ref} className={`pill-filter${condition ? " set" : ""}`} onClick={(e) => e.stopPropagation()}>
      <span className="pill-label">{field.label}</span>
      <span className="pill-eq">=</span>
      <ColumnFilter field={field} condition={condition} onChange={onChange} />
      <button type="button" className="pill-x" aria-label={`Remove the ${field.label} filter`} onClick={onRemove}>
        <Icon name="x" size={11} />
      </button>
    </span>
  );
}

export function PillSearch({
  fields,
  visible,
  columns,
  onColumns,
  search,
  onSearch,
  freeText = true,
  exclude = [],
  onAdvanced,
}: {
  fields: FieldDescriptor[] | undefined;
  visible: string[] | null;
  columns: Record<string, FilterCondition>;
  onColumns: (next: Record<string, FilterCondition>) => void;
  search: string;
  onSearch: (text: string) => void;
  /** False: no free-text quick search on this page (it has its own box); fields only. */
  freeText?: boolean;
  /** Fields the page filters elsewhere (its own toolbar). */
  exclude?: string[];
  /** Opens the AND / OR builder. */
  onAdvanced?: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(search);
  const [find, setFind] = useState("");
  // Picked fields still without a value stay as empty pills until removed.
  const [pending, setPending] = useState<string[]>([]);
  const [focusField, setFocusField] = useState<string | null>(null);
  useEffect(() => setDraft(search), [search]);
  const byName = useMemo(() => new Map((fields ?? []).map((f) => [f.field, f])), [fields]);
  const pillFields = [
    ...Object.keys(columns).filter((k) => k !== "archived" && !exclude.includes(k)),
    ...pending.filter((k) => !(k in columns)),
  ].filter((k) => byName.has(k));
  const groups = pickableFields(fields ?? [], visible, new Set(pillFields), exclude)
    .map((g) => ({ ...g, fields: g.fields.filter((f) => f.label.toLowerCase().includes(find.toLowerCase())) }))
    .filter((g) => g.fields.length);
  const setCondition = (field: string, c: FilterCondition | null) => {
    const next = { ...columns };
    if (c) next[field] = c;
    else delete next[field];
    if (!c && !pending.includes(field)) setPending((p) => [...p, field]);
    onColumns(next);
  };
  const remove = (field: string) => {
    setPending((p) => p.filter((x) => x !== field));
    if (field in columns) {
      const next = { ...columns };
      delete next[field];
      onColumns(next);
    }
  };
  const pick = (f: FieldDescriptor) => {
    setPending((p) => (p.includes(f.field) ? p : [...p, f.field]));
    setFocusField(f.field);
    setFind("");
    setOpen(false);
  };
  return (
    <div
      ref={barRef}
      className={`pill-search${open ? " open" : ""}`}
      onClick={() => {
        inputRef.current?.focus();
        setOpen(true);
      }}
    >
      <Icon name="search" size={14} />
      {pillFields.map((k) => (
        <Pill
          key={k}
          field={byName.get(k)!}
          condition={columns[k]}
          onChange={(c) => setCondition(k, c)}
          onRemove={() => remove(k)}
          focus={focusField === k}
        />
      ))}
      <input
        ref={inputRef}
        className="pill-search-input"
        value={freeText ? draft : find}
        placeholder={
          pillFields.length
            ? freeText
              ? "Search, or pick another field…"
              : "Pick another field…"
            : freeText
              ? "Quick search, or click to filter by a field…"
              : "Click to filter by a field…"
        }
        aria-label="Quick search"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          if (freeText) setDraft(e.target.value);
          setFind(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && freeText) {
            onSearch(draft.trim());
            setOpen(false);
          }
          if (e.key === "Escape") {
            if (freeText && draft) {
              setDraft("");
              onSearch("");
            }
            setFind("");
            setOpen(false);
          }
          if (e.key === "Backspace" && !draft && !find && pillFields.length) remove(pillFields[pillFields.length - 1]!);
        }}
        onBlur={() => freeText && draft.trim() !== search && onSearch(draft.trim())}
      />
      <Popover anchor={barRef} open={open} onClose={() => setOpen(false)} className="pill-pop">
        <div className="pill-card" onMouseDown={(e) => e.preventDefault()}>
          {freeText && draft.trim() && (
            <button
              type="button"
              className="pill-card-search"
              onClick={() => {
                onSearch(draft.trim());
                setOpen(false);
              }}
            >
              <Icon name="search" size={13} /> Search all text columns for &quot;{draft.trim()}&quot;
              <kbd>Enter</kbd>
            </button>
          )}
          {groups.length === 0 ? (
            <p className="muted small pad">
              {find ? "No field matches." : "Every field is in use. Show more columns to filter by them."}
            </p>
          ) : (
            <div className="pill-groups">
              {groups.map((g) => (
                <div key={g.group} className="pill-group">
                  <div className="pill-group-title">{g.group}</div>
                  {g.fields.map((f) => (
                    <button key={f.field} type="button" className="pill-field" onClick={() => pick(f)}>
                      {f.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="pill-card-foot">
            <span className="muted small">
              % any text · _ one character · &gt;5 · 5..10 · =exact · !not · /regex/ · all fields must match
            </span>
            {onAdvanced && (
              <button
                type="button"
                className="link small"
                onClick={() => {
                  setOpen(false);
                  onAdvanced();
                }}
              >
                Any of (OR)…
              </button>
            )}
          </div>
        </div>
      </Popover>
    </div>
  );
}
