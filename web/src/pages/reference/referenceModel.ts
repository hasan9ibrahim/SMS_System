// Pure helpers for the §6.1 reference-data pages: import summaries, CSV templates and the
// MCCMNC code shown for a destination (an empty MNC is the country's "All networks" code).
import type { ImportResult } from "@sms/contract";

export type ImportKind = "destinations" | "dial_codes" | "mo_numbers";

/** Header row and one example line per import (§6.1 import modals). */
export const TEMPLATES: Record<ImportKind, string> = {
  destinations: "mcc,mnc,original_mnc,country,network\n262,01,,Germany,Example Network\n262,,,Germany,\n",
  dial_codes: "prefix,mccmnc\n4915,26201\n",
  mo_numbers:
    "customer_trunk,number,keyword,rate,vendor_rate,mccmnc,setup_charge,fix_charge\nEXAMPLE_TRUNK,491701234567,INFO,0.02,0.01,26201,0,10\n",
};

/** One line for the toast and the dialog: what the import does or did. */
export function importSummary(r: ImportResult): string {
  const parts = [
    r.added && `${r.added.toLocaleString("en-US")} to add`,
    r.updated && `${r.updated.toLocaleString("en-US")} to change`,
    r.archived && `${r.archived.toLocaleString("en-US")} to archive`,
    r.unchanged && `${r.unchanged.toLocaleString("en-US")} unchanged`,
  ].filter(Boolean) as string[];
  const text = parts.length ? parts.join(", ") : "nothing to change";
  return r.applied
    ? text.replaceAll(" to add", " added").replaceAll(" to change", " changed").replaceAll(" to archive", " archived")
    : text;
}

/** Whether "Import" can run after a dry run. */
export const canApply = (r: ImportResult | null) =>
  !!r && r.errors.length === 0 && r.added + r.updated + r.archived > 0;

/** The code an MCC + MNC pair makes, as the grid shows it ("262 · all" for a country). */
export const codeLabel = (mcc: string, mnc: string) => (mnc === "" ? `${mcc} · all` : `${mcc}${mnc}`);
