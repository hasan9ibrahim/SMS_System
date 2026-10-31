// Migration Center (§13.22). Export: one encrypted package with every entity as its own CSV and a
// manifest; credentials only for admins with a 2FA code, logged in the audit trail and e-mailed to the
// other admins; downloads through single-use links that expire after 15 minutes. Import: CSV per entity
// from the old platform (through a saved column mapping) or a package from another installation;
// a dry run reports what would be created, updated or skipped, apply writes it as one change in History
// (undo = rollback), trunks arrive inactive and go live per partner.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  CurrentUser,
  MigrationActivate,
  MigrationExport,
  MigrationExportInput,
  MigrationFileInput,
  MigrationImport,
  MigrationImportEntity,
  MigrationImportInput,
  MigrationLinkInput,
  MigrationMapping,
  MigrationMappingInput,
  MigrationReport,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import { acceptTotp, decryptSecret, encryptSecret, TOTP_USED, totpSecretOf } from "../admin/passwords.js";
import { toCsv } from "../migration/csv.js";
import { BUILT_IN_MAPPINGS, ENTITY, IMPORT_ENTITIES, REFERENCE_PLATFORM } from "../migration/entities.js";
import { packageFiles } from "../migration/fromPackage.js";
import { applyPlan, planImport, type Entry, type ImportSettings } from "../migration/importer.js";
import { PACKAGE_DIR, PackageError, readPackage, writePackage } from "../migration/package.js";
import { logEmail } from "./emailLog.js";
import type { DiffEntry } from "./records.js";
import { iso, recordChange } from "./records.js";
import { adminSql, getCurrentUser } from "./session.js";
import { checkEmailCode, EMAIL_CODE_USED, useEmailCode } from "./admin.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
const LINK_MINUTES = 15;
export const MIGRATION_VERSION = { value: "0.0.0" };

const isAdmin = (me: CurrentUser) => me.permissions.includes("*");
const fieldError = (reply: FastifyReply, path: string, message: string) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors: [{ path, message }] });

/**
 * Admin + 2FA check for credentials. Returns null when fine, else a function that sends the problem:
 * a Fastify reply is thenable, so it must not come back through `await` directly.
 */
async function totpRefusal(c: Db, reply: FastifyReply, me: CurrentUser, code: string | null | undefined) {
  if (!isAdmin(me))
    return () => sendProblem(reply, 403, "Credentials can be exported and imported by admins only");
  const { rows } = await c.query("SELECT totp_enabled, totp_secret FROM users WHERE id = $1", [me.id]);
  const u = rows[0];
  // Without the authenticator app, the code e-mailed by sendMyCredentialCode is the second factor, as at sign-in (R9).
  // Either code works once (§13.28): it is used up here, as the last check before the export, link or import.
  if (!u?.totp_enabled || !u.totp_secret) {
    const wrong = await checkEmailCode(db(), me.id, code, "enter the code we e-mailed you (Send code)");
    if (wrong) return () => fieldError(reply, "/totpCode", wrong);
    return (await useEmailCode(c, me.id, code!)) ? null : () => fieldError(reply, "/totpCode", EMAIL_CODE_USED);
  }
  if (!code) return () => fieldError(reply, "/totpCode", "enter the code from your 2FA app");
  const refused = await acceptTotp(c, me.id, totpSecretOf(u.totp_secret), code);
  if (refused === "wrong") return () => fieldError(reply, "/totpCode", "the 2FA code does not match");
  if (refused === "used") return () => fieldError(reply, "/totpCode", TOTP_USED);
  return null;
}

/** Tells the other admins that credentials left or entered the system. */
async function notifyAdmins(c: Db, me: CurrentUser, subject: string, body: string) {
  const { rows } = await c.query(`SELECT email FROM users u WHERE ${adminSql()} AND deleted_at IS NULL AND id <> $1`, [
    me.id,
  ]);
  await logEmail(c, {
    type: "credential_transfer",
    to: rows.map((r) => r.email as string),
    subject,
    body: `${body}\n\nBy ${me.displayName} at ${new Date().toISOString()}. If this was not expected, contact them now.`,
    userId: me.id,
  });
}

// ---------------------------------------------------------------- entities, templates, mappings

export function getMigrationEntities() {
  return IMPORT_ENTITIES;
}

