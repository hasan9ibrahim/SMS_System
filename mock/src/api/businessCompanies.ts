// Business Company (§11): the selling entity's form - company, format files, default e-mail templates,
// address, bank and one sender block per department mailbox. SMTP passwords and OAuth client secrets
// are write-only: stored encrypted, never returned (only hasX flags). Check SMTP Connection connects to
// the mail server in production only (backend step 11); elsewhere it is simulated (CLAUDE.md rule 1).
import type { FastifyReply, FastifyRequest } from "fastify";
import { production } from "../mode.js";
import { verifyMailbox } from "../jobs/mailer.js";
import type pg from "pg";
import type {
  ArchiveRequest,
  BusinessCompanyInput,
  BusinessCompanyRecord,
  CloneInput,
  CompanyFileUpload,
  CompanySenders,
  MailboxInput,
  MailboxRow,
  SmtpCheckInput,
} from "@sms/contract";
import { withDb } from "../db.js";
import { decryptSecret, encryptSecret } from "../admin/passwords.js";
import { SENDER_DEFAULTS } from "./emailLog.js";
import { BUSINESS_COMPANY_FROM, BUSINESS_COMPANY_SELECT } from "../lists/adminDefs.js";
import { sendProblem } from "../problem.js";
import { archiveGate } from "./enterprises.js";
import { notFound, setArchived } from "./masterData.js";
import { dependencies, iso, recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { badInput } from "./switchTools.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };
type Row = Record<string, unknown>;
const str = (v: unknown) => (v as string | null) ?? null;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const trimOrNull = (v: string | null | undefined) => (v == null ? null : v.trim() || null);

const SCALARS: [keyof BusinessCompanyInput & string, string][] = [
  ["name", "name"],
  ["description", "description"],
  ["baseCurrency", "base_currency"],
  ["tpsLimit", "tps_limit"],
  ["website", "website"],
  ["smppHost", "smpp_host"],
  ["smppPort", "smpp_port"],
  ["invoiceNumberStart", "invoice_number_start"],
  ["companyIp", "company_ip"],
  ["customerRateFileName", "customer_rate_file_name"],
];
const ADDRESS: [string, string][] = [
  ["line1", "address_line1"],
  ["line2", "address_line2"],
  ["city", "city"],
  ["state", "state"],
  ["countryIso", "country_iso"],
  ["zip", "zip"],
];
const BANK: [string, string][] = [
  ["beneficiaryName", "bank_beneficiary_name"],
  ["beneficiaryAddress", "bank_beneficiary_address"],
  ["bankName", "bank_name"],
  ["bankAddress", "bank_address"],
  ["currency", "bank_currency"],
  ["accountNumber", "bank_account_number"],
  ["iban", "bank_iban"],
  ["swift", "bank_swift"],
];
const TEMPLATE_TYPES: Record<string, string> = {
  customerRate: "customer_rate",
  invoice: "invoice",
  lowBalance: "low_balance",
  bindDown: "bind_down",
  customerTechInfo: "customer_tech_info",
  trunkChangeInfo: "trunk_change_info",
  soaStatement: "soa_statement",
  rateUploadNotification: "rate_upload_notification",
  autoUploadRejected: "auto_upload_rejected",
};
const MAILBOX_ORDER = ["noc", "sales", "rates", "billing", "support"];
const char = (v: unknown) => (v == null ? null : String(v).trim());

function mapMailbox(r: Row): MailboxRow {
  return {
    department: r.department as MailboxRow["department"],
    name: str(r.name),
    phone: str(r.phone),
    smtpEmail: r.smtp_email as string,
    smtpSecure: r.smtp_secure as MailboxRow["smtpSecure"],
    smtpHost: r.smtp_host as string,
    smtpPort: Number(r.smtp_port),
    smtpUsername: str(r.smtp_username),
    extension: str(r.extension),
    skypeName: str(r.skype_name),
    oauthRedirectUris: (r.oauth_redirect_uris as string[]) ?? [],
    clientId: r.client_id as string,
    hasSmtpPassword: r.smtp_password_enc != null,
    hasClientSecret: r.client_secret_enc != null,
    lastCheckAt: iso(r.last_check_at),
    lastCheckOk: (r.last_check_ok as boolean | null) ?? null,
    imapHost: str(r.imap_host),
    imapPort: Number(r.imap_port ?? 993),
    imapLastReadAt: iso(r.imap_last_read_at),
    imapLastError: str(r.imap_last_error),
  };
}

export async function loadCompany(c: Db, id: number): Promise<BusinessCompanyRecord | null> {
  const { rows } = await c.query(`SELECT ${BUSINESS_COMPANY_SELECT} FROM ${BUSINESS_COMPANY_FROM} WHERE bc.id = $1`, [
    id,
  ]);
  const r = rows[0];
  if (!r) return null;
  const { rows: mb } = await c.query(
    `SELECT * FROM business_company_mailboxes WHERE business_company_id = $1
      ORDER BY array_position(ARRAY['noc','sales','rates','billing','support'], department)`,
    [id],
  );
  const { rows: files } = await c.query(
    `SELECT f.kind, f.name, f.size, f.content_type, f.uploaded_at, u.username AS uploaded_by
       FROM business_company_files f LEFT JOIN users u ON u.id = f.uploaded_by_id WHERE f.business_company_id = $1 ORDER BY f.kind`,
    [id],
  );
  const dt = (r.default_templates as Record<string, number | null>) ?? {};
  return {
    id: Number(r.id),
    name: r.name as string,
    description: str(r.description),
    baseCurrency: char(r.base_currency)!,
    tpsLimit: r.tps_limit == null ? null : Number(r.tps_limit),
    website: str(r.website),
    smppHost: str(r.smpp_host),
    smppPort: r.smpp_port == null ? null : Number(r.smpp_port),
    invoiceNumberStart: Number(r.invoice_number_start),
    companyIp: str(r.company_ip),
    customerRateFileName: str(r.customer_rate_file_name),
    address: Object.fromEntries(
      ADDRESS.map(([k, col]) => [k, k === "countryIso" ? char(r[col]) : str(r[col])]),
    ) as BusinessCompanyRecord["address"],
    bank: Object.fromEntries(
      BANK.map(([k, col]) => [k, k === "currency" ? char(r[col]) : str(r[col])]),
    ) as BusinessCompanyRecord["bank"],
    defaultTemplates: Object.fromEntries(
      Object.keys(TEMPLATE_TYPES).map((k) => [k, dt[k] ?? null]),
    ) as BusinessCompanyRecord["defaultTemplates"],
    senders: { ...SENDER_DEFAULTS, ...((r.senders as Partial<CompanySenders> | null) ?? {}) },
    mailboxes: mb.map(mapMailbox),
    files: files.map((f) => ({
      kind: f.kind,
      name: f.name,
      size: Number(f.size),
      contentType: f.content_type,
      uploadedAt: iso(f.uploaded_at)!,
      uploadedBy: str(f.uploaded_by),
    })),
    enterprises: Number(r.enterprise_count ?? 0),
    users: Number(r.user_count ?? 0),
    updatedBy: str(r.updated_by),
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export const getBusinessCompany = (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadCompany(pool, id)) ?? notFound(reply, "Business company", id));
};

function values(b: BusinessCompanyInput): BusinessCompanyInput {
  const t = (o: Record<string, string | null>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? trimOrNull(v) : v]));
  return {
    ...b,
    name: b.name.trim(),
    description: trimOrNull(b.description),
    website: trimOrNull(b.website),
    smppHost: trimOrNull(b.smppHost),
    companyIp: trimOrNull(b.companyIp),
    customerRateFileName: trimOrNull(b.customerRateFileName),
    address: t(b.address) as BusinessCompanyInput["address"],
    bank: t(b.bank) as BusinessCompanyInput["bank"],
    mailboxes: [...b.mailboxes].sort(
      (x, y) => MAILBOX_ORDER.indexOf(x.department) - MAILBOX_ORDER.indexOf(y.department),
    ),
  };
}

