// Admin (§11, §12.5, §13.28): users with temporary passwords, forced changes and QR 2FA, the signed-in
// user's own password change, departments, GUI access groups (page × action matrix), logged-in users,
// e-mail templates (placeholders, preview) and customer portal logins. Every save is one undoable
// change (§13.10); deletes archive and are blocked by live dependencies (§13.29).
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  AccessGroupInput,
  ArchiveRequest,
  CloneInput,
  DepartmentInput,
  EmailTemplateInput,
  EmailTemplateTestInput,
  SenderEmail,
  EmailTemplatePreviewInput,
  EmailTemplateRecord,
  ForcePasswordChangeInput,
  PasswordChangeInput,
  PasswordCheckInput,
  PortalUserInput,
  TempPasswordInput,
  TotpConfirmInput,
  UserInput,
} from "@sms/contract";
import { withDb } from "../db.js";
import { ACTIONS, checkPermissions, checkTabs, MODULES, normalisePermissions, SECTIONS } from "../admin/catalog.js";
import {
  encryptSecret,
  hashPassword,
  newTotpSecret,
  otpauthUri,
  loadPolicy,
  passwordExpiry,
  passwordRules,
  policy,
  totpSecretOf,
  verifyPassword,
  verifyTotp,
} from "../admin/passwords.js";
import {
  ACCESS_GROUP_FROM,
  ACCESS_GROUP_SELECT,
  currentSessionSql,
  DEPARTMENT_FROM,
  DEPARTMENT_SELECT,
  EMAIL_TEMPLATE_FROM,
  EMAIL_TEMPLATE_SELECT,
  mapAccessGroup,
  mapDepartment,
  mapEmailTemplate,
  mapPortalUser,
  mapUser,
  PORTAL_USER_FROM,
  PORTAL_USER_SELECT,
  USER_FROM,
  USER_SELECT,
} from "../lists/adminDefs.js";
import { sendProblem } from "../problem.js";
import { archiveGate } from "./enterprises.js";
import { notFound, setArchived } from "./masterData.js";
import { dependencies, recordChange, type DiffEntry, type FieldError } from "./records.js";
import { currentUserId, getCurrentUser } from "./session.js";
import { badInput } from "./switchTools.js";
import { inTransaction } from "./views.js";
import { companyDetails, companyPlaceholders, logEmail, senderFor } from "./emailLog.js";
import {
  compatIssues,
  emailDocument,
  escapeHtml,
  fillBody,
  fillText,
  isHtml,
  outlookView,
  sanitizeHtml,
} from "../email/html.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };
type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const trimOrNull = (v: string | null | undefined) => (v == null ? null : v.trim() || null);

async function one<T>(c: Db, select: string, from: string, idCol: string, id: number, map: (r: Row) => T) {
  const { rows } = await c.query(`SELECT ${select} FROM ${from} WHERE ${idCol} = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}
const exists = async (c: Db, table: string, id: number | null, live = true) => {
  if (id == null) return true;
  const { rows } = await c.query(`SELECT 1 FROM ${table} WHERE id = $1${live ? " AND deleted_at IS NULL" : ""}`, [id]);
  return !!rows[0];
};

// ---------------------------------------------------------------- generic records

export interface Spec<I, R> {
  table: string;
  entityType: string;
  label: string;
  fields: [keyof I & string, string][];
  load: (c: Db, id: number) => Promise<R | null>;
  values: (b: I) => I;
  check: (c: Db, b: I, id: number | null) => Promise<FieldError[]>;
  nameOf: (b: I) => string;
  /** Dependencies checked before a delete (§13.29). */
  deps?: (c: Db, id: number) => Promise<ReturnType<typeof dependencies>>;
  /** Extra writes in the same transaction after a delete, e.g. ending sessions. */
  onArchive?: (c: pg.PoolClient, id: number) => Promise<void>;
  restoreClash?: (c: Db, id: number) => Promise<string | null>;
}

export function records<I, R extends { archivedAt: string | null }>(spec: Spec<I, R>) {
  const cols = spec.fields.map(([, col]) => col);
  async function insert(c: pg.PoolClient, b: I, extra: Record<string, unknown> = {}) {
    const me = await getCurrentUser();
    const extraCols = Object.keys(extra);
    const vals = [...spec.fields.map(([k]) => b[k]), ...Object.values(extra), me.id];
    const { rows } = await c.query(
      `INSERT INTO ${spec.table} (${[...cols, ...extraCols, "updated_by_id"].join(", ")})
       VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      vals,
    );
    return Number(rows[0].id);
  }
  async function created(request: FastifyRequest, c: pg.PoolClient, id: number, name: string, note?: string) {
    const me = await getCurrentUser();
    return recordChange(c, {
      entityType: spec.entityType,
      entityIds: [id],
      changeType: "create",
      diff: [{ entity_id: id, field: "*", before: null, after: { name } }],
      note: note ?? `Added ${spec.label.toLowerCase()} ${name}`,
      userId: me.id,
      ip: request.ip,
    });
  }
  return {
    insert,
    created,
    get: (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as Params;
      return withDb(reply, async (pool) => (await spec.load(pool, id)) ?? notFound(reply, spec.label, id));
    },
    dependencies: (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as Params;
      return withDb(reply, async (pool) => {
        if (!(await spec.load(pool, id))) return notFound(reply, spec.label, id);
        return spec.deps ? spec.deps(pool, id) : dependencies([]);
      });
    },
    create: (request: FastifyRequest, reply: FastifyReply) => {
      const b = spec.values(request.body as I);
      return withDb(reply, async (pool) => {
        const errors = await spec.check(pool, b, null);
        if (errors.length) return badInput(reply, errors);
        const { id, change } = await inTransaction(pool, async (c) => {
          const id = await insert(c, b);
          return { id, change: await created(request, c, id, spec.nameOf(b)) };
        });
        return reply.code(201).send({ record: await spec.load(pool, id), change });
      });
    },
    update: (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as Params;
      const b = spec.values(request.body as I);
      return withDb(reply, async (pool) => {
        const before = (await spec.load(pool, id)) as (R & Record<string, unknown>) | null;
        if (!before) return notFound(reply, spec.label, id);
        if (before.archivedAt)
          return sendProblem(reply, 409, `This ${spec.label.toLowerCase()} is deleted; restore it first`);
        const errors = await spec.check(pool, b, id);
        if (errors.length) return badInput(reply, errors);
        const changed = spec.fields.filter(([k]) => !same(before[k], b[k]));
        if (!changed.length) return { record: before, change: null };
        const diff: DiffEntry[] = changed.map(([k]) => ({
          entity_id: id,
          field: k,
          before: before[k] ?? null,
          after: b[k] ?? null,
        }));
        const me = await getCurrentUser();
        const change = await inTransaction(pool, async (c) => {
          await c.query(
            `UPDATE ${spec.table} SET ${changed.map(([, col], i) => `${col} = $${i + 2}`).join(", ")},
                    updated_by_id = $${changed.length + 2}, updated_at = now() WHERE id = $1`,
            [id, ...changed.map(([k]) => b[k]), me.id],
          );
          return recordChange(c, {
            entityType: spec.entityType,
            entityIds: [id],
            changeType: "edit",
            diff,
            note: `Changed ${spec.label.toLowerCase()} ${spec.nameOf(b)}`,
            userId: me.id,
            ip: request.ip,
          });
        });
        return { record: await spec.load(pool, id), change };
      });
    },
    archive: (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as Params;
      const body = (request.body ?? {}) as ArchiveRequest;
      return withDb(reply, async (pool) => {
        const before = await spec.load(pool, id);
        if (!before) return notFound(reply, spec.label, id);
        if (before.archivedAt) return { record: before, change: null };
        const gate = await archiveGate(reply, body, spec.deps ? await spec.deps(pool, id) : dependencies([]));
        if (!gate.ok) return gate.reply;
        const me = await getCurrentUser();
        const name =
          (before as unknown as { name?: string; username?: string }).name ??
          (before as unknown as { username?: string }).username ??
          id;
        const change = await inTransaction(pool, async (c) => {
          await c.query(`UPDATE ${spec.table} SET deleted_at = now() WHERE id = $1`, [id]);
          await spec.onArchive?.(c, id);
          return recordChange(c, {
            entityType: spec.entityType,
            entityIds: [id],
            changeType: "delete",
            diff: [{ entity_id: id, field: "archived", before: false, after: true }],
            note: [`Deleted ${spec.label.toLowerCase()} ${name}`, gate.note].filter(Boolean).join(" – "),
            userId: me.id,
            ip: request.ip,
          });
        });
        return { record: await spec.load(pool, id), change };
      });
    },
    restore: (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as Params;
      return withDb(reply, async (pool) => {
        const before = await spec.load(pool, id);
        if (!before) return notFound(reply, spec.label, id);
        if (!before.archivedAt) return sendProblem(reply, 400, `This ${spec.label.toLowerCase()} is not deleted`);
        const r = await setArchived(request, reply, pool, {
          table: spec.table,
          entityType: spec.entityType,
          archive: false,
          note: null,
          restoreClash: spec.restoreClash ? (c) => spec.restoreClash!(c, id) : undefined,
        });
        if ("reply" in r) return r.reply;
        return { record: await spec.load(pool, id), change: r.change };
      });
    },
  };
}