const EXAMPLES: Record<MigrationImportEntity, Record<string, string>> = {
  departments: { externalId: "D-10", name: "Sales", description: "Account managers", status: "active" },
  product_categories: { externalId: "PC-5", name: "OTP" },
  number_lists: { name: "Bank Sender IDs", type: "tag", value: "BANKX", content: "" },
  translation_rules: {
    externalId: "TR-700",
    name: "Strip 00 from receivers",
    direction: "",
    action: "allow",
    status: "active",
    continueAfter: "no",
    customerTrunks: "EXAMPLE_OTP",
    vendorTrunks: "",
    mccmncs: "",
    senderPattern: "",
    receiverPattern: "^00",
    contentPattern: "",
    senderList: "",
    receiverList: "",
    senderConversion: "",
    senderConversionValue: "",
    senderConversionList: "",
    receiverConversion: "left_strip",
    receiverConversionValue: "2",
    senderTon: "",
    senderNpi: "",
    destTon: "1",
    destNpi: "1",
  },
  hlr_rules: {
    externalId: "HR-30",
    name: "Nigeria lookups",
    provider: "Example HLR",
    dnidPattern: "^234",
    status: "active",
    customerTrunks: "EXAMPLE_OTP",
  },
  users: {
    externalId: "U-1001",
    username: "first.last",
    firstName: "First",
    lastName: "Last",
    email: "first.last@example.com",
    department: "Sales",
    accessGroup: "Account Manager",
    isAccountManager: "yes",
    status: "active",
  },
  enterprises: {
    externalId: "E-2001",
    name: "Example Messaging Ltd",
    alias: "EXAMPLE",
    type: "customer",
    tier: "tier2",
    status: "active",
    businessCompany: "",
    accountManager: "first.last",
    country: "AE",
    vatNumber: "",
    address: "1 Example Street",
    emails: "sales@example.com",
    technicalEmails: "noc@example.com,support@example.com",
    ratesEmails: "rates@example.com",
    financeEmails: "billing@example.com",
  },
  customer_trunks: {
    externalId: "CT-3001",
    enterprise: "Example Messaging Ltd",
    name: "EXAMPLE_OTP",
    username: "example_otp",
    password: "change-me",
    hostIps: "192.0.2.10,192.0.2.11",
    sslType: "none",
    protocol: "smpp",
    tps: "50",
    category: "OTP",
    billingType: "submit",
    tonNpiMode: "as_sent",
  },
  vendor_trunks: {
    externalId: "VT-4001",
    enterprise: "Example Messaging Ltd",
    name: "EXAMPLE_DIRECT",
    host: "smsc.example.net",
    port: "2775",
    username: "ours",
    password: "change-me",
    protocol: "smpp",
    tps: "100",
    category: "DIRECT",
    billingType: "delivery",
    tonNpiMode: "auto",
    refuseInvalidSenders: "yes",
  },
  rate_tables: {
    externalId: "RT-5001",
    name: "EXAMPLE_DIRECT USD",
    kind: "vendor",
    currency: "EUR",
    category: "DIRECT",
    vendorTrunk: "EXAMPLE_DIRECT",
    customerTrunks: "",
  },
  rate_lines: {
    rateTable: "EXAMPLE_DIRECT USD",
    mccmnc: "424",
    senderId: "",
    rate: "0.0125",
    validFrom: new Date().toISOString().slice(0, 10),
    blocked: "no",
  },
  route_rules: {
    externalId: "RR-6001",
    name: "Example OTP to AE",
    priority: "10",
    status: "active",
    customerTrunks: "EXAMPLE_OTP",
    destinations: "424",
    vendors: "EXAMPLE_DIRECT:100",
  },
  opening_balances: {
    enterprise: "Example Messaging Ltd",
    side: "customer",
    amount: "-1250.00",
    currency: "EUR",
    date: new Date().toISOString().slice(0, 10),
  },
};

export function getMigrationTemplate(request: FastifyRequest, reply: FastifyReply) {
  const { entity } = request.params as { entity: MigrationImportEntity };
  const info = ENTITY.get(entity);
  if (!info) return sendProblem(reply, 404, `No import template for ${entity}`);
  const fields = info.fields.map((f) => f.field);
  return reply
    .header("content-disposition", `attachment; filename="import_${entity}.csv"`)
    .type("text/csv; charset=utf-8")
    .send(toCsv([fields, fields.map((f) => EXAMPLES[entity][f] ?? "")]));
}

