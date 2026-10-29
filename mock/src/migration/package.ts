// Migration export package (§13.22): one encrypted file holding every entity as its own CSV plus a
// manifest of record counts and links. Layout:
//   "SMSPKG1\n" + JSON header {kdf, salt, iv, cipher} + "\n" + AES-256-GCM(gzip(frames)) + 16-byte tag
// where each frame is "<name>\n<byte length>\n<bytes>\n" and the first frame is manifest.json.
// The key comes from the export password through scrypt; the password is never stored.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import type pg from "pg";
import { to as copyTo } from "pg-copy-streams";
import type { MigrationExportInput, MigrationManifest, MigrationManifestEntity } from "@sms/contract";
import { production } from "../mode.js";
import { CREDENTIAL, EXPORT_TABLES, NEVER, SECRET } from "./entities.js";

const MAGIC = "SMSPKG1\n";
const TAG = 16;
/**
 * Export packages and unpacking work. In production the service's working folder (/opt/sms/service/work), which a
 * restart keeps (R9: its private /tmp is emptied on every restart, so packages vanished after an update).
 */
export const PACKAGE_DIR =
  process.env.SMS_MIGRATION_DIR ?? (production ? join(process.cwd(), "migration") : join(tmpdir(), "sms-migration"));

export class PackageError extends Error {}

/** Links listed in the manifest: how many rows of `from` point at `to` through `via`. */
const LINKS: { from: string; to: string; via: string }[] = [
  { from: "users", to: "departments", via: "department_id" },
  { from: "enterprises", to: "business_companies", via: "business_company_id" },
  { from: "enterprises", to: "users", via: "account_manager_id" },
  { from: "enterprise_contacts", to: "enterprises", via: "enterprise_id" },
  { from: "customer_trunks", to: "enterprises", via: "enterprise_id" },
  { from: "vendor_trunks", to: "enterprises", via: "enterprise_id" },
  { from: "rate_tables", to: "vendor_trunks", via: "vendor_trunk_id" },
  { from: "customer_trunk_rate_tables", to: "customer_trunks", via: "customer_trunk_id" },
  { from: "rate_lines", to: "rate_tables", via: "rate_table_id" },
  { from: "route_rule_vendors", to: "route_rules", via: "route_rule_id" },
  { from: "route_rule_vendors", to: "vendor_trunks", via: "vendor_trunk_id" },
  { from: "translation_rule_targets", to: "translation_rules", via: "translation_rule_id" },
  { from: "enterprise_billing", to: "enterprises", via: "enterprise_id" },
  { from: "transactions", to: "enterprises", via: "enterprise_id" },
];

type Options = Pick<MigrationExportInput, "includeCredentials" | "withPasswords" | "rateLines">;

/** Columns a table exports with these options (login secrets of our own users never go). */
export async function exportColumns(c: pg.Pool | pg.PoolClient, table: string, opts: Options) {
  const { rows } = await c.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'sms' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows
    .filter((r) => {
      const col = r.column_name as string;
      if (NEVER.test(col)) return false;
      const textual = /text|char|ARRAY|inet/.test(r.data_type);
      if (textual && SECRET.test(col)) return opts.includeCredentials && opts.withPasswords;
      // A user's username is their login name (business data), not a connection detail.
      if (table !== "users" && CREDENTIAL.test(col)) return opts.includeCredentials;
      return true;
    })
    .map((r) => r.column_name as string);
}

/** Tables that archive records (deleted_at), so "live" can skip archived ones. */
async function archiving(c: pg.PoolClient) {
  const { rows } = await c.query(
    "SELECT table_name FROM information_schema.columns WHERE table_schema = 'sms' AND column_name = 'deleted_at'",
  );
  return new Set(rows.map((r) => r.table_name as string));
}