async function endSessions(c: Db, where: string, params: unknown[], reason: string, by: number | null) {
  const { rowCount } = await c.query(
    `UPDATE user_sessions SET ended_at = now(), end_reason = '${reason}', ended_by_id = ${by == null ? "NULL" : Number(by)}
      WHERE ended_at IS NULL AND ${where}`,
    params,
  );
  return rowCount ?? 0;
}

const ruleErrors = (rules: ReturnType<typeof passwordRules>, path: string): FieldError[] =>
  rules.filter((r) => !r.met).map((r) => ({ path, message: r.label }));

async function recentHashes(c: Db, column: "user_id" | "portal_user_id", id: number): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT password_hash FROM password_history WHERE ${column} = $1 ORDER BY changed_at DESC LIMIT ${(await loadPolicy(c)).passwordHistory - 1}`,
    [id],
  );
  const table = column === "user_id" ? "users" : "customer_portal_users";
  const { rows: cur } = await c.query(`SELECT password_hash FROM ${table} WHERE id = $1`, [id]);
  return [...cur.map((r) => r.password_hash as string), ...rows.map((r) => r.password_hash as string)];
}

// ---------------------------------------------------------------- users (§11, §12.5, §13.28)

const loadUser = (c: Db, id: number) => one(c, USER_SELECT, USER_FROM, "u.id", id, mapUser);
const USER_FIELDS: [keyof UserInput & string, string][] = [
  ["username", "username"],
  ["firstName", "first_name"],
  ["lastName", "last_name"],
  ["email", "email"],
  ["phone", "phone"],
  ["departmentId", "department_id"],
  ["accessGroupId", "access_group_id"],
  ["businessCompanyId", "business_company_id"],
  ["managerId", "manager_id"],
  ["userType", "user_type"],
  ["isAccountManager", "is_account_manager"],
  ["isTeamLead", "is_team_lead"],
  ["status", "status"],
  ["allowMultipleLogin", "allow_multiple_login"],
  ["otpMethod", "otp_method"],
  ["language", "language"],
  ["address1", "address1"],
  ["address2", "address2"],
  ["countryIso", "country_iso"],
  ["state", "state"],
  ["city", "city"],
  ["zip", "zip"],
  ["permissionOverrides", "permission_overrides"],
  ["tabOverrides", "tab_overrides"],
];

async function checkUser(c: Db, b: UserInput, id: number | null): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  if (!(await exists(c, "departments", b.departmentId)))
    errors.push({ path: "/departmentId", message: "unknown department" });
  if (!(await exists(c, "access_groups", b.accessGroupId)))
    errors.push({ path: "/accessGroupId", message: "unknown GUI access group" });
  if (!(await exists(c, "business_companies", b.businessCompanyId)))
    errors.push({ path: "/businessCompanyId", message: "unknown business company" });
  if (b.managerId != null && (b.managerId === id || !(await exists(c, "users", b.managerId))))
    errors.push({
      path: "/managerId",
      message: b.managerId === id ? "a user cannot report to themself" : "unknown user",
    });
  // Per-user overrides of the access group (team trial round 2); [] = no access to that page.
  for (const e of checkPermissions(b.permissionOverrides ?? {}))
    if (!e.message.includes("needs View"))
      errors.push({ ...e, path: e.path.replace("/permissions", "/permissionOverrides") });
  errors.push(...checkTabs(Object.keys(b.tabOverrides ?? {}), "/tabOverrides"));
  const { rows: co } = await c.query("SELECT 1 FROM countries WHERE iso = $1", [b.countryIso]);
  if (!co[0]) errors.push({ path: "/countryIso", message: "unknown country" });
  // The username stays reserved by deleted users too (history and audit refer to it).
  const { rows: dup } = await c.query(
    "SELECT deleted_at FROM users WHERE lower(username) = lower($1) AND id <> coalesce($2, 0)",
    [b.username, id],
  );
  if (dup[0])
    errors.push({
      path: "/username",
      message: dup[0].deleted_at ? "a deleted user has this username" : "another user has this username",
    });
  return errors;
}

async function userDeps(c: Db, id: number) {
  const { rows } = await c.query(
    `SELECT (SELECT count(*)::int FROM enterprises WHERE account_manager_id = $1 AND deleted_at IS NULL) AS ams,
            (SELECT count(*)::int FROM users WHERE manager_id = $1 AND deleted_at IS NULL) AS reports,
            (SELECT count(*)::int FROM user_sessions WHERE user_id = $1 AND ended_at IS NULL) AS sessions`,
    [id],
  );
  const r = rows[0];
  return dependencies([
    {
      key: "account_manager",
      label: "Account manager of live enterprises",
      count: r.ams,
      blocking: true,
      detail: "Hand them to another AM first (§13.30)",
    },
    { key: "team", label: "Users reporting to this user", count: r.reports, blocking: false, detail: null },
    {
      key: "sessions",
      label: "Open sessions (signed out on delete)",
      count: r.sessions,
      blocking: false,
      detail: null,
    },
  ]);
}

const users = records<UserInput, NonNullable<Awaited<ReturnType<typeof loadUser>>>>({
  table: "users",
  entityType: "user",
  label: "User",
  fields: USER_FIELDS,
  load: loadUser,
  values: (b) => ({
    ...b,
    username: b.username.trim().toLowerCase(),
    permissionOverrides: b.permissionOverrides ?? {},
    tabOverrides: b.tabOverrides ?? {},
    firstName: b.firstName.trim(),
    lastName: b.lastName.trim(),
    email: b.email.trim(),
    phone: trimOrNull(b.phone),
    address1: b.address1.trim(),
    address2: trimOrNull(b.address2),
    state: trimOrNull(b.state),
    city: trimOrNull(b.city),
    zip: trimOrNull(b.zip),
  }),
  check: checkUser,
  nameOf: (b) => b.username,
  deps: userDeps,
  onArchive: async (c, id) => void (await endSessions(c, "user_id = $1", [id], "forced", currentUserId())),
});
export const getUser = users.get;
export const getUserDependencies = users.dependencies;
export const updateUser = users.update;
export const archiveUser = users.archive;
export const restoreUser = users.restore;

export function createUser(request: FastifyRequest, reply: FastifyReply) {
  const raw = request.body as UserInput;
  const b = { ...raw, username: raw.username.trim().toLowerCase() };
  return withDb(reply, async (pool) => {
    const errors = await checkUser(pool, b, null);
    if (!b.password) errors.push({ path: "/password", message: "set a temporary password" });
    else errors.push(...ruleErrors(passwordRules(b.password, b, []), "/password"));
    if (errors.length) return badInput(reply, errors);
    const hash = hashPassword(b.password!);
    const { id, change } = await inTransaction(pool, async (c) => {
      const id = await users.insert(c, b, {
        password_hash: hash,
        password_changed_at: new Date(),
        must_change_password: true,
        temp_password_expires_at: new Date(Date.now() + (await loadPolicy(pool)).tempPasswordHours * 3600_000),
        is_admin: false,
      });
      await c.query("INSERT INTO password_history (user_id, password_hash, changed_at) VALUES ($1, $2, now())", [
        id,
        hash,
      ]);
      return { id, change: await users.created(request, c, id, b.username) };
    });
    return reply.code(201).send({ record: await loadUser(pool, id), change });
  });
}

async function passwordChange(
  request: FastifyRequest,
  c: pg.PoolClient,
  entityType: "user_password" | "portal_user_password",
  id: number,
  note: string,
) {
  const me = await getCurrentUser();
  return recordChange(c, {
    entityType,
    entityIds: [id],
    changeType: "edit",
    // The password itself is never stored or shown (§13.28).
    diff: [{ entity_id: id, field: "password", before: null, after: "(temporary password set)" }],
    note,
    userId: me.id,
    ip: request.ip,
  });
}

export function setUserPassword(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as TempPasswordInput;
  return withDb(reply, async (pool) => {
    const u = await loadUser(pool, id);
    if (!u) return notFound(reply, "User", id);
    if (u.archivedAt) return sendProblem(reply, 409, "This user is deleted; restore it first");
    const errors: FieldError[] = [];
    if (b.password !== b.confirmPassword)
      errors.push({ path: "/confirmPassword", message: "the passwords do not match" });
    errors.push(...ruleErrors(passwordRules(b.password, u, await recentHashes(pool, "user_id", id)), "/password"));
    if (errors.length) return badInput(reply, errors);
    const hash = hashPassword(b.password);
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = true,
                temp_password_expires_at = now() + make_interval(hours => ${(await loadPolicy(pool)).tempPasswordHours}), updated_at = now() WHERE id = $1`,
        [id, hash],
      );
      await c.query("INSERT INTO password_history (user_id, password_hash, changed_at) VALUES ($1, $2, now())", [
        id,
        hash,
      ]);
      await endSessions(c, "user_id = $1", [id], "password_change", currentUserId());
      return passwordChange(
        request,
        c,
        "user_password",
        id,
        `Temporary password set for ${u.username} (valid ${policy().tempPasswordHours} h)`,
      );
    });
    return { record: await loadUser(pool, id), change };
  });
}