const mapMapping = (r: Record<string, unknown>): MigrationMapping => ({
  id: Number(r.id),
  sourceSystem: r.source_system as string,
  entity: r.entity as MigrationImportEntity,
  name: r.name as string,
  columns: r.columns as Record<string, string>,
  builtIn: !!r.built_in,
  updatedAt: iso(r.updated_at)!,
});
/** The ready mappings, kept as the code has them (they cannot be edited): new fields reach a kept database too. */
async function seedMappings(c: Db) {
  for (const m of BUILT_IN_MAPPINGS)
    await c.query(
      `INSERT INTO migration_mappings (source_system, entity, name, columns, built_in) VALUES ($1, $2, $1, $3, true)
       ON CONFLICT (source_system, entity, name) DO UPDATE SET columns = EXCLUDED.columns, updated_at = now()
        WHERE migration_mappings.built_in AND migration_mappings.columns IS DISTINCT FROM EXCLUDED.columns`,
      [REFERENCE_PLATFORM, m.entity, JSON.stringify(m.columns)],
    );
}

export function getMigrationMappings(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    await seedMappings(pool);
    const { rows } = await pool.query("SELECT * FROM migration_mappings ORDER BY source_system, entity, name");
    return rows.map(mapMapping);
  });
}

export function saveMigrationMapping(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as MigrationMappingInput;
  return withDb(reply, async (pool) => {
    const info = ENTITY.get(b.entity)!;
    const unknown = Object.keys(b.columns).filter((k) => !info.fields.some((f) => f.field === k));
    if (unknown.length) return fieldError(reply, "/columns", `not fields of ${info.label}: ${unknown.join(", ")}`);
    const missing = info.fields.filter((f) => f.required && !b.columns[f.field]?.trim());
    if (missing.length)
      return fieldError(reply, "/columns", `map the required fields: ${missing.map((f) => f.label).join(", ")}`);
    if (!b.sourceSystem.trim() || !b.name.trim())
      return fieldError(reply, "/name", "name the source system and the mapping");
    await seedMappings(pool);
    const { rows: cur } = await pool.query(
      "SELECT built_in FROM migration_mappings WHERE source_system = $1 AND entity = $2 AND name = $3",
      [b.sourceSystem.trim(), b.entity, b.name.trim()],
    );
    if (cur[0]?.built_in)
      return fieldError(reply, "/name", "the ready mapping cannot be replaced: save it under another name");
    const { rows } = await pool.query(
      `INSERT INTO migration_mappings (source_system, entity, name, columns) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_system, entity, name) DO UPDATE SET columns = EXCLUDED.columns, updated_at = now()
       RETURNING *`,
      [b.sourceSystem.trim(), b.entity, b.name.trim(), JSON.stringify(b.columns)],
    );
    return mapMapping(rows[0]);
  });
}

// ---------------------------------------------------------------- exports

const exportSelect = `SELECT x.*, u.first_name || ' ' || u.last_name AS created_by
  FROM migration_exports x LEFT JOIN users u ON u.id = x.created_by_id`;
const mapExport = (r: Record<string, unknown>): MigrationExport => ({
  id: Number(r.id),
  status: r.status as MigrationExport["status"],
  includesCredentials: !!r.includes_credentials,
  withPasswords: !!r.with_passwords,
  rateLines: r.rate_lines as string,
  createdBy: (r.created_by as string) ?? null,
  createdAt: iso(r.inserted_at)!,
  finishedAt: iso(r.finished_at),
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
  error: (r.error as string) ?? null,
  manifest: (r.manifest as MigrationExport["manifest"]) ?? null,
});
async function loadExport(c: Db, id: number) {
  const { rows } = await c.query(`${exportSelect} WHERE x.id = $1`, [id]);
  return rows[0] ? mapExport(rows[0]) : null;
}

export function getMigrationExports(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) =>
    (await pool.query(`${exportSelect} ORDER BY x.id DESC LIMIT 50`)).rows.map(mapExport),
  );
}

export function getMigrationExport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(
    reply,
    async (pool) => (await loadExport(pool, id)) ?? sendProblem(reply, 404, `Export ${id} not found`),
  );
}