async function check(c: Db, b: BusinessCompanyInput, id: number | null): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const { rows: dup } = await c.query(
    "SELECT 1 FROM business_companies WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> coalesce($2, 0)",
    [b.name, id],
  );
  if (dup[0]) errors.push({ path: "/name", message: "another business company has this name" });
  for (const [path, cur] of [
    ["/baseCurrency", b.baseCurrency],
    ["/bank/currency", b.bank.currency],
  ] as const) {
    if (!cur) continue;
    const { rows } = await c.query("SELECT 1 FROM currencies WHERE iso = $1 AND deleted_at IS NULL", [cur]);
    if (!rows[0]) errors.push({ path, message: "unknown currency" });
  }
  if (b.address.countryIso) {
    const { rows } = await c.query("SELECT 1 FROM countries WHERE iso = $1", [b.address.countryIso]);
    if (!rows[0]) errors.push({ path: "/address/countryIso", message: "unknown country" });
  }
  for (const [key, type] of Object.entries(TEMPLATE_TYPES)) {
    const tid = (b.defaultTemplates as Record<string, number | null>)[key];
    if (tid == null) continue;
    const { rows } = await c.query(
      "SELECT email_type FROM email_templates WHERE id = $1 AND deleted_at IS NULL AND (business_company_id IS NULL OR business_company_id = $2)",
      [tid, id ?? 0],
    );
    if (!rows[0]) errors.push({ path: `/defaultTemplates/${key}`, message: "unknown template" });
    else if (rows[0].email_type !== type)
      errors.push({ path: `/defaultTemplates/${key}`, message: "this template is of another type" });
  }
  const seen = new Set<string>();
  const stored = id == null ? new Map<string, Row>() : await storedMailboxes(c, id);
  b.mailboxes.forEach((m, i) => {
    if (seen.has(m.department))
      errors.push({ path: `/mailboxes/${i}/department`, message: "one mailbox per department" });
    seen.add(m.department);
    if (m.clientSecret == null && !stored.get(m.department)?.client_secret_enc)
      errors.push({ path: `/mailboxes/${i}/clientSecret`, message: "required" });
  });
  return errors;
}

