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
