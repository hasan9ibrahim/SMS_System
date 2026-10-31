// Customer portal (§1, team trial round 5): its own sign-in at /portal and the customer's own balance, rates,
// traffic and messages. Every answer is scoped to the signed-in user's enterprise; no vendor, route, cost or
// margin data is ever selected. Portal users are managed by staff in Admin › Customer Portal (§11); their
// sessions sit in user_sessions (user_kind 'customer'), found by a hash of the cookie.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ListQuery,
  PortalListId,
  PortalMessageRow,
  PortalOverview,
  PortalPasswordInput,
  PortalRateRow,
  PortalSession,
  PortalSignInInput,
  PortalSignInResult,
  SignInChallengeRef,
  SignInCodeInput,
  PortalTotals,
  PortalTraffic,
  PortalTrafficQuery,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { chQuery, ChUnavailable } from "../edr.js";
import { sendProblem } from "../problem.js";
import { listFields } from "../lists/fields.js";
import { exportRows, runList, type ListDef } from "../lists/engine.js";
import { lit, runChList, type ChListDef } from "../lists/chEngine.js";
import { edrValues } from "../lists/edrDefs.js";
import { BALANCE_FROM } from "../lists/defs.js";
import {
  hashPassword,
  LIFETIME_SQL,
  loadPolicy,
  passwordExpiry,
  passwordRules,
  verifyNoUser,
  verifyPassword,
} from "../admin/passwords.js";
import { badInput } from "./switchTools.js";
import type { FieldError } from "./records.js";
import { money } from "../currency.js";
import { logEmail } from "./emailLog.js";
import { maskEmail } from "./admin.js";
import { beforeDetail, counter, type EdrSource } from "../reports/source.js";
import { csvText } from "../csvSafe.js";

export const PORTAL_COOKIE = "sms_portal";
const SESSION_HOURS = 12;
/** A session ends 24 hours after sign-in however active it is (as the staff sessions, §13.28). */
const SESSION_MAX_HOURS = 24;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const RESEND_GAP_S = 60;
/** Sign-in attempts (passwords and codes) one address may make in 10 minutes, whatever the usernames. */
const ADDRESS_LIMIT = 30;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function cookieToken(request: FastifyRequest): string | null {
  const raw = request.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === PORTAL_COOKIE) return decodeURIComponent(v.join("=")) || null;
  }
  return null;
}

// Behind HTTPS (COOKIE_SECURE=1, as the API, backend step 12) the browser sends the cookie over HTTPS only.
const SECURE = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
const setCookie = (reply: FastifyReply, token: string, maxAge: number) =>
  // The backend adds Secure behind HTTPS (BACKEND_TODO); the trial instance may run on plain HTTP.
  reply.header("set-cookie", `${PORTAL_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE}`);

/** Desktop / mobile, OS and browser in words, for Logged In Users (§11). */
export function device(ua: string) {
  const mobile = /Mobile|Android|iPhone/i.test(ua);
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Other";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Other";
  return { device: mobile ? "mobile" : "desktop", os, browser };
}

interface PortalUser {
  sessionId: number;
  id: number;
  enterpriseId: number;
  session: PortalSession;
}

const MUST_CHANGE_SQL = `(u.temp_password_expires_at IS NOT NULL OR u.must_change_password
  OR u.password_changed_at + ${LIFETIME_SQL} <= now())`;

async function sessionOf(pool: pg.Pool, userId: number): Promise<PortalSession | null> {
  await loadPolicy(pool);
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.first_name, u.last_name, u.email, u.password_changed_at, e.id AS enterprise_id,
            e.name AS enterprise, ${MUST_CHANGE_SQL} AS must_change
       FROM customer_portal_users u JOIN enterprises e ON e.id = u.enterprise_id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    user: {
      id: Number(r.id),
      username: r.username,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
    },
    enterprise: { id: Number(r.enterprise_id), name: r.enterprise },
    mustChangePassword: Boolean(r.must_change),
    passwordExpiresAt: passwordExpiry(r.password_changed_at as Date).toISOString(),
  };
}

