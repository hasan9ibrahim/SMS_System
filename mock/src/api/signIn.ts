// Staff sign-in (backend step 9, contract v0.96.0, §13.28). Password, then a 2FA code at every login (product owner
// 2026-10-25): the authenticator app when the user has one, otherwise a code e-mailed to the user; only an
// administrator can turn the code off for a user (OTP verification Off). Sessions live in user_sessions (staff),
// found by a hash of the sms_session cookie, and end after 8 hours idle or 24 hours. The Elixir API answers the same
// operations; the mock checks the cookie itself only with MOCK_REQUIRE_SIGN_IN=1 (src/auth/user.ts).
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { SignInChallengeRef, SignInCodeInput, SignInInput, SignInResult } from "@sms/contract";
import { withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import { verifyPassword, verifyTotp } from "../admin/passwords.js";
import { cookieToken, MAX_HOURS, SESSION_COOKIE, sha } from "../auth/user.js";
import { device } from "./portal.js";
import { maskEmail } from "./admin.js";
import { logEmail } from "./emailLog.js";
import { demoUser, loadUser } from "./session.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const RESEND_GAP_S = 60;

const codeHash = (challengeId: number, code: string) =>
  createHash("sha256").update(`signin:${challengeId}:${code}`).digest("hex");

const setCookie = (reply: FastifyReply, token: string, maxAge: number) =>
  // The backend adds Secure behind HTTPS (BACKEND_TODO); the trial instance may run on plain HTTP.
  reply.header("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);

/** The user to record in the audit trail for a sign-in call (no session yet). */
const auditAs = (request: FastifyRequest, userId: number) => {
  (request as unknown as { smsUserId?: number }).smsUserId = userId;
};

/** Opens the session: other sessions end first for a user without Allow Multiple Login. */
async function openSession(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply, userId: number) {
  const { rows } = await pool.query("SELECT allow_multiple_login FROM users WHERE id = $1", [userId]);
  if (!rows[0]?.allow_multiple_login)
    await pool.query(
      `UPDATE user_sessions SET ended_at = now(), end_reason = 'replaced'
        WHERE user_kind = 'staff' AND user_id = $1 AND ended_at IS NULL`,
      [userId],
    );
  const token = randomBytes(32).toString("base64url");
  const d = device(String(request.headers["user-agent"] ?? ""));
  await pool.query(
    `INSERT INTO user_sessions (user_kind, user_id, ip, device, os, browser, logged_in_at, last_seen_at, token_hash)
     VALUES ('staff', $1, $2, $3, $4, $5, now(), now(), $6)`,
    [userId, request.ip || "127.0.0.1", d.device, d.os, d.browser, sha(token)],
  );
  await pool.query("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [
    userId,
  ]);
  setCookie(reply, token, MAX_HOURS * 3600);
  auditAs(request, userId);
  const user = (await loadUser(pool, userId)) ?? demoUser;
  return { status: "signed_in", user } satisfies SignInResult;
}

/** E-mails a new code for the challenge (the code only; never a password or a sign-in link, §13.28). */
async function sendCode(pool: pg.Pool, challengeId: number, userId: number): Promise<string> {
  const { rows } = await pool.query("SELECT first_name, email FROM users WHERE id = $1", [userId]);
  const u = rows[0]!;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await pool.query("UPDATE sign_in_challenges SET code_hash = $2, sent_at = now(), tries = 0 WHERE id = $1", [
    challengeId,
    codeHash(challengeId, code),
  ]);
  await logEmail(pool, {
    type: "otp",
    to: u.email ? [u.email as string] : [],
    subject: "Your sign-in code",
    body:
      `Hello ${u.first_name},\n\nYour sign-in code is ${code}. It works for ${CODE_MINUTES} minutes.\n\n` +
      `If you did not try to sign in, change your password and tell your administrator.`,
    userId,
  });
  return maskEmail(String(u.email ?? ""));
}

export function signIn(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SignInInput;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `SELECT id, password_hash, status, failed_logins, locked_until, temp_password_expires_at, otp_method,
              totp_enabled, totp_secret, email
         FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
      [b.username.trim()],
    );
    const u = rows[0];
    // One message for an unknown user and a wrong password, so usernames cannot be guessed.
    const wrong = () => sendProblem(reply, 401, "Wrong username or password");
    if (!u) return wrong();
    auditAs(request, Number(u.id));
    if (u.locked_until && (u.locked_until as Date).getTime() > Date.now())
      return sendProblem(reply, 429, "Too many wrong passwords", {
        detail: `Try again after ${(u.locked_until as Date).toISOString().slice(11, 16)} UTC.`,
      });
    if (!u.password_hash || !verifyPassword(b.password, u.password_hash as string)) {
      const failed = Number(u.failed_logins) + 1;
      await pool.query(
        `UPDATE users SET failed_logins = $2::smallint,
                locked_until = CASE WHEN $3::boolean THEN now() + interval '${LOCK_MINUTES} minutes' END
          WHERE id = $1`,
        [u.id, failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED],
      );
      if (failed >= MAX_FAILED)
        return sendProblem(reply, 429, "Too many wrong passwords", {
          detail: `The account is locked for ${LOCK_MINUTES} minutes.`,
        });
      return wrong();
    }
    if (u.status !== "active") return sendProblem(reply, 401, "This user is not active. Ask your administrator.");
    if (u.temp_password_expires_at && (u.temp_password_expires_at as Date).getTime() < Date.now())
      return sendProblem(reply, 401, "Your temporary password expired. Ask your administrator for a new one.");

    const method = u.totp_enabled && u.totp_secret ? "authenticator" : u.otp_method === "off" ? null : "email";
    if (!method) return openSession(pool, request, reply, Number(u.id));
    if (method === "email" && !u.email)
      return sendProblem(reply, 401, "Your user has no e-mail address for the sign-in code. Ask your administrator.");

    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000);
    const { rows: ch } = await pool.query(
      `INSERT INTO sign_in_challenges (token_hash, user_id, method, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [sha(challenge), u.id, method, request.ip || "127.0.0.1", String(request.headers["user-agent"] ?? ""), expiresAt],
    );
    const sentTo = method === "email" ? await sendCode(pool, Number(ch[0].id), Number(u.id)) : undefined;
    return {
      status: "code_required",
      challenge,
      method,
      ...(sentTo ? { sentTo } : {}),
      expiresAt: expiresAt.toISOString(),
    } satisfies SignInResult;
  });
}

