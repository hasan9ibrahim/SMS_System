// Removes EDRs a test wrote, with what the materialized views took from them on insert: the hourly figures
// (ClickHouse 001/005) and the long-term totals (008), so reports on the totals keep matching the detailed EDRs.
import { chQuery } from "../src/edr.js";

/** Deletes the attempt and receipt rows matching `where` (on columns all of these tables have) everywhere. */
export async function deleteTestEdrs(where: string): Promise<void> {
  for (const t of ["edr", "edr_receipt", "edr_hourly", "edr_totals", "edr_sender_daily"])
    await chQuery(`ALTER TABLE ${t} DELETE WHERE ${where} SETTINGS mutations_sync = 1`);
}
