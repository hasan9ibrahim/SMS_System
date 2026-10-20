// Dates and times in the platform time zone (team trial round 2): rate changes are entered and shown in the
// system's default time zone, not UTC or this computer's zone. Values for date-time fields keep the
// "YYYY-MM-DDTHH:mm" form; the API gets UTC ISO timestamps.
import { useReference } from "../api/records";
import { setDisplayTz } from "./zonedCore";

export * from "./zonedCore";

/** The platform time zone (IANA name), UTC until the reference data has loaded. */
export function usePlatformTz(): string {
  const tz = useReference().data?.platformTimezone ?? "UTC";
  setDisplayTz(tz);
  return tz;
}
