// Incoming RNs by e-mail (§13.13 A; backend step 11): every Rates mailbox with an IMAP host is read every 2 minutes
// over SSL with its SMTP login. Each new e-mail that carries a rate sheet (CSV, text or Excel) goes through the same
// intake as an upload (api/rn.ts intakeMail): the trunk is found from the sender, subject and file, the RN is checked
// and, by the vendor's settings, accepted automatically. E-mails without a sheet are left alone.
//
// Only e-mails that arrive after the mailbox is first read are taken (the inbox's history is not imported); the last
// message read is kept per mailbox (imap_last_uid, reset when the server renumbers the folder).
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type pg from "pg";
import type { RnAttachment, RnIntake } from "@sms/contract";
import { decryptSecret } from "../admin/passwords.js";
import { db } from "../db.js";
import { intakeMail } from "../api/rn.js";
import { systemUserId } from "./system.js";

const SHEET = /\.(csv|txt|tsv|xlsx|xls)$/i;
const MAX_PER_RUN = 50;
/** An e-mail larger than this is not read (rate sheets are far smaller; security audit, team trial round 12). */
const MAX_MAIL_BYTES = 40 * 1024 * 1024;

interface Box {
  id: number;
  email: string;
  host: string;
  port: number;
  user: string;
  pass: string | null;
  lastUid: number | null;
  uidValidity: number | null;
}

/** The sheets of one e-mail as RN attachments (exported for tests). */
export function sheetsOf(attachments: { filename?: string; content: Buffer }[]): RnAttachment[] {
  return attachments
    .filter((a) => a.filename && SHEET.test(a.filename) && a.content.length > 0)
    .map((a) =>
      /\.xlsx?$/i.test(a.filename!)
        ? { fileName: a.filename!, content: a.content.toString("base64"), encoding: "base64" as const }
        : { fileName: a.filename!, content: a.content.toString("utf8"), encoding: "text" as const },
    );
}

async function readBox(pool: pg.Pool, box: Box): Promise<number> {
  const client = new ImapFlow({
    host: box.host,
    port: box.port,
    secure: true,
    auth: { user: box.user, pass: box.pass ?? "" },
    logger: false,
  });
  await client.connect();
  let taken = 0;
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = client.mailbox && typeof client.mailbox === "object" ? client.mailbox : null;
      const validity = Number(status?.uidValidity ?? 0);
      const next = Number(status?.uidNext ?? 1);
      // First read, or the server renumbered the folder: start from now.
      if (box.lastUid === null || box.uidValidity !== validity) {
        await pool.query("UPDATE business_company_mailboxes SET imap_last_uid = $2, imap_uid_validity = $3 WHERE id = $1", [
          box.id,
          next - 1,
          validity,
        ]);
        return 0;
      }
      let last = box.lastUid;
      for await (const msg of client.fetch({ uid: `${box.lastUid + 1}:*` }, { uid: true, source: true }, { uid: true })) {
        if (msg.uid <= box.lastUid || !msg.source) continue;
        // One e-mail that cannot be read never holds up the mailbox: it is skipped and logged, and the next run starts
        // after it (security audit, team trial round 12: it was read again every 2 minutes).
        try {
          taken += await takeMessage(pool, box.email, msg.source);
        } catch (err) {
          console.warn(`rate mailbox ${box.email}: e-mail ${msg.uid} skipped (${(err as Error).message})`);
        }
        last = Math.max(last, msg.uid);
        await pool.query("UPDATE business_company_mailboxes SET imap_last_uid = $2 WHERE id = $1", [box.id, last]);
        if (taken >= MAX_PER_RUN) break;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return taken;
}

/** One e-mail of a Rates mailbox: its rate sheets become an incoming RN; 1 when taken in, else 0. */
async function takeMessage(pool: pg.Pool, mailbox: string, source: Buffer): Promise<number> {
  if (source.length > MAX_MAIL_BYTES) throw new Error(`larger than ${MAX_MAIL_BYTES / 1024 / 1024} MB`);
  const mail = await simpleParser(source);
  const sheets = sheetsOf(mail.attachments ?? []);
  if (!sheets.length) return 0;
  const intake: RnIntake = {
    source: "email",
    mailbox,
    fromAddress: mail.from?.value?.[0]?.address ?? null,
    subject: (mail.subject ?? "").slice(0, 500) || null,
    body: (mail.text ?? "").slice(0, 20_000) || null,
    attachments: sheets,
  };
  await intakeMail(pool, intake, await systemUserId(pool), null);
  return 1;
}

/** One round over every Rates mailbox with an IMAP host; returns the e-mails taken in. */
export async function readRateMailboxes(pool: pg.Pool = db()): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, smtp_email, imap_host, imap_port, coalesce(smtp_username, smtp_email) AS username, smtp_password_enc,
            imap_last_uid, imap_uid_validity
       FROM business_company_mailboxes WHERE department = 'rates' AND imap_host IS NOT NULL AND imap_host <> ''`,
  );
  let total = 0;
  for (const r of rows) {
    const box: Box = {
      id: Number(r.id),
      email: String(r.smtp_email),
      host: String(r.imap_host),
      port: Number(r.imap_port),
      user: String(r.username),
      pass: r.smtp_password_enc ? decryptSecret(String(r.smtp_password_enc)) : null,
      lastUid: r.imap_last_uid == null ? null : Number(r.imap_last_uid),
      uidValidity: r.imap_uid_validity == null ? null : Number(r.imap_uid_validity),
    };
    try {
      total += await readBox(pool, box);
      await pool.query(
        "UPDATE business_company_mailboxes SET imap_last_read_at = now(), imap_last_error = NULL WHERE id = $1",
        [box.id],
      );
    } catch (err) {
      const e = err as { responseText?: string; message?: string };
      await pool.query("UPDATE business_company_mailboxes SET imap_last_error = $2 WHERE id = $1", [
        box.id,
        String(e.responseText ?? e.message ?? err).slice(0, 500),
      ]);
    }
  }
  return total;
}

/** Every 2 minutes on the server that runs the jobs. */
export function startImapIntake() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await readRateMailboxes();
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void tick().catch(() => undefined), 30_000).unref();
  setInterval(() => void tick().catch(() => undefined), 120_000).unref();
}