export function forcePasswordChange(request: FastifyRequest, reply: FastifyReply) {
  const { ids } = request.body as ForcePasswordChangeInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const out = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `UPDATE users SET must_change_password = true, updated_at = now(), updated_by_id = $2
          WHERE id = ANY($1) AND deleted_at IS NULL AND NOT must_change_password RETURNING id, username`,
        [ids, me.id],
      );
      if (!rows.length) return { updated: 0, change: null };
      const change = await recordChange(c, {
        entityType: "user",
        entityIds: rows.map((r) => Number(r.id)),
        changeType: "edit",
        diff: rows.map((r) => ({ entity_id: Number(r.id), field: "mustChangePassword", before: false, after: true })),
        note:
          rows.length === 1
            ? `Forced a password change for ${rows[0].username as string}`
            : `Forced a password change for ${rows.length} users`,
        userId: me.id,
        ip: request.ip,
      });
      return { updated: rows.length, change };
    });
    return out;
  });
}

export function setupUserTotp(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const u = await loadUser(pool, id);
    if (!u) return notFound(reply, "User", id);
    const secret = newTotpSecret();
    await pool.query("UPDATE users SET totp_pending_secret = $2 WHERE id = $1", [id, encryptSecret(secret)]);
    return { secret, otpauthUri: otpauthUri(secret, u.username) };
  });
}

async function totpChange(request: FastifyRequest, c: pg.PoolClient, id: number, enabled: boolean, username: string) {
  const me = await getCurrentUser();
  return recordChange(c, {
    entityType: "user_totp",
    entityIds: [id],
    changeType: "edit",
    diff: [{ entity_id: id, field: "totpEnabled", before: !enabled, after: enabled }],
    note: `${enabled ? "Enabled" : "Disabled"} QR 2FA for ${username}`,
    userId: me.id,
    ip: request.ip,
  });
}

export function confirmUserTotp(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { code } = request.body as TotpConfirmInput;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT username, totp_pending_secret FROM users WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, "User", id);
    const pending = totpSecretOf(rows[0].totp_pending_secret);
    if (!pending) return badInput(reply, [{ path: "/code", message: "start the QR enrolment first" }]);
    if (!verifyTotp(pending, code))
      return badInput(reply, [{ path: "/code", message: "the code does not match; check the phone's clock" }]);
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE users SET totp_enabled = true, totp_secret = totp_pending_secret, totp_pending_secret = NULL, updated_at = now() WHERE id = $1",
        [id],
      );
      return totpChange(request, c, id, true, rows[0].username as string);
    });
    return { record: await loadUser(pool, id), change };
  });
}

