// PostgreSQL access for the mock server (configuration data seeded by the generator).
// Connection settings come from the repo's .env (see .env.example); defaults match it.
import pg from "pg";
import type { FastifyReply } from "fastify";
import { sendProblem } from "./problem.js";

const env = process.env;
export const PG_CONFIG = {
  host: env.POSTGRES_HOST ?? "localhost",
  port: Number(env.POSTGRES_PORT ?? 5432),
  database: env.POSTGRES_DB ?? "sms_config",
  user: env.POSTGRES_USER ?? "sms_dev",
  password: env.POSTGRES_PASSWORD ?? "sms_dev_password",
};
/** Application schema (db/postgres/init creates it; the Elixir backend uses the same one). */
export const PG_SCHEMA = "sms";

// int8 and numeric come back as strings by default; ids and counts fit in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

let pool: pg.Pool | null = null;
export function db(): pg.Pool {
  pool ??= new pg.Pool({
    ...PG_CONFIG,
    max: 10,
    connectionTimeoutMillis: 2000,
    options: `-c search_path=${PG_SCHEMA},public -c statement_timeout=15000`,
  });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

export class Unavailable extends Error {}

/** Connection refused, unknown database, or schema not created / not seeded / outdated. */
function isUnavailable(err: unknown): boolean {
  const e = err as { code?: string; errors?: unknown[] };
  if (Array.isArray(e.errors) && e.errors.some(isUnavailable)) return true;
  return (
    [
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "3D000",
      "42P01",
      "42703",
      "3F000",
      "28P01",
      "57P03",
    ].includes(e.code ?? "") ||
    (err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message))
  );
}

/** Runs a handler body; a missing or unseeded database becomes the contract's 503. */
export async function withDb<T>(reply: FastifyReply, fn: (pool: pg.Pool) => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn(db());
  } catch (err) {
    if (err instanceof Unavailable || isUnavailable(err)) {
      return sendProblem(reply, 503, "Data store unavailable", {
        detail: "Start and seed the local databases: npm run db:up && npm run seed:small",
      });
    }
    throw err;
  }
}

/** True when the seeded database answers (used by tests to skip DB-backed checks). */
export async function dbReady(): Promise<boolean> {
  try {
    await db().query("SELECT 1 FROM enterprises LIMIT 1");
    return true;
  } catch {
    return false;
  }
}
