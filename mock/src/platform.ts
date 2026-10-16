// Platform settings read from the environment in this phase (later: admin settings).
// The platform time zone is one of the Enterprise report's time zone choices (§13.31).
import { TIMEZONES } from "./api/records.js";

const tz = process.env.PLATFORM_TIMEZONE ?? "UTC";
export const PLATFORM_TIMEZONE = TIMEZONES.includes(tz) ? tz : "UTC";