export function disableUserTotp(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const u = await loadUser(pool, id);
    if (!u) return notFound(reply, "User", id);
    if (!u.totpEnabled) return { record: u, change: null };
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending_secret = NULL, updated_at = now() WHERE id = $1",
        [id],
      );
      return totpChange(request, c, id, false, u.username);
    });
    return { record: await loadUser(pool, id), change };
  });
}

// ---------------------------------------------------------------- e-mailed password-change code (R6, §13.28)

/** Decided 2026-10-24 (R6): a code is always needed to change a password; without an authenticator it is e-mailed. */
const CODE_TTL_MIN = 10;
const CODE_TRIES = 5;
const CODE_GAP_S = 60;
const codeHash = (userId: number, code: string) =>
  createHash("sha256").update(`pwcode:${userId}:${code}`).digest("hex");
export const maskEmail = (e: string) => {
  const [local = "", domain = ""] = e.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
};

export const sendMyPasswordCode = (_request: FastifyRequest, reply: FastifyReply) => sendCode(reply, "password");

/** A code for a Migration export or import with credentials (§13.22, R9): admins without the authenticator app. */
export const sendMyCredentialCode = (_request: FastifyRequest, reply: FastifyReply) => sendCode(reply, "credentials");

const CODE_MAIL = {
  password: {
    subject: "Your code to change your password",
    body: (name: string, code: string) =>
      `Hello ${name},\n\nYour code to change your password is ${code}. It works for ${CODE_TTL_MIN} minutes.\n\n` +
      `If you did not ask to change your password, ignore this e-mail and tell your administrator.`,
  },
  credentials: {
    subject: "Your code to export or import credentials",
    body: (name: string, code: string) =>
      `Hello ${name},\n\nYour code to export or import trunk credentials in the Migration Center is ${code}. ` +
      `It works for ${CODE_TTL_MIN} minutes.\n\nIf you did not ask for it, tell your administrator now.`,
  },
};

/** E-mails a 6-digit code to the signed-in user (one at a time, at most one a minute). */
function sendCode(reply: FastifyReply, purpose: keyof typeof CODE_MAIL) {
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (purpose === "credentials" && !me.permissions.includes("*"))
      return sendProblem(reply, 403, "Credentials can be exported and imported by admins only (§13.22)");
    const { rows } = await pool.query(
      `SELECT first_name, email, totp_enabled, password_code_sent_at > now() - make_interval(secs => $2) AS too_soon
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [me.id, CODE_GAP_S],
    );
    const u = rows[0];
    if (!u) return sendProblem(reply, 401, "Sign in again");
    if (u.totp_enabled)
      return sendProblem(reply, 409, "Your account has 2FA on: use the code from your authenticator app");
    if (!u.email)
      return badInput(reply, [{ path: "/", message: "your account has no e-mail address; ask an administrator" }]);
    if (u.too_soon) return badInput(reply, [{ path: "/", message: "a code was sent less than a minute ago" }]);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);
    await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE users SET password_code_hash = $2, password_code_expires_at = $3, password_code_sent_at = now(),
                password_code_tries = 0 WHERE id = $1`,
        [me.id, codeHash(me.id, code), expiresAt],
      );
      // The code only; never a password or a sign-in link (§13.28).
      await logEmail(c, {
        type: "otp",
        to: [u.email as string],
        subject: CODE_MAIL[purpose].subject,
        body: CODE_MAIL[purpose].body(u.first_name as string, code),
      });
    });
    return { sentTo: maskEmail(u.email as string), expiresAt: expiresAt.toISOString() };
  });
}

/** Checks an e-mailed code; a wrong code uses up one of the tries. */
export async function checkEmailCode(
  pool: pg.Pool,
  userId: number,
  code: string | null | undefined,
  missing = "enter the code we e-mailed you (Send code)",
): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT password_code_hash, password_code_expires_at > now() AS live, password_code_tries FROM users WHERE id = $1",
    [userId],
  );
  const r = rows[0];
  if (!code) return missing;
  if (!r?.password_code_hash || !r.live) return "the code has expired; send a new one";
  if (Number(r.password_code_tries) >= CODE_TRIES) return "too many wrong codes; send a new one";
  const want = Buffer.from(r.password_code_hash as string, "hex");
  const got = Buffer.from(codeHash(userId, code), "hex");
  if (want.length === got.length && timingSafeEqual(want, got)) return null;
  await pool.query("UPDATE users SET password_code_tries = password_code_tries + 1 WHERE id = $1", [userId]);
  return "the code does not match";
}

