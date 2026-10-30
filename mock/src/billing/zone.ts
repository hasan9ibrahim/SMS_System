// Billing days in a time zone (§13.31): day boundaries as UTC instants. No I/O, so the data
// generator and the API share it.
export const nextDay = (d: string) => new Date(Date.parse(d) + 86400_000).toISOString().slice(0, 10);

/** Minutes `tz` is ahead of UTC at instant `t`. */
function offsetAt(t: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(t);
  const get = (k: string) => Number(parts.find((p) => p.type === k)!.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - t.getTime()) / 60_000;
}

/**
 * Midnight of `day` in `tz` as a UTC instant. The offset is read again at the first answer: read only at UTC midnight
 * it can be the other side of a daylight-saving change, an hour off (Pacific/Auckland on 2026-09-27).
 */
export function zonedMidnight(day: string, tz: string): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  const first = new Date(guess.getTime() - offsetAt(guess, tz) * 60_000);
  return new Date(guess.getTime() - offsetAt(first, tz) * 60_000);
}

/** The window counted for days [from, to] in `tz`: midnight of `from` to midnight after `to`. */
export const dayWindow = (from: string, to: string, tz: string) => ({
  from: zonedMidnight(from, tz),
  to: zonedMidnight(nextDay(to), tz),
});
