/**
 * Builds the MCC/MNC master list used by the generator (spec §6.1, §13.21).
 *
 * Input:  the public mcc-mnc-table CSV (MIT, github.com/musalbas/mcc-mnc-table),
 *         snapshot kept in data/source/.
 * Output: data/mccmnc.csv with one row per unique MCCMNC:
 *         mcc,mnc,mccmnc,iso,country,dial_code,network
 *
 * Cleaning: drops placeholder rows ("Failed Calls", "Unknown", empty network),
 * international/test MCCs (001, 901, 999), keeps the first row per MCCMNC and
 * fills the few missing dial codes. The per-MCC "All networks" codes are added by
 * the generator, not stored here.
 *
 * Usage: tsx scripts/build-mccmnc.ts <input.csv> <output.csv>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: build-mccmnc <input.csv> <output.csv>");
  process.exit(1);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const csvField = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const DROP_NETWORKS = new Set(["", "failed calls", "unknown", "test network", "test"]);
const DROP_MCC = new Set(["001", "901", "999"]);
// Missing in the source table.
const DIAL_FIX: Record<string, string> = { pr: "1", ss: "211", tc: "1" };

const rows = readFileSync(input, "utf8").trim().split(/\r?\n/).slice(1).map(parseCsvLine);
const field = (r: string[], i: number) => r[i] ?? "";
const seen = new Map<string, string[]>();
for (const r of rows) {
  const [mcc, mnc, isoRaw, country, dialRaw, networkRaw] = [0, 2, 4, 5, 6, 7].map((i) => field(r, i)) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const network = networkRaw
    .trim()
    .replace(/\s*\($/, "")
    .replace(/\s+/g, " ");
  if (DROP_NETWORKS.has(network.toLowerCase()) || DROP_MCC.has(mcc)) continue;
  const iso = isoRaw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso)) continue;
  const dial = (dialRaw.trim() || DIAL_FIX[isoRaw.trim()] || "").split(/[^0-9]/)[0] ?? "";
  if (!dial) continue;
  const key = mcc + mnc;
  if (seen.has(key)) continue;
  seen.set(key, [mcc, mnc, key, iso, country.trim(), dial, network]);
}

const sorted = [...seen.values()].sort(
  (a, b) =>
    field(a, 4).localeCompare(field(b, 4)) ||
    field(a, 6).localeCompare(field(b, 6)) ||
    field(a, 2).localeCompare(field(b, 2)),
);
const lines = ["mcc,mnc,mccmnc,iso,country,dial_code,network", ...sorted.map((r) => r.map(csvField).join(","))];
writeFileSync(output, lines.join("\n") + "\n");
console.log(`wrote ${sorted.length} MCCMNC rows, ${new Set(sorted.map((r) => r[3])).size} countries -> ${output}`);