/** §13.28: the signed-in user's own change - current password, a code (always, R6), rules; other sessions end. */
export function changeMyPassword(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as PasswordChangeInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      "SELECT username, first_name, last_name, password_hash, totp_enabled, totp_secret FROM users WHERE id = $1",
      [me.id],
    );
    const u = rows[0];
    if (!u) return sendProblem(reply, 401, "Sign in again");
    const errors: FieldError[] = [];
    if (!verifyPassword(b.currentPassword, u.password_hash as string))
      errors.push({ path: "/currentPassword", message: "the current password is wrong" });
    // A code is always needed (R6): the authenticator's when 2FA is on, otherwise the e-mailed one.
    if (u.totp_enabled) {
      const secret = totpSecretOf(u.totp_secret);
      if (!b.totpCode || !secret || !verifyTotp(secret, b.totpCode))
        errors.push({
          path: "/totpCode",
          message: b.totpCode ? "the 2FA code does not match" : "enter the code from your 2FA app",
        });
    } else {
      const wrong = await checkEmailCode(pool, me.id, b.emailCode);
      if (wrong) errors.push({ path: "/emailCode", message: wrong });
    }
    if (b.newPassword === b.currentPassword) errors.push({ path: "/newPassword", message: "choose a new password" });
    errors.push(
      ...ruleErrors(
        passwordRules(
          b.newPassword,
          { username: u.username, firstName: u.first_name, lastName: u.last_name },
          await recentHashes(pool, "user_id", me.id),
        ),
        "/newPassword",
      ),
    );
    if (errors.length) {
      // Failed attempts are logged for the team activity view (§13.28 Audit).
      await recordFailure(pool, request, me.id);
      return badInput(reply, errors);
    }
    const hash = hashPassword(b.newPassword);
    const changedAt = new Date();
    const signedOut = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE users SET password_hash = $2, password_changed_at = $3, must_change_password = false,
                temp_password_expires_at = NULL, password_code_hash = NULL, password_code_expires_at = NULL,
                updated_at = now() WHERE id = $1`,
        [me.id, hash, changedAt],
      );
      await c.query("INSERT INTO password_history (user_id, password_hash, changed_at) VALUES ($1, $2, $3)", [
        me.id,
        hash,
        changedAt,
      ]);
      return endSessions(
        c,
        `user_id = $1 AND id <> coalesce(${currentSessionSql(me.id)}, 0)`,
        [me.id],
        "password_change",
        me.id,
      );
    });
    return {
      changedAt: changedAt.toISOString(),
      expiresAt: passwordExpiry(changedAt).toISOString(),
      signedOutSessions: signedOut,
    };
  });
}

async function recordFailure(pool: pg.Pool, request: FastifyRequest, userId: number) {
  await pool.query(
    `INSERT INTO audit_log (user_id, ip, module, controller, method, action, table_name, master_id, status)
     VALUES ($1, $2, 'session', '/me/password', 'POST', 'changeMyPasswordFailed', 'users', $3, 400)`,
    [userId, request.ip || null, String(userId)],
  );
}

export function checkPassword(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as PasswordCheckInput;
  return withDb(reply, async (pool) => {
    let who = { username: b.username ?? null, firstName: b.firstName ?? null, lastName: b.lastName ?? null };
    let recent: string[] = [];
    if (b.userId != null) {
      const { rows } = await pool.query("SELECT username, first_name, last_name FROM users WHERE id = $1", [b.userId]);
      if (rows[0]) {
        who = { username: rows[0].username, firstName: rows[0].first_name, lastName: rows[0].last_name };
        recent = await recentHashes(pool, "user_id", b.userId);
      }
    }
    const rules = passwordRules(b.password, who, recent);
    return { ok: rules.every((r) => r.met), rules };
  });
}

// ---------------------------------------------------------------- departments

const loadDepartment = (c: Db, id: number) => one(c, DEPARTMENT_SELECT, DEPARTMENT_FROM, "d.id", id, mapDepartment);
const departments = records<DepartmentInput, NonNullable<Awaited<ReturnType<typeof loadDepartment>>>>({
  table: "departments",
  entityType: "department",
  label: "Department",
  fields: [
    ["name", "name"],
    ["status", "status"],
    ["managerId", "manager_id"],
    ["description", "description"],
  ],
  load: loadDepartment,
  values: (b) => ({ ...b, name: b.name.trim(), description: trimOrNull(b.description) }),
  check: async (c, b, id) => {
    const errors: FieldError[] = [];
    if (!(await exists(c, "users", b.managerId))) errors.push({ path: "/managerId", message: "unknown user" });
    const { rows } = await c.query(
      "SELECT deleted_at FROM departments WHERE lower(name) = lower($1) AND id <> coalesce($2, 0)",
      [b.name, id],
    );
    if (rows[0])
      errors.push({
        path: "/name",
        message: rows[0].deleted_at ? "a deleted department has this name" : "another department has this name",
      });
    return errors;
  },
  nameOf: (b) => b.name,
  deps: async (c, id) => {
    const { rows } = await c.query(
      "SELECT count(*)::int AS n FROM users WHERE department_id = $1 AND deleted_at IS NULL",
      [id],
    );
    return dependencies([
      { key: "users", label: "Users in this department", count: rows[0].n, blocking: true, detail: "Move them first" },
    ]);
  },
});
export const getDepartment = departments.get;
export const getDepartmentDependencies = departments.dependencies;
export const createDepartment = departments.create;
export const updateDepartment = departments.update;
export const archiveDepartment = departments.archive;
export const restoreDepartment = departments.restore;

// ---------------------------------------------------------------- GUI access groups

const loadAccessGroup = (c: Db, id: number) =>
  one(c, ACCESS_GROUP_SELECT, ACCESS_GROUP_FROM, "g.id", id, mapAccessGroup);
async function checkGroup(c: Db, b: AccessGroupInput, id: number | null): Promise<FieldError[]> {
  const errors = [...checkPermissions(b.permissions), ...checkTabs(b.hiddenTabs ?? [], "/hiddenTabs")];
  const { rows } = await c.query(
    "SELECT deleted_at FROM access_groups WHERE lower(name) = lower($1) AND id <> coalesce($2, 0)",
    [b.name, id],
  );
  if (rows[0])
    errors.push({
      path: "/name",
      message: rows[0].deleted_at ? "a deleted access group has this name" : "another access group has this name",
    });
  return errors;
}
const groups = records<AccessGroupInput, NonNullable<Awaited<ReturnType<typeof loadAccessGroup>>>>({
  table: "access_groups",
  entityType: "access_group",
  label: "Access group",
  fields: [
    ["name", "name"],
    ["status", "status"],
    ["description", "description"],
    ["permissions", "permissions"],
    ["hiddenTabs", "hidden_tabs"],
  ],
  load: loadAccessGroup,
  values: (b) => ({
    ...b,
    name: b.name.trim(),
    description: trimOrNull(b.description),
    permissions: normalisePermissions(b.permissions),
    hiddenTabs: [...new Set(b.hiddenTabs ?? [])].sort(),
  }),
  check: checkGroup,
  nameOf: (b) => b.name,
  deps: async (c, id) => {
    const { rows } = await c.query(
      "SELECT count(*)::int AS n FROM users WHERE access_group_id = $1 AND deleted_at IS NULL",
      [id],
    );
    return dependencies([
      {
        key: "users",
        label: "Users with this access group",
        count: rows[0].n,
        blocking: true,
        detail: "Give them another group first",
      },
    ]);
  },
});
export const getAccessGroup = groups.get;
export const getAccessGroupDependencies = groups.dependencies;
export const createAccessGroup = groups.create;
export const updateAccessGroup = groups.update;
export const archiveAccessGroup = groups.archive;
export const restoreAccessGroup = groups.restore;
export const getAccessCatalog = () => ({ actions: ACTIONS, sections: SECTIONS, modules: MODULES });

export function cloneAccessGroup(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { name } = request.body as CloneInput;
  return withDb(reply, async (pool) => {
    const src = await loadAccessGroup(pool, id);
    if (!src) return notFound(reply, "Access group", id);
    const b: AccessGroupInput = {
      name: name.trim(),
      status: src.status,
      description: src.description,
      permissions: src.permissions,
      hiddenTabs: src.hiddenTabs,
    };
    const errors = await checkGroup(pool, b, null);
    if (errors.length) return badInput(reply, errors);
    const { newId, change } = await inTransaction(pool, async (c) => {
      const newId = await groups.insert(c, b);
      return {
        newId,
        change: await groups.created(request, c, newId, b.name, `Cloned access group ${src.name} as ${b.name}`),
      };
    });
    return reply.code(201).send({ record: await loadAccessGroup(pool, newId), change });
  });
}

// ---------------------------------------------------------------- logged-in users

export function endUserSession(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `SELECT ended_at, (id = ${currentSessionSql(me.id)}) AS current FROM user_sessions WHERE id = $1`,
      [id],
    );
    if (!rows[0]) return notFound(reply, "Session", id);
    if (rows[0].current) return sendProblem(reply, 400, "This is your own session; sign out from the avatar menu");
    if (rows[0].ended_at) return { ended: false };
    await endSessions(pool, "id = $1", [id], "forced", me.id);
    return { ended: true };
  });
}

// ---------------------------------------------------------------- e-mail templates

/** Placeholders each e-mail type fills, with fake sample values for the preview. */
const COMMON: [string, string, string][] = [
  ["enterprise", "Partner (enterprise) name", "Fenphy Demo Telecom"],
  ["company", "Business company name", "Bricor Gateway Group"],
  // The sending business company's address and bank (§11): each entity's e-mails carry its own account.
  ["company_logo", "Business company logo (image, 48 px high)", "[logo]"],
  ["company_address", "Business company address", "12 Example Street, 1000 Demo City, Lebanon"],
  ["company_website", "Business company website", "https://bricor.example"],
  [
    "bank_details",
    "All bank lines of the business company",
    "Beneficiary: Bricor Gateway Group\nBank: Demo Bank SAL\nIBAN: LB00 0000 0000 0000 0000 0000 0000\nSWIFT: DEMOLBBE",
  ],
  ["bank_beneficiary", "Bank beneficiary name", "Bricor Gateway Group"],
  ["bank_name", "Bank name", "Demo Bank SAL"],
  ["bank_address", "Bank address", "1 Bank Square, Demo City"],
  ["bank_currency", "Bank account currency", "EUR"],
  ["bank_account", "Bank account number", "000123456789"],
  ["bank_iban", "IBAN", "LB00 0000 0000 0000 0000 0000 0000"],
  ["bank_swift", "SWIFT / BIC", "DEMOLBBE"],
];
const PLACEHOLDERS: Record<string, [string, string, string][]> = {
  customer_rate: [
    ["trunk", "Customer trunk", "FENPHY-MAIN"],
    ["rate_date", "Effective date", "2026-10-20"],
  ],
  invoice: [
    ["from", "Usage start", "2026-10-01"],
    ["to", "Usage end", "2026-10-15"],
    ["invoice_no", "Invoice number", "INV-1042"],
    ["amount", "Total", "1,250.40"],
    ["due_amount", "Amount due (after balance)", "1,250.40"],
    ["currency", "Currency", "EUR"],
    ["due_date", "Due date", "2026-10-30"],
  ],
  low_balance: [
    ["balance", "Current balance", "120.00"],
    ["threshold", "Alert level", "500.00"],
    ["currency", "Currency", "EUR"],
  ],
  bind_down: [
    ["trunk", "Trunk", "FENPHY-MAIN"],
    ["since", "Down since (UTC)", "2026-10-16 18:05"],
  ],
  customer_tech_info: [
    ["trunk", "Trunk", "FENPHY-MAIN"],
    ["host", "SMPP host", "smpp.bricor.example"],
    ["port", "SMPP port", "2775"],
    ["system_id", "System ID", "fenphy01"],
    ["bind_type", "Bind type", "TRX"],
    ["ips", "Allowed IPs", "192.0.2.10, 192.0.2.11"],
    ["tps", "TPS", "100"],
    ["connections", "Connections", "4"],
    ["password", "SMPP password (plain text, team trial round 1)", "fake-pass-123"],
    [
      "trunks",
      "Every trunk's connection details, one block each (Notifications on the enterprise)",
      "FENPHY-MAIN\n  SMPP host:    smpp.bricor.example\n  SMPP port:    2775\n  System ID:    fenphy01",
    ],
  ],
  trunk_change_info: [
    ["trunk", "Trunk", "FENPHY-MAIN"],
    ["date", "Change date", "2026-10-16"],
    ["changes", "What changed", "TPS 100 → 150"],
  ],
  soa_statement: [
    ["from", "Period start", "2026-09-01"],
    ["to", "Period end", "2026-09-30"],
    ["timezone", "Time zone", "UTC"],
    ["closing_balance", "Closing balance", "-3,410.25"],
    ["currency", "Currency", "EUR"],
    ["balance_words", "Balance in words", "you owe us"],
  ],
  rate_upload_notification: [
    ["trunk", "Vendor trunk", "VND-ALPHA"],
    ["file", "File name", "rates_oct.xlsx"],
    ["lines", "Lines loaded", "2,140"],
    ["rate_date", "Effective date", "2026-10-20"],
  ],
  traffic_alert: [
    ["alert", "Alert name", "ASR drop"],
    ["trunk", "Trunk", "FENPHY-MAIN"],
    ["interval", "Interval (minutes)", "15"],
    ["breaches", "Breached thresholds", "ASR 41 % < 60 %"],
  ],
  auto_upload_rejected: [
    ["trunk", "Vendor trunk", "VND-ALPHA"],
    ["file", "File name", "rates_oct.xlsx"],
    ["reason", "Why it was rejected", "Missing MCCMNC column"],
  ],
  trouble_ticket: [
    ["trunk", "Trunk", "VND-ALPHA"],
    ["rows", "Messages listed", "12"],
    ["edrs", "The message table", "(table of EDRs)"],
  ],
  send_soa: [
    ["from", "Period start", "2026-09-01"],
    ["to", "Period end", "2026-09-30"],
    ["closing_balance", "Closing balance", "-3,410.25"],
    ["currency", "Currency", "EUR"],
    ["balance_words", "Balance in words", "you owe us"],
  ],
  monitoring_alert: [
    ["severity", "CRITICAL / WARNING / INFO, or OK on recovery", "CRITICAL"],
    ["rule", "Alert rule", "DLR drop – key clients"],
    ["entity", "What the incident is about", "FENPHY-MAIN"],
    ["metric", "Metric and condition", "DLR – DLR down 20 % vs previous window · 15 min"],
    ["current", "Value now", "61 %"],
    ["baseline", "Baseline", "92 %"],
    ["started", "Start time (UTC)", "2026-10-16 18:05"],
    ["link", "Link that opens the incident", "https://platform.example/monitoring/incidents?incident=5001"],
    [
      "state_line",
      "What happened in words (or the digest list)",
      "FENPHY-MAIN DLR dropped from 92 % to 61 % in 15 min",
    ],
  ],
  // The client is told about its new account manager (team trial round 2).
  am_handover: [
    ["old_am", "The previous account manager", "Rana Haddad"],
    ["new_am", "The new account manager", "Karim Saad"],
    ["new_am_email", "The new account manager's e-mail", "karim.saad@demo.example"],
    ["new_am_phone", "The new account manager's phone", "+000 1 234 567"],
    ["new_am_phone_line", "“ or <phone>” when the new AM has a phone, else empty", " or +000 1 234 567"],
    ["effective_date", "When the handover takes effect (platform time zone)", "2026-11-01 00:00"],
    ["note", "The note typed on the handover", "I look forward to working with you."],
  ],
};
const TYPE_LABELS: Record<string, string> = {
  customer_rate: "Customer Rate",
  invoice: "Invoice",
  low_balance: "Low Balance",
  bind_down: "Bind Down",
  customer_tech_info: "Customer Tech Info",
  trunk_change_info: "Trunk Change Info",
  soa_statement: "SOA Statement",
  rate_upload_notification: "Rate Upload Notification",
  traffic_alert: "Traffic Alert",
  auto_upload_rejected: "Auto Upload Report – Reject",
  trouble_ticket: "EDR – Trouble Ticket",
  send_soa: "Send SOA",
  monitoring_alert: "Monitoring Alert",
  am_handover: "Account Manager Handover",
};
const placeholdersOf = (type: string) =>
  [...COMMON, ...(PLACEHOLDERS[type] ?? [])].map(([key, description, sample]) => ({ key, description, sample }));
export const listEmailPlaceholders = () => ({
  types: Object.keys(TYPE_LABELS).map((t) => ({
    emailType: t as EmailTemplateRecord["emailType"],
    label: TYPE_LABELS[t]!,
    placeholders: placeholdersOf(t),
  })),
});

async function loadTemplate(c: Db, id: number): Promise<EmailTemplateRecord | null> {
  const { rows } = await c.query(
    `SELECT ${EMAIL_TEMPLATE_SELECT}, t.body FROM ${EMAIL_TEMPLATE_FROM} WHERE t.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  return {
    ...mapEmailTemplate(rows[0]),
    body: rows[0].body as string,
    placeholders: placeholdersOf(rows[0].email_type as string),
  };
}
async function checkTemplate(c: Db, b: EmailTemplateInput): Promise<FieldError[]> {
  return (await exists(c, "business_companies", b.businessCompanyId))
    ? []
    : [{ path: "/businessCompanyId", message: "unknown business company" }];
}
const templates = records<EmailTemplateInput, EmailTemplateRecord>({
  table: "email_templates",
  entityType: "email_template",
  label: "E-mail template",
  fields: [
    ["name", "name"],
    ["emailType", "email_type"],
    ["subject", "subject"],
    ["body", "body"],
    ["businessCompanyId", "business_company_id"],
  ],
  load: loadTemplate,
  // Designs are kept whole; only scripts, handlers, forms and frames are removed (§11).
  values: (b) => ({ ...b, name: b.name.trim(), subject: b.subject.trim(), body: sanitizeHtml(b.body) }),
  check: (c, b) => checkTemplate(c, b),
  nameOf: (b) => b.name,
  deps: async (c, id) => {
    const { rows } = await c.query(
      `SELECT (SELECT count(*)::int FROM business_companies b, jsonb_each_text(b.default_templates) kv
                WHERE b.deleted_at IS NULL AND kv.value = $2) AS companies,
              (SELECT count(*)::int FROM traffic_alerts WHERE template_id = $1 AND deleted_at IS NULL) AS alerts,
              (SELECT count(*)::int FROM soa_reports WHERE template_id = $1) AS soa`,
      [id, String(id)],
    );
    const r = rows[0];
    return dependencies([
      {
        key: "business_companies",
        label: "Business company defaults",
        count: r.companies,
        blocking: true,
        detail: null,
      },
      { key: "traffic_alerts", label: "Traffic alerts", count: r.alerts, blocking: true, detail: null },
      { key: "soa_reports", label: "SOA reports", count: r.soa, blocking: true, detail: null },
    ]);
  },
});
export const getEmailTemplate = templates.get;
export const getEmailTemplateDependencies = templates.dependencies;
export const createEmailTemplate = templates.create;
export const updateEmailTemplate = templates.update;
export const archiveEmailTemplate = templates.archive;
export const restoreEmailTemplate = templates.restore;

