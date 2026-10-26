// Server-side lists for Admin (§11, §13.28): users with the Password column, departments, GUI access
// groups, logged-in users, the audit trail, business companies, customer portal users and e-mail
// templates. The SELECT / FROM / mapRow parts are shared with the record endpoints (api/admin.ts).
import type {
  AccessGroupRow,
  AuditRow,
  BusinessCompanyRow,
  DepartmentRow,
  EmailTemplateRow,
  PortalUserRow,
  UserRow,
  UserSessionRow,
} from "@sms/contract";
import { LIFETIME_SQL } from "../admin/passwords.js";
import type { ListDef } from "./engine.js";
import { listFields } from "./fields.js";
import { currentSessionId } from "../auth/user.js";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const str = (v: unknown) => (v as string | null) ?? null;
const num = (v: unknown) => (v == null ? null : Number(v));
const fullName = (a: string) => `(${a}.first_name || ' ' || ${a}.last_name)`;
const LIFETIME = LIFETIME_SQL;

// ---------------------------------------------------------------- users (§11, §13.28)

const expires = (a: string) => `(${a}.password_changed_at + ${LIFETIME})`;
const daysLeftSql = (a: string) => `floor(extract(epoch FROM (${expires(a)} - now())) / 86400)::int`;
const stateSql = `(CASE WHEN u.temp_password_expires_at IS NOT NULL THEN 'temporary'
  WHEN u.must_change_password THEN 'must_change'
  WHEN ${expires("u")} <= now() THEN 'expired'
  WHEN ${expires("u")} <= now() + interval '7 days' THEN 'expiring' ELSE 'ok' END)`;
const sessionsSql = "(SELECT count(*)::int FROM user_sessions s WHERE s.user_id = u.id AND s.ended_at IS NULL)";
const liveEnterprisesSql =
  "(SELECT count(*)::int FROM enterprises e WHERE e.account_manager_id = u.id AND e.deleted_at IS NULL)";

export const USER_FROM = `users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN access_groups g ON g.id = u.access_group_id
    LEFT JOIN business_companies bc ON bc.id = u.business_company_id
    LEFT JOIN users m ON m.id = u.manager_id
    LEFT JOIN users ub ON ub.id = u.updated_by_id`;
export const USER_SELECT = `u.*, ${fullName("u")} AS display_name, d.name AS department, g.name AS access_group,
    bc.name AS business_company, ${fullName("m")} AS manager, ub.username AS updated_by, ${expires("u")} AS password_expires_at,
    ${daysLeftSql("u")} AS password_days_left, ${stateSql} AS password_state, ${sessionsSql} AS active_sessions,
    ${liveEnterprisesSql} AS live_enterprises`;

