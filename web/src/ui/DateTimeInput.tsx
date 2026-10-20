// Date and time in 24-hour format (team trial round 2): a calendar for the date and a typed HH:MM for the
// time, instead of the browser's date-time picker (12-hour on some systems, and its time is set by
// scrolling). Same value as <input type="datetime-local">: "YYYY-MM-DDTHH:mm", or "" when empty.
// A date with no time typed means 00:00, the start of the day.
import { useEffect, useState } from "react";

/** "930" → "09:30", "1530" → "15:30", "7" → "07:00"; null when it is not a valid 24-hour time. */
export function normalizeTime(raw: string): string | null {
  const s = raw.trim().replace(/[.h]/i, ":");
  let h: number;
  let min: number;
  const colon = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (colon) {
    h = Number(colon[1]);
    min = Number(colon[2]);
  } else if (/^\d{1,4}$/.test(s)) {
    // "7" → 07:00, "15" → 15:00, "930" → 09:30, "1530" → 15:30
    h = Number(s.length <= 2 ? s : s.slice(0, s.length - 2));
    min = s.length <= 2 ? 0 : Number(s.slice(-2));
  } else return null;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Joins the parts into the datetime-local value; a date alone is the start of that day. */
export function joinDateTime(date: string, time: string): string {
  if (!date) return "";
  return `${date}T${normalizeTime(time) ?? "00:00"}`;
}

interface Props {
  value: string;
  /** Called like an input's onChange, so it can replace <input type="datetime-local"> as is. */
  onChange: (e: { target: { value: string } }) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  title?: string;
}

export function DateTimeInput({
  value,
  onChange,
  min,
  max,
  disabled,
  required,
  autoFocus,
  id,
  className,
  title,
  ...rest
}: Props) {
  const [date, setDate] = useState(value.slice(0, 10));
  const [time, setTime] = useState(value.slice(11, 16));
  const [bad, setBad] = useState(false);
  // Follow the value when it changes from outside (a reset, a preset).
  useEffect(() => {
    setDate(value.slice(0, 10));
    setTime(value.slice(11, 16));
    setBad(false);
  }, [value]);
  const emit = (d: string, t: string) => onChange({ target: { value: joinDateTime(d, t) } });
  const label = rest["aria-label"];
  return (
    <span className={`dt-input${className ? ` ${className}` : ""}`} title={title}>
      <input
        type="date"
        id={id}
        value={date}
        min={min?.slice(0, 10)}
        max={max?.slice(0, 10)}
        disabled={disabled}
        required={required}
        autoFocus={autoFocus}
        aria-label={label ? `${label}: date` : "Date"}
        onChange={(e) => {
          setDate(e.target.value);
          emit(e.target.value, time);
        }}
      />
      <input
        type="text"
        inputMode="numeric"
        className={`dt-time${bad ? " invalid" : ""}`}
        placeholder="00:00"
        maxLength={5}
        value={time}
        disabled={disabled || !date}
        aria-label={label ? `${label}: time (24-hour)` : "Time (24-hour, HH:MM)"}
        aria-invalid={bad}
        title="24-hour time, e.g. 09:30 or 1530. Empty = 00:00"
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d:]/g, "");
          // Insert the colon while typing: "153" → "15:3"
          const t =
            raw.length === 3 && !raw.includes(":") && Number(raw.slice(0, 2)) <= 23
              ? `${raw.slice(0, 2)}:${raw.slice(2)}`
              : raw;
          setTime(t);
          const ok = t === "" || normalizeTime(t) !== null;
          setBad(!ok && t.length >= 4);
          if (ok) emit(date, t);
        }}
        onBlur={() => {
          const n = normalizeTime(time);
          if (time !== "" && n === null) {
            setBad(true);
            return;
          }
          setTime(n ?? "");
          setBad(false);
        }}
      />
    </span>
  );
}