/** Running exports, so tests (and a shutdown) can wait for them. */
export const runningExports = new Map<number, Promise<void>>();

export function createMigrationExport(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as MigrationExportInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!isAdmin(me)) return sendProblem(reply, 403, "Full export packages are made by admins only");
    if (b.password.length < 12) return fieldError(reply, "/password", "use at least 12 characters");
    if (b.withPasswords && !b.includeCredentials)
      return fieldError(reply, "/withPasswords", "passwords go only with credentials included");
    if (b.includeCredentials) {
      const refused = await totpRefusal(pool, reply, me, b.totpCode);
      if (refused) return refused();
    }
    const { rows } = await pool.query(
      `INSERT INTO migration_exports (includes_credentials, with_passwords, rate_lines, created_by_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [b.includeCredentials, b.withPasswords, b.rateLines, me.id],
    );
    const id = Number(rows[0].id);
    if (b.includeCredentials)
      await notifyAdmins(
        pool,
        me,
        "Export with credentials made",
        `Migration export #${id} includes trunk connection details${b.withPasswords ? " and passwords" : ""}.`,
      );
    await mkdir(PACKAGE_DIR, { recursive: true });
    const path = join(PACKAGE_DIR, `export-${id}-${randomBytes(6).toString("hex")}.smspkg`);
    const job = writePackage(db(), b, b.password, path, MIGRATION_VERSION.value)
      .then(({ manifest, sizeBytes }) =>
        db().query(
          `UPDATE migration_exports SET status = 'done', file_path = $2, size_bytes = $3, manifest = $4, finished_at = now()
            WHERE id = $1`,
          [id, path, sizeBytes, JSON.stringify(manifest)],
        ),
      )
      .catch((err: unknown) =>
        db()
          .query("UPDATE migration_exports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [
            id,
            err instanceof Error ? err.message : String(err),
          ])
          .catch(() => undefined),
      )
      .then(() => undefined)
      .finally(() => runningExports.delete(id));
    runningExports.set(id, job);
    return reply.code(201).send(await loadExport(pool, id));
  });
}

export function createMigrationLink(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const b = (request.body ?? {}) as MigrationLinkInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!isAdmin(me)) return sendProblem(reply, 403, "Export packages are downloaded by admins only");
    const x = await loadExport(pool, id);
    if (!x) return sendProblem(reply, 404, `Export ${id} not found`);
    if (x.status !== "done")
      return sendProblem(reply, 409, `Export #${id} is ${x.status}: a link needs a finished package`);
    if (x.includesCredentials) {
      const refused = await totpRefusal(pool, reply, me, b.totpCode);
      if (refused) return refused();
    }
    const token = randomBytes(24).toString("base64url");
    const { rows } = await pool.query(
      `INSERT INTO migration_links (token, export_id, expires_at, created_by_id)
       VALUES ($1, $2, now() + make_interval(mins => $3), $4) RETURNING expires_at`,
      [token, id, LINK_MINUTES, me.id],
    );
    if (x.includesCredentials)
      await notifyAdmins(
        pool,
        me,
        "Download link for credentials",
        `A download link for migration export #${id} (with credentials) was made.`,
      );
    return {
      url: `/api/v1/migration/downloads/${token}`,
      expiresAt: iso(rows[0].expires_at)!,
      note: `Works once and expires in ${LINK_MINUTES} minutes. The file opens only with the export password.`,
    };
  });
}

export function downloadMigrationPackage(request: FastifyRequest, reply: FastifyReply) {
  const { token } = request.params as { token: string };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `UPDATE migration_links l SET used_at = now()
         FROM migration_exports x
        WHERE l.token = $1 AND l.used_at IS NULL AND l.expires_at > now() AND x.id = l.export_id
        RETURNING x.id, x.file_path`,
      [token],
    );
    if (!rows[0]) {
      const { rows: known } = await pool.query("SELECT 1 FROM migration_links WHERE token = $1", [token]);
      return known[0]
        ? sendProblem(reply, 410, "This link was used or has expired: make a new one")
        : sendProblem(reply, 404, "Unknown download link");
    }
    return reply
      .header("content-disposition", `attachment; filename="migration-export-${rows[0].id}.smspkg"`)
      .type("application/octet-stream")
      .send(createReadStream(rows[0].file_path as string));
  });
}

