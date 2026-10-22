// Period controls in one style for every page with a calendar (design refresh, team trial round 2): quick periods
// as a segmented control, the range as a chip ("22 Oct 2026 → 22 Oct 2026") that opens From / To fields, and the
// hours of each day as a chip ("Each day 00:00 – 23:59").
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DateTimeInput } from "./DateTimeInput";
import { Icon } from "./Icon";
import { Button, Popover } from "./primitives";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-22" or "2026-10-22T07:00…" → "22 Oct 2026" (with "07:00" when `time`). Empty → "". */
export function fmtDay(value: string | null | undefined, time = false): string {
  if (!value) return "";
  const [y, m, d] = value.slice(0, 10).split("-");
  if (!y || !m || !d) return value;
  const day = `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
  return time && value.length >= 16 ? `${day} ${value.slice(11, 16)}` : day;
}

/** Quick periods as one segmented control; the period in use is the white pill. */
export function PeriodTabs<K extends string>({
  options,
  value,
  onPick,
  label = "Quick periods",
}: {
  options: readonly { key: K; label: string }[];
  value: K | null;
  onPick: (k: K) => void;
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={value === o.key ? "on" : undefined}
          aria-pressed={value === o.key}
          onClick={() => onPick(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The period as a chip; a click opens From / To. `withTime` edits date and time (local "YYYY-MM-DDTHH:MM"),
 * else days ("YYYY-MM-DD"). Either end may be empty. `suffix` follows the range (e.g. "UTC").
 */
export function RangeChip({
  from,
  to,
  onChange,
  withTime = false,
  suffix,
  empty = "Any time",
  prefix,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  withTime?: boolean;
  suffix?: string;
  empty?: string;
  /** Text before the range, e.g. "Today ·". */
  prefix?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from, to });
  useEffect(() => {
    if (open) setDraft({ from, to });
  }, [open, from, to]);
  const sameDay = withTime && from && to && from.slice(0, 10) === to.slice(0, 10);
  const label = sameDay
    ? `${prefix ?? fmtDay(from)} ${from.slice(11, 16)} – ${to.slice(11, 16)}${suffix ? ` ${suffix}` : ""}`
    : from || to
      ? `${prefix ? `${prefix} ` : ""}${fmtDay(from, withTime) || "…"} → ${fmtDay(to, withTime) || "…"}${suffix ? ` ${suffix}` : ""}`
      : empty;
  const field = (which: "from" | "to") =>
    withTime ? (
      <DateTimeInput
        value={draft[which]}
        onChange={(e) => setDraft({ ...draft, [which]: e.target.value })}
        aria-label={which === "from" ? "From" : "To"}
      />
    ) : (
      <input
        type="date"
        value={draft[which]}
        onChange={(e) => setDraft({ ...draft, [which]: e.target.value })}
        aria-label={which === "from" ? "From" : "To"}
      />
    );
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`range-chip${from || to ? " set" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="calendar" size={15} />
        <span>{label}</span>
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="range-pop">
        <div className="range-pop-body">
          <label className="field">
            <span>From</span>
            {field("from")}
          </label>
          <label className="field">
            <span>To</span>
            {field("to")}
          </label>
          {suffix && <span className="muted small">{suffix}</span>}
        </div>
        <div className="range-pop-foot">
          {(from || to) && (
            <Button
              variant="ghost"
              onClick={() => {
                onChange("", "");
                setOpen(false);
              }}
            >
              Clear
            </Button>
          )}
          <span className="fb-spacer" />
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onChange(draft.from, draft.to);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </Popover>
    </>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const hh = (h: number) => String(h).padStart(2, "0");

/** The hours of every day of the period as a chip ("Each day 00:00 – 23:59"); a click opens the two hours. */
export function HoursChip({
  from,
  to,
  onChange,
  title = "Only these hours, every day of the period (wraps past midnight)",
}: {
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
  title?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`range-chip plain${from !== 0 || to !== 23 ? " set" : ""}`}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="clock" size={15} />
        <span>
          Each day {hh(from)}:00 – {hh(to)}:59
        </span>
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="range-pop">
        <div className="range-pop-body">
          <label className="field">
            <span>From</span>
            <select aria-label="Each day from" value={from} onChange={(e) => onChange(Number(e.target.value), to)}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hh(h)}:00
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>To</span>
            <select aria-label="Each day to" value={to} onChange={(e) => onChange(from, Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hh(h)}:59
                </option>
              ))}
            </select>
          </label>
        </div>
      </Popover>
    </>
  );
}

/** A chip that opens a small panel (e.g. "Destinations: All", "Status: All"). */
export function ChipButton({
  children,
  active,
  onClick,
  title,
}: {
  children: ReactNode;
  active?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button type="button" className={`range-chip plain${active ? " set" : ""}`} title={title} onClick={onClick}>
      {children}
    </button>
  );
}