export function cloneEmailTemplate(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { name } = request.body as CloneInput;
  return withDb(reply, async (pool) => {
    const src = await loadTemplate(pool, id);
    if (!src) return notFound(reply, "E-mail template", id);
    const b: EmailTemplateInput = {
      name: name.trim(),
      emailType: src.emailType,
      subject: src.subject,
      body: src.body,
      businessCompanyId: src.businessCompanyId,
    };
    const { newId, change } = await inTransaction(pool, async (c) => {
      const newId = await templates.insert(c, b);
      return {
        newId,
        change: await templates.created(request, c, newId, b.name, `Cloned e-mail template ${src.name} as ${b.name}`),
      };
    });
    return reply.code(201).send({ record: await loadTemplate(pool, newId), change });
  });
}

/** Shown for {company_logo} when no business company (or no logo) is picked. */
const LOGO_SAMPLE =
  '<span style="display:inline-block;width:120px;height:40px;line-height:40px;text-align:center;background-color:#e5e7eb;color:#6b7280;font:bold 12px Arial,sans-serif">LOGO</span>';

/**
 * Fills {placeholders} with sample values (a picked business company's own name, address, bank and
 * logo), and builds the e-mail as sent, the classic Outlook view and the compatibility report (§11).
 */
/** The template filled with sample values (a picked business company's own name, address, bank and logo). */
function fillSamples(type: string, subject: string, body: string, company: string | Record<string, string> | null) {
  const values: Record<string, string> = Object.fromEntries(placeholdersOf(type).map((p) => [p.key, p.sample]));
  values.company_logo = LOGO_SAMPLE;
  if (typeof company === "string") values.company = company;
  else if (company) for (const [k, v] of Object.entries(company)) if (v && k in values) values[k] = v;
  const unknown = new Set<string>();
  return { subject: fillText(subject, values, unknown), body: fillBody(body, values, unknown), unknown };
}