// ---------------------------------------------------------------- imports

interface StoredInput {
  sourceSystem: string;
  conflicts: Record<string, string>;
  trunksInactive: boolean;
  files: { entity: string; fileName: string; rows: number; mapping: string | null }[];
  packageExportId: number | null;
  warnings: string[];
  /** Imports before R9: the encrypted files on disk (the service's /tmp, emptied on restart). */
  blob?: string;
}

/**
 * File contents (credentials included), encrypted, for the files_enc column (R9). They were kept in the service's
 * private /tmp, which systemd empties on every restart, so Apply after an update could not find them.
 */
const sealFiles = (files: MigrationFileInput[]) => encryptSecret(gzipSync(JSON.stringify(files)).toString("base64"));

class FilesGone extends Error {}

async function loadFiles(r: Record<string, unknown>): Promise<MigrationFileInput[]> {
  let sealed = (r.files_enc as string | null) ?? null;
  const blob = (r.input as StoredInput).blob;
  if (!sealed && blob) sealed = await readFile(blob, "utf8").catch(() => null);
  const plain = sealed ? decryptSecret(sealed) : null;
  if (!plain)
    throw new FilesGone("The uploaded files are no longer on the server: use Fix and re-run to upload them again");
  return JSON.parse(gunzipSync(Buffer.from(plain, "base64")).toString("utf8"));
}

async function loadMappings(c: Db) {
  await seedMappings(c);
  const { rows } = await c.query("SELECT id, entity, name, columns FROM migration_mappings");
  return new Map(
    rows.map((r) => [Number(r.id), { entity: r.entity as string, name: r.name as string, columns: r.columns }]),
  );
}

// Every column but the files (files_enc), which only apply reads.
const importSelect = `SELECT mi.id, mi.source_system, mi.status, mi.input, mi.report, mi.includes_credentials, mi.change_id,
    mi.inserted_at, mi.validated_at, mi.applied_at, mi.apply_error, u.first_name || ' ' || u.last_name AS created_by,
    EXISTS (SELECT 1 FROM changes un WHERE un.undo_of_id = mi.change_id
             AND NOT EXISTS (SELECT 1 FROM changes re WHERE re.undo_of_id = un.id)) AS rolled_back
  FROM migration_imports mi LEFT JOIN users u ON u.id = mi.created_by_id
 WHERE mi.deleted_at IS NULL`;

/** Trunks an applied import created, still inactive and not archived. */
async function inactiveTrunks(c: Db, changeId: number | null, enterpriseIds: number[] | null = null) {
  if (changeId == null) return [] as { table: string; id: number }[];
  const { rows } = await c.query(
    `SELECT e->>'table' AS t, (e->>'entity_id')::bigint AS id
       FROM changes ch, jsonb_array_elements(ch.diff) e
      WHERE ch.id = $1 AND e->>'field' = '*' AND e->>'table' IN ('customer_trunks', 'vendor_trunks')`,
    [changeId],
  );
  const out: { table: string; id: number }[] = [];
  for (const table of ["customer_trunks", "vendor_trunks"]) {
    const ids = rows.filter((r) => r.t === table).map((r) => Number(r.id));
    if (!ids.length) continue;
    const { rows: live } = await c.query(
      `SELECT id FROM ${table} WHERE id = ANY($1) AND status = 'inactive' AND deleted_at IS NULL
         AND ($2::bigint[] IS NULL OR enterprise_id = ANY($2))`,
      [ids, enterpriseIds],
    );
    out.push(...live.map((r) => ({ table, id: Number(r.id) })));
  }
  return out;
}

/** Users an applied import created or restored that are still there (team trial round 11: E-mail password links). */
async function importedUsers(c: Db, changeId: number | null): Promise<number[]> {
  if (changeId == null) return [];
  const { rows } = await c.query(
    `SELECT DISTINCT (e->>'entity_id')::bigint AS id
       FROM changes ch, jsonb_array_elements(ch.diff) e
      WHERE ch.id = $1 AND e->>'table' = 'users'
        AND (e->>'field' = '*' OR (e->>'field' = 'row' AND e->'before'->>'deleted_at' IS NOT NULL))`,
    [changeId],
  );
  if (!rows.length) return [];
  const { rows: live } = await c.query("SELECT id FROM users WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY id", [
    rows.map((r) => Number(r.id)),
  ]);
  return live.map((r) => Number(r.id));
}