async function storedMailboxes(c: Db, id: number) {
  const { rows } = await c.query("SELECT * FROM business_company_mailboxes WHERE business_company_id = $1", [id]);
  return new Map(rows.map((r) => [r.department as string, r as Row]));
}

/** Writes the mailboxes: new secrets are encrypted, null keeps the stored one; missing departments go. */
async function writeMailboxes(c: pg.PoolClient, id: number, list: (MailboxInput | MailboxRow)[]) {
  const stored = await storedMailboxes(c, id);
  await c.query(
    "DELETE FROM business_company_mailboxes WHERE business_company_id = $1 AND NOT (department = ANY($2))",
    [id, list.map((m) => m.department)],
  );
  for (const m of list) {
    const old = stored.get(m.department);
    const pass =
      "smtpPassword" in m && m.smtpPassword != null ? encryptSecret(m.smtpPassword) : (old?.smtp_password_enc ?? null);
    const secret =
      "clientSecret" in m && m.clientSecret != null ? encryptSecret(m.clientSecret) : (old?.client_secret_enc ?? null);
    await c.query(
      `INSERT INTO business_company_mailboxes (business_company_id, department, name, phone, smtp_email, smtp_secure, smtp_host,
         smtp_port, smtp_username, smtp_password_enc, extension, skype_name, oauth_redirect_uris, client_id, client_secret_enc,
         imap_host, imap_port)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (business_company_id, department) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone,
         smtp_email = EXCLUDED.smtp_email, smtp_secure = EXCLUDED.smtp_secure, smtp_host = EXCLUDED.smtp_host,
         smtp_port = EXCLUDED.smtp_port, smtp_username = EXCLUDED.smtp_username, smtp_password_enc = EXCLUDED.smtp_password_enc,
         extension = EXCLUDED.extension, skype_name = EXCLUDED.skype_name, oauth_redirect_uris = EXCLUDED.oauth_redirect_uris,
         client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc, imap_host = EXCLUDED.imap_host,
         imap_port = EXCLUDED.imap_port`,
      [
        id,
        m.department,
        trimOrNull(m.name),
        trimOrNull(m.phone),
        m.smtpEmail.trim(),
        m.smtpSecure,
        m.smtpHost.trim(),
        m.smtpPort,
        trimOrNull(m.smtpUsername),
        pass,
        trimOrNull(m.extension),
        trimOrNull(m.skypeName),
        m.oauthRedirectUris.map((u) => u.trim()).filter(Boolean),
        m.clientId.trim(),
        secret,
        trimOrNull(m.imapHost ?? null),
        m.imapPort ?? 993,
      ],
    );
  }
}