/** The signed-in portal user, or null (no cookie, ended or idle session, user inactive or deleted). */
async function currentPortalUser(pool: pg.Pool, request: FastifyRequest): Promise<PortalUser | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.enterprise_id
       FROM user_sessions s JOIN customer_portal_users u ON u.id = s.portal_user_id
      WHERE s.token_hash = $1 AND s.user_kind = 'customer' AND s.ended_at IS NULL
        AND s.last_seen_at > now() - make_interval(hours => ${SESSION_HOURS})
        AND s.logged_in_at > now() - make_interval(hours => ${SESSION_MAX_HOURS})
        AND u.status = 'active' AND u.deleted_at IS NULL`,
    [sha(token)],
  );
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - (r.last_seen_at as Date).getTime() > 60_000)
    await pool.query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [r.session_id]);
  const session = await sessionOf(pool, Number(r.id));
  if (!session) return null;
  return { sessionId: Number(r.session_id), id: Number(r.id), enterpriseId: Number(r.enterprise_id), session };
}

/** Runs fn for the signed-in portal user; 401 without one, 403 while the password must be changed. */
function portal<T>(request: FastifyRequest, reply: FastifyReply, fn: (pool: pg.Pool, user: PortalUser) => Promise<T>) {
  return withDb(reply, async (pool) => {
    const user = await currentPortalUser(pool, request);
    if (!user) return sendProblem(reply, 401, "Sign in to the customer portal");
    if (user.session.mustChangePassword)
      return sendProblem(reply, 403, "Change your password to continue", { code: "password_change_required" });
    try {
      return await fn(pool, user);
    } catch (e) {
      if (e instanceof ChUnavailable) return sendProblem(reply, 503, "Traffic data is not available right now");
      throw e;
    }
  });
}

// ---------------------------------------------------------------- session

export function portalGetSession(request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const user = await currentPortalUser(pool, request);
    return user ? user.session : sendProblem(reply, 401, "Sign in to the customer portal");
  });
}

// ---------------------------------------------------------------- sign-in limits per address

const attempts = new Map<string, number[]>();
/** False once the address made too many sign-in attempts in the last 10 minutes (per server). */
function addressAllowed(ip: string, now = Date.now()) {
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (now - v[v.length - 1]! > 10 * 60_000) attempts.delete(k);
  return recent.length <= ADDRESS_LIMIT;
}
const tooManyFromAddress = (reply: FastifyReply) =>
  sendProblem(reply, 429, "Too many sign-in attempts", { detail: "Wait a few minutes, then try again." });

/** Exported for tests: forgets the attempts counted per address. */
export const resetPortalAddressLimits = () => attempts.clear();

// ---------------------------------------------------------------- sign-in

const codeHash = (challengeId: number, code: string) =>
  createHash("sha256").update(`portal-signin:${challengeId}:${code}`).digest("hex");

async function openSession(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply, userId: number) {
  const token = randomBytes(32).toString("base64url");
  const d = device(String(request.headers["user-agent"] ?? ""));
  await pool.query(
    `INSERT INTO user_sessions (user_kind, portal_user_id, ip, device, os, browser, logged_in_at, last_seen_at, token_hash)
     VALUES ('customer', $1, $2, $3, $4, $5, now(), now(), $6)`,
    [userId, request.ip || "127.0.0.1", d.device, d.os, d.browser, sha(token)],
  );
  await pool.query(
    "UPDATE customer_portal_users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
    [userId],
  );
  setCookie(reply, token, SESSION_HOURS * 3600);
  return (await sessionOf(pool, userId))!;
}

/** E-mails a new code for the challenge (the code only; never a password or a sign-in link, §13.28). */
async function sendCode(pool: pg.Pool, challengeId: number, userId: number): Promise<string> {
  const { rows } = await pool.query(
    "SELECT first_name, email, enterprise_id FROM customer_portal_users WHERE id = $1",
    [userId],
  );
  const u = rows[0]!;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await pool.query("UPDATE sign_in_challenges SET code_hash = $2, sent_at = now(), tries = 0 WHERE id = $1", [
    challengeId,
    codeHash(challengeId, code),
  ]);
  await logEmail(pool, {
    type: "otp",
    enterpriseId: Number(u.enterprise_id),
    to: u.email ? [u.email as string] : [],
    subject: "Your customer portal sign-in code",
    body:
      `Hello ${u.first_name},\n\nYour sign-in code is ${code}. It works for ${CODE_MINUTES} minutes.\n\n` +
      `If you did not try to sign in, change your password and tell your account manager.`,
  });
  return maskEmail(String(u.email ?? ""));
}

export function portalSignIn(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as PortalSignInInput;
  return withDb(reply, async (pool) => {
    if (!addressAllowed(request.ip || "127.0.0.1")) return tooManyFromAddress(reply);
    const { rows } = await pool.query(
      `SELECT id, password_hash, status, failed_logins, locked_until, temp_password_expires_at, otp_method, email
         FROM customer_portal_users WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
      [b.username.trim()],
    );
    const u = rows[0];
    // One message for an unknown user and a wrong password, so usernames cannot be guessed.
    const wrong = () => sendProblem(reply, 401, "Wrong username or password");
    if (!u) return verifyNoUser(b.password) || wrong();
    if (u.locked_until && (u.locked_until as Date).getTime() > Date.now())
      return sendProblem(reply, 429, "Too many wrong passwords", {
        detail: `Try again after ${(u.locked_until as Date).toISOString().slice(11, 16)} UTC.`,
      });
    if (!verifyPassword(b.password, u.password_hash as string)) {
      const failed = Number(u.failed_logins) + 1;
      await pool.query(
        `UPDATE customer_portal_users SET failed_logins = $2::smallint,
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
    if (u.status !== "active")
      return sendProblem(reply, 401, "This login is not active. Contact your account manager.");
    if (u.temp_password_expires_at && (u.temp_password_expires_at as Date).getTime() < Date.now())
      return sendProblem(reply, 401, "Your temporary password expired. Ask your account manager for a new one.");
    // The e-mailed code at every sign-in (backend step 13), unless staff turned it off for this user.
    if (u.otp_method === "off")
      return { status: "signed_in", session: await openSession(pool, request, reply, Number(u.id)) } satisfies PortalSignInResult;
    if (!u.email)
      return sendProblem(reply, 401, "Your login has no e-mail address for the sign-in code. Contact your account manager.");
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000);
    const { rows: ch } = await pool.query(
      `INSERT INTO sign_in_challenges (token_hash, portal_user_id, method, ip, user_agent, expires_at)
       VALUES ($1, $2, 'email', $3, $4, $5) RETURNING id`,
      [sha(challenge), u.id, request.ip || "127.0.0.1", String(request.headers["user-agent"] ?? ""), expiresAt],
    );
    const sentTo = await sendCode(pool, Number(ch[0].id), Number(u.id));
    return { status: "code_required", challenge, sentTo, expiresAt: expiresAt.toISOString() } satisfies PortalSignInResult;
  });
}

async function openChallenge(pool: pg.Pool, challenge: string) {
  const { rows } = await pool.query(
    `SELECT c.id, c.portal_user_id, c.code_hash, c.tries, c.expires_at,
            c.sent_at > now() - make_interval(secs => ${RESEND_GAP_S}) AS too_soon
       FROM sign_in_challenges c JOIN customer_portal_users u ON u.id = c.portal_user_id
      WHERE c.token_hash = $1 AND c.used_at IS NULL AND c.expires_at > now() AND c.tries < ${CODE_TRIES}
        AND u.status = 'active' AND u.deleted_at IS NULL`,
    [sha(challenge)],
  );
  return rows[0] ?? null;
}

const challengeExpired = (reply: FastifyReply) =>
  sendProblem(reply, 401, "The sign-in expired. Sign in again.", { code: "challenge_expired" });

export function portalSignInCode(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SignInCodeInput;
  return withDb(reply, async (pool) => {
    if (!addressAllowed(request.ip || "127.0.0.1")) return tooManyFromAddress(reply);
    const c = await openChallenge(pool, b.challenge);
    if (!c) return challengeExpired(reply);
    const want = Buffer.from(String(c.code_hash ?? ""), "hex");
    const got = Buffer.from(codeHash(Number(c.id), b.code), "hex");
    if (!(want.length === got.length && timingSafeEqual(want, got))) {
      await pool.query("UPDATE sign_in_challenges SET tries = tries + 1 WHERE id = $1", [c.id]);
      const left = CODE_TRIES - Number(c.tries) - 1;
      return left > 0
        ? sendProblem(reply, 401, "The code does not match", { detail: `${left} tries left.`, code: "wrong_code" })
        : sendProblem(reply, 401, "Too many wrong codes. Sign in again.", { code: "challenge_expired" });
    }
    await pool.query("UPDATE sign_in_challenges SET used_at = now() WHERE id = $1", [c.id]);
    return openSession(pool, request, reply, Number(c.portal_user_id));
  });
}

export function portalResendSignInCode(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SignInChallengeRef;
  return withDb(reply, async (pool) => {
    const c = await openChallenge(pool, b.challenge);
    if (!c) return challengeExpired(reply);
    if (c.too_soon) return sendProblem(reply, 409, "A code was sent less than a minute ago");
    const sentTo = await sendCode(pool, Number(c.id), Number(c.portal_user_id));
    return {
      status: "code_required",
      challenge: b.challenge,
      sentTo,
      expiresAt: (c.expires_at as Date).toISOString(),
    } satisfies PortalSignInResult;
  });
}

export function portalSignOut(request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const token = cookieToken(request);
    if (token)
      await pool.query(
        "UPDATE user_sessions SET ended_at = now(), end_reason = 'logout' WHERE token_hash = $1 AND ended_at IS NULL",
        [sha(token)],
      );
    setCookie(reply, "", 0);
    return reply.code(204).send();
  });
}

export function portalChangePassword(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as PortalPasswordInput;
  return withDb(reply, async (pool) => {
    const me = await currentPortalUser(pool, request);
    if (!me) return sendProblem(reply, 401, "Sign in to the customer portal");
    const { rows } = await pool.query(
      "SELECT username, first_name, last_name, password_hash FROM customer_portal_users WHERE id = $1",
      [me.id],
    );
    const u = rows[0]!;
    const pol = await loadPolicy(pool);
    const { rows: hist } = await pool.query(
      `SELECT password_hash FROM password_history WHERE portal_user_id = $1 ORDER BY changed_at DESC LIMIT ${pol.passwordHistory - 1}`,
      [me.id],
    );
    const errors: FieldError[] = [];
    if (!verifyPassword(b.currentPassword, u.password_hash as string))
      errors.push({ path: "/currentPassword", message: "the current password is wrong" });
    if (b.newPassword === b.currentPassword) errors.push({ path: "/newPassword", message: "choose a new password" });
    for (const r of passwordRules(
      b.newPassword,
      { username: u.username, firstName: u.first_name, lastName: u.last_name },
      [u.password_hash as string, ...hist.map((h) => h.password_hash as string)],
      pol,
    ))
      if (!r.met) errors.push({ path: "/newPassword", message: r.label });
    if (errors.length) return badInput(reply, errors);
    const hash = hashPassword(b.newPassword);
    await pool.query(
      `UPDATE customer_portal_users SET password_hash = $2, password_changed_at = now(), must_change_password = false,
              temp_password_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [me.id, hash],
    );
    await pool.query(
      "INSERT INTO password_history (portal_user_id, password_hash, changed_at) VALUES ($1, $2, now())",
      [me.id, hash],
    );
    // Other sessions of this user end (§13.28); this one stays signed in.
    await pool.query(
      `UPDATE user_sessions SET ended_at = now(), end_reason = 'password_change'
        WHERE portal_user_id = $1 AND ended_at IS NULL AND id <> $2`,
      [me.id, me.sessionId],
    );
    return sessionOf(pool, me.id);
  });
}

