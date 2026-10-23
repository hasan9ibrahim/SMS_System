// Incident filter bar (team trial round 4): quick periods, the range as a chip, and Rule / Severity / State as
// "Rule: All" chips that open a checklist. Each one is a column filter, so the list stays filtered on the server.
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AlertRuleRow, FilterCondition } from "@sms/contract";
import { fetchListPage } from "../../../api/hooks";
import type { GridState } from "../../../grid/filterModel";
import { PeriodTabs, RangeChip } from "../../../ui/DateRange";
import { Popover } from "../../../ui/primitives";
import { timeBounds, timeCondition } from "../monitorModel";

type Period = "hour" | "today" | "yesterday" | "week" | "month";
const PERIODS: { key: Period; label: string }[] = [
  { key: "hour", label: "Last hour" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "Last 7 days" },
  { key: "month", label: "This month" },
];

const day = (d: Date) => d.toISOString().slice(0, 10);
/** From / To (UTC, "YYYY-MM-DDTHH:MM") of a quick period; To empty = until now. */
export function periodBounds(p: Period, now = new Date()): { from: string; to: string } {
  const today = day(now);
  if (p === "hour") return { from: new Date(now.getTime() - 3600_000).toISOString().slice(0, 16), to: "" };
  if (p === "today") return { from: `${today}T00:00`, to: "" };
  if (p === "yesterday") {
    const y = day(new Date(now.getTime() - 86400_000));
    return { from: `${y}T00:00`, to: `${y}T23:59` };
  }
  if (p === "week") return { from: `${day(new Date(now.getTime() - 6 * 86400_000))}T00:00`, to: "" };
  return { from: `${today.slice(0, 8)}01T00:00`, to: "" };
}

export const todayCondition = (): FilterCondition => timeCondition("startedAt", periodBounds("today").from, "")!;

function ChecklistChip({
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
        <div className="picker-list check-list" role="listbox" aria-label={label}>
          {options.map((o) => (
            <label key={o.value} className="toggle-inline">
              <input type="checkbox" checked={picked.has(o.value)} onChange={() => toggle(o.value)} /> {o.label}
            </label>
          ))}
          {picked.size > 0 && (
            <button type="button" className="link small" onClick={() => onChange(null)}>
              Show all
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}

export function IncidentFilters({ state, setState }: { state: GridState; setState: (s: GridState) => void }) {
  const rules = useQuery({
    queryKey: ["list", "alert_rules", "names"],
    queryFn: () => fetchListPage<AlertRuleRow>("alert_rules", { limit: 200, withTotal: false }),
    staleTime: 60_000,
  });
  const set = (field: string, c: FilterCondition | null) => {
    const columns = { ...state.columns };
    if (c) columns[field] = c;
    else delete columns[field];
    setState({ ...state, columns });
  };
  const bounds = timeBounds(state.columns.startedAt);
  const period = PERIODS.find((p) => {
    const b = periodBounds(p.key);
    // "Last hour" moves every minute: matched by its missing To and a From within the last hour.
    if (p.key === "hour")
      return !bounds.to && bounds.from > periodBounds("today").from && bounds.from.slice(11) !== "00:00";
    return b.from === bounds.from && b.to === bounds.to;
  })?.key;
  return (
    <div className="incident-filters">
      <PeriodTabs
        options={PERIODS}
        value={period ?? null}
        onPick={(p) => {
          const b = periodBounds(p);
          set("startedAt", timeCondition("startedAt", b.from, b.to));
        }}
      />
      <RangeChip
        withTime
        from={bounds.from}
        to={bounds.to}
        suffix="UTC"
        empty="Any time"
        onChange={(from, to) => set("startedAt", timeCondition("startedAt", from, to))}
      />
      <ChecklistChip
        label="Rule"
        field="ruleName"
        condition={state.columns.ruleName}
        options={(rules.data?.rows ?? []).map((r) => ({ value: r.name, label: r.name }))}
        onChange={(c) => set("ruleName", c)}
      />
      <ChecklistChip
        label="Severity"
        field="severity"
        condition={state.columns.severity}
        options={[
          { value: "critical", label: "Critical" },
          { value: "warning", label: "Warning" },
          { value: "info", label: "Info" },
        ]}
        onChange={(c) => set("severity", c)}
      />
      <ChecklistChip
        label="State"
        field="state"
        condition={state.columns.state}
        options={[
          { value: "open", label: "Open" },
          { value: "acknowledged", label: "Acknowledged" },
          { value: "recovered", label: "Recovered" },
        ]}
        onChange={(c) => set("state", c)}
      />
    </div>
  );
}