/** Writes one top-level form field (also used by undo, §13.10). */
export async function applyBusinessCompanyField(c: pg.PoolClient, id: number, field: string, value: unknown) {
  const scalar = SCALARS.find(([k]) => k === field);
  if (scalar) {
    await c.query(`UPDATE business_companies SET ${scalar[1]} = $2, updated_at = now() WHERE id = $1`, [id, value]);
  } else if (field === "address" || field === "bank") {
    const map = field === "address" ? ADDRESS : BANK;
    const v = (value ?? {}) as Record<string, unknown>;
    await c.query(
      `UPDATE business_companies SET ${map.map(([, col], i) => `${col} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
      [id, ...map.map(([k]) => v[k] ?? null)],
    );
  } else if (field === "defaultTemplates") {
    await c.query("UPDATE business_companies SET default_templates = $2, updated_at = now() WHERE id = $1", [
      id,
      JSON.stringify(value ?? {}),
    ]);
  } else if (field === "senders") {
    await c.query("UPDATE business_companies SET senders = $2, updated_at = now() WHERE id = $1", [
      id,
      JSON.stringify(value ?? {}),
    ]);
  } else if (field === "mailboxes") {
    // Secrets are not in the history; an undo keeps the stored ones per department.
    await writeMailboxes(c, id, (value as MailboxRow[]) ?? []);
  }
}

/** Mailboxes as kept in the change history: settings only, and whether a secret was changed. */
const historyMailboxes = (list: (MailboxInput | MailboxRow)[]) =>
  list.map((m) => {
    const {
      smtpPassword: _p,
      clientSecret: _s,
      hasSmtpPassword: _hp,
      hasClientSecret: _hs,
      lastCheckAt: _a,
      lastCheckOk: _o,
      ...rest
    } = m as MailboxInput & MailboxRow;
    return rest;
  });