/** Preview (§11): the filled body, the e-mail as sent, the classic Outlook view and the compatibility report. */
export function fillTemplate(
  type: string,
  subject: string,
  body: string,
  company: string | Record<string, string> | null,
) {
  const f = fillSamples(type, subject, body, company);
  const emailHtml = emailDocument(f.body);
  return {
    subject: f.subject,
    bodyHtml: isHtml(body) ? sanitizeHtml(f.body) : escapeHtml(f.body).replace(/\n/g, "<br>"),
    emailHtml,
    outlookHtml: outlookView(emailHtml),
    issues: compatIssues(emailHtml, body),
    unknownPlaceholders: [...f.unknown],
  };
}

const companyValues = async (c: Db, companyId: number | null) =>
  companyId == null ? null : companyPlaceholders(await companyDetails(c, { companyId }));

export function previewEmailTemplate(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as EmailTemplatePreviewInput;
  return withDb(reply, async (pool) =>
    fillTemplate(b.emailType, b.subject, b.body, await companyValues(pool, b.businessCompanyId)),
  );
}

/** The mailbox that sends each template type (Senders, §11). */
const SENDER_OF: Record<string, SenderEmail> = {
  customer_rate: "rateSheet",
  invoice: "invoice",
  low_balance: "invoice",
  bind_down: "techInfo",
  customer_tech_info: "techInfo",
  trunk_change_info: "techInfo",
  soa_statement: "soa",
  send_soa: "soa",
  rate_upload_notification: "rnReply",
  auto_upload_rejected: "rnReply",
  traffic_alert: "trafficAlert",
  monitoring_alert: "trafficAlert",
  trouble_ticket: "troubleTicket",
};

