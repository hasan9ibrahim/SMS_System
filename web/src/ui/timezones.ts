// Time zone choices shown with their UTC offset (team trial 2026-10-18): "UTC+04:00 · Asia/Dubai".
// The value stays the IANA name, so daylight-saving changes are handled; the offset shown is today's.

/** Today's offset of an IANA zone in minutes east of UTC (0 when the zone is unknown). */
export function tzOffsetMinutes(zone: string, at = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    if (!m) return 0;
    const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === "-" ? -mins : mins;
  } catch {
    return 0;
  }
}

export function utcOffsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "UTC+04:00 · Asia/Dubai"; plain "UTC" stays "UTC+00:00 · UTC". */
export const tzLabel = (zone: string, at = new Date()) => `${utcOffsetLabel(tzOffsetMinutes(zone, at))} · ${zone}`;

/** Select options, ordered west to east, then by name. */
export function tzOptions(zones: string[], at = new Date()): { value: string; label: string }[] {
  return [...zones]
    .map((z) => ({ z, off: tzOffsetMinutes(z, at) }))
    .sort((a, b) => a.off - b.off || a.z.localeCompare(b.z))
    .map(({ z }) => ({ value: z, label: tzLabel(z, at) }));
}
