/**
 * Loaders: PostgreSQL (schema reset + COPY of the generated CSV files in
 * dependency order) and ClickHouse / gzip file writers for EDRs.
 */
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { EDR_COLUMNS, type EdrWriter } from "./edr.js";
import { PG_CONFIG, PG_SCHEMA } from "../db.js";

const DB_DIR = fileURLToPath(new URL("../../../db/", import.meta.url));

/** FK-safe load order. Every generated table must be listed. */
export const TABLE_ORDER = [
  "currencies",
  "business_companies",
  "departments",
  "access_groups",
  "users",
  "currency_rates",
  "billing_cycles",
  "product_categories",
  "countries",
  "mccmnc",
  "dial_code_profiles",
  "dial_codes",
  "enterprises",
  "enterprise_contacts",
  "enterprise_am_history",
  "enterprise_billing",
  "enterprise_beneficiaries",
  "vendor_trunks",
  "customer_trunks",
  "rate_tables",
  "customer_trunk_rate_tables",
  "rate_lines",
  "rate_imports",
  "number_lists",
  "number_list_entries",
  "route_rule_groups",
  "route_rules",
  "route_rule_vendors",
  "route_rule_whitelists",
  "translation_rules",
  "translation_rule_targets",
  "translation_rule_trunk_settings",
  "hlr_providers",
  "hlr_rules",
  "hlr_rule_targets",
  "hlr_rule_trunk_settings",
  "hlr_provider_rates",
  "hlr_policies",
  "invoices",
  "transactions",
  "invoice_requests",
  "soa_reports",
  "vendor_invoices",
  "vendor_invoice_events",
  "vendor_invoice_lines",
  "recon_rules",
  "mo_numbers",
  "rerating_requests",
  "rerating_results",
  "qbr_stats",
  "changes",
];

export async function loadPostgres(dir: string, opts: { reset: boolean; log: (s: string) => void }): Promise<void> {
  const client = new pg.Client({ ...PG_CONFIG, options: `-c search_path=${PG_SCHEMA},public` });
  await client.connect();
  try {
    if (opts.reset) {
      opts.log("postgres: resetting schema");
      await client.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
      for (const dir of ["init", "migrations"]) {
        const base = join(DB_DIR, "postgres", dir);
        for (const f of readdirSync(base)
          .filter((x) => x.endsWith(".sql"))
          .sort()) {
          await client.query(readFileSync(join(base, f), "utf8"));
        }
      }
      await client.query(`SET search_path = ${PG_SCHEMA}, public`);
    }
    // Drop FK and exclusion constraints during COPY and re-add them afterwards: they
    // are still fully checked, but in bulk instead of one trigger call per row.
    const { rows: constraints } = await client.query<{ tbl: string; name: string; def: string; type: string }>(
      `SELECT conrelid::regclass::text AS tbl, conname AS name, pg_get_constraintdef(oid) AS def, contype AS type
         FROM pg_constraint WHERE connamespace = '${PG_SCHEMA}'::regnamespace AND contype IN ('f', 'x')`,
    );
    for (const c of constraints) await client.query(`ALTER TABLE ${c.tbl} DROP CONSTRAINT ${c.name}`);

    const files = new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith(".csv"))
        .map((f) => f.slice(0, -4)),
    );
    for (const f of files) if (!TABLE_ORDER.includes(f)) throw new Error(`table ${f} is not in TABLE_ORDER`);
    for (const table of TABLE_ORDER) {
      if (!files.has(table)) continue;
      const path = join(dir, `${table}.csv`);
      const header = readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, 4096).split("\n")[0]!;
      const started = Date.now();
      await pipeline(
        createReadStream(path),
        client.query(copyFrom(`COPY ${table} (${header}) FROM STDIN WITH (FORMAT csv, HEADER true)`)),
      );
      // Identity columns continue after the generated ids.
      if (header.split(",")[0]! === "id") {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT max(id) FROM ${table}), 1))`,
        );
      }
      opts.log(`postgres: ${table} loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    const started = Date.now();
    for (const c of [...constraints].sort((a, b) => (a.type === b.type ? 0 : a.type === "x" ? -1 : 1))) {
      await client.query(`ALTER TABLE ${c.tbl} ADD CONSTRAINT ${c.name} ${c.def}`);
    }
    opts.log(
      `postgres: ${constraints.length} foreign key and exclusion constraints validated in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    // Views and counts built on the loaded rates (migration 004, §13.12).
    await client.query("REFRESH MATERIALIZED VIEW best_buy_rates");
    await client.query("SELECT refresh_rate_table_stats()");
    // VACUUM also sets the visibility map, so count queries can use index-only scans.
    await client.query("VACUUM ANALYZE");
  } finally {
    await client.end();
  }
}

const env = process.env;
const CH_URL = `http://${env.CLICKHOUSE_HOST ?? "localhost"}:${env.CLICKHOUSE_HTTP_PORT ?? 8123}`;
const CH_DB = env.CLICKHOUSE_DB ?? "sms_edr";
const CH_USER = env.CLICKHOUSE_USER ?? "sms_dev";
const CH_PASSWORD = env.CLICKHOUSE_PASSWORD ?? "sms_dev_password";

/** One HTTP request per call, no keep-alive (a reused idle socket can be closed by the server mid-insert). */
export function clickhouse(sql: string, body = "", database = CH_DB): Promise<string> {
  const url = new URL(CH_URL);
  url.searchParams.set("query", sql);
  url.searchParams.set("database", database);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "X-ClickHouse-User": CH_USER,
          "X-ClickHouse-Key": CH_PASSWORD,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (d: Buffer) => parts.push(d));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString("utf8");
          if ((res.statusCode ?? 500) >= 300) reject(new Error(`ClickHouse ${res.statusCode}: ${text.slice(0, 500)}`));
          else resolve(text);
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export async function resetClickHouse(log: (s: string) => void): Promise<void> {
  log(`clickhouse: recreating EDR tables in ${CH_DB}`);
  await clickhouse(`CREATE DATABASE IF NOT EXISTS ${CH_DB}`, "", "default");
  for (const t of ["edr_hourly_mv", "edr_hourly", "edr"]) await clickhouse(`DROP TABLE IF EXISTS ${t} SYNC`);
  const base = join(DB_DIR, "clickhouse", "migrations");
  for (const f of readdirSync(base)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(base, f), "utf8").replace(/^\s*--.*$/gm, "");
    for (const stmt of sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean))
      await clickhouse(stmt);
  }
}

export function clickHouseWriter(): EdrWriter {
  const query = `INSERT INTO edr (${EDR_COLUMNS.join(",")}) FORMAT TabSeparated`;
  return {
    write: async (chunk) => {
      await clickhouse(query, chunk);
    },
    close: async () => {},
  };
}

export function fileWriter(path: string): EdrWriter {
  const gz = createGzip({ level: 4 });
  const out = createWriteStream(path);
  const done = pipeline(gz, out);
  gz.write(EDR_COLUMNS.join("\t") + "\n");
  return {
    write: async (chunk) => {
      if (!gz.write(chunk)) await new Promise<void>((r) => gz.once("drain", r));
    },
    close: async () => {
      gz.end();
      await done;
    },
  };
}

export function hasFile(dir: string, table: string): boolean {
  return existsSync(join(dir, `${table}.csv`));
}
