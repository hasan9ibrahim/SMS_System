// Email Logs (§8): every e-mail the platform sends, or fails to send, writes one row. The mock
// records the message instead of sending it; a send without recipients is logged as failed.
import type pg from "pg";
import type { EmailLogRow } from "@sms/contract";

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

export async function logEmail(c: Db, m: EmailLogInput): Promise<"sent" | "failed"> {
  const error = m.error ?? (m.to.length ? null : "No recipient: the partner has no contact for this e-mail");
  const status = error ? "failed" : "sent";
  await c.query(
    `INSERT INTO email_logs (enterprise_id, customer_trunk_id, vendor_trunk_id, email_type, status, rate_date, file_name,
                             error, sender, to_addresses, cc_addresses, subject, body, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
    ],
  );
  return status;
}

/** The business company's mailbox for a department, e.g. billing@company.example (§11 sender blocks). */
export async function companyMailbox(c: Db, enterpriseId: number, department: string): Promise<string | null> {
  const { rows } = await c.query(
    `SELECT mb.smtp_email, bc.website FROM enterprises e JOIN business_companies bc ON bc.id = e.business_company_id
       LEFT JOIN business_company_mailboxes mb ON mb.business_company_id = bc.id AND mb.department = $2
      WHERE e.id = $1`,
    [enterpriseId, department],
  );
  if (rows[0]?.smtp_email) return rows[0].smtp_email as string;
  const host = (rows[0]?.website as string | undefined)?.replace(/^https?:\/\/(www\.)?/, "");
  return host ? `${department}@${host}` : null;
}
