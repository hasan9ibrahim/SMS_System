// System clock in the top menu bar (team trial round 1): the server's time, shown in the platform
// time zone and ticking every second. It follows the server, not this computer's clock (§15.1).
import { useEffect, useState } from "react";
import { useServerOffset } from "../api/hooks";
import { useReference } from "../api/records";

export function SystemClock() {
  const { data, isError } = useServerOffset();
  const tz = useReference().data?.platformTimezone ?? "UTC";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const at = new Date(now + (data?.offset ?? 0));
  const fmt = (opts: Intl.DateTimeFormatOptions, zone = tz) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts }).format(at);
  const time = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  // The date in the platform time zone too, so it turns over at the platform's midnight.
  const weekday = fmt({ weekday: "short" });
  const date = fmt({ day: "numeric", month: "short" });
  const utc = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }, "UTC");
  return (
    <span
      className={`top-clock${isError ? " offline" : ""}`}
      title={
        isError
          ? "Server not reachable: showing this computer's clock"
          : `System time (${tz})${tz === "UTC" ? "" : ` · UTC ${utc}`} · ${fmt({ dateStyle: "full" })}`
      }
    >
      <span className="top-clock-date">
        <span className="top-clock-weekday">{weekday} </span>
        {date}
      </span>
      <span className="num">{time}</span>
      <span className="top-clock-tz">{tz === "UTC" ? "UTC" : tz.split("/").pop()!.replace(/_/g, " ")}</span>
    </span>
  );
}