async function mapImport(c: Db, r: Record<string, unknown>): Promise<MigrationImport> {
  const input = r.input as StoredInput;
  const changeId = r.change_id == null ? null : Number(r.change_id);
  const live = r.status === "applied" && !r.rolled_back;
  return {
    id: Number(r.id),
    sourceSystem: r.source_system as string,
    status: r.rolled_back ? "rolled_back" : (r.status as MigrationImport["status"]),
    files: input.files,
    conflicts: input.conflicts,
    trunksInactive: input.trunksInactive,
    includesCredentials: !!r.includes_credentials,
    createdBy: (r.created_by as string) ?? null,
    createdAt: iso(r.inserted_at)!,
    validatedAt: iso(r.validated_at)!,
    appliedAt: iso(r.applied_at),
    changeId,
    inactiveTrunks: live ? (await inactiveTrunks(c, changeId)).length : 0,
    report: r.report as MigrationReport,
    applyError: (r.apply_error as string | null) ?? null,
    newUserIds: live ? await importedUsers(c, changeId) : [],
  };
}
async function loadImport(c: Db, id: number) {
  const { rows } = await c.query(`${importSelect} AND mi.id = $1`, [id]);
  return rows[0] ?? null;
}

export function getMigrationImports(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(`${importSelect} ORDER BY mi.id DESC LIMIT 50`);
    return Promise.all(rows.map((r) => mapImport(pool, r)));
  });
}

export function getMigrationImport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const r = await loadImport(pool, id);
    return r ? mapImport(pool, r) : sendProblem(reply, 404, `Import ${id} not found`);
  });
}

/** Reads the files (or the package), runs the dry run and checks the credential safeguards. */
async function prepare(pool: pg.Pool, reply: FastifyReply, me: CurrentUser, b: MigrationImportInput) {
  if (!b.sourceSystem.trim())
    return { refused: fieldError(reply, "/sourceSystem", "name the system the data comes from") };
  let files = b.files;
  const warnings: string[] = [];
  let fromPackage = false;
  if (b.packageExportId != null) {
    const x = await pool.query("SELECT file_path, status, includes_credentials FROM migration_exports WHERE id = $1", [
      b.packageExportId,
    ]);
    if (!x.rows[0] || x.rows[0].status !== "done")
      return { refused: fieldError(reply, "/packageExportId", "no finished export package with that number") };
    if (!b.packagePassword) return { refused: fieldError(reply, "/packagePassword", "enter the package password") };
    try {
      const frames = await readPackage(x.rows[0].file_path, b.packagePassword);
      const adapted = packageFiles(frames);
      files = [...adapted.files, ...files.filter((f) => !adapted.files.some((a) => a.entity === f.entity))];
      warnings.push(...adapted.warnings);
      fromPackage = true;
    } catch (err) {
      if (err instanceof PackageError) return { refused: fieldError(reply, "/packagePassword", err.message) };
      throw err;
    }
  }
  if (!files.length) return { refused: fieldError(reply, "/files", "add at least one file") };
  const mappings = await loadMappings(pool);
  const settings: ImportSettings = {
    sourceSystem: b.sourceSystem.trim(),
    files,
    conflicts: b.conflicts ?? {},
    trunksInactive: b.trunksInactive,
  };
  const plan = await planImport(pool, settings, mappings);
  for (const w of warnings) {
    plan.report.issues.unshift({ entity: "package", row: 0, field: null, message: w, severity: "warning" });
    plan.report.issueCount++;
  }
  if (plan.includesCredentials) {
    const refused = await totpRefusal(pool, reply, me, b.totpCode);
    if (refused) return { refused: refused() };
  }
  const stored: StoredInput = {
    sourceSystem: settings.sourceSystem,
    conflicts: settings.conflicts as Record<string, string>,
    trunksInactive: settings.trunksInactive,
    files: files.map((f) => ({
      entity: f.entity,
      fileName: f.fileName,
      rows: plan.report.entities.find((e) => e.entity === f.entity)?.source ?? 0,
      mapping: f.mappingId != null ? (mappings.get(f.mappingId)?.name ?? null) : null,
    })),
    packageExportId: fromPackage ? (b.packageExportId ?? null) : null,
    warnings,
  };
  return { plan, stored, sealed: sealFiles(files) };
}

