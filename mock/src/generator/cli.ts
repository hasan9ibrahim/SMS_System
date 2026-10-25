/**
 * Fake data generator CLI (build-order step 2).
 *
 *   npm run gen -- [--profile small|full] [--seed 42] [--anchor 2026-10-16T12:00:00Z]
 *                  [--target db|csv] [--out out] [--edrs N] [--days N]
 *                  [--skip-edrs] [--edrs-only] [--no-reset]
 *
 * target db  (default): config -> PostgreSQL, EDRs -> ClickHouse (docker-compose services;
 *                       connection values from the root .env: POSTGRES_*, CLICKHOUSE_*).
 * target csv:           config -> <out>/<table>.csv, EDRs -> <out>/edr.tsv.gz.
 */
import { join, resolve } from "node:path";
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROFILES } from "./profiles.js";
import { TableSink } from "./sink.js";
import { generateWorld, Rng } from "./index.js";
import { generateEdrs } from "./edr.js";
import { clickHouseWriter, fileWriter, loadPostgres, resetClickHouse } from "./loaders.js";
import { MINUTE } from "./world.js";
import { markUpgradesApplied } from "../upgrades.js";
import { closeDb } from "../db.js";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string", default: "small" },
    seed: { type: "string", default: "42" },
    anchor: { type: "string" },
    target: { type: "string", default: "db" },
    out: { type: "string", default: "out" },
    edrs: { type: "string" },
    days: { type: "string" },
    "skip-edrs": { type: "boolean", default: false },
    "edrs-only": { type: "boolean", default: false },
    "no-reset": { type: "boolean", default: false },
  },
});

const profile = PROFILES[args.profile!];
if (!profile) throw new Error(`unknown profile ${args.profile}; use ${Object.keys(PROFILES).join(" | ")}`);
if (args.target !== "db" && args.target !== "csv") throw new Error("--target must be db or csv");
const anchor = args.anchor ? Date.parse(args.anchor) : Math.floor(Date.now() / MINUTE) * MINUTE;
if (Number.isNaN(anchor)) throw new Error(`bad --anchor ${args.anchor}`);
const edrCount = args.edrs ? Number(args.edrs) : profile.edrs;
const edrDays = args.days ? Number(args.days) : profile.edrDays;

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const outDir = resolve(args.out!);
const stagingDir = args.target === "csv" ? outDir : join(outDir, ".staging");
rmSync(stagingDir, { recursive: true, force: true });

log(`profile=${profile.name} seed=${args.seed} anchor=${new Date(anchor).toISOString()} target=${args.target}`);
const sink = new TableSink(stagingDir);
const world = await generateWorld({ seed: args.seed!, profile, anchor, sink, log });
await sink.close();
const counts = sink.counts();
log(
  "config rows: " +
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v.toLocaleString("en-US")}`)
      .join(", "),
);

if (args.target === "db" && !args["edrs-only"]) {
  await loadPostgres(stagingDir, { reset: !args["no-reset"], log });
  // The seed is the current schema: the upgrade scripts are already applied (backend step 11).
  await markUpgradesApplied();
  await closeDb();
}

if (!args["skip-edrs"]) {
  let writer;
  if (args.target === "db") {
    if (!args["no-reset"]) await resetClickHouse(log);
    writer = clickHouseWriter();
  } else {
    writer = fileWriter(join(outDir, "edr.tsv.gz"));
  }
  let lastLog = 0;
  const started = Date.now();
  const n = await generateEdrs(world, new Rng(`${args.seed}:edr`), writer, {
    count: edrCount,
    days: edrDays,
    onProgress: (done, total) => {
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        log(`edrs: ${done.toLocaleString("en-US")} rows (~${Math.round((done / total) * 100)}% of messages)`);
      }
    },
  });
  const secs = (Date.now() - started) / 1000;
  log(
    `edrs: ${n.toLocaleString("en-US")} rows over ${edrDays} days in ${secs.toFixed(1)}s (${Math.round(n / secs).toLocaleString("en-US")} rows/s)`,
  );
}
if (args.target === "db") rmSync(stagingDir, { recursive: true, force: true });
log("done");
