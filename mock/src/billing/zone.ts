// Billing days in a time zone (§13.31): day boundaries as UTC instants. No I/O, so the data
// generator and the API share it.
export const nextDay = (d: string) => new Date(Date.parse(d) + 86400_000).toISOString().slice(0, 10);

/** Midnight of `day` in `tz` as a UTC instant. */
export function zonedMidnight(day: string, tz: string): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

/** The window counted for days [from, to] in `tz`: midnight of `from` to midnight after `to`. */
export const dayWindow = (from: string, to: string, tz: string) => ({
  from: zonedMidnight(from, tz),
  to: zonedMidnight(nextDay(to), tz),
});
