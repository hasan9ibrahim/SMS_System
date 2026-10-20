// Platform settings read from the environment in this phase (later: admin settings).
// The platform time zone is one of the Enterprise report's time zone choices (§13.31).
import { TIMEZONES } from "./api/records.js";

const tz = process.env.PLATFORM_TIMEZONE ?? "UTC";
export const PLATFORM_TIMEZONE = TIMEZONES.includes(tz) ? tz : "UTC";

/** "Today" on every screen (live dashboard §13.3, money today §13.12) is the day in the platform time zone. */
export const PLATFORM_DAY_START_SQL = `toStartOfDay(now('${PLATFORM_TIMEZONE}'))`;

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: PLATFORM_TIMEZONE });
/** The platform-time-zone date of `t` as YYYY-MM-DD. */
export const platformDay = (t: number) => dayFormat.format(t);

const timeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: PLATFORM_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** `t` in the platform time zone as "YYYY-MM-DD HH:MM" (24-hour; rate notifications, team trial round 2). */
export const platformDateTime = (t: number | string | Date) => {
  const p = Object.fromEntries(timeFormat.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

/** The instant the platform clock shows `hhmm` on platform day `day` (YYYY-MM-DD); DST-safe to the minute. */
export function platformInstant(day: string, hhmm: string): number {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  // Two passes settle the offset, also across a DST change.
  for (let i = 0; i < 2; i++) {
    const shown = platformDateTime(t);
    const [sd, st] = shown.split(" ") as [string, string];
    const [sy, smo, sdd] = sd.split("-").map(Number) as [number, number, number];
    const [sh, smi] = st.split(":").map(Number) as [number, number];
    t += want - Date.UTC(sy, smo - 1, sdd, sh, smi);
  }
  return t;
}

/** The last and next time the platform clock shows `hhmm` around `now` (daily jobs, team trial round 3). */
export function dailyMoments(hhmm: string, now = Date.now()): { last: number; next: number } {
  const today = platformInstant(platformDay(now), hhmm);
  if (today <= now) return { last: today, next: platformInstant(platformDay(now + 86_400_000), hhmm) };
  return { last: platformInstant(platformDay(now - 86_400_000), hhmm), next: today };
}