export function mapUser(r: Record<string, unknown>): UserRow {
  return {
    id: Number(r.id),
    username: r.username as string,
    firstName: r.first_name as string,
    lastName: r.last_name as string,
    displayName: r.display_name as string,
    email: r.email as string,
    phone: str(r.phone),
    departmentId: Number(r.department_id),
    department: str(r.department),
    accessGroupId: num(r.access_group_id),
    accessGroup: str(r.access_group),
    businessCompanyId: num(r.business_company_id),
    businessCompany: str(r.business_company),
    managerId: num(r.manager_id),
    manager: str(r.manager),
    userType: r.user_type as UserRow["userType"],
    isAccountManager: r.is_account_manager as boolean,
    isTeamLead: r.is_team_lead as boolean,
    status: r.status as UserRow["status"],
    allowMultipleLogin: r.allow_multiple_login as boolean,
    otpMethod: r.otp_method as UserRow["otpMethod"],
    language: "en",
    address1: r.address1 as string,
    address2: str(r.address2),
    countryIso: String(r.country_iso).trim(),
    state: str(r.state),
    city: str(r.city),
    zip: str(r.zip),
    permissionOverrides: (r.permission_overrides as Record<string, string[]> | null) ?? {},
    tabOverrides: (r.tab_overrides as Record<string, boolean> | null) ?? {},
    passwordChangedAt: iso(r.password_changed_at)!,
    passwordExpiresAt: iso(r.password_expires_at)!,
    passwordDaysLeft: Number(r.password_days_left),
    passwordState: r.password_state as UserRow["passwordState"],
    mustChangePassword: r.must_change_password as boolean,
    tempPasswordExpiresAt: iso(r.temp_password_expires_at),
    totpEnabled: r.totp_enabled as boolean,
    lastLoginAt: iso(r.last_login_at),
    activeSessions: Number(r.active_sessions ?? 0),
    liveEnterprises: Number(r.live_enterprises ?? 0),
    updatedBy: str(r.updated_by),
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export const userList: ListDef<UserRow> = {
  fields: listFields.users,
  from: USER_FROM,
  baseWhere: "u.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "u.id" },
    username: { sql: "u.username" },
    displayName: { sql: fullName("u") },
    email: { sql: "u.email" },
    department: { sql: "d.name" },
    userType: { sql: "u.user_type" },
    accessGroup: { sql: "g.name" },
    status: { sql: "u.status" },
    passwordState: { sql: stateSql },
    passwordChangedAt: { sql: "u.password_changed_at" },
    passwordDaysLeft: { sql: daysLeftSql("u") },
    totpEnabled: { sql: "u.totp_enabled" },
    isAccountManager: { sql: "u.is_account_manager" },
    isTeamLead: { sql: "u.is_team_lead" },
    manager: { sql: fullName("m") },
    businessCompany: { sql: "bc.name" },
    lastLoginAt: { sql: "u.last_login_at" },
    activeSessions: { sql: sessionsSql },
    updatedBy: { sql: "ub.username" },
    archived: { sql: "(u.deleted_at IS NOT NULL)" },
  },
  search: ["username", "displayName", "email"],
  searchPrefix: true,
  idSql: "u.id",
  select: USER_SELECT,
  mapRow: mapUser,
};

// ---------------------------------------------------------------- departments

const deptUsersSql = "(SELECT count(*)::int FROM users x WHERE x.department_id = d.id AND x.deleted_at IS NULL)";
export const DEPARTMENT_FROM = `departments d LEFT JOIN users m ON m.id = d.manager_id LEFT JOIN users ub ON ub.id = d.updated_by_id`;
export const DEPARTMENT_SELECT = `d.*, ${fullName("m")} AS manager, ${deptUsersSql} AS user_count, ub.username AS updated_by`;
export const mapDepartment = (r: Record<string, unknown>): DepartmentRow => ({
  id: Number(r.id),
  name: r.name as string,
  status: r.status as DepartmentRow["status"],
  managerId: num(r.manager_id),
  manager: str(r.manager),
  description: str(r.description),
  userCount: Number(r.user_count ?? 0),
  updatedBy: str(r.updated_by),
  updatedAt: iso(r.updated_at)!,
  archivedAt: iso(r.deleted_at),
});
export const departmentList: ListDef<DepartmentRow> = {
  fields: listFields.departments,
  from: DEPARTMENT_FROM,
  baseWhere: "d.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "d.id" },
    name: { sql: "d.name" },
    manager: { sql: fullName("m") },
    userCount: { sql: deptUsersSql },
    status: { sql: "d.status" },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "d.updated_at" },
    archived: { sql: "(d.deleted_at IS NOT NULL)" },
  },
  search: ["name", "manager"],
  idSql: "d.id",
  select: DEPARTMENT_SELECT,
  mapRow: mapDepartment,
};

// ---------------------------------------------------------------- GUI access groups

const groupUsersSql = "(SELECT count(*)::int FROM users x WHERE x.access_group_id = g.id AND x.deleted_at IS NULL)";
const moduleCountSql = "(SELECT count(*)::int FROM jsonb_object_keys(g.permissions) k WHERE k <> '*')";
export const ACCESS_GROUP_FROM = "access_groups g LEFT JOIN users ub ON ub.id = g.updated_by_id";
export const ACCESS_GROUP_SELECT = `g.*, ${groupUsersSql} AS user_count, ${moduleCountSql} AS module_count,
  (g.permissions ? '*') AS full_access, ub.username AS updated_by`;
