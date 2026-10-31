// Texts and counts of the bulk delete and restore dialogs (§13.29), kept apart from the dialogs so they can be tested.
import type { BulkRecordsResult } from "@sms/contract";

export type BulkMode = "delete" | "restore";

/** Names shown in a sentence: the first few, then "…". */
const SHOWN = 5;

const n = (count: number) => count.toLocaleString("en-US");
/** "1 MCCMNC code", "12 MCCMNC codes". */
export const countOf = (count: number, noun: string, plural: string) => `${n(count)} ${count === 1 ? noun : plural}`;

/** "Delete 12 MCCMNC codes: 23410, 23415, 23420, 23430, 23433, …" — the count and the first records. */
export function selectionSentence(verb: string, names: string[], noun: string, plural: string): string {
  const head = names.slice(0, SHOWN).join(", ");
  return `${verb} ${countOf(names.length, noun, plural)}${head ? `: ${head}${names.length > SHOWN ? ", …" : ""}` : ""}`;
}

/** The second confirmation: "Are you sure? 12 MCCMNC codes will be deleted." */
export const secondConfirmText = (count: number, noun: string, plural: string, mode: BulkMode = "delete") =>
  `Are you sure? ${countOf(count, noun, plural)} will be ${mode === "delete" ? "deleted" : "restored"}.`;

/** How many rows the request would change: those the dry run accepts, and with an override the overridable ones. */
export const willChange = (r: Pick<BulkRecordsResult, "done" | "refused">, override: boolean) =>
  r.done.length + (override ? r.refused.filter((x) => x.overridable).length : 0);

/** The names the first dialog lists: the rows that go, with an override the overridable refused ones too. */
export const goingNames = (r: Pick<BulkRecordsResult, "done" | "refused">, override: boolean) =>
  [...r.done, ...(override ? r.refused.filter((x) => x.overridable) : [])].map((x) => x.name);

/** Rows still refused: all refused ones, or with an override only those nobody may override. */
export const stillRefused = (r: Pick<BulkRecordsResult, "refused">, override: boolean) =>
  override ? r.refused.filter((x) => !x.overridable) : r.refused;