export function createBusinessCompany(request: FastifyRequest, reply: FastifyReply) {
  const b = values(request.body as BusinessCompanyInput);
  return withDb(reply, async (pool) => {
    const errors = await check(pool, b, null);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        "INSERT INTO business_companies (name, base_currency, invoice_number_start, updated_by_id) VALUES ($1, $2, $3, $4) RETURNING id",
        [b.name, b.baseCurrency, b.invoiceNumberStart, me.id],
      );
      const id = Number(rows[0].id);
      for (const f of [...SCALARS.map(([k]) => k), "address", "bank", "defaultTemplates", "senders"])
        await applyBusinessCompanyField(c, id, f, (b as unknown as Row)[f]);
      await writeMailboxes(c, id, b.mailboxes);
      const change = await recordChange(c, {
        entityType: "business_company",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: b.name } }],
        note: `Added business company ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadCompany(pool, id), change });
  });
}

export function updateBusinessCompany(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = values(request.body as BusinessCompanyInput);
  return withDb(reply, async (pool) => {
    const before = await loadCompany(pool, id);
    if (!before) return notFound(reply, "Business company", id);
    if (before.archivedAt) return sendProblem(reply, 409, "This business company is deleted; restore it first");
    const errors = await check(pool, b, id);
    if (errors.length) return badInput(reply, errors);
    const keys = [...SCALARS.map(([k]) => k), "address", "bank", "defaultTemplates", "senders"];
    const diff: DiffEntry[] = keys
      .filter((k) => !same((before as unknown as Row)[k], (b as unknown as Row)[k]))
      .map((k) => ({
        entity_id: id,
        field: k,
        before: (before as unknown as Row)[k] ?? null,
        after: (b as unknown as Row)[k] ?? null,
      }));
    const mbBefore = historyMailboxes(before.mailboxes);
    const mbAfter = historyMailboxes(b.mailboxes);
    const secrets = b.mailboxes
      .filter((m) => m.smtpPassword != null || m.clientSecret != null)
      .map((m) => m.department);
    if (!same(mbBefore, mbAfter) || secrets.length)
      diff.push({ entity_id: id, field: "mailboxes", before: mbBefore, after: mbAfter });
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) if (d.field !== "mailboxes") await applyBusinessCompanyField(c, id, d.field, d.after);
      if (diff.some((d) => d.field === "mailboxes")) await writeMailboxes(c, id, b.mailboxes);
      await c.query("UPDATE business_companies SET updated_by_id = $2, updated_at = now() WHERE id = $1", [id, me.id]);
      return recordChange(c, {
        entityType: "business_company",
        entityIds: [id],
        changeType: "edit",
        diff,
        note:
          `Changed business company ${b.name}` +
          (secrets.length ? ` (new mailbox secrets: ${secrets.join(", ")}; secrets are never shown or undone)` : ""),
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadCompany(pool, id), change };
  });
}

async function companyDeps(c: Db, id: number) {
  const { rows } = await c.query(
    `SELECT (SELECT count(*)::int FROM enterprises WHERE business_company_id = $1 AND deleted_at IS NULL) AS enterprises,
            (SELECT count(*)::int FROM users WHERE business_company_id = $1 AND deleted_at IS NULL) AS users,
            (SELECT count(*)::int FROM scheduled_reports WHERE business_company_id = $1 AND deleted_at IS NULL) AS schedules`,
    [id],
  );
  const r = rows[0];
  return dependencies([
    {
      key: "enterprises",
      label: "Live enterprises",
      count: r.enterprises,
      blocking: true,
      detail: "Move them to another business company",
    },
    { key: "users", label: "Users", count: r.users, blocking: true, detail: null },
    { key: "scheduled_reports", label: "Scheduled reports", count: r.schedules, blocking: false, detail: null },
  ]);
}

export function getBusinessCompanyDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM business_companies WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, "Business company", id);
    return companyDeps(pool, id);
  });
}

export function archiveBusinessCompany(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = (request.body ?? {}) as ArchiveRequest;
  return withDb(reply, async (pool) => {
    const before = await loadCompany(pool, id);
    if (!before) return notFound(reply, "Business company", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(reply, body, await companyDeps(pool, id));
    if (!gate.ok) return gate.reply;
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE business_companies SET deleted_at = now() WHERE id = $1", [id]);
      return recordChange(c, {
        entityType: "business_company",
        entityIds: [id],
        changeType: "delete",
        diff: [{ entity_id: id, field: "archived", before: false, after: true }],
        note: [`Deleted business company ${before.name}`, gate.note].filter(Boolean).join(" – "),
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadCompany(pool, id), change };
  });
}

export function restoreBusinessCompany(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadCompany(pool, id);
    if (!before) return notFound(reply, "Business company", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This business company is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "business_companies",
      entityType: "business_company",
      archive: false,
      note: null,
      restoreClash: async (c) => {
        const { rows } = await c.query(
          "SELECT 1 FROM business_companies WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> $2",
          [before.name, id],
        );
        return rows[0] ? "Another live business company has this name" : null;
      },
    });
    if ("reply" in r) return r.reply;
    return { record: await loadCompany(pool, id), change: r.change };
  });
}

export function cloneBusinessCompany(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { name } = request.body as CloneInput;
  return withDb(reply, async (pool) => {
    const src = await loadCompany(pool, id);
    if (!src) return notFound(reply, "Business company", id);
    const { rows: dup } = await pool.query(
      "SELECT 1 FROM business_companies WHERE lower(name) = lower($1) AND deleted_at IS NULL",
      [name.trim()],
    );
    if (dup[0]) return badInput(reply, [{ path: "/name", message: "another business company has this name" }]);
    const me = await getCurrentUser();
    const { newId, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        "INSERT INTO business_companies (name, base_currency, invoice_number_start, updated_by_id) VALUES ($1, $2, $3, $4) RETURNING id",
        [name.trim(), src.baseCurrency, src.invoiceNumberStart, me.id],
      );
      const newId = Number(rows[0].id);
      for (const f of [
        ...SCALARS.map(([k]) => k).filter((k) => k !== "name"),
        "address",
        "bank",
        "defaultTemplates",
        "senders",
      ])
        await applyBusinessCompanyField(c, newId, f, (src as unknown as Row)[f]);
      // Mailboxes without passwords or secrets: those are entered again for the new company.
      for (const m of src.mailboxes)
        await c.query(
          `INSERT INTO business_company_mailboxes (business_company_id, department, name, phone, smtp_email, smtp_secure, smtp_host,
             smtp_port, smtp_username, extension, skype_name, oauth_redirect_uris, client_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            newId,
            m.department,
            m.name,
            m.phone,
            m.smtpEmail,
            m.smtpSecure,
            m.smtpHost,
            m.smtpPort,
            m.smtpUsername,
            m.extension,
            m.skypeName,
            m.oauthRedirectUris,
            m.clientId,
          ],
        );
      await c.query(
        `INSERT INTO business_company_files (business_company_id, kind, name, content_type, size, content, uploaded_by_id)
         SELECT $2, kind, name, content_type, size, content, $3 FROM business_company_files WHERE business_company_id = $1`,
        [id, newId, me.id],
      );
      const change = await recordChange(c, {
        entityType: "business_company",
        entityIds: [newId],
        changeType: "create",
        diff: [{ entity_id: newId, field: "*", before: null, after: { name: name.trim() } }],
        note: `Cloned business company ${src.name} as ${name.trim()}`,
        userId: me.id,
        ip: request.ip,
      });
      return { newId, change };
    });
    return reply.code(201).send({ record: await loadCompany(pool, newId), change });
  });
}