export function createMigrationImport(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as MigrationImportInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const p = await prepare(pool, reply, me, b);
    if ("refused" in p) return p.refused;
    const { rows } = await pool.query(
      `INSERT INTO migration_imports (source_system, input, report, includes_credentials, created_by_id, files_enc)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        p.stored.sourceSystem,
        JSON.stringify(p.stored),
        JSON.stringify(p.plan.report),
        p.plan.includesCredentials,
        me.id,
        p.sealed,
      ],
    );
    if (p.plan.includesCredentials)
      await notifyAdmins(
        pool,
        me,
        "Import with credentials uploaded",
        `Migration import #${rows[0].id} from ${p.stored.sourceSystem} contains trunk credentials.`,
      );
    return reply.code(201).send(await mapImport(pool, await loadImport(pool, Number(rows[0].id))));
  });
}

export function revalidateMigrationImport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const b = request.body as MigrationImportInput;
  return withDb(reply, async (pool) => {
    const cur = await loadImport(pool, id);
    if (!cur) return sendProblem(reply, 404, `Import ${id} not found`);
    if (cur.status === "applying") return sendProblem(reply, 409, `Import #${id} is being applied: wait for it`);
    if (cur.status !== "validated")
      return sendProblem(reply, 409, `Import #${id} was already applied: start a new import`);
    const me = await getCurrentUser();
    const p = await prepare(pool, reply, me, b);
    if ("refused" in p) return p.refused;
    const blob = (cur.input as StoredInput).blob;
    if (blob) await rm(blob, { force: true });
    await pool.query(
      `UPDATE migration_imports SET source_system = $2, input = $3, report = $4, includes_credentials = $5, validated_at = now(),
              files_enc = $6, apply_error = NULL
        WHERE id = $1`,
      [
        id,
        p.stored.sourceSystem,
        JSON.stringify(p.stored),
        JSON.stringify(p.plan.report),
        p.plan.includesCredentials,
        p.sealed,
      ],
    );
    return mapImport(pool, await loadImport(pool, id));
  });
}

const counts = (r: MigrationReport) =>
  JSON.stringify(r.entities.map((e) => [e.entity, e.create, e.update, e.skip, e.errors]));

/** Applies running in the background, so tests (and a shutdown) can wait for them. */
export const runningApplies = new Map<number, Promise<void>>();

/**
 * Apply (R9: in the background, as large files outlast the web request): the import turns `applying` at once and the
 * screen polls it. One transaction: it ends `applied`, or back at `validated` with apply_error and nothing written.
 */
export function applyMigrationImport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const cur = await loadImport(pool, id);
    if (!cur) return sendProblem(reply, 404, `Import ${id} not found`);
    if (cur.status === "applying") return sendProblem(reply, 409, `Import #${id} is already being applied`);
    if (cur.status !== "validated") return sendProblem(reply, 409, `Import #${id} was already applied`);
    const report = cur.report as MigrationReport;
    if (!report.canApply)
      return sendProblem(
        reply,
        409,
        report.entities.some((e) => e.errors)
          ? "Fix the errors in the dry run first, then apply"
          : "Nothing to apply: every row is already in the system as in the files",
      );
    const me = await getCurrentUser();
    // Only one apply at a time, even from two screens.
    const { rowCount } = await pool.query(
      "UPDATE migration_imports SET status = 'applying', apply_error = NULL WHERE id = $1 AND status = 'validated'",
      [id],
    );
    if (!rowCount) return sendProblem(reply, 409, `Import #${id} is already being applied`);
    const job = runApply(pool, id, me, request.ip).finally(() => runningApplies.delete(id));
    runningApplies.set(id, job);
    return reply.code(202).send(await mapImport(pool, await loadImport(pool, id)));
  });
}