// ---------------------------------------------------------------- traffic figures

// Over edr_all (backend step 11b): the final MT attempts, and the switch's outcome rows that carry the customer's final
// status and the money billed on the receipt. Messages and parts count attempt rows only.
// Test SMS and Repush messages (internal_kind, backend step 13) are ours, never the customer's.
const FINAL = "(kind = 'outcome' OR (is_final_attempt = 1 AND msg_type = 'MT')) AND internal_kind = ''";
const FAILED_STATUSES = ["UNDELIV", "REJECTD", "EXPIRED", "DELETED", "UNKNOWN"];
/** The figures over edr_all, or over the long-term totals for days before the detailed EDRs (BACKEND_PLAN §3.7). */
const totalsSql = (src: EdrSource = "edr_all") => {
  const n = counter(src);
  return `${n("kind = 'attempt'")} AS messages, sumIf(msg_count, kind = 'attempt') AS parts,
  ${n("c_msg_status = 'DELIVRD'")} AS delivered,
  ${n(`c_msg_status IN (${FAILED_STATUSES.map(lit).join(",")}) OR (kind = 'attempt' AND is_submit_success = 0)`)} AS failed,
  toFloat64(sum(revenue)) AS amount`;
};

function totals(r: Record<string, unknown> | undefined): PortalTotals {
  const delivered = Number(r?.delivered ?? 0);
  const failed = Number(r?.failed ?? 0);
  return {
    messages: Number(r?.messages ?? 0),
    parts: Number(r?.parts ?? 0),
    delivered,
    failed,
    deliveredPct: delivered + failed > 0 ? Math.round((delivered / (delivered + failed)) * 1000) / 10 : null,
    amount: Math.round(Number(r?.amount ?? 0) * 1e6) / 1e6,
  };
}