// ---------------------------------------------------------------- format files

const FILE_RULES: Record<string, { ext: RegExp; label: string; type: (name: string) => string }> = {
  logo: { ext: /\.png$/i, label: "a PNG image", type: () => "image/png" },
  invoice_format: { ext: /\.(xlsx|xls|xml)$/i, label: "an Excel file", type: excelType },
  customer_rate_format: { ext: /\.(xlsx|xls|xml)$/i, label: "an Excel file", type: excelType },
  soa_format: { ext: /\.(xlsx|xls|xml)$/i, label: "an Excel file", type: excelType },
};
function excelType(name: string) {
  return /\.xlsx$/i.test(name)
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/vnd.ms-excel";
}
const MAX_FILE = 10 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export function uploadCompanyFile(request: FastifyRequest, reply: FastifyReply) {
  const { id, kind } = request.params as { id: number; kind: string };
  const b = request.body as CompanyFileUpload;
  return withDb(reply, async (pool) => {
    const before = await loadCompany(pool, id);
    if (!before) return notFound(reply, "Business company", id);
    const rule = FILE_RULES[kind]!;
    const content = Buffer.from(b.contentBase64, "base64");
    if (!rule.ext.test(b.name)) return badInput(reply, [{ path: "/name", message: `upload ${rule.label}` }]);
    if (!content.length || content.length > MAX_FILE)
      return badInput(reply, [{ path: "/contentBase64", message: "the file must be 1 byte to 10 MB" }]);
    if (kind === "logo" && !content.subarray(0, 4).equals(PNG_MAGIC))
      return badInput(reply, [{ path: "/contentBase64", message: "this is not a PNG image" }]);
    const me = await getCurrentUser();
    const old = before.files.find((f) => f.kind === kind)?.name ?? null;
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `INSERT INTO business_company_files (business_company_id, kind, name, content_type, size, content, uploaded_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (business_company_id, kind) DO UPDATE SET name = EXCLUDED.name, content_type = EXCLUDED.content_type,
           size = EXCLUDED.size, content = EXCLUDED.content, uploaded_by_id = EXCLUDED.uploaded_by_id, uploaded_at = now()`,
        [id, kind, b.name, rule.type(b.name), content.length, content, me.id],
      );
      return recordChange(c, {
        entityType: "business_company_file",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: kind, before: old, after: b.name }],
        note: `Uploaded ${kind.replaceAll("_", " ")} ${b.name} for ${before.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadCompany(pool, id), change };
  });
}

export function downloadCompanyFile(request: FastifyRequest, reply: FastifyReply) {
  const { id, kind } = request.params as { id: number; kind: string };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      "SELECT name, content_type, content FROM business_company_files WHERE business_company_id = $1 AND kind = $2",
      [id, kind],
    );
    if (!rows[0]) return sendProblem(reply, 404, "No such file");
    return reply
      .type(rows[0].content_type as string)
      .header("content-disposition", `attachment; filename="${String(rows[0].name).replace(/"/g, "")}"`)
      .send(rows[0].content as Buffer);
  });
}

