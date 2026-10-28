import type { ValueMatch } from "@sms/contract";

/**
 * Sender ID / receiver value rows (team trial round 8, §6.3, §6.4): any row matching is a hit. Each row has its own
 * match (the whole value, its start or anywhere in it) and case.
 */
export function valuesHit(rows: readonly ValueMatch[] | null | undefined, value: string): boolean {
  return (rows ?? []).some((r) => {
    const v = r.matchCase ? value : value.toLowerCase();
    const want = r.matchCase ? r.value : r.value.toLowerCase();
    return r.match === "is" ? v === want : r.match === "starts" ? v.startsWith(want) : v.includes(want);
  });
}

/** The rows as text for a test result: is "BANK" (case) · starts "44" (any case). */
export function valuesText(rows: readonly ValueMatch[]): string {
  return rows
    .map((r) => `${r.match === "is" ? "is" : r.match === "starts" ? "starts with" : "contains"} "${r.value}"${r.matchCase ? "" : " (any case)"}`)
    .join(" or ");
}
