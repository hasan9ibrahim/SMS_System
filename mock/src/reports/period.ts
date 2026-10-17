// Report periods (§10, §13.15): relative periods resolve in the report's time zone against "now" -
// in this phase the latest EDR, since the generated traffic ends at a fixed time. No I/O.
import type { ReportPeriod } from "@sms/contract";
import { nextDay, zonedMidnight } from "../billing/zone.js";

const DAY = 86_400_000;
export const MAX_DAYS = 400;

/** The calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function dayIn(t: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
  return p;
}
const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);
/** Monday of the week of a day (ISO week). */
const monday = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

export interface Window {
  from: Date;
  to: Date;
}

/** [from, to) of a period; custom periods are checked by the caller. */
export function resolvePeriod(
  period: ReportPeriod,
  tz: string,
  now: number,
  custom?: { from?: string | null; to?: string | null },
): Window {
  const today = dayIn(now, tz);
  const mid = (d: string) => zonedMidnight(d, tz);
  switch (period) {
    case "today":
      return { from: mid(today), to: new Date(now) };
    case "yesterday":
      return { from: mid(addDays(today, -1)), to: mid(today) };
    case "last_24_hours":
      return { from: new Date(now - DAY), to: new Date(now) };
    case "last_7_days":
      return { from: mid(addDays(today, -6)), to: new Date(now) };
    case "this_week":
      return { from: mid(monday(today)), to: new Date(now) };
    case "last_week":
      return { from: mid(addDays(monday(today), -7)), to: mid(monday(today)) };
    case "this_month":
      return { from: mid(`${today.slice(0, 7)}-01`), to: new Date(now) };
    case "last_month": {
      const first = `${today.slice(0, 7)}-01`;
      const prev = addDays(first, -1).slice(0, 7);
      return { from: mid(`${prev}-01`), to: mid(first) };
    }
    case "custom":
      return { from: new Date(custom?.from ?? now - DAY), to: new Date(custom?.to ?? now) };
  }
}

/** The window to compare with: the same length just before, or the same window a week earlier. */
export function previousWindow(w: Window, compare: "previous_period" | "previous_week"): Window {
  const len = w.to.getTime() - w.from.getTime();
  return compare === "previous_week"
    ? { from: new Date(w.from.getTime() - 7 * DAY), to: new Date(w.to.getTime() - 7 * DAY) }
    : { from: new Date(w.from.getTime() - len), to: new Date(w.from.getTime()) };
}

export const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export { nextDay };