export const listFormatVariables = () => ({
  formats: [
    {
      kind: "invoice_format",
      label: "Invoice Format File",
      variables: [
        ["invoice_no", "Invoice number"],
        ["invoice_date", "Invoice date"],
        ["due_date", "Due date"],
        ["enterprise", "Partner name"],
        ["enterprise_address", "Partner address"],
        ["period_from", "Usage start"],
        ["period_to", "Usage end"],
        ["lines", "One row per destination: country, network, messages, rate, amount"],
        ["total", "Total amount"],
        ["currency", "Billing currency"],
        ["bank_details", "Bank block of the business company"],
      ],
    },
    {
      kind: "customer_rate_format",
      label: "Customer Rate Format File",
      variables: [
        ["trunk", "Customer trunk"],
        ["rate_date", "Effective date"],
        ["mccmnc", "MCCMNC"],
        ["country", "Country"],
        ["network", "Network"],
        ["rate", "Rate"],
        ["currency", "Currency"],
        ["change_type", "NEW / SAME / INCREASE / DECREASE"],
        ["from_date", "From date"],
      ],
    },
    {
      kind: "soa_format",
      label: "SOA Format File",
      variables: [
        ["enterprise", "Partner name"],
        ["from", "Period start"],
        ["to", "Period end"],
        ["opening_balance", "Opening balance"],
        ["entries", "One row per entry: date, description, debit, credit, balance"],
        ["closing_balance", "Closing balance"],
        ["currency", "Currency"],
      ],
    },
    {
      kind: "customer_rate_file_name",
      label: "Customer Rate File Name",
      variables: [
        ["company", "Business company"],
        ["enterprise", "Partner name"],
        ["trunk", "Customer trunk"],
        ["date", "Send date (YYYY-MM-DD)"],
      ],
    },
  ].map((f) => ({
    ...f,
    variables: f.variables.map(([key, description]) => ({ key: key!, description: description! })),
  })),
});

