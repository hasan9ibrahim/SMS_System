// Set-password links (team trial round 11, §13.28): an administrator e-mails users a single-use link that works for
// 72 hours, e.g. after importing them. The link opens the Set Password screen; the user picks a password under the
// usual rules and then signs in as usual (2FA included): the link never signs anyone in.
//
//   * only the token's SHA-256 is kept to check a link; the token itself is kept encrypted until the e-mail job has
//     sent it (the logged e-mail shows a placeholder, so Email Logs never shows a working link), then cleared;
//   * a new link replaces the user's earlier ones; using a link ends the user's open sessions;
//   * deleted or inactive users, users without an e-mail address and administrators (unless the sender is one) are
//     skipped; addresses that get links for several users are reported, since whoever reads that mailbox can use
//     them.
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  PasswordLinksInput,
  PasswordLinksResult,
  PasswordSetupCheckInput,
  PasswordSetupInfo,
  PasswordSetupInput,
} from "@sms/contract";
import { decryptSecret, encryptSecret, hashPassword, passwordRules } from "../admin/passwords.js";
import { withDb } from "../db.js";
import { production } from "../mode.js";
import { sendProblem } from "../problem.js";
import { endSessions, recentHashes, ruleErrors } from "./admin.js";
import type { FieldError } from "./records.js";
import { logEmail } from "./emailLog.js";
import { adminSql, getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;

export const LINK_HOURS = 72;
/** What the logged e-mail shows instead of the link; the e-mail job puts the link in when it sends. */
export const LINK_PLACEHOLDER = "[set-password link, shown only in the e-mail itself]";

const tokenHash = (token: string) => createHash("sha256").update(`password-link:${token}`).digest("hex");
const publicUrl = () => (process.env.PUBLIC_URL ?? "http://localhost:5173").replace(/\/+$/, "");
/** The token goes after # so it never reaches a server log. */
export const linkUrl = (token: string) => `${publicUrl()}/set-password#${token}`;

const body = (firstName: string, username: string, link: string) =>
  `Hello ${firstName},\n\n` +
  `An administrator has set up your Xpert account. Your username is ${username}.\n\n` +
  `Open this link to choose your password:\n${link}\n\n` +
  `The link works once, for ${LINK_HOURS} hours. Then sign in with your username, your new password and the ` +
  `sign-in code.\n\n` +
  `This link does not sign you in. If you did not expect this e-mail, ignore it and tell your administrator.`;

export function sendPasswordLinks(request: FastifyRequest, reply: FastifyReply) {
  const { ids } = request.body as PasswordLinksInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const iAmAdmin = me.permissions.includes("*");
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.first_name, u.email, u.status, u.deleted_at, ${adminSql("u")} AS is_admin
         FROM users u WHERE u.id = ANY($1)`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const skipped: PasswordLinksResult["skipped"] = [];
    const ok: { id: number; username: string; firstName: string; email: string }[] = [];
    for (const id of ids) {
      const u = byId.get(id);
      const reason = !u
        ? "not found"
        : u.deleted_at
          ? "deleted"
          : u.status !== "active"
            ? "inactive"
            : !String(u.email ?? "").trim()
              ? "no e-mail address"
              : u.is_admin && !iAmAdmin
                ? "an administrator: only an administrator can send this"
                : null;
      if (reason) skipped.push({ userId: id, username: u ? String(u.username) : `#${id}`, reason });
      else ok.push({ id, username: String(u!.username), firstName: String(u!.first_name), email: String(u!.email).trim() });
    }
    const expiresAt = new Date(Date.now() + LINK_HOURS * 3_600_000);
    await inTransaction(pool, async (c) => {
      for (const u of ok) {
        // A new link replaces the earlier ones.
        await c.query("UPDATE password_links SET used_at = now(), token_enc = NULL WHERE user_id = $1 AND used_at IS NULL", [
          u.id,
        ]);
        const token = randomBytes(32).toString("base64url");
        const logId = { value: 0 };
        // In production the e-mail job sends it and puts the link in; without a mail server (development) nothing is
        // delivered, so the logged e-mail keeps the link for testing.
        await logEmail(
          c,
          {
            type: "password_setup",
            to: [u.email],
            subject: "Set your Xpert password",
            body: body(u.firstName, u.username, production ? LINK_PLACEHOLDER : linkUrl(token)),
            sender: null,
            userId: u.id,
          },
          logId,
        );
        await c.query(
          `INSERT INTO password_links (user_id, token_hash, token_enc, email_log_id, expires_at, created_by_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [u.id, tokenHash(token), production ? encryptSecret(token) : null, logId.value || null, expiresAt, me.id],
        );
        // Team activity (§13.18) shows it on the user's timeline.
        await c.query(
          `INSERT INTO audit_log (user_id, ip, module, controller, method, action, table_name, master_id, status)
           VALUES ($1, $2, 'security', '/users/password-links', 'POST', 'passwordLinkSent', 'users', $3, 200)`,
          [me.id, request.ip ?? null, String(u.id)],
        );
      }
    });
    const byEmail = new Map<string, string[]>();
    for (const u of ok) byEmail.set(u.email.toLowerCase(), [...(byEmail.get(u.email.toLowerCase()) ?? []), u.username]);
    const sharedEmails = [...byEmail.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([email, usernames]) => ({ email, usernames }));
    return { sent: ok.length, skipped, sharedEmails, expiresAt: expiresAt.toISOString() } satisfies PasswordLinksResult;
  });
}

/** The live link of a token, with its user; null when unknown, used, expired, or the user cannot sign in. */
async function linkOf(c: Db, token: string) {
  const { rows } = await c.query(
    `SELECT l.id, l.user_id, l.expires_at, u.username, u.first_name, u.last_name
       FROM password_links l JOIN users u ON u.id = l.user_id
      WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now()
        AND u.deleted_at IS NULL AND u.status = 'active'`,
    [tokenHash(token)],
  );
  return rows[0] ?? null;
}

const gone = (reply: FastifyReply) =>
  sendProblem(reply, 404, "This link has expired or was already used", {
    detail: "Ask your administrator to e-mail you a new one.",
  });

export function checkPasswordSetup(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as PasswordSetupCheckInput;
  return withDb(reply, async (pool) => {
    const link = await linkOf(pool, b.token);
    if (!link) return gone(reply);
    const password = b.password ?? "";
    const rules = passwordRules(
      password,
      { username: link.username, firstName: link.first_name, lastName: link.last_name },
      password ? await recentHashes(pool, "user_id", Number(link.user_id)) : [],
    ).map((r) => ({ ...r, met: !!password && r.met }));
    return {
      username: String(link.username),
      firstName: String(link.first_name),
      expiresAt: (link.expires_at as Date).toISOString(),
      rules,
    } satisfies PasswordSetupInfo;
  });
}

export function completePasswordSetup(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as PasswordSetupInput;
  return withDb(reply, async (pool) => {
    const link = await linkOf(pool, b.token);
    if (!link) return gone(reply);
    const userId = Number(link.user_id);
    const errors: FieldError[] = [];
    if (b.password !== b.confirmPassword) errors.push({ path: "/confirmPassword", message: "the passwords do not match" });
    errors.push(
      ...ruleErrors(
        passwordRules(
          b.password,
          { username: link.username, firstName: link.first_name, lastName: link.last_name },
          await recentHashes(pool, "user_id", userId),
        ),
        "/password",
      ),
    );
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    const hash = hashPassword(b.password);
    const done = await inTransaction(pool, async (c) => {
      // Used once: a second request with the same link finds it used.
      const { rowCount } = await c.query(
        "UPDATE password_links SET used_at = now(), token_enc = NULL WHERE id = $1 AND used_at IS NULL",
        [link.id],
      );
      if (!rowCount) return false;
      await c.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false,
                temp_password_expires_at = NULL, failed_logins = 0, locked_until = NULL, updated_at = now()
          WHERE id = $1`,
        [userId, hash],
      );
      await c.query("INSERT INTO password_history (user_id, password_hash, changed_at) VALUES ($1, $2, now())", [
        userId,
        hash,
      ]);
      await endSessions(c, "user_id = $1", [userId], "password_change", null);
      await c.query(
        `INSERT INTO audit_log (user_id, ip, module, controller, method, action, table_name, master_id, status)
         VALUES ($1, $2, 'security', '/password-setup', 'POST', 'passwordSetFromLink', 'users', $3, 200)`,
        [userId, request.ip ?? null, String(userId)],
      );
      return true;
    });
    if (!done) return gone(reply);
    return { username: String(link.username) };
  });
}

/**
 * The e-mail job's part: the link to put in a set-password e-mail it is about to send, or null when the link was
 * replaced or used meanwhile (the e-mail then fails with that reason).
 */
export async function linkForEmail(c: Db, emailLogId: number): Promise<string | null> {
  const { rows } = await c.query(
    "SELECT token_enc FROM password_links WHERE email_log_id = $1 AND used_at IS NULL AND expires_at > now()",
    [emailLogId],
  );
  const token = rows[0]?.token_enc ? decryptSecret(String(rows[0].token_enc)) : null;
  return token ? linkUrl(token) : null;
}

/** After sending (or giving up), the token is not kept any longer. */
export async function forgetLinkToken(c: Db, emailLogId: number) {
  await c.query("UPDATE password_links SET token_enc = NULL WHERE email_log_id = $1", [emailLogId]);
}
