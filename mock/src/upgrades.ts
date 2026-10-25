// Database upgrades on start (team trial round 2): a server that keeps its data gets the schema changes of a new
// image without anyone running SQL by hand. Every script in db/postgres/upgrades runs in name order, each in one
// transaction under an advisory lock (two mock containers never run it at once). The scripts are idempotent (each
// one-time step is guarded by upgrade_marks); a script also runs only when its content changed since it was last
// applied, recorded in upgrade_marks as "script:<file>:<sha256>". A database that is not seeded yet is skipped and
// tried again later. The Elixir backend will replace this with its own migrations.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { db, PG_SCHEMA } from "./db.js";
import { chQuery } from "./edr.js";

// SMS_DB_DIR: the SQL files in the bundled server image (deploy/Dockerfile.mock); else the repo's db/.
const UPGRADES_DIR = join(
  process.env.SMS_DB_DIR ?? fileURLToPath(new URL("../../db/", import.meta.url)),
  "postgres",
  "upgrades",
);
const LOCK_KEY = 4_242_017; // pg_advisory_xact_lock key for upgrades
const CH_MIGRATIONS_DIR = join(
  process.env.SMS_DB_DIR ?? fileURLToPath(new URL("../../db/", import.meta.url)),
  "clickhouse",
  "migrations",
);

/**
 * The EDR store's schema files, run in order (they are idempotent: IF NOT EXISTS), so a kept EDR store gets new
 * columns too (team trial round 2: both sides of translated fields). Skipped while the EDR table does not exist.
 */
export async function applyChMigrations(dir = CH_MIGRATIONS_DIR): Promise<number> {
  if (!existsSync(dir)) return 0;
  const exists = await chQuery<{ n: number }>(
    "SELECT count() AS n FROM system.tables WHERE database = currentDatabase() AND name = 'edr'",
  );
  if (!Number(exists[0]?.n)) throw new Error("EDR store not seeded yet");
  let n = 0;
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(dir, f), "utf8").replace(/^\s*--.*$/gm, "");
    for (const stmt of sql
      .split(/;\s*$/m)
      .map((x) => x.trim())
      .filter(Boolean)) {
      await chQuery(stmt, 120_000);
      n++;
    }
  }
  return n;
}

export interface UpgradeResult {
  applied: string[];
  upToDate: string[];
}

export function upgradeScripts(dir = UPGRADES_DIR): { name: string; sql: string; mark: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      const sha = createHash("sha256").update(sql).digest("hex").slice(0, 16);
      return { name, sql, mark: `script:${name}:${sha}` };
    });
}

/**
 * Records every upgrade script and its one-time steps as applied, after a fresh seed: the seed already builds the
 * current schema (backend step 11). Without it the first start (or a test) ran the whole script against a live
 * database, taking table locks under running requests.
 */
export async function markUpgradesApplied(pool: pg.Pool = db(), dir = UPGRADES_DIR): Promise<void> {
  const marks = [...upgradeScripts(dir).map((s) => s.mark), ...ONE_TIME_STEPS];
  await pool.query(
    "CREATE TABLE IF NOT EXISTS upgrade_marks (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  await pool.query("INSERT INTO upgrade_marks (name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [marks]);
}

/** The scripts' one-time data steps (guarded by these marks inside the scripts); a fresh seed needs none of them. */
const ONE_TIME_STEPS = ["priority_high_first", "market_unlisted_tier1"];

/** Applies the upgrade scripts that changed since they last ran. Throws when the database is down or a script fails. */
export async function applyUpgrades(pool: pg.Pool = db(), dir = UPGRADES_DIR): Promise<UpgradeResult> {
  const result: UpgradeResult = { applied: [], upToDate: [] };
  const scripts = upgradeScripts(dir);
  if (!scripts.length) return result;
  const client = await pool.connect();
  try {
    // Not seeded yet: nothing to upgrade (the seed builds the current schema).
    const { rows } = await client.query("SELECT to_regclass($1) AS t", [`${PG_SCHEMA}.enterprises`]);
    if (!rows[0].t) throw new Error("database not seeded yet");
    for (const s of scripts) {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL search_path = ${PG_SCHEMA}, public`);
        await client.query("SET LOCAL statement_timeout = 0");
        await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
        await client.query(
          "CREATE TABLE IF NOT EXISTS upgrade_marks (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
        );
        const done = await client.query("SELECT 1 FROM upgrade_marks WHERE name = $1", [s.mark]);
        if (done.rowCount) {
          await client.query("COMMIT");
          result.upToDate.push(s.name);
          continue;
        }
        await client.query(s.sql);
        await client.query("INSERT INTO upgrade_marks (name) VALUES ($1) ON CONFLICT DO NOTHING", [s.mark]);
        await client.query("COMMIT");
        result.applied.push(s.name);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`upgrade ${s.name} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    client.release();
  }
  return result;
}

/**
 * Runs the upgrades before the server starts serving; when the database is not reachable or not seeded yet it
 * retries every minute in the background. A failing script is logged and retried the same way.
 */
export async function upgradeOnStart(log: (msg: string) => void, retryMs = 60_000): Promise<void> {
  let lastError = "";
  let pgDone = false;
  let chDone = false;
  const attempt = async (): Promise<boolean> => {
    const errors: string[] = [];
    if (!pgDone)
      try {
        const r = await applyUpgrades();
        log(
          r.applied.length
            ? `database upgraded: ${r.applied.join(", ")}`
            : `database schema up to date (${r.upToDate.length} upgrade script(s))`,
        );
        pgDone = true;
      } catch (e) {
        errors.push((e as Error).message);
      }
    if (!chDone)
      try {
        log(`EDR store schema checked (${await applyChMigrations()} statement(s))`);
        chDone = true;
      } catch (e) {
        errors.push(`EDR store: ${(e as Error).message}`);
      }
    const msg = errors.join("; ");
    if (msg && msg !== lastError) log(`database upgrade postponed: ${msg}; retrying every ${retryMs / 1000} s`);
    lastError = msg;
    return pgDone && chDone;
  };
  if (await attempt()) return;
  const timer = setInterval(() => {
    void attempt().then((ok) => ok && clearInterval(timer));
  }, retryMs);
  timer.unref();
}