function whereOf(t: (typeof EXPORT_TABLES)[number], opts: Options, archived: Set<string>) {
  const parts: string[] = [];
  if (t.live && archived.has(t.from)) parts.push("deleted_at IS NULL");
  if (t.entity === "rate_lines" && opts.rateLines === "current") parts.push("(valid_to IS NULL OR valid_to > now())");
  // Children of archived records stay out, so every link in the package resolves.
  for (const [col, parent] of Object.entries(t.parents ?? {}))
    if (archived.has(parent)) parts.push(`${col} IN (SELECT id FROM sms.${parent} WHERE deleted_at IS NULL)`);
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

function frameHeader(name: string, bytes: number) {
  return Buffer.from(`${name}\n${bytes}\n`, "utf8");
}

/** Writes the package to `outPath`; returns the manifest and file size. */
export async function writePackage(
  pool: pg.Pool,
  opts: Options,
  password: string,
  outPath: string,
  platformVersion: string,
): Promise<{ manifest: MigrationManifest; sizeBytes: number }> {
  await mkdir(PACKAGE_DIR, { recursive: true });
  const work = join(PACKAGE_DIR, `work-${randomBytes(6).toString("hex")}`);
  await mkdir(work);
  try {
    const tables = EXPORT_TABLES.filter((t) => !(t.entity === "rate_lines" && opts.rateLines === "none"));
    const entities: MigrationManifestEntity[] = [];
    const files: { name: string; path: string; size: number }[] = [];
    const client = await pool.connect();
    try {
      // A full package (all rate line history) takes longer than the API's statement timeout.
      await client.query("SET statement_timeout = 0");
      const archived = await archiving(client);
      for (const t of tables) {
        const cols = await exportColumns(client, t.from, opts);
        const where = whereOf(t, opts, archived);
        const select = `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM sms.${t.from} ${where} ORDER BY 1`;
        const path = join(work, `${t.entity}.csv`);
        await pipeline(
          client.query(copyTo(`COPY (${select}) TO STDOUT WITH (FORMAT csv, HEADER)`)),
          createWriteStream(path),
        );
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM sms.${t.from} ${where}`);
        entities.push({ entity: t.entity, rows: rows[0].n, sensitivity: t.sensitivity });
        files.push({ name: `${t.entity}.csv`, path, size: (await stat(path)).size });
      }
      const links = [];
      for (const l of LINKS) {
        const t = tables.find((x) => x.entity === l.from);
        if (!t || !tables.some((x) => x.entity === l.to)) continue;
        const where = whereOf(t, opts, archived);
        const { rows } = await client.query(`SELECT count(${l.via})::int AS n FROM sms.${t.from} ${where}`);
        links.push({ ...l, count: rows[0].n });
      }
      const manifest: MigrationManifest = {
        createdAt: new Date().toISOString(),
        platformVersion,
        entities,
        links,
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");

      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = scryptSync(password, salt, 32);
      const header = {
        format: 1,
        kdf: "scrypt",
        n: 16384,
        r: 8,
        p: 1,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        cipher: "aes-256-gcm",
        compression: "gzip",
      };
      await writeFile(outPath, `${MAGIC}${JSON.stringify(header)}\n`);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      async function* frames() {
        yield frameHeader("manifest.json", manifestBytes.length);
        yield manifestBytes;
        yield Buffer.from("\n");
        for (const f of files) {
          yield frameHeader(f.name, f.size);
          for await (const chunk of createReadStream(f.path)) yield chunk as Buffer;
          yield Buffer.from("\n");
        }
      }
      await pipeline(Readable.from(frames()), createGzip(), cipher, createWriteStream(outPath, { flags: "a" }));
      await appendFile(outPath, cipher.getAuthTag());
      return { manifest, sizeBytes: (await stat(outPath)).size };
    } finally {
      await client.query("RESET statement_timeout").catch(() => undefined);
      client.release();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Opens a package: every frame by name (manifest.json and one CSV per entity). */
export async function readPackage(path: string, password: string): Promise<Map<string, string>> {
  const buf = await readFile(path);
  if (buf.subarray(0, MAGIC.length).toString("utf8") !== MAGIC) throw new PackageError("Not a migration package");
  const nl = buf.indexOf(10, MAGIC.length);
  let header: { salt: string; iv: string; n?: number; r?: number; p?: number };
  try {
    header = JSON.parse(buf.subarray(MAGIC.length, nl).toString("utf8"));
  } catch {
    throw new PackageError("The package header is damaged");
  }
  const body = buf.subarray(nl + 1, buf.length - TAG);
  const key = scryptSync(password, Buffer.from(header.salt, "base64"), 32, {
    N: header.n ?? 16384,
    r: header.r ?? 8,
    p: header.p ?? 1,
  });
  let plain: Buffer;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
    d.setAuthTag(buf.subarray(buf.length - TAG));
    plain = gunzipSync(Buffer.concat([d.update(body), d.final()]));
  } catch {
    throw new PackageError("Wrong package password, or the file is damaged");
  }
  const out = new Map<string, string>();
  let at = 0;
  while (at < plain.length) {
    const e1 = plain.indexOf(10, at);
    const e2 = plain.indexOf(10, e1 + 1);
    if (e1 < 0 || e2 < 0) break;
    const name = plain.subarray(at, e1).toString("utf8");
    const len = Number(plain.subarray(e1 + 1, e2).toString("utf8"));
    out.set(name, plain.subarray(e2 + 1, e2 + 1 + len).toString("utf8"));
    at = e2 + 1 + len + 1;
  }
  return out;
}
