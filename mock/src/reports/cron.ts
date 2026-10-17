// CRON schedules for scheduled reports (§10): five fields - minute hour day-of-month month
// day-of-week - in UTC, with `*`, lists, ranges and steps. When both day fields are restricted a
// day matches either one (standard cron). No I/O.

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const NAMES = ["minute", "hour", "day of month", "month", "day of week"];

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayAny: boolean;
  weekdayAny: boolean;
}

function field(text: string, i: number): Set<number> {
  const [lo, hi] = RANGES[i]!;
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`${NAMES[i]}: "${part}" is not valid`);
    const step = m[4] ? Number(m[4]) : 1;
    const a = m[1] === "*" ? lo : Number(m[2]);
    const b = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a;
    if (step < 1 || a < lo || b > hi || a > b) throw new Error(`${NAMES[i]}: "${part}" is out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(i === 4 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("use five fields: minute hour day month weekday");
  const [mi, h, d, mo, w] = parts.map((p, i) => field(p, i));
  return {
    minutes: mi!,
    hours: h!,
    days: d!,
    months: mo!,
    weekdays: w!,
    dayAny: parts[2] === "*",
    weekdayAny: parts[4] === "*",
  };
}

function dayMatches(c: Cron, t: Date): boolean {
  if (!c.months.has(t.getUTCMonth() + 1)) return false;
  const dom = c.days.has(t.getUTCDate());
  const dow = c.weekdays.has(t.getUTCDay());
  if (c.dayAny && c.weekdayAny) return true;
  if (c.dayAny) return dow;
  if (c.weekdayAny) return dom;
  return dom || dow;
}

/** The next `count` run times strictly after `after` (searches up to two years ahead). */
export function nextRuns(expr: string, after: Date, count = 1): Date[] {
  const c = parseCron(expr);
  const out: Date[] = [];
  const t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const limit = after.getTime() + 2 * 366 * 86_400_000;
  while (out.length < count && t.getTime() < limit) {
    if (!dayMatches(c, t)) {
      t.setUTCHours(0, 0, 0, 0);
      t.setUTCDate(t.getUTCDate() + 1);
      continue;
    }
    if (!c.hours.has(t.getUTCHours())) {
      t.setUTCMinutes(0, 0, 0);
      t.setUTCHours(t.getUTCHours() + 1);
      continue;
    }
    if (c.minutes.has(t.getUTCMinutes())) out.push(new Date(t));
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A short description for the common shapes, else the fields spelled out. */
export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  const [mi, h, d, mo, w] = p;
  const at = /^\d+$/.test(mi!) && /^\d+$/.test(h!) ? `at ${pad(Number(h))}:${pad(Number(mi))} UTC` : null;
  if (/^\*\/(\d+)$/.test(mi!) && h === "*" && d === "*" && mo === "*" && w === "*")
    return `every ${mi!.slice(2)} minutes`;
  if (/^\d+$/.test(mi!) && /^\*(\/\d+)?$/.test(h!) && d === "*" && mo === "*" && w === "*")
    return `every ${h === "*" ? "" : `${h!.slice(2)} `}hour${h === "*" ? "" : "s"} at minute ${mi}`;
  if (at && d === "*" && mo === "*" && w === "*") return `every day ${at}`;
  if (at && d === "*" && mo === "*" && /^\d$/.test(w!)) return `every ${DOW[Number(w) % 7]} ${at}`;
  if (at && d === "*" && mo === "*" && w === "1-5") return `weekdays ${at}`;
  if (at && /^\d+$/.test(d!) && mo === "*" && w === "*") return `day ${d} of every month ${at}`;
  return `minute ${mi}, hour ${h}, day ${d}, month ${mo}, weekday ${w} (UTC)`;
}

/** The expression the interval and frequency boxes suggest (§10 CRON Interval / Frequency). */
export function cronFor(interval: string, frequency: number): string {
  switch (interval) {
    case "minute":
      return `*/${frequency} * * * *`;
    case "hourly":
      return `0 */${frequency} * * *`;
    case "weekly":
      return "0 6 * * 1";
    case "monthly":
      return "0 6 1 * *";
    default:
      return frequency > 1 ? `0 6 */${frequency} * *` : "0 6 * * *";
  }
}