export const mapAccessGroup = (r: Record<string, unknown>): AccessGroupRow => ({
  id: Number(r.id),
  name: r.name as string,
  status: r.status as AccessGroupRow["status"],
  description: str(r.description),
  permissions: (r.permissions as Record<string, string[]>) ?? {},
  hiddenTabs: (r.hidden_tabs as string[] | null) ?? [],
  userCount: Number(r.user_count ?? 0),
  moduleCount: Number(r.module_count ?? 0),
  fullAccess: !!r.full_access,
  updatedBy: str(r.updated_by),
  updatedAt: iso(r.updated_at)!,
  archivedAt: iso(r.deleted_at),
});
export const accessGroupList: ListDef<AccessGroupRow> = {
  fields: listFields.access_groups,
  from: ACCESS_GROUP_FROM,
  baseWhere: "g.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "g.id" },
    name: { sql: "g.name" },
    description: { sql: "g.description" },
    moduleCount: { sql: moduleCountSql },
    fullAccess: { sql: "(g.permissions ? '*')" },
    userCount: { sql: groupUsersSql },
    status: { sql: "g.status" },
    updatedBy: { sql: "ub.username" },
    archived: { sql: "(g.deleted_at IS NOT NULL)" },
  },
  search: ["name", "description"],
  idSql: "g.id",
  select: ACCESS_GROUP_SELECT,
  mapRow: mapAccessGroup,
};

// ---------------------------------------------------------------- logged-in users

/** The mock has no sign-in yet: "this session" is the newest open session of the current user. */
/** The request's own session when signed in (backend step 9), else the user's newest open one. */
export const currentSessionSql = (userId: number) => {
  const sid = currentSessionId();
  return sid !== null
    ? String(Number(sid))
    : `(SELECT max(x.id) FROM user_sessions x WHERE x.user_id = ${Number(userId)} AND x.ended_at IS NULL)`;
};
export const SESSION_FROM = `user_sessions s
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN customer_portal_users p ON p.id = s.portal_user_id
    LEFT JOIN enterprises e ON e.id = p.enterprise_id`;
const sessionUser = "coalesce(u.username, p.username)";
const sessionName = `coalesce(${fullName("u")}, ${fullName("p")})`;
export const sessionSelect = (userId: number) => `s.*, host(s.ip) AS ip_text, ${sessionUser} AS username,
  ${sessionName} AS display_name, e.name AS enterprise, (s.id = ${currentSessionSql(userId)}) AS is_current`;
export const mapSession = (r: Record<string, unknown>): UserSessionRow => ({
  id: Number(r.id),
  userKind: r.user_kind as UserSessionRow["userKind"],
  userId: Number(r.user_id ?? r.portal_user_id),
  username: r.username as string,
  displayName: r.display_name as string,
  enterprise: str(r.enterprise),
  ip: r.ip_text as string,
  location: str(r.location),
  device: r.device as UserSessionRow["device"],
  os: r.os as string,
  browser: r.browser as string,
  loggedInAt: iso(r.logged_in_at)!,
  lastSeenAt: iso(r.last_seen_at)!,
  current: !!r.is_current,
});
export function sessionList(userId: number): ListDef<UserSessionRow> {
  return {
    fields: listFields.user_sessions,
    from: SESSION_FROM,
    baseWhere: "s.ended_at IS NULL",
    columns: {
      loggedInAt: { sql: "s.logged_in_at" },
      displayName: { sql: sessionName },
      username: { sql: sessionUser },
      userKind: { sql: "s.user_kind" },
      enterprise: { sql: "e.name" },
      ip: { sql: "host(s.ip)" },
      location: { sql: "s.location" },
      device: { sql: "s.device" },
      os: { sql: "s.os" },
      browser: { sql: "s.browser" },
      lastSeenAt: { sql: "s.last_seen_at" },
    },
    search: ["displayName", "username", "ip"],
    idSql: "s.id",
    select: sessionSelect(userId),
    mapRow: mapSession,
  };
}

// ---------------------------------------------------------------- audit trail