async function runApply(pool: pg.Pool, id: number, me: CurrentUser, ip: string): Promise<void> {
  const fail = (message: string, report?: MigrationReport) =>
    pool
      .query(
        `UPDATE migration_imports SET status = 'validated', apply_error = $2, report = coalesce($3::jsonb, report),
                validated_at = CASE WHEN $3::jsonb IS NULL THEN validated_at ELSE now() END
          WHERE id = $1`,
        [id, message, report ? JSON.stringify(report) : null],
      )
      .then(() => undefined);
  try {
    const { rows } = await pool.query("SELECT input, report, files_enc FROM migration_imports WHERE id = $1", [id]);
    const cur = rows[0];
    const input = cur.input as StoredInput;
    const report = cur.report as MigrationReport;
    const files = await loadFiles(cur);
    const mappings = await loadMappings(pool);
    const outcome = await inTransaction(pool, async (c) => {
      const plan = await planImport(
        c,
        { sourceSystem: input.sourceSystem, files, conflicts: input.conflicts, trunksInactive: input.trunksInactive },
        mappings,
      );
      // Apply writes exactly what the dry run showed; if the data changed since, show the new report first.
      if (counts(plan.report) !== counts(report) || !plan.report.canApply) return { stale: plan.report };
      const { entries } = await applyPlan(c, plan, id, me.id);
      const created = entries.filter((e) => e.field === "*").length;
      const change = await recordChange(c, {
        entityType: "migration",
        entityIds: [...new Set(entries.map((e) => e.entity_id))].slice(0, 5000),
        changeType: "import",
        diff: entries as unknown as DiffEntry[],
        note: `Import #${id} from ${input.sourceSystem}: ${created} created, ${entries.length - created} updated`,
        userId: me.id,
        ip,
      });
      await c.query(
        "UPDATE migration_imports SET status = 'applied', applied_at = now(), change_id = $2 WHERE id = $1",
        [id, change.id],
      );
      return { stale: null };
    });
    if (outcome.stale)
      await fail("The data changed since the dry run: review the new report, then apply again", outcome.stale);
  } catch (err) {
    // Nothing was written (one transaction); the reason shows on the import.
    if (!(err instanceof FilesGone)) console.error(`migration import ${id}: apply failed`, err);
    await fail(err instanceof Error ? err.message : String(err)).catch(() => undefined);
  }
}

/** After a restart, an apply that was running wrote nothing (its transaction ended with the process). */
export async function resetStuckImports(pool: pg.Pool = db()): Promise<void> {
  await pool.query(
    `UPDATE migration_imports SET status = 'validated',
            apply_error = 'The service restarted while applying; nothing was written. Apply again.'
      WHERE status = 'applying'`,
  );
}

/** Delete an import (R9): off the list, files removed; an applied import's change stays in History. */
export function deleteMigrationImport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const cur = await loadImport(pool, id);
    if (!cur) return sendProblem(reply, 404, `Import ${id} not found`);
    if (cur.status === "applying") return sendProblem(reply, 409, `Import #${id} is being applied: wait for it`);
    const blob = (cur.input as StoredInput).blob;
    if (blob) await rm(blob, { force: true });
    await pool.query("UPDATE migration_imports SET deleted_at = now(), files_enc = NULL WHERE id = $1", [id]);
    return reply.code(204).send();
  });
}

export function activateMigrationTrunks(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const b = request.body as MigrationActivate;
  return withDb(reply, async (pool) => {
    const cur = await loadImport(pool, id);
    if (!cur) return sendProblem(reply, 404, `Import ${id} not found`);
    if (cur.status !== "applied" || cur.rolled_back)
      return sendProblem(reply, 409, `Import #${id} is not applied: nothing to activate`);
    if (b.enterpriseIds && !b.enterpriseIds.length)
      return fieldError(reply, "/enterpriseIds", "pick at least one partner");
    const me = await getCurrentUser();
    const trunks = await inactiveTrunks(pool, Number(cur.change_id), b.enterpriseIds);
    if (!trunks.length) return { activated: 0, change: null };
    const change = await inTransaction(pool, async (c) => {
      const entries: Entry[] = [];
      for (const t of trunks) {
        await c.query(`UPDATE ${t.table} SET status = 'active', updated_at = now(), updated_by_id = $2 WHERE id = $1`, [
          t.id,
          me.id,
        ]);
        entries.push({
          table: t.table,
          entity_id: t.id,
          field: "row",
          before: { status: "inactive" },
          after: { status: "active" },
        });
      }
      return recordChange(c, {
        entityType: "migration",
        entityIds: trunks.map((t) => t.id),
        changeType: "enable",
        diff: entries as unknown as DiffEntry[],
        note: `Go-live of import #${id}: ${trunks.length} trunks activated`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { activated: trunks.length, change };
  });
}
