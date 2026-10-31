// The e-mail job (backend step 11, §8 Email Logs, §11 department mailboxes): sends the e-mails queued in email_logs
// (api/emailLog.ts logEmail, and the Elixir API's sign-in codes) over SMTP and records the outcome.
//
//   * From: the mailbox whose SMTP Email is the e-mail's sender (Business Company → department mailboxes), with its
//     host, port, security and login; platform e-mails without a company sender (sign-in codes, password reminders)
//     use the platform mailbox (SMTP_URL / SMTP_FROM);
//   * the designed body goes out as sent (CSS inlined), uploaded images and the company logo embedded inline (cid),
//     with the e-mail's attachments; the platform's own plain-text e-mails get the Xpert logo and footer (round 11);
//   * a mail server that is down or answers 4xx is tried again after 1, 5, 15 and 60 minutes; a 5xx answer, or the
//     last try, marks the e-mail failed with the server's answer. Sent e-mails drop their attachment copies.
//
// Runs on the server that runs the jobs; rows are claimed (FOR UPDATE SKIP LOCKED) so a second sender never sends one
// twice.
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type pg from "pg";
import { decryptSecret } from "../admin/passwords.js";
import { db } from "../db.js";
import { embedImages, isHtml } from "../email/html.js";
import { platformDocument, platformLogoPart } from "../email/platform.js";
import { forgetLinkToken, LINK_PLACEHOLDER, linkForEmail } from "../api/passwordLinks.js";
import { OTP_HIDDEN } from "../api/emailLog.js";

type Db = pg.Pool | pg.PoolClient;

const BATCH = 20;
const RETRY_MIN = [1, 5, 15, 60];
/** A claimed row that is not finished in this time (the server stopped) is tried again. */
const LEASE_MIN = 10;

export interface Mailbox {
  id: number | null;
  name: string | null;
  email: string;
  host: string;
  port: number;
  secure: "none" | "ssl" | "starttls";
  username: string | null;
  password: string | null;
}

/** The transport options of a mailbox (exported for tests). */
export function transportOptions(m: Mailbox) {
  return {
    host: m.host,
    port: m.port,
    secure: m.secure === "ssl",
    requireTLS: m.secure === "starttls",
    ignoreTLS: m.secure === "none",
    auth: m.username ? { user: m.username, pass: m.password ?? "" } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  };
}

const transports = new Map<string, Transporter>();
function transportFor(m: Mailbox): Transporter {
  const key = JSON.stringify(transportOptions(m));
  let t = transports.get(key);
  if (!t) transports.set(key, (t = nodemailer.createTransport(transportOptions(m))));
  return t;
}

/** The platform mailbox from SMTP_URL (smtp://user:pass@host:587, smtps:// for SSL) and SMTP_FROM. */
export function platformMailbox(env = process.env): Mailbox | null {
  if (!env.SMTP_URL) return null;
  const u = new URL(env.SMTP_URL);
  const ssl = u.protocol === "smtps:";
  const from = env.SMTP_FROM || decodeURIComponent(u.username);
  return {
    id: null,
    name: env.SMTP_FROM_NAME || null,
    email: from,
    host: u.hostname,
    port: Number(u.port || (ssl ? 465 : 587)),
    secure: ssl ? "ssl" : u.searchParams.get("secure") === "none" ? "none" : "starttls",
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
  };
}

const mapMailbox = (r: Record<string, unknown>): Mailbox => ({
  id: Number(r.id),
  name: (r.name as string | null) ?? null,
  email: String(r.smtp_email),
  host: String(r.smtp_host),
  port: Number(r.smtp_port),
  secure: r.smtp_secure as Mailbox["secure"],
  username: (r.smtp_username as string | null) || null,
  password: r.smtp_password_enc ? decryptSecret(String(r.smtp_password_enc)) : null,
});

/** The mailbox that sends as `sender`: a department mailbox with that SMTP Email, else the platform mailbox. */
export async function mailboxFor(c: Db, sender: string | null): Promise<Mailbox | null> {
  if (sender) {
    const { rows } = await c.query(
      "SELECT * FROM business_company_mailboxes WHERE lower(smtp_email) = lower($1) ORDER BY id LIMIT 1",
      [sender],
    );
    if (rows[0]) return mapMailbox(rows[0]);
  }
  return platformMailbox();
}

/** A department mailbox by id (Check SMTP Connection). */
export async function mailboxById(c: Db, id: number): Promise<Mailbox | null> {
  const { rows } = await c.query("SELECT * FROM business_company_mailboxes WHERE id = $1", [id]);
  return rows[0] ? mapMailbox(rows[0]) : null;
}

/** Connects and logs in to the mailbox's server; null when it works, else the server's answer. */
export async function verifyMailbox(m: Mailbox): Promise<string | null> {
  const t = nodemailer.createTransport(transportOptions(m));
  try {
    await t.verify();
    return null;
  } catch (err) {
    return errorText(err);
  } finally {
    t.close();
  }
}

const errorText = (err: unknown) => {
  const e = err as { response?: string; message?: string; code?: string };
  return String(e.response ?? e.message ?? e.code ?? err).slice(0, 500);
};
/** A 5xx answer will not change on a retry; anything else (4xx, timeout, connection refused) may. */
const permanent = (err: unknown) => {
  const code = Number((err as { responseCode?: number }).responseCode ?? 0);
  return code >= 500 && code < 600;
};

