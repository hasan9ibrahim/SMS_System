// Pure helpers for dates in the platform time zone (team trial round 2); zonedTime.ts adds the React hook.

let current = "UTC";
/** The zone plain formatters use (shortDate and friends); set by usePlatformTz once reference data loads. */
export const displayTz = () => current;
export function setDisplayTz(tz: string) {
  current = tz;
}

/** "CEST", "GMT+4"… for `iso` in the display zone. */
export function zoneAbbr(iso: string | number, tz = current): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(typeof iso === "number" ? iso : Date.parse(iso))
    .find((x) => x.type === "timeZoneName");
  return p?.value ?? tz;
}

function parts(t: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(f.formatToParts(t).map((p) => [p.type, p.value])) as Record<string, string>;
}

/** Minutes the zone is ahead of UTC at instant `t`. */
function offsetMin(t: number, tz: string): number {
  const p = parts(t, tz);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60_000);
}

/** "YYYY-MM-DDTHH:mm" in `tz` → UTC ISO timestamp. */
export function zonedToIso(local: string, tz: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) throw new Error(`not a date-time: ${local}`);
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  let t = guess - offsetMin(guess, tz) * 60_000;
  t = guess - offsetMin(t, tz) * 60_000; // the offset at the result (daylight saving changes)
  return new Date(t).toISOString();
}

/** A timestamp → "YYYY-MM-DDTHH:mm" in `tz`. */
export function isoToZoned(iso: string | number, tz: string): string {
  const p = parts(typeof iso === "number" ? iso : Date.parse(iso), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The start of today (00:00) in `tz`, as "YYYY-MM-DDT00:00": the default for rate changes (team trial round 2). */
export function todayMidnight(tz: string, now = Date.now()): string {
  return `${isoToZoned(now, tz).slice(0, 10)}T00:00`;
}

/** The start of the next day (00:00) in `tz`, as "YYYY-MM-DDT00:00". */
export function nextMidnight(tz: string, now = Date.now()): string {
  const today = isoToZoned(now, tz).slice(0, 10);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)}T00:00`;
}

/** "21 Oct 2026, 00:00" in `tz`, 24-hour. */
export function formatZoned(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(Date.parse(iso));
}
