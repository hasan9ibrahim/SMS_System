// Who makes the current request (backend step 9, §13.28). Kept in AsyncLocalStorage so every handler reads it with
// currentUserId() without passing the request around.
//
//   * Behind the Elixir API (Phoenix in front, product owner 2026-10-25): the API signs the user in and forwards the
//     calls it has not ported yet with X-Sms-User and the shared X-Sms-Proxy-Secret (MOCK_PROXY_SECRET).
//   * MOCK_REQUIRE_SIGN_IN=1: the mock checks the sms_session cookie itself (POST /session).
//   * Otherwise (development, tests, the team trial so far): one seeded user, MOCK_USER_ID (default 1).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { production } from "../mode.js";

export const SESSION_COOKIE = "sms_session";
/** Decided 2026-10-25: 8 hours without activity, 24 hours after sign-in at most. */
export const IDLE_HOURS = 8;
export const MAX_HOURS = 24;

/** The fake user the mock acts as when nobody signs in (user 1 is a seeded administrator). */
export const DEFAULT_USER_ID = Number(process.env.MOCK_USER_ID ?? 1);

export interface RequestUser {
  userId: number;
  /** The user_sessions row, when signed in with a cookie or forwarded by the API. */
  sessionId: number | null;
}

const als = new AsyncLocalStorage<RequestUser>();

/** The user of the current request; the default user outside a request (background jobs, tests). */
export const currentUserId = (): number => als.getStore()?.userId ?? DEFAULT_USER_ID;
export const currentSessionId = (): number | null => als.getStore()?.sessionId ?? null;

export function runAsRequestUser<T>(user: RequestUser, fn: () => T): T {
  return als.run(user, fn);
}

// Production always requires a signed-in user (backend step 11): no request runs as the default user.
export const requireSignIn = () => production || process.env.MOCK_REQUIRE_SIGN_IN === "1";

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const header = (request: FastifyRequest, name: string): string | undefined => {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function cookieToken(request: FastifyRequest, name = SESSION_COOKIE): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("=")) || null;
  }
  return null;
}

/**
 * The operation the Elixir API checked before forwarding (X-Sms-Op), or null when the call was not forwarded with the
 * shared secret. A forwarded call whose route is another operation is refused (security audit, team trial round 12).
 */
export function forwardedOperation(request: FastifyRequest): { op: string | null } | null {
  return forwarded(request) ? { op: header(request, "x-sms-op") ?? null } : null;
}

function forwarded(request: FastifyRequest): RequestUser | null {
  const secret = process.env.MOCK_PROXY_SECRET;
  const given = header(request, "x-sms-proxy-secret");
  if (!secret || !given) return null;
  const a = Buffer.from(sha(secret), "hex");
  const b = Buffer.from(sha(given), "hex");
  if (!timingSafeEqual(a, b)) return null;
  const userId = Number(header(request, "x-sms-user"));
  const sessionId = Number(header(request, "x-sms-session"));
  return Number.isInteger(userId) && userId > 0
    ? { userId, sessionId: Number.isInteger(sessionId) && sessionId > 0 ? sessionId : null }
    : null;
}

/** The open staff session of a cookie token: not ended, active within 8 hours, signed in within 24. */
export async function sessionOfToken(pool: pg.Pool, token: string): Promise<RequestUser | null> {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.last_seen_at FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.user_kind = 'staff' AND s.ended_at IS NULL
        AND s.last_seen_at > now() - make_interval(hours => ${IDLE_HOURS})
        AND s.logged_in_at > now() - make_interval(hours => ${MAX_HOURS})
        AND u.status = 'active' AND u.deleted_at IS NULL`,
    [sha(token)],
  );
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - (r.last_seen_at as Date).getTime() > 60_000)
    await pool.query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [r.id]);
  return { userId: Number(r.user_id), sessionId: Number(r.id) };
}

/**
 * Whether a session is still open (not ended, idle or past its lifetime) for an active user, without counting the look
 * as activity: the live socket checks it every minute, which must not keep an idle session alive (§13.28).
 */
export async function sessionOpen(pool: pg.Pool, sessionId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.ended_at IS NULL
        AND s.last_seen_at > now() - make_interval(hours => ${IDLE_HOURS})
        AND s.logged_in_at > now() - make_interval(hours => ${MAX_HOURS})
        AND u.status = 'active' AND u.deleted_at IS NULL`,
    [sessionId],
  );
  return rows.length > 0;
}

/** The user of a request, or null when sign-in is required and there is none. */
export async function requestUser(request: FastifyRequest, pool: () => pg.Pool): Promise<RequestUser | null> {
  const viaApi = forwarded(request);
  if (viaApi) return viaApi;
  if (!requireSignIn()) return { userId: DEFAULT_USER_ID, sessionId: null };
  const token = cookieToken(request);
  if (!token) return null;
  try {
    return await sessionOfToken(pool(), token);
  } catch {
    return null;
  }
}
