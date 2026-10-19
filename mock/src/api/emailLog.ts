// Email Logs (§8): every e-mail the platform sends, or fails to send, writes one row. The mock
// records the message instead of sending it; a send without recipients is logged as failed.
import type pg from "pg";
import type { EmailLogRow, MailboxDepartment, SenderEmail } from "@sms/contract";
import { embedImages, emailDocument, imageInfo, logoTag } from "../email/html.js";

type Db = pg.Pool | pg.PoolClient;

export interface EmailLogInput {
  type: EmailLogRow["emailType"];
  enterpriseId?: number | null;
  customerTrunkId?: number | null;
  vendorTrunkId?: number | null;
  to: string[];
  cc?: string[];
  sender?: string | null;
  subject: string;
  body?: string;
  file?: string | null;
  rateDate?: string | null;
  /** Failed when set, or when there is no recipient. */
  error?: string | null;
  userId?: number | null;
}

/** Logs an e-mail and returns its status; `id` receives the log row's ID when given. */
export async function logEmail(c: Db, m: EmailLogInput, id?: { value: number }): Promise<"sent" | "failed"> {
  const error = m.error ?? (m.to.length ? null : "No recipient: the partner has no contact for this e-mail");
  const status = error ? "failed" : "sent";
  // The e-mail as sent (§11): the designed HTML with CSS inlined; uploaded images go inline (cid).
  const doc = emailDocument(m.body ?? "");
  const inline = embedImages(doc).images.map((i) => (i.assetId ? `image-${i.assetId}` : `logo-${i.companyId}`));
  const { rows } = await c.query(
    `INSERT INTO email_logs (enterprise_id, customer_trunk_id, vendor_trunk_id, email_type, status, rate_date, file_name,
                             error, sender, to_addresses, cc_addresses, subject, body, user_id, body_html, inline_images)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      m.enterpriseId ?? null,
      m.customerTrunkId ?? null,
      m.vendorTrunkId ?? null,
      m.type,
      status,
      m.rateDate ?? null,
      m.file ?? null,
      error,
      m.sender ?? null,
      m.to,
      m.cc ?? [],
      m.subject,
      m.body ?? "",
      m.userId ?? null,
      doc,
      inline,
    ],
  );
  if (id) id.value = Number(rows[0].id);
  return status;
}

// ---------------------------------------------------------------- the business company behind an e-mail (§11)

/** The selling entity an e-mail goes out for: the partner's business company, or one named directly. */
export type MailFor = { enterpriseId: number } | { companyId: number };
const companyIdSql = (who: MailFor) =>
  "companyId" in who ? "$1::bigint" : "(SELECT business_company_id FROM enterprises WHERE id = $1)";
const idOf = (who: MailFor) => ("companyId" in who ? who.companyId : who.enterpriseId);

/** Default department mailbox per e-mail kind; a business company can choose another (Senders, §11). */
export const SENDER_DEFAULTS: Record<SenderEmail, MailboxDepartment> = {
  rateSheet: "rates",
  rnReply: "rates",
  techInfo: "noc",
  trafficAlert: "noc",
  dailyReport: "noc",
  scheduledReport: "noc",
  invoice: "billing",
  soa: "billing",
  paymentConfirmation: "billing",
  vendorInvoiceReply: "billing",
  troubleTicket: "noc",
};

/**
 * The address an e-mail kind is sent from: the department the business company chose for it (else the
 * default), that department's mailbox, else the default department's mailbox, else department@website.
 */
export async function senderFor(c: Db, who: MailFor, kind: SenderEmail): Promise<string | null> {
  const { rows } = await c.query(
    `SELECT bc.website, bc.senders,
            coalesce(jsonb_object_agg(mb.department, mb.smtp_email) FILTER (WHERE mb.department IS NOT NULL), '{}') AS boxes
       FROM business_companies bc LEFT JOIN business_company_mailboxes mb ON mb.business_company_id = bc.id
      WHERE bc.id = ${companyIdSql(who)} GROUP BY bc.id`,
    [idOf(who)],
  );
  const r = rows[0];
  if (!r) return null;
  const fallback = SENDER_DEFAULTS[kind];
  const dept = ((r.senders as Record<string, string> | null)?.[kind] as MailboxDepartment | undefined) ?? fallback;
  const boxes = r.boxes as Record<string, string>;
  if (boxes[dept]) return boxes[dept];
  if (boxes[fallback]) return boxes[fallback];
  const host = (r.website as string | null)?.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");
  return host ? `${dept}@${host}` : null;
}

/** The partner's business company's sender for an e-mail kind. */
export const companyMailbox = (c: Db, enterpriseId: number, kind: SenderEmail) => senderFor(c, { enterpriseId }, kind);

/** Email template type → its key in the business company's default templates (§11). */
const DEFAULT_TEMPLATE_KEY: Record<string, string> = {
  customer_rate: "customerRate",
  invoice: "invoice",
  low_balance: "lowBalance",
  bind_down: "bindDown",
  customer_tech_info: "customerTechInfo",
  trunk_change_info: "trunkChangeInfo",
  soa_statement: "soaStatement",
  rate_upload_notification: "rateUploadNotification",
  auto_upload_rejected: "autoUploadRejected",
};

/**
 * The template an e-mail type uses for this business company: its chosen default for the type, else one of
 * its own templates of the type, else a shared one (no business company). Undefined when none exists.
 */
export async function companyTemplate(
  c: Db,
  who: MailFor,
  type: string,
): Promise<{ id: number; subject: string; body: string } | undefined> {
  const { rows } = await c.query(
    `WITH bc AS (SELECT id, default_templates FROM business_companies WHERE id = ${companyIdSql(who)})
     SELECT t.id, t.subject, t.body FROM email_templates t LEFT JOIN bc ON true
      WHERE t.email_type = $2 AND t.deleted_at IS NULL AND (t.business_company_id IS NULL OR t.business_company_id = bc.id)
      ORDER BY (t.id::text = bc.default_templates->>$3) DESC NULLS LAST, (t.business_company_id IS NOT NULL) DESC, t.id
      LIMIT 1`,
    [idOf(who), type, DEFAULT_TEMPLATE_KEY[type] ?? ""],
  );
  const r = rows[0];
  return r ? { id: Number(r.id), subject: r.subject as string, body: r.body as string } : undefined;
}

/** The business company's own details for a document or e-mail: name, address, website and bank. */
export interface CompanyDetails {
  id: number;
  name: string;
  address: string;
  website: string;
  hasLogo: boolean;
  /** The logo's pixel size, read from the uploaded file. */
  logo: { width: number; height: number } | null;
  bank: { label: string; value: string }[];
}

export async function companyDetails(c: Db, who: MailFor): Promise<CompanyDetails | null> {
  const { rows } = await c.query(
    `SELECT bc.*, co.name AS country_name,
            (SELECT substring(f.content FROM 1 FOR 65536) FROM business_company_files f
              WHERE f.business_company_id = bc.id AND f.kind = 'logo') AS logo_head
       FROM business_companies bc LEFT JOIN countries co ON co.iso = bc.country_iso WHERE bc.id = ${companyIdSql(who)}`,
    [idOf(who)],
  );
  const r = rows[0];
  if (!r) return null;
  const t = (v: unknown) => (v == null ? "" : String(v).trim());
  const bank = (
    [
      ["Beneficiary", r.bank_beneficiary_name],
      ["Beneficiary address", r.bank_beneficiary_address],
      ["Bank", r.bank_name],
      ["Bank address", r.bank_address],
      ["Account currency", r.bank_currency],
      ["Account number", r.bank_account_number],
      ["IBAN", r.bank_iban],
      ["SWIFT", r.bank_swift],
    ] as [string, unknown][]
  )
    .map(([label, v]) => ({ label, value: t(v) }))
    .filter((x) => x.value);
  const logo = r.logo_head ? imageInfo(r.logo_head as Buffer) : null;
  return {
    id: Number(r.id),
    name: t(r.name),
    address: [
      r.address_line1,
      r.address_line2,
      [r.zip, r.city].map(t).filter(Boolean).join(" "),
      r.state,
      r.country_name,
    ]
      .map(t)
      .filter(Boolean)
      .join(", "),
    website: t(r.website),
    hasLogo: r.logo_head != null,
    logo: logo ? { width: logo.width, height: logo.height } : null,
    bank,
  };
}

/**
 * Placeholders every template can use for the sending business company (§11): {company}, {company_logo},
 * {company_address}, {company_website}, {bank_details} (all bank lines) and one per bank field.
 */
export function companyPlaceholders(d: CompanyDetails | null): Record<string, string> {
  const get = (label: string) => d?.bank.find((b) => b.label === label)?.value ?? "";
  return {
    company: d?.name ?? "",
    company_address: d?.address ?? "",
    company_website: d?.website ?? "",
    company_logo:
      d?.logo != null && d.logo.height >= 16
        ? logoTag(`/api/v1/business-companies/${d.id}/files/logo`, d.name, d.logo.width, d.logo.height)
        : "",
    bank_beneficiary: get("Beneficiary"),
    bank_name: get("Bank"),
    bank_address: get("Bank address"),
    bank_currency: get("Account currency"),
    bank_account: get("Account number"),
    bank_iban: get("IBAN"),
    bank_swift: get("SWIFT"),
    bank_details: (d?.bank ?? []).map((b) => `${b.label}: ${b.value}`).join("\n"),
  };
}
