// "Rule: All" filter chip (team trial round 4): opens a checklist; the ticked values become one `in` column filter,
// so the list stays filtered on the server (§13.25). Used on Incidents, Market moves and other queue pages.
import { useRef, useState } from "react";
import type { FilterCondition } from "@sms/contract";
import { Popover } from "./primitives";

export function ChecklistChip({
  label,
  options,
  condition,
  field,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  condition: FilterCondition | undefined;
  field: string;
  onChange: (c: FilterCondition | null) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const picked = new Set(
    (condition?.op === "in" ? (condition.values ?? []) : condition?.op === "eq" ? [condition.value] : []).map(String),
  );
  const shown =
    picked.size === 0 ? "All" : picked.size === 1 ? options.find((o) => picked.has(o.value))?.label : `${picked.size}`;
  const toggle = (v: string) => {
    const next = new Set(picked);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next.size ? { field, op: "in", values: [...next] } : null);
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`range-chip plain${picked.size ? " set" : ""}`}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
      >
        {label}: {shown}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="picker-pop">
        {/* Count and Check all / Uncheck all on top, as in every multi-select (team trial round 12). None ticked
            filters nothing. */}
        <div className="checklist-bar chip-checks-bar">
          <span className="muted">
            {picked.size ? `Selected ${picked.size} of ${options.length}` : "None ticked: showing all"}
          </span>
          <span className="checklist-actions">
            <button
              type="button"
              className="link"
              disabled={picked.size === options.length}
              onClick={() => onChange({ field, op: "in", values: options.map((o) => o.value) })}
            >
              Check all
            </button>
            <button type="button" className="link" disabled={!picked.size} onClick={() => onChange(null)}>
              Uncheck all
            </button>
          </span>
        </div>
        <div className="picker-list check-list" role="listbox" aria-label={label}>
          {options.map((o) => (
            <label key={o.value} className="toggle-inline">
              <input type="checkbox" checked={picked.has(o.value)} onChange={() => toggle(o.value)} /> {o.label}
            </label>
          ))}
        </div>
      </Popover>
    </>
  );
}