export const auditList: ListDef<AuditRow> = {
  fields: listFields.audit_log,
  from: "audit_log a LEFT JOIN users u ON u.id = a.user_id",
  columns: {
    id: { sql: "a.id" },
    ip: { sql: "host(a.ip)" },
    module: { sql: "a.module" },
    controller: { sql: "a.controller" },
    method: { sql: "a.method" },
    action: { sql: "a.action" },
    tableName: { sql: "a.table_name" },
    masterId: { sql: "a.master_id" },
    at: { sql: "a.at" },
    user: { sql: "u.username" },
    userId: { sql: "a.user_id" },
    status: { sql: "a.status" },
    durationMs: { sql: "a.duration_ms" },
  },
  search: ["user", "action", "controller", "masterId"],
  idSql: "a.id",
  select: "a.*, host(a.ip) AS ip_text, u.username",
  mapRow: (r) => ({
    id: Number(r.id),
    at: iso(r.at)!,
    userId: num(r.user_id),
    user: str(r.username),
    ip: str(r.ip_text),
    module: r.module as string,
    controller: r.controller as string,
    method: r.method as string,
    action: r.action as string,
    tableName: str(r.table_name),
    masterId: str(r.master_id),
    status: Number(r.status),
    durationMs: Number(r.duration_ms),
  }),
};

// ---------------------------------------------------------------- business companies

const bcEnterprisesSql =
  "(SELECT count(*)::int FROM enterprises e WHERE e.business_company_id = bc.id AND e.deleted_at IS NULL)";
const bcUsersSql = "(SELECT count(*)::int FROM users x WHERE x.business_company_id = bc.id AND x.deleted_at IS NULL)";
const bcMailboxesSql = "(SELECT count(*)::int FROM business_company_mailboxes mb WHERE mb.business_company_id = bc.id)";
export const BUSINESS_COMPANY_FROM = "business_companies bc LEFT JOIN users ub ON ub.id = bc.updated_by_id";
export const BUSINESS_COMPANY_SELECT = `bc.*, ${bcEnterprisesSql} AS enterprise_count, ${bcUsersSql} AS user_count,
  ${bcMailboxesSql} AS mailbox_count, ub.username AS updated_by`;
export const businessCompanyList: ListDef<BusinessCompanyRow> = {
  fields: listFields.business_companies,
  from: BUSINESS_COMPANY_FROM,
  baseWhere: "bc.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "bc.id" },
    name: { sql: "bc.name" },
    description: { sql: "bc.description" },
    baseCurrency: { sql: "bc.base_currency" },
    tpsLimit: { sql: "bc.tps_limit" },
    enterprises: { sql: bcEnterprisesSql },
    users: { sql: bcUsersSql },
    website: { sql: "bc.website" },
    mailboxCount: { sql: bcMailboxesSql },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "bc.updated_at" },
    archived: { sql: "(bc.deleted_at IS NOT NULL)" },
  },
  search: ["name", "description"],
  idSql: "bc.id",
  select: BUSINESS_COMPANY_SELECT,
  mapRow: (r) => ({
    id: Number(r.id),
    name: r.name as string,
    description: str(r.description),
    baseCurrency: String(r.base_currency).trim(),
    tpsLimit: num(r.tps_limit),
    website: str(r.website),
    enterprises: Number(r.enterprise_count ?? 0),
    users: Number(r.user_count ?? 0),
    mailboxCount: Number(r.mailbox_count ?? 0),
    updatedBy: str(r.updated_by),
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  }),
};

// ---------------------------------------------------------------- customer portal users

export const PORTAL_USER_FROM = `customer_portal_users p JOIN enterprises e ON e.id = p.enterprise_id
    LEFT JOIN users ub ON ub.id = p.updated_by_id`;
export const PORTAL_USER_SELECT = `p.*, e.name AS enterprise, ub.username AS updated_by, ${expires("p")} AS password_expires_at,
  ${daysLeftSql("p")} AS password_days_left`;