/** The inline images of a designed body: uploaded assets and company logos (api/emailLog.ts embedImages). */
async function inlineImages(c: Db, html: string) {
  const { html: out, images } = embedImages(html);
  const files: { cid: string; filename: string; content: Buffer; contentType: string }[] = [];
  for (const i of images) {
    const { rows } =
      i.assetId != null
        ? await c.query("SELECT name, content_type, data FROM email_assets WHERE id = $1", [i.assetId])
        : await c.query(
            "SELECT 'logo.png' AS name, 'image/png' AS content_type, content AS data FROM business_company_files WHERE business_company_id = $1 AND kind = 'logo'",
            [i.companyId],
          );
    if (rows[0])
      files.push({ cid: i.cid, filename: String(rows[0].name), content: rows[0].data as Buffer, contentType: String(rows[0].content_type) });
  }
  return { html: out, files };
}

/** Sends one queued e-mail; exported for tests (`send` replaces the SMTP transport). */
export async function deliver(
  c: Db,
  row: Record<string, unknown>,
  send: (m: Mailbox, message: SendMailOptions) => Promise<{ messageId?: string }> = (m, message) =>
    transportFor(m).sendMail(message),
): Promise<"sent" | "queued" | "failed"> {
  const id = Number(row.id);
  const tries = Number(row.tries ?? 0) + 1;
  const fail = async (error: string, retry: boolean) => {
    const wait = RETRY_MIN[tries - 1];
    if (retry && wait !== undefined) {
      await c.query(
        "UPDATE email_logs SET tries = $2, error = $3, next_try_at = now() + make_interval(mins => $4) WHERE id = $1",
        [id, tries, error, wait],
      );
      return "queued" as const;
    }
    await c.query("UPDATE email_logs SET status = 'failed', tries = $2, error = $3, next_try_at = NULL WHERE id = $1", [
      id,
      tries,
      error,
    ]);
    await forgetSecrets(c, String(row.email_type), id);
    return "failed" as const;
  };
  const mailbox = await mailboxFor(c, (row.sender as string | null) ?? null);
  if (!mailbox)
    return fail(
      row.sender
        ? `No mailbox sends as ${row.sender}: add it under Business Company → mailboxes, or set SMTP_URL`
        : "No platform mailbox: set SMTP_URL and SMTP_FROM",
      false,
    );
  // A set-password e-mail gets its link only now: the logged copy never holds a working link (team trial round 11).
  let body = String(row.body ?? "");
  if (row.email_type === "password_setup" && body.includes(LINK_PLACEHOLDER)) {
    const link = await linkForEmail(c, id);
    if (!link) {
      await forgetLinkToken(c, id);
      return fail("The link was replaced or used before this e-mail went out: send a new one from Users", false);
    }
    body = body.replace(LINK_PLACEHOLDER, link);
  }
  // The platform's own plain-text e-mails go out with the Xpert logo (team trial round 11); the text stays as the
  // text part. Designed e-mails and company mailboxes keep their own design.
  const branded = mailbox.id === null && body.trim() !== "" && !isHtml(body);
  const html = branded ? null : ((row.body_html as string | null) ?? null);
  const inline = html ? await inlineImages(c, html) : null;
  const { rows: att } = await c.query(
    "SELECT file_name, content_type, content FROM email_attachments WHERE email_log_id = $1 ORDER BY id",
    [id],
  );
  const message: SendMailOptions = {
    from: mailbox.name ? { name: mailbox.name, address: mailbox.email } : mailbox.email,
    to: row.to_addresses as string[],
    cc: (row.cc_addresses as string[] | null) ?? [],
    subject: String(row.subject),
    ...(inline
      ? { html: inline.html }
      : branded
        ? { text: body, html: platformDocument(body) }
        : { text: String(row.body ?? "") }),
    attachments: [
      ...(inline?.files ?? []),
      ...(branded ? [platformLogoPart()] : []),
      ...att.map((a) => ({ filename: String(a.file_name), contentType: String(a.content_type), content: a.content as Buffer })),
    ],
  };
  try {
    const info = await send(mailbox, message);
    await c.query(
      `UPDATE email_logs SET status = 'sent', tries = $2, error = NULL, next_try_at = NULL, sent_at = now(),
              message_id = $3, sender = coalesce(sender, $4) WHERE id = $1`,
      [id, tries, info.messageId ?? null, mailbox.email],
    );
    await c.query("DELETE FROM email_attachments WHERE email_log_id = $1", [id]);
    await forgetSecrets(c, String(row.email_type), id);
    return "sent";
  } catch (err) {
    return fail(errorText(err), !permanent(err));
  }
}

/**
 * After the last try, sent or given up: a set-password link and a sign-in code are not kept in the log (§13.28;
 * the code since the round 13 security review).
 */
async function forgetSecrets(c: Db, type: string, id: number) {
  if (type === "password_setup") await forgetLinkToken(c, id);
  if (type === "otp")
    await c.query("UPDATE email_logs SET body = $2, body_html = NULL WHERE id = $1", [id, OTP_HIDDEN]);
}

let busy = false;

/** One round: claims up to 20 due e-mails and sends them. */
export async function sendQueued(c: pg.Pool = db()): Promise<number> {
  if (busy) return 0;
  busy = true;
  try {
    const { rows } = await c.query(
      `UPDATE email_logs l SET next_try_at = now() + make_interval(mins => $2)
        WHERE l.id IN (SELECT id FROM email_logs WHERE status = 'queued' AND coalesce(next_try_at, inserted_at) <= now()
                        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING l.*`,
      [BATCH, LEASE_MIN],
    );
    for (const r of rows) await deliver(c, r).catch((err) => console.warn(`e-mail ${r.id}: ${errorText(err)}`));
    return rows.length;
  } finally {
    busy = false;
  }
}

/** Every 5 s; at once again when a round was full. */
export function startMailer() {
  const tick = () =>
    void sendQueued()
      .then((n) => {
        if (n >= BATCH) setImmediate(tick);
      })
      .catch(() => undefined);
  setInterval(tick, 5_000).unref();
  tick();
}
