// Check list (team trial round 1): a searchable list of checkboxes with "Selected X of Y" and
// Check all / Uncheck all, which act on the items the search shows (select all filtered). Long lists
// (thousands of MCCMNC codes) scroll with virtualisation. Used by Rate Lookup and the rating pickers.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Popover } from "./primitives";
import { Icon } from "./Icon";

export interface CheckItem<V extends string | number> {
  value: V;
  label: string;
  /** Shown muted after the label (e.g. "12 tables", the enterprise). */
  detail?: string;
  /** Greyed out (e.g. no rates now); still selectable. */
  muted?: boolean;
  /** Extra text the search matches (codes, enterprise name). */
  keywords?: string;
}

/** Search text: words in any order, `%` and `_` wildcards (§13.25), case-insensitive. */
export function matcher(q: string): (text: string) => boolean {
  const t = q.trim().toLowerCase();
  if (!t) return () => true;
  if (/[%_]/.test(t)) {
    const re = new RegExp(
      `^${t
        .split("")
        .map((c) => (c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("")}$`,
    );
    return (text) => re.test(text.toLowerCase());
  }
  const words = t.split(/\s+/);
  return (text) => {
    const s = text.toLowerCase();
    return words.every((w) => s.includes(w));
  };
}

/** Check all / Uncheck all on the shown items only; the rest of the selection stays. */
export function applyToShown<V>(selected: readonly V[], shown: readonly V[], check: boolean): V[] {
  const set = new Set(selected);
  for (const v of shown) {
    if (check) set.add(v);
    else set.delete(v);
  }
  return [...set];
}

export function CheckList<V extends string | number>({
  items,
  selected,
  onChange,
  label,
  height = 260,
  placeholder = "Search…",
}: {
  items: CheckItem<V>[];
  selected: readonly V[];
  onChange: (next: V[]) => void;
  label: string;
  height?: number;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const m = matcher(q);
    return items.filter((i) => m(`${i.label} ${i.detail ?? ""} ${i.keywords ?? ""} ${i.value}`));
  }, [items, q]);
  const sel = useMemo(() => new Set(selected), [selected]);
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 28,
    overscan: 12,
  });
  const toggle = (v: V) => onChange(sel.has(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const values = shown.map((i) => i.value);
  return (
    <div className="checklist" aria-label={label}>
      <div className="checklist-search">
        <Icon name="search" size={13} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={`Search ${label}`}
          autoFocus
        />
      </div>
      <div className="checklist-bar">
        <span className="muted">
          Selected {selected.length.toLocaleString("en-US")} of {items.length.toLocaleString("en-US")}
          {q.trim() ? ` · ${shown.length.toLocaleString("en-US")} shown` : ""}
        </span>
        <span className="checklist-actions">
          <button type="button" className="link" onClick={() => onChange(applyToShown(selected, values, true))}>
            {q.trim() ? "Check shown" : "Check all"}
          </button>
          <button type="button" className="link" onClick={() => onChange(applyToShown(selected, values, false))}>
            {q.trim() ? "Uncheck shown" : "Uncheck all"}
          </button>
        </span>
      </div>
      <div className="checklist-items" ref={scroll} style={{ height }} role="listbox" aria-multiselectable>
        {shown.length === 0 ? (
          <div className="muted checklist-empty">Nothing matches</div>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((vi) => {
              const it = shown[vi.index]!;
              return (
                <label
                  key={String(it.value)}
                  className={`checklist-item${it.muted ? " muted" : ""}`}
                  style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
                  role="option"
                  aria-selected={sel.has(it.value)}
                >
                  <input type="checkbox" checked={sel.has(it.value)} onChange={() => toggle(it.value)} />
                  <span className="checklist-label">{it.label}</span>
                  {it.detail && <span className="checklist-detail">{it.detail}</span>}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** A filter button ("Country: 3 selected ▾") opening a CheckList. */
export function CheckListButton<V extends string | number>({
  title,
  items,
  selected,
  onChange,
  allLabel = "All",
  disabled,
  footer,
}: {
  title: string;
  items: CheckItem<V>[];
  selected: readonly V[];
  onChange: (next: V[]) => void;
  allLabel?: string;
  disabled?: boolean;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (items.find((i) => i.value === selected[0])?.label ?? "1 selected")
        : `${selected.length.toLocaleString("en-US")} selected`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`btn checklist-btn${selected.length ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        title={`${title}: ${summary}`}
      >
        <span className="checklist-btn-title">{title}</span>
        <span className="checklist-btn-value">{summary}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} className="checklist-pop">
        <div className="checklist-pop-head">
          <strong>{title}</strong>
          {selected.length > 0 && (
            <button type="button" className="link" onClick={() => onChange([])}>
              Clear ({allLabel.toLowerCase()})
            </button>
          )}
        </div>
        <CheckList items={items} selected={selected} onChange={onChange} label={title} />
        {footer}
      </Popover>
    </>
  );
}