// ---------------------------------------------------------------- Check SMTP Connection
// The settings are checked first; in production (backend step 11) the mailbox's server is then really connected to
// and logged in to (jobs/mailer.ts verifyMailbox). Elsewhere that last step is simulated.

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
export function checkSmtp(request: FastifyRequest, reply: FastifyReply) {
  const { businessCompanyId, mailbox: m } = request.body as SmtpCheckInput;
  return withDb(reply, async (pool) => {
    let storedPass: string | null = null;
    if (businessCompanyId != null) {
      const { rows } = await pool.query(
        `SELECT smtp_password_enc, smtp_host, smtp_port, coalesce(smtp_username, smtp_email) AS login
           FROM business_company_mailboxes WHERE business_company_id = $1 AND department = $2`,
        [businessCompanyId, m.department],
      );
      const r = rows[0];
      // The stored password is only tried against the server it is stored for (security audit, team trial round 12):
      // with another host, port or login it would be handed to whatever server the caller names.
      const same =
        !!r &&
        String(r.smtp_host ?? "").trim().toLowerCase() === m.smtpHost.trim().toLowerCase() &&
        Number(r.smtp_port) === m.smtpPort &&
        String(r.login ?? "").trim().toLowerCase() === String(m.smtpUsername || m.smtpEmail || "").trim().toLowerCase();
      storedPass = same && r.smtp_password_enc ? decryptSecret(r.smtp_password_enc as string) : null;
    }
    const password = m.smtpPassword ?? storedPass;
    const host = m.smtpHost.trim();
    const steps = [
      { step: "Resolve host", ok: HOST.test(host), detail: HOST.test(host) ? host : "not a valid host name" },
      {
        step: "Connect",
        ok: [25, 465, 587, 2525].includes(m.smtpPort),
        detail: `port ${m.smtpPort}${[25, 465, 587, 2525].includes(m.smtpPort) ? "" : " is not an SMTP port"}`,
      },
      {
        step: "Encryption",
        ok: !(m.smtpPort === 465 && m.smtpSecure !== "ssl") && !(m.smtpPort === 587 && m.smtpSecure === "ssl"),
        detail:
          m.smtpPort === 465 ? "port 465 needs SSL" : m.smtpPort === 587 ? "port 587 uses STARTTLS" : m.smtpSecure,
      },
      {
        step: "Log in",
        ok: !!password && !!(m.smtpUsername || m.smtpEmail),
        detail: password ? `as ${m.smtpUsername || m.smtpEmail}` : "no SMTP password stored or entered",
      },
    ];
    if (production && steps.every((s) => s.ok)) {
      const answer = await verifyMailbox({
        id: null,
        name: null,
        email: m.smtpEmail,
        host,
        port: m.smtpPort,
        secure: m.smtpSecure,
        username: m.smtpUsername || m.smtpEmail,
        password,
      });
      steps.push({ step: "Server", ok: answer === null, detail: answer ?? `${host} accepted the login` });
    }
    // A step after a failed one does not run.
    const firstFail = steps.findIndex((s) => !s.ok);
    const out = steps.map((s, i) => (firstFail >= 0 && i > firstFail ? { ...s, ok: false, detail: "skipped" } : s));
    const ok = firstFail < 0;
    if (businessCompanyId != null)
      await pool.query(
        "UPDATE business_company_mailboxes SET last_check_at = now(), last_check_ok = $3 WHERE business_company_id = $1 AND department = $2",
        [businessCompanyId, m.department, ok],
      );
    return {
      ok,
      message: ok
        ? production
          ? `Connected to ${host}:${m.smtpPort} and logged in`
          : `Connected to ${host}:${m.smtpPort} (simulated - no e-mail is sent in this phase)`
        : `Failed at “${steps[firstFail]!.step}”`,
      steps: out,
    };
  });
}

/** Department mailboxes of a business company, for sender pickers (§8 Broadcast). */
export function listCompanyMailboxes(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const { rows: bc } = await pool.query("SELECT 1 FROM business_companies WHERE id = $1", [id]);
    if (!bc[0]) return notFound(reply, "Business company", id);
    const { rows } = await pool.query(
      `SELECT smtp_email, department FROM business_company_mailboxes WHERE business_company_id = $1
        ORDER BY array_position(ARRAY['noc','sales','rates','billing','support'], department)`,
      [id],
    );
    return {
      mailboxes: rows.map((r) => ({
        email: r.smtp_email as string,
        department:
          r.department === "noc" ? "NOC" : String(r.department).charAt(0).toUpperCase() + String(r.department).slice(1),
      })),
    };
  });
}