/** The customer's billing time zone and currency (enterprise billing, §7). */
async function billing(pool: pg.Pool, enterpriseId: number) {
  const { rows } = await pool.query(
    "SELECT timezone, currency, billing_type, credit_limit FROM enterprise_billing WHERE enterprise_id = $1 AND side = 'customer'",
    [enterpriseId],
  );
  const r = rows[0];
  return {
    tz: (r?.timezone as string | undefined) ?? "UTC",
    currency: r ? String(r.currency).trim() : null,
    billingType: (r?.billing_type as PortalOverview["billingType"]) ?? null,
    creditLimit: r?.credit_limit == null ? null : Number(r.credit_limit),
  };
}

const dateRange = (tz: string, from: string, to: string) =>
  `submit_time >= toDateTime64(${lit(`${from} 00:00:00`)}, 3, ${lit(tz)})
   AND submit_time < toDateTime64(${lit(`${to} 00:00:00`)}, 3, ${lit(tz)}) + INTERVAL 1 DAY`;

// ---------------------------------------------------------------- overview

export function portalOverview(request: FastifyRequest, reply: FastifyReply) {
  return portal(request, reply, async (pool, me): Promise<PortalOverview> => {
    const b = await billing(pool, me.enterpriseId);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: b.tz });
    const monthStart = `${today.slice(0, 8)}01`;
    const [bal, trunks, inv, figures] = await Promise.all([
      pool.query(`SELECT bal.customer FROM ${BALANCE_FROM} WHERE e.id = $1`, [me.enterpriseId]),
      pool.query(
        `SELECT t.id, t.name, t.tps, CASE WHEN tb.status = 'online' THEN 'up' ELSE 'down' END AS connection
           FROM customer_trunks t LEFT JOIN trunk_binds tb ON tb.side = 'customer' AND tb.trunk_id = t.id
          WHERE t.enterprise_id = $1 AND t.deleted_at IS NULL ORDER BY t.name`,
        [me.enterpriseId],
      ),
      pool.query(
        `SELECT invoice_number, invoice_date, due_amount, due_date FROM invoices
          WHERE enterprise_id = $1 AND deleted_at IS NULL AND status <> 'failed'
          ORDER BY invoice_date DESC, id DESC LIMIT 1`,
        [me.enterpriseId],
      ),
      chQuery<Record<string, unknown>>(
        `SELECT toDate(submit_time, ${lit(b.tz)}) = toDate(${lit(today)}) AS is_today, ${totalsSql()}
           FROM edr_all WHERE c_enterprise_id = ${me.enterpriseId} AND ${FINAL} AND ${dateRange(b.tz, monthStart, today)}
          GROUP BY is_today`,
      ),
    ]);
    const todayRow = figures.find((r) => Number(r.is_today) === 1);
    const month = figures.reduce<Record<string, number>>((acc, r) => {
      for (const k of ["messages", "parts", "delivered", "failed", "amount"]) acc[k] = (acc[k] ?? 0) + Number(r[k]);
      return acc;
    }, {});
    const balance = bal.rows[0]?.customer == null ? null : Number(bal.rows[0].customer);
    const i = inv.rows[0];
    const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
    return {
      enterprise: me.session.enterprise.name,
      currency: b.currency,
      billingType: b.billingType,
      balance,
      creditLimit: b.creditLimit,
      availableCredit: balance === null ? null : money(balance + (b.creditLimit ?? 0)),
      today: totals(todayRow),
      thisMonth: totals(month),
      trunks: trunks.rows.map((t) => ({
        id: Number(t.id),
        name: t.name,
        connection: t.connection,
        tps: Number(t.tps ?? 0),
      })),
      lastInvoice: i
        ? {
            number: i.invoice_number,
            date: day(i.invoice_date)!,
            amount: Number(i.due_amount),
            dueDate: day(i.due_date),
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------- traffic

export function portalTraffic(request: FastifyRequest, reply: FastifyReply) {
  const q = request.body as PortalTrafficQuery;
  return portal(request, reply, async (pool, me): Promise<PortalTraffic | FastifyReply> => {
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    if (!(days >= 0) || days > 92)
      return badInput(reply, [{ path: "/to", message: "the period must be 1 to 93 days, To on or after From" }]);
    const b = await billing(pool, me.enterpriseId);
    const key =
      q.groupBy === "day"
        ? `toString(toDate(submit_time, ${lit(b.tz)}))`
        : q.groupBy === "country"
          ? "c_country_iso"
          : "toString(c_trunk_id)";
    // Days from midnight in the billing zone, 14 hours either side of UTC.
    const src = beforeDetail(new Date(Date.parse(`${q.from}T00:00:00Z`) - 14 * 3_600_000)) ? "edr_totals" : "edr_all";
    const rows = await chQuery<Record<string, unknown>>(
      `SELECT ${key} AS k, ${totalsSql(src)} FROM ${src}
        WHERE c_enterprise_id = ${me.enterpriseId} AND ${FINAL} AND ${dateRange(b.tz, q.from, q.to)}
        GROUP BY k ORDER BY ${q.groupBy === "day" ? "k" : "messages DESC"} LIMIT 1000`,
    );
    const keys = rows.map((r) => String(r.k));
    const labels = new Map<string, string>();
    if (q.groupBy === "country" && keys.length) {
      const { rows: c } = await pool.query("SELECT trim(iso) AS iso, name FROM countries WHERE trim(iso) = ANY($1)", [
        keys.map((k) => k.trim()),
      ]);
      for (const r of c) labels.set(r.iso, `${r.name} (${r.iso})`);
    } else if (q.groupBy === "trunk" && keys.length) {
      const { rows: t } = await pool.query(
        "SELECT id::text AS id, name FROM customer_trunks WHERE enterprise_id = $1 AND id = ANY($2::bigint[])",
        [me.enterpriseId, keys.map(Number)],
      );
      for (const r of t) labels.set(r.id, r.name);
    }
    const sum = rows.reduce<Record<string, number>>((acc, r) => {
      for (const k of ["messages", "parts", "delivered", "failed", "amount"]) acc[k] = (acc[k] ?? 0) + Number(r[k]);
      return acc;
    }, {});
    return {
      currency: b.currency,
      rows: rows.map((r) => {
        const k = String(r.k).trim();
        return { key: k, label: labels.get(k) ?? (k || "—"), ...totals(r) };
      }),
      total: totals(sum),
    };
  });
}

// ---------------------------------------------------------------- rates

/**
 * Per trunk and destination: the line in force from the first of the trunk's rate tables that prices it (§5.4,
 * first match wins), plus the next announced line. Sender-specific lines and rate table names stay internal.
 */
const rateFrom = (enterpriseId: number) => `(
  SELECT DISTINCT ON (ct.id, rl.mccmnc_id, rl.valid_from > now())
         ct.id::bigint * 4294967296 + rl.id AS id, ct.name AS trunk, c.name AS country, trim(c.iso) AS country_iso,
         CASE WHEN m.is_all_networks THEN NULL ELSE m.network END AS network, rl.mccmnc, rl.rate, trim(rl.currency) AS currency,
         rl.valid_from, rl.valid_to, CASE WHEN rl.valid_from > now() THEN 'upcoming' ELSE 'current' END AS state,
         rl.change_type, rl.is_blocked
    FROM customer_trunks ct
    JOIN customer_trunk_rate_tables ctrt ON ctrt.customer_trunk_id = ct.id
    JOIN rate_tables rt ON rt.id = ctrt.rate_table_id AND rt.deleted_at IS NULL
    JOIN rate_lines rl ON rl.rate_table_id = rt.id AND rl.sender_id IS NULL AND (rl.valid_to IS NULL OR rl.valid_to > now())
    JOIN mccmnc m ON m.id = rl.mccmnc_id
    JOIN countries c ON c.id = m.country_id
   WHERE ct.enterprise_id = ${Number(enterpriseId)} AND ct.deleted_at IS NULL
   ORDER BY ct.id, rl.mccmnc_id, rl.valid_from > now(), ctrt.position, rl.valid_from) r`;

export const rateList = (enterpriseId: number): ListDef<PortalRateRow> => ({
  fields: listFields.portal_rates,
  from: rateFrom(enterpriseId),
  columns: {
    id: { sql: "r.id" },
    trunk: { sql: "r.trunk" },
    country: { sql: "r.country" },
    network: { sql: "r.network" },
    mccmnc: { sql: "r.mccmnc" },
    rate: { sql: "r.rate" },
    currency: { sql: "r.currency" },
    validFrom: { sql: "r.valid_from" },
    validTo: { sql: "r.valid_to" },
    state: { sql: "r.state" },
    changeType: { sql: "r.change_type" },
    blocked: { sql: "r.is_blocked" },
  },
  search: ["country", "network", "mccmnc", "trunk"],
  searchPrefix: true,
  idSql: "r.id",
  select: "r.*",
  mapRow: (r) => ({
    id: Number(r.id),
    trunk: r.trunk as string,
    country: (r.country as string | null) ?? null,
    countryIso: (r.country_iso as string | null) ?? null,
    network: (r.network as string | null) ?? null,
    mccmnc: r.mccmnc as string,
    rate: Number(r.rate),
    currency: r.currency as string,
    validFrom: (r.valid_from as Date).toISOString(),
    validTo: r.valid_to ? (r.valid_to as Date).toISOString() : null,
    state: r.state as PortalRateRow["state"],
    changeType: r.change_type as PortalRateRow["changeType"],
    blocked: Boolean(r.is_blocked),
  }),
});

export function portalQueryRates(request: FastifyRequest, reply: FastifyReply) {
  // null viewer: staff visibility policies (§13.17) never apply to a customer's own data.
  return portal(request, reply, (pool, me) =>
    runList(pool, rateList(me.enterpriseId), request.body as ListQuery, null),
  );
}

const csvCell = (v: unknown) => {
  const s = csvText(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function portalExportRates(request: FastifyRequest, reply: FastifyReply) {
  return portal(request, reply, async (pool, me) => {
    const rows = await exportRows(pool, rateList(me.enterpriseId), {
      ...(request.body as ListQuery),
      limit: 100_000,
    });
    const head = [
      "Trunk",
      "Country",
      "Network",
      "MCCMNC",
      "Rate",
      "Currency",
      "Effective From",
      "Effective Until",
      "State",
      "Change",
      "Blocked",
    ];
    const lines = rows.map((r) =>
      [
        r.trunk,
        r.country,
        r.network ?? "All networks",
        r.mccmnc,
        r.rate.toFixed(6),
        r.currency,
        r.validFrom.slice(0, 16).replace("T", " "),
        r.validTo ? r.validTo.slice(0, 16).replace("T", " ") : "",
        r.state,
        r.changeType,
        r.blocked ? "Yes" : "No",
      ]
        .map(csvCell)
        .join(","),
    );
    const name = me.session.enterprise.name.replace(/[^A-Za-z0-9_-]+/g, "_");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="rates_${name}_${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      .send([head.join(","), ...lines].join("\n"));
  });
}

// ---------------------------------------------------------------- messages

const MESSAGE_COLUMNS: ChListDef<PortalMessageRow>["columns"] = {
  id: { sql: "toString(edr_id)" },
  submitTime: { sql: "submit_time" },
  deliveryTime: {
    sql: "delivery_time",
    nullable: true,
    outcome: { sql: "receipt_time", merge: "status", when: "c_msg_status != ''" },
  },
  messageId: { sql: "c_message_id" },
  trunk: {
    sql: "c_trunk_id",
    names: { table: "customer_trunks t", name: "t.name", id: "t.id", idSql: "c_trunk_id" },
  },
  senderId: { sql: "src_addr" },
  receiver: { sql: "dst_addr" },
  country: { sql: "c_country_iso" },
  mccmnc: { sql: "c_mccmnc" },
  parts: { sql: "msg_count" },
  status: { sql: "c_msg_status", outcome: { sql: "c_msg_status", merge: "status" } },
  errorCode: { sql: "c_delivery_error", outcome: { sql: "c_delivery_error", merge: "status", when: "c_msg_status != ''" } },
  rate: { sql: "toFloat64(c_rate)" },
  currency: { sql: "c_currency" },
  amount: { sql: "toFloat64(revenue)", outcome: { sql: "revenue", merge: "add" } },
  messageText: { sql: "message_text" },
};

export const messageList = (enterpriseId: number): ChListDef<PortalMessageRow> => ({
  fields: listFields.portal_messages,
  table: "edr",
  // One row per message: its final attempt, with the switch's outcome row merged in (backend step 11b).
  baseWhere: `c_enterprise_id = ${Number(enterpriseId)} AND is_final_attempt = 1 AND msg_type = 'MT' AND internal_kind = ''`,
  columns: MESSAGE_COLUMNS,
  search: ["senderId", "receiver", "messageId"],
  searchNumbers: ["senderId", "receiver"],
  idSql: "edr_id",
  // A message the switch wrote twice is listed once (ClickHouse 010, S-7.3).
  rowKey: true,
  mapRow: (r, names) => {
    const v = edrValues(listFields.portal_messages.fields, MESSAGE_COLUMNS, r, names) as Record<string, unknown>;
    return {
      ...v,
      id: String(r._id ?? v.id ?? ""),
      // The trunk name comes from the customer's own trunks only.
      trunk: (v.trunk as string | null) ?? null,
      deliveryTime: (v.deliveryTime as string | null) || null,
    } as unknown as PortalMessageRow;
  },
});

export function portalQueryMessages(request: FastifyRequest, reply: FastifyReply) {
  return portal(request, reply, (pool, me) => runChList(pool, messageList(me.enterpriseId), request.body as ListQuery));
}

// ---------------------------------------------------------------- field catalogues

export function portalListFields(request: FastifyRequest, reply: FastifyReply) {
  const { list } = request.params as { list: PortalListId };
  return portal(request, reply, async () => listFields[list]);
}

/** Portal operations skip the staff password gate, visibility and audit (their own sign-in, own data only). */
export const isPortalOperation = (operationId: string) => operationId.startsWith("portal");

export const portalPoolForTests = () => db();
