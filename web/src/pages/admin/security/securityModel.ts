// Security settings (§13.28): pure helpers for the page — form checks, reminder days and state labels.
import type { PasswordState, SecuritySettings, SecuritySettingsInput } from "@sms/contract";

export const LIMITS = {
  passwordLifetimeDays: [7, 365],
  tempPasswordHours: [1, 72],
  minPasswordLength: [12, 64],
  passwordHistory: [12, 24],
  reminderDay: [1, 30],
} as const;

export const settingsInput = (s: SecuritySettings): SecuritySettingsInput => ({
  passwordLifetimeDays: s.passwordLifetimeDays,
  reminderDays: [...s.reminderDays],
  tempPasswordHours: s.tempPasswordHours,
  minPasswordLength: s.minPasswordLength,
  passwordHistory: s.passwordHistory,
});

const inRange = (v: number, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && v >= lo && v <= hi;

/** Problems that keep Save disabled; the floors (12 characters, 12 passwords) and "never off" hold. */
export function settingsProblems(d: SecuritySettingsInput): string[] {
  const out: string[] = [];
  if (!inRange(d.passwordLifetimeDays, LIMITS.passwordLifetimeDays))
    out.push("Password lifetime: 7 to 365 days (it can't be turned off)");
  if (!inRange(d.tempPasswordHours, LIMITS.tempPasswordHours)) out.push("Temporary password: 1 to 72 hours");
  if (!inRange(d.minPasswordLength, LIMITS.minPasswordLength)) out.push("Minimum length: 12 to 64 characters");
  if (!inRange(d.passwordHistory, LIMITS.passwordHistory)) out.push("Password history: 12 to 24 passwords");
  if (!d.reminderDays.length) out.push("Keep at least one reminder day");
  else if (Math.max(...d.reminderDays) >= d.passwordLifetimeDays)
    out.push("Reminders must come before the password expires");
  return out;
}

/** Adds a reminder day (1–30, at most 5), kept unique and in descending order. */
export function addReminderDay(days: number[], day: number): number[] {
  if (!inRange(day, LIMITS.reminderDay) || days.includes(day) || days.length >= 5) return days;
  return [...days, day].sort((a, b) => b - a);
}
export const removeReminderDay = (days: number[], day: number) => days.filter((d) => d !== day);

export const sameSettings = (a: SecuritySettingsInput, b: SecuritySettingsInput) =>
  JSON.stringify({ ...a, reminderDays: [...a.reminderDays].sort() }) ===
  JSON.stringify({ ...b, reminderDays: [...b.reminderDays].sort() });

export const STATES: { key: PasswordState; label: string; tone: "good" | "warning" | "error" | "neutral" }[] = [
  { key: "ok", label: "OK", tone: "good" },
  { key: "expiring", label: "Expiring (7 days)", tone: "warning" },
  { key: "expired", label: "Expired", tone: "error" },
  { key: "temporary", label: "Temporary", tone: "warning" },
  { key: "must_change", label: "Must change", tone: "warning" },
];

/** "Reminders 7, 3 and 1 days before; expires every 30 days." */
export function policyLine(d: SecuritySettingsInput): string {
  const days = [...d.reminderDays].sort((a, b) => b - a);
  const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}` : String(days[0] ?? "");
  return `Expires every ${d.passwordLifetimeDays} days · reminders ${list} day${days.length === 1 && days[0] === 1 ? "" : "s"} before`;
}