/** A test of a template to real addresses, so it can be checked in Outlook (logged as template_test). */
export function testEmailTemplate(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as EmailTemplateTestInput;
  return withDb(reply, async (pool) => {
    if (b.businessCompanyId != null && !(await exists(pool, "business_companies", b.businessCompanyId)))
      return badInput(reply, [{ path: "/businessCompanyId", message: "unknown business company" }]);
    if (!b.subject.trim() || !b.body.trim())
      return badInput(reply, [{ path: b.subject.trim() ? "/body" : "/subject", message: "required" }]);
    const f = fillSamples(b.emailType, b.subject, b.body, await companyValues(pool, b.businessCompanyId));
    const me = await getCurrentUser();
    const sender =
      b.businessCompanyId == null
        ? null
        : await senderFor(pool, { companyId: b.businessCompanyId }, SENDER_OF[b.emailType] ?? "techInfo");
    const id = { value: 0 };
    const to = [...new Set(b.to.map((x) => x.trim().toLowerCase()))];
    const status = await logEmail(
      pool,
      { type: "template_test", to, sender, subject: `[Test] ${f.subject}`, body: f.body, userId: me.id },
      id,
    );
    const { rows } = await pool.query("SELECT inline_images FROM email_logs WHERE id = $1", [id.value]);
    return {
      status,
      emailLogId: id.value,
      sender,
      inlineImages: (rows[0]?.inline_images as string[] | undefined)?.length ?? 0,
    };
  });
}

// ---------------------------------------------------------------- customer portal users

const loadPortalUser = (c: Db, id: number) => one(c, PORTAL_USER_SELECT, PORTAL_USER_FROM, "p.id", id, mapPortalUser);
async function checkPortalUser(c: Db, b: PortalUserInput, id: number | null): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const { rows } = await c.query("SELECT type FROM enterprises WHERE id = $1 AND deleted_at IS NULL", [b.enterpriseId]);
  if (!rows[0]) errors.push({ path: "/enterpriseId", message: "unknown enterprise" });
  else if (rows[0].type === "vendor")
    errors.push({ path: "/enterpriseId", message: "the portal is for customers; this is a vendor" });
  const { rows: dup } = await c.query(
    "SELECT 1 FROM customer_portal_users WHERE lower(username) = lower($1) AND deleted_at IS NULL AND id <> coalesce($2, 0)",
    [b.username, id],
  );
  if (dup[0]) errors.push({ path: "/username", message: "another portal user has this username" });
  return errors;
}
const portalUsers = records<PortalUserInput, NonNullable<Awaited<ReturnType<typeof loadPortalUser>>>>({
  table: "customer_portal_users",
  entityType: "portal_user",
  label: "Portal user",
  fields: [
    ["email", "email"],
    ["username", "username"],
    ["enterpriseId", "enterprise_id"],
    ["firstName", "first_name"],
    ["lastName", "last_name"],
    ["status", "status"],
    ["otpMethod", "otp_method"],
  ],
  load: loadPortalUser,
  values: (b) => ({
    ...b,
    // The e-mailed sign-in code (backend step 13): on unless staff turn it off for the user.
    otpMethod: b.otpMethod ?? "email",
    email: b.email.trim(),
    username: b.username.trim(),
    firstName: b.firstName.trim(),
    lastName: b.lastName.trim(),
  }),
  check: checkPortalUser,
  nameOf: (b) => b.username,
  onArchive: async (c, id) => void (await endSessions(c, "portal_user_id = $1", [id], "forced", currentUserId())),
  restoreClash: async (c, id) => {
    const { rows } = await c.query(
      `SELECT 1 FROM customer_portal_users x JOIN customer_portal_users p ON lower(p.username) = lower(x.username)
        WHERE p.id = $1 AND x.id <> p.id AND x.deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? "Another live portal user has this username" : null;
  },
});
export const getPortalUser = portalUsers.get;
export const updatePortalUser = portalUsers.update;
export const archivePortalUser = portalUsers.archive;
export const restorePortalUser = portalUsers.restore;

export function createPortalUser(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as PortalUserInput;
  return withDb(reply, async (pool) => {
    const errors = await checkPortalUser(pool, b, null);
    if (!b.password) errors.push({ path: "/password", message: "set a temporary password" });
    else errors.push(...ruleErrors(passwordRules(b.password, b, []), "/password"));
    if (errors.length) return badInput(reply, errors);
    const hash = hashPassword(b.password!);
    const { id, change } = await inTransaction(pool, async (c) => {
      const id = await portalUsers.insert(
        c,
        { ...b, username: b.username.trim() },
        {
          password_hash: hash,
          password_changed_at: new Date(),
          must_change_password: true,
          temp_password_expires_at: new Date(Date.now() + (await loadPolicy(pool)).tempPasswordHours * 3600_000),
        },
      );
      await c.query("INSERT INTO password_history (portal_user_id, password_hash, changed_at) VALUES ($1, $2, now())", [
        id,
        hash,
      ]);
      return { id, change: await portalUsers.created(request, c, id, b.username.trim()) };
    });
    return reply.code(201).send({ record: await loadPortalUser(pool, id), change });
  });
}

export function setPortalUserPassword(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as TempPasswordInput;
  return withDb(reply, async (pool) => {
    const u = await loadPortalUser(pool, id);
    if (!u) return notFound(reply, "Portal user", id);
    if (u.archivedAt) return sendProblem(reply, 409, "This portal user is deleted; restore it first");
    const errors: FieldError[] = [];
    if (b.password !== b.confirmPassword)
      errors.push({ path: "/confirmPassword", message: "the passwords do not match" });
    errors.push(
      ...ruleErrors(passwordRules(b.password, u, await recentHashes(pool, "portal_user_id", id)), "/password"),
    );
    if (errors.length) return badInput(reply, errors);
    const hash = hashPassword(b.password);
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE customer_portal_users SET password_hash = $2, password_changed_at = now(), must_change_password = true,
                temp_password_expires_at = now() + make_interval(hours => ${(await loadPolicy(pool)).tempPasswordHours}), updated_at = now() WHERE id = $1`,
        [id, hash],
      );
      await c.query("INSERT INTO password_history (portal_user_id, password_hash, changed_at) VALUES ($1, $2, now())", [
        id,
        hash,
      ]);
      await endSessions(c, "portal_user_id = $1", [id], "password_change", currentUserId());
      return passwordChange(request, c, "portal_user_password", id, `Temporary portal password set for ${u.username}`);
    });
    return { record: await loadPortalUser(pool, id), change };
  });
}