export const mapPortalUser = (r: Record<string, unknown>): PortalUserRow => ({
  id: Number(r.id),
  email: r.email as string,
  username: r.username as string,
  enterpriseId: Number(r.enterprise_id),
  enterprise: r.enterprise as string,
  firstName: r.first_name as string,
  lastName: r.last_name as string,
  status: r.status as PortalUserRow["status"],
  passwordChangedAt: iso(r.password_changed_at)!,
  passwordExpiresAt: iso(r.password_expires_at)!,
  passwordDaysLeft: Number(r.password_days_left),
  mustChangePassword: r.must_change_password as boolean,
  tempPasswordExpiresAt: iso(r.temp_password_expires_at),
  lastLoginAt: iso(r.last_login_at),
  otpMethod: (r.otp_method as PortalUserRow["otpMethod"]) ?? "email",
  updatedBy: str(r.updated_by),
  updatedAt: iso(r.updated_at)!,
  archivedAt: iso(r.deleted_at),
});
export const portalUserList: ListDef<PortalUserRow> = {
  fields: listFields.customer_portal_users,
  from: PORTAL_USER_FROM,
  baseWhere: "p.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "p.id" },
    email: { sql: "p.email" },
    username: { sql: "p.username" },
    enterprise: { sql: "e.name" },
    enterpriseId: { sql: "p.enterprise_id" },
    firstName: { sql: "p.first_name" },
    lastName: { sql: "p.last_name" },
    status: { sql: "p.status" },
    passwordDaysLeft: { sql: daysLeftSql("p") },
    lastLoginAt: { sql: "p.last_login_at" },
    archived: { sql: "(p.deleted_at IS NOT NULL)" },
  },
  search: ["email", "username", "enterprise", "firstName", "lastName"],
  idSql: "p.id",
  select: PORTAL_USER_SELECT,
  mapRow: mapPortalUser,
};

// ---------------------------------------------------------------- e-mail templates

/** Places that use a template: business company defaults, traffic alerts and SOA reports. */
export const templateUsesSql = `((SELECT count(*)::int FROM business_companies b, jsonb_each_text(b.default_templates) kv
      WHERE b.deleted_at IS NULL AND kv.value = t.id::text)
  + (SELECT count(*)::int FROM traffic_alerts ta WHERE ta.template_id = t.id AND ta.deleted_at IS NULL)
  + (SELECT count(*)::int FROM soa_reports sr WHERE sr.template_id = t.id))`;
export const EMAIL_TEMPLATE_FROM = `email_templates t LEFT JOIN business_companies bc ON bc.id = t.business_company_id
    LEFT JOIN users u ON u.id = t.updated_by_id`;
export const EMAIL_TEMPLATE_SELECT = `t.id, t.name, t.email_type, t.subject, t.business_company_id, bc.name AS business_company,
  u.username AS updated_by, t.updated_at, t.deleted_at, ${templateUsesSql} AS used_by`;
export const mapEmailTemplate = (r: Record<string, unknown>): EmailTemplateRow => ({
  id: Number(r.id),
  name: r.name as string,
  emailType: r.email_type as EmailTemplateRow["emailType"],
  subject: r.subject as string,
  businessCompanyId: num(r.business_company_id),
  businessCompany: str(r.business_company),
  usedBy: Number(r.used_by ?? 0),
  updatedBy: str(r.updated_by),
  updatedAt: iso(r.updated_at)!,
  archivedAt: iso(r.deleted_at),
});
export const emailTemplateList: ListDef<EmailTemplateRow> = {
  fields: listFields.email_templates,
  from: EMAIL_TEMPLATE_FROM,
  baseWhere: "t.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "t.id" },
    name: { sql: "t.name" },
    emailType: { sql: "t.email_type" },
    subject: { sql: "t.subject" },
    businessCompany: { sql: "bc.name" },
    businessCompanyId: { sql: "t.business_company_id" },
    updatedBy: { sql: "u.username" },
    updatedAt: { sql: "t.updated_at" },
    usedBy: { sql: templateUsesSql },
    archived: { sql: "(t.deleted_at IS NOT NULL)" },
  },
  search: ["name", "subject"],
  idSql: "t.id",
  select: EMAIL_TEMPLATE_SELECT,
  mapRow: mapEmailTemplate,
};