async function openChallenge(pool: pg.Pool, challenge: string) {
  const { rows } = await pool.query(
    `SELECT c.id, c.user_id, c.method, c.code_hash, c.tries, c.expires_at,
            c.sent_at > now() - make_interval(secs => ${RESEND_GAP_S}) AS too_soon, u.totp_secret
       FROM sign_in_challenges c JOIN users u ON u.id = c.user_id
      WHERE c.token_hash = $1 AND c.used_at IS NULL AND c.expires_at > now() AND c.tries < ${CODE_TRIES}
        AND u.status = 'active' AND u.deleted_at IS NULL`,
    [sha(challenge)],
  );
  return rows[0] ?? null;
}

export function signInCode(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SignInCodeInput;
  return withDb(reply, async (pool) => {
    const c = await openChallenge(pool, b.challenge);
    if (!c) return sendProblem(reply, 401, "The sign-in expired. Sign in again.", { code: "challenge_expired" });
    auditAs(request, Number(c.user_id));
    let ok: boolean;
    if (c.method === "authenticator") ok = Boolean(c.totp_secret) && verifyTotp(c.totp_secret as string, b.code);
    else {
      const want = Buffer.from(String(c.code_hash ?? ""), "hex");
      const got = Buffer.from(codeHash(Number(c.id), b.code), "hex");
      ok = want.length === got.length && timingSafeEqual(want, got);
    }
    if (!ok) {
      await pool.query("UPDATE sign_in_challenges SET tries = tries + 1 WHERE id = $1", [c.id]);
      const left = CODE_TRIES - Number(c.tries) - 1;
      return left > 0
        ? sendProblem(reply, 401, "The code does not match", { detail: `${left} tries left.`, code: "wrong_code" })
        : sendProblem(reply, 401, "Too many wrong codes. Sign in again.", { code: "challenge_expired" });
    }
    await pool.query("UPDATE sign_in_challenges SET used_at = now() WHERE id = $1", [c.id]);
    return openSession(pool, request, reply, Number(c.user_id));
  });
}

export function resendSignInCode(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SignInChallengeRef;
  return withDb(reply, async (pool) => {
    const c = await openChallenge(pool, b.challenge);
    if (!c) return sendProblem(reply, 401, "The sign-in expired. Sign in again.", { code: "challenge_expired" });
    if (c.method !== "email") return sendProblem(reply, 409, "Use the code from your authenticator app");
    if (c.too_soon) return sendProblem(reply, 409, "A code was sent less than a minute ago");
    const sentTo = await sendCode(pool, Number(c.id), Number(c.user_id));
    return {
      status: "code_required",
      challenge: b.challenge,
      method: "email",
      sentTo,
      expiresAt: (c.expires_at as Date).toISOString(),
    } satisfies SignInResult;
  });
}

export function signOut(request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const token = cookieToken(request);
    if (token)
      await pool.query(
        `UPDATE user_sessions SET ended_at = now(), end_reason = 'logout'
          WHERE token_hash = $1 AND user_kind = 'staff' AND ended_at IS NULL`,
        [sha(token)],
      );
    setCookie(reply, "", 0);
    return reply.code(204).send();
  });
}
