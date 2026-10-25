// Switch utilities (§8): Email Logs, Notification (Send Rate, Send Tech Info, View Rate), Firewall
// (banned / trusted IPs and filters), Traffic Alert (checked against the EDR store), SMS To Voice and
// Broadcast. Saves are undoable changes (§13.10); delete archives (§13.29); every e-mail the
// platform sends is logged (emailLog.ts).
import { appendText, fillBody, fillText } from "../email/html.js";
import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  BroadcastAudienceInput,
  BroadcastInput,
  FirewallCheckInput,
  FirewallFilterInput,
  FirewallRuleInput,
  NotificationPreviewInput,
  NotificationTrunksInput,
  SendRateInput,
  SmsVoiceRuleInput,
  SmsVoiceTestInput,
  TrafficAlertCheck,
  TrafficAlertInput,
  TrafficAlertValues,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { chRows } from "../edr.js";
import {
  BROADCAST_FROM,
  BROADCAST_SELECT,
  EMAIL_LOG_FROM,
  EMAIL_LOG_SELECT,
  emailLogList,
  FIREWALL_FILTER_FROM,
  FIREWALL_FILTER_SELECT,
  FIREWALL_RULE_FROM,
  FIREWALL_RULE_SELECT,
  mapBroadcast,
  mapEmailLog,
  mapFirewallFilter,
  mapFirewallRule,
  mapSmsVoiceRule,
  mapTrafficAlert,
  SMS_VOICE_FROM,
  SMS_VOICE_SELECT,
  TRAFFIC_ALERT_FROM,
  TRAFFIC_ALERT_SELECT,
} from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { spreadsheetXml } from "../billing/files.js";
import { edrCoverage } from "../billing/edrFigures.js";
import { companyDetails, companyMailbox, companyPlaceholders, companyTemplate, logEmail } from "./emailLog.js";
import { exportList, notFound, setArchived } from "./masterData.js";
import { recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { mccmncLookup } from "./translationRules.js";
import { inTransaction } from "./views.js";
import { production } from "../mode.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };

export const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });
const ymd = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);

async function one<T>(
  c: Db,
  select: string,
  from: string,
  idSql: string,
  id: number,
  map: (r: Record<string, unknown>) => T,
) {
  const { rows } = await c.query(`SELECT ${select} FROM ${from} WHERE ${idSql} = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/** The template a partner's e-mail uses: its business company's default, else a shared one (§11). */
async function templateFor(c: Db, enterpriseId: number, type: string) {
  return companyTemplate(c, { enterpriseId }, type);
}
/** The sending business company's placeholders ({company}, {bank_details}, …) for a partner (§11). */
async function companyVarsOf(c: Db, enterpriseId: number) {
  return companyPlaceholders(await companyDetails(c, { enterpriseId }));
}
export const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

export async function contactEmails(c: Db, enterpriseId: number, types: string[]): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT emails FROM enterprise_contacts WHERE enterprise_id = $1 AND contact_type = ANY($2)
      ORDER BY array_position($2::text[], contact_type)`,
    [enterpriseId, types],
  );
  return [...new Set(rows.flatMap((r) => (r.emails as string[]) ?? []))];
}

// ---------------------------------------------------------------- email logs

export function getEmailLog(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `SELECT ${EMAIL_LOG_SELECT}, l.body, l.sender, l.body_html, l.inline_images FROM ${EMAIL_LOG_FROM} WHERE l.id = $1`,
      [id],
    );
    if (!rows[0]) return notFound(reply, "E-mail log", id);
    return {
      ...mapEmailLog(rows[0]),
      body: rows[0].body ?? "",
      sender: rows[0].sender ?? null,
      bodyHtml: rows[0].body_html ?? null,
      inlineImages: rows[0].inline_images ?? [],
    };
  });
}

export const exportEmailLogs = (request: FastifyRequest, reply: FastifyReply) =>
  exportList(
    request,
    reply,
    "email_logs",
    emailLogList,
    [
      ["info_id", (r) => r.id],
      ["enterprise", (r) => r.enterprise],
      ["customer_trunk", (r) => r.customerTrunk],
      ["vendor_trunk", (r) => r.vendorTrunk],
      ["email_type", (r) => r.emailType],
      ["status", (r) => r.status],
      ["rate_date", (r) => r.rateDate],
      ["file", (r) => r.file],
      ["error", (r) => r.error],
      ["to", (r) => r.to.join(" ")],
      ["cc", (r) => r.cc.join(" ")],
      ["subject", (r) => r.subject],
      ["updated_by", (r) => r.updatedBy],
      ["updated_at", (r) => r.updatedAt],
    ],
    "email_logs.csv",
  );

// ---------------------------------------------------------------- notifications

interface TrunkInfo {
  id: number;
  name: string;
  enterpriseId: number;
  enterprise: string;
  company: string;
  host: string | null;
  port: number;
  username: string;
  bindType: string;
  password: string;
  ips: string[];
  tps: number;
  connections: number;
  rateTableId: number | null;
  currency: string | null;
}

async function trunkInfo(c: Db, id: number): Promise<TrunkInfo | null> {
  const { rows } = await c.query(
    `SELECT t.id, t.name, t.enterprise_id, e.name AS enterprise, bc.name AS company, bc.smpp_host, t.port, t.username,
            t.bind_type, array(SELECT host(x) FROM unnest(t.host_ips) x) AS ips, t.tps, t.max_connections, t.password,
            (SELECT rt.id FROM customer_trunk_rate_tables x JOIN rate_tables rt ON rt.id = x.rate_table_id
              WHERE x.customer_trunk_id = t.id ORDER BY x.position LIMIT 1) AS rate_table_id,
            (SELECT rt.currency FROM customer_trunk_rate_tables x JOIN rate_tables rt ON rt.id = x.rate_table_id
              WHERE x.customer_trunk_id = t.id ORDER BY x.position LIMIT 1) AS currency
       FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
       JOIN business_companies bc ON bc.id = e.business_company_id
      WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    name: r.name,
    enterpriseId: Number(r.enterprise_id),
    enterprise: r.enterprise,
    company: r.company,
    host: r.smpp_host,
    port: Number(r.port),
    username: r.username,
    bindType: r.bind_type,
    password: r.password ?? "",
    ips: r.ips ?? [],
    tps: Number(r.tps),
    connections: Number(r.max_connections),
    rateTableId: r.rate_table_id === null ? null : Number(r.rate_table_id),
    currency: r.currency ? String(r.currency).trim() : null,
  };
}

/** Current and scheduled lines of the trunk's rate table (blocked lines left out). */
async function rateSheet(c: Db, t: TrunkInfo) {
  const { rows } = await c.query(
    `SELECT co.name AS country, m.network, l.mccmnc, l.dial_code, l.rate, l.currency, l.valid_from, l.change_type
       FROM rate_lines l JOIN mccmnc m ON m.id = l.mccmnc_id LEFT JOIN countries co ON co.id = m.country_id
      WHERE l.rate_table_id = $1 AND l.sender_id IS NULL AND NOT l.is_blocked
        AND (l.valid_to IS NULL OR l.valid_to > now())
      ORDER BY co.name, m.network NULLS FIRST, l.mccmnc, l.valid_from`,
    [t.rateTableId],
  );
  return rows.map((r) => ({
    country: (r.country as string) ?? "",
    network: (r.network as string) ?? "All networks",
    mccmnc: r.mccmnc as string,
    dialCode: (r.dial_code as string) ?? "",
    rate: Number(r.rate),
    currency: String(r.currency).trim(),
    effective: ymd(r.valid_from),
    change: (r.valid_from as Date).getTime() > Date.now() ? `scheduled ${r.change_type}` : r.change_type,
  }));
}

export function sheetFile(t: TrunkInfo, lines: Awaited<ReturnType<typeof rateSheet>>, fileType: "excel" | "csv") {
  const head = ["Country", "Network", "MCCMNC", "Dial Code", "Rate", "Currency", "Effective Date", "Change"];
  const name = `Rates_${t.name.replace(/\W+/g, "_")}_${today()}.${fileType === "csv" ? "csv" : "xls"}`;
  if (fileType === "csv") {
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      head,
      ...lines.map((l) => [l.country, l.network, l.mccmnc, l.dialCode, l.rate, l.currency, l.effective, l.change]),
    ]
      .map((r) => r.map(cell).join(","))
      .join("\n");
    return { name, type: "text/csv", body: Buffer.from(`${csv}\n`, "utf8") };
  }
  const body = spreadsheetXml(`Rates ${t.name}`, [
    { cells: [t.company], bold: true },
    { cells: [`Rate sheet for ${t.name} (${t.enterprise})`, `Issued ${today()}`] },
    { cells: [] },
    { cells: head, bold: true },
    ...lines.map((l) => ({
      cells: [l.country, l.network, l.mccmnc, l.dialCode, l.rate, l.currency, l.effective, l.change],
    })),
  ]);
  return { name, type: "application/vnd.ms-excel", body };
}

export function downloadRateSheet(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const fileType = ((request.query as { fileType?: string }).fileType ?? "excel") as "excel" | "csv";
  return withDb(reply, async (pool) => {
    const t = await trunkInfo(pool, id);
    if (!t) return notFound(reply, "Customer trunk", id);
    if (!t.rateTableId) return sendProblem(reply, 409, `${t.name} has no rate table`);
    const f = sheetFile(t, await rateSheet(pool, t), fileType);
    return reply.type(f.type).header("content-disposition", `attachment; filename="${f.name}"`).send(f.body);
  });
}

async function rateMail(c: Db, t: TrunkInfo) {
  const tpl = await templateFor(c, t.enterpriseId, "customer_rate");
  const vars = {
    ...(await companyVarsOf(c, t.enterpriseId)),
    enterprise: t.enterprise,
    trunk: t.name,
    company: t.company,
    rate_date: today(),
  };
  return {
    to: await contactEmails(c, t.enterpriseId, ["rates", "commercial"]).then((x) => x.slice(0, 3)),
    subject: fillText(tpl?.subject ?? "Rate update for {trunk}", vars),
    body: fillBody(tpl?.body ?? "", vars),
  };
}

/** One trunk's connection details as a text block (the {trunks} placeholder, team trial round 3). */
const techBlock = (t: TrunkInfo) =>
  [
    t.name,
    `  SMPP host:    ${t.host ?? "—"}`,
    `  SMPP port:    ${t.port}`,
    `  System ID:    ${t.username}`,
    `  Password:     ${t.password || "—"}`,
    `  Bind type:    ${t.bindType}`,
    `  Allowed IPs:  ${t.ips.join(", ") || "—"}`,
    `  TPS:          ${t.tps}`,
    `  Connections:  ${t.connections}`,
  ].join("\n");

/**
 * The Customer Tech Info e-mail for one trunk, or for several trunks of one enterprise in one e-mail (`trunks` =
 * all of them; the first gives the single-trunk placeholders).
 */
async function techMail(c: Db, t: TrunkInfo, trunks: TrunkInfo[] = [t]) {
  const tpl = await templateFor(c, t.enterpriseId, "customer_tech_info");
  const many = trunks.length > 1;
  const vars = {
    ...(await companyVarsOf(c, t.enterpriseId)),
    enterprise: t.enterprise,
    trunk: many ? trunks.map((x) => x.name).join(", ") : t.name,
    company: t.company,
    host: t.host ?? "—",
    port: String(t.port),
    system_id: t.username,
    bind_type: t.bindType,
    ips: t.ips.join(", ") || "—",
    tps: String(t.tps),
    connections: String(t.connections),
    // The SMPP password goes in the e-mail in plain text (decided 2026-10-18, team trial round 1).
    password: t.password || "—",
    trunks: trunks.map(techBlock).join("\n\n"),
  };
  const template = tpl?.body ?? "";
  const body = fillBody(template, vars);
  return {
    to: await contactEmails(c, t.enterpriseId, ["technical", "commercial"]).then((x) => x.slice(0, 3)),
    subject: fillText(
      many
        ? (tpl?.subject ?? "Connection details for {trunk}").replace("{trunk}", "your trunks")
        : (tpl?.subject ?? "Connection details for {trunk}"),
      vars,
    ),
    // A template without {trunks} still lists every trunk when several go in one e-mail.
    body: many && !template.includes("{trunks}") ? appendText(body, vars.trunks) : body,
  };
}

export function previewNotification(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as NotificationPreviewInput;
  return withDb(reply, async (pool) => {
    const t = await trunkInfo(pool, b.trunkId);
    if (!t) return notFound(reply, "Customer trunk", b.trunkId);
    const m = b.kind === "send_rate" ? await rateMail(pool, t) : await techMail(pool, t);
    return { recipients: m.to, subject: m.subject, body: m.body };
  });
}

export function sendRateNotifications(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SendRateInput;
  if (!b.trunkIds?.length && !b.rateTableIds?.length)
    return badInput(reply, [{ path: "/trunkIds", message: "choose customer trunks or rate tables" }]);
  return withDb(reply, async (pool) => emailRateSheets(pool, b, (await getCurrentUser()).id));
}

/**
 * E-mails the current rate sheet to customer trunks, or to every live customer trunk using the given rate tables
 * (Rate Manager and market move auto-apply, team trial round 4, §8, §13.14). One e-mail per trunk.
 */
export async function emailRateSheets(pool: pg.Pool | pg.PoolClient, b: SendRateInput, userId: number | null) {
  let sent = 0;
  const sentTrunks: { trunkId: number; trunk: string; enterprise: string; to: string }[] = [];
  const failed: { trunkId: number; trunk: string; enterprise: string | null; reason: string }[] = [];
  const skippedTables: { rateTableId: number; rateTable: string; reason: string }[] = [];
  // Rate tables (Rate Manager, team trial round 4): every live customer trunk using one of them.
  const ids = new Set(b.trunkIds ?? []);
  if (b.rateTableIds?.length) {
    const { rows } = await pool.query(
      `SELECT rt.id, rt.name, rt.kind, array_remove(array_agg(t.id ORDER BY t.id), NULL) AS trunks
           FROM rate_tables rt
           LEFT JOIN customer_trunk_rate_tables x ON x.rate_table_id = rt.id
           LEFT JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
          WHERE rt.id = ANY($1::bigint[]) AND rt.deleted_at IS NULL
          GROUP BY rt.id`,
      [b.rateTableIds],
    );
    const found = new Map(rows.map((r) => [Number(r.id), r]));
    for (const id of new Set(b.rateTableIds)) {
      const r = found.get(id);
      if (!r) skippedTables.push({ rateTableId: id, rateTable: `#${id}`, reason: "not found" });
      else if (r.kind !== "customer")
        skippedTables.push({ rateTableId: id, rateTable: r.name, reason: "a vendor table; rate sheets go to clients" });
      else if (!(r.trunks as number[]).length)
        skippedTables.push({ rateTableId: id, rateTable: r.name, reason: "no live customer trunk uses it" });
      else for (const t of r.trunks as number[]) ids.add(Number(t));
    }
  }
  for (const id of ids) {
    const t = await trunkInfo(pool, id);
    if (!t) {
      failed.push({ trunkId: id, trunk: `#${id}`, enterprise: null, reason: "not found" });
      continue;
    }
    if (!t.rateTableId) {
      failed.push({ trunkId: id, trunk: t.name, enterprise: t.enterprise, reason: "no rate table" });
      continue;
    }
    if (!b.sendEmail) continue;
    const m = await rateMail(pool, t);
    const lines = await rateSheet(pool, t);
    const sheet = sheetFile(t, lines, b.fileType);
    const status = await logEmail(pool, {
      type: "send_rate",
      enterpriseId: t.enterpriseId,
      customerTrunkId: t.id,
      to: m.to,
      sender: await companyMailbox(pool, t.enterpriseId, "rateSheet"),
      subject: m.subject,
      body: appendText(m.body, `(${lines.length} rate lines attached)`),
      file: sheet.name,
      attachments: [{ fileName: sheet.name, contentType: sheet.type, content: sheet.body }],
      rateDate: today(),
      userId,
    });
    if (status === "sent") {
      sent++;
      sentTrunks.push({ trunkId: t.id, trunk: t.name, enterprise: t.enterprise, to: m.to.join(", ") });
    } else
      failed.push({ trunkId: id, trunk: t.name, enterprise: t.enterprise, reason: "no Rates or Commercial contact" });
  }
  return { sent, sentTrunks, failed, skippedTables };
}

export function sendTechInfoNotifications(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as NotificationTrunksInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    let sent = 0;
    const failed: { trunkId: number; trunk: string; reason: string }[] = [];
    const found: TrunkInfo[] = [];
    for (const id of [...new Set(b.trunkIds)]) {
      const t = await trunkInfo(pool, id);
      if (t) found.push(t);
      else failed.push({ trunkId: id, trunk: `#${id}`, reason: "not found" });
    }
    // One e-mail per trunk, or per enterprise with all its trunks (team trial round 3).
    const byEnterprise = new Map<number, TrunkInfo[]>();
    for (const t of found) byEnterprise.set(t.enterpriseId, [...(byEnterprise.get(t.enterpriseId) ?? []), t]);
    const groups = b.oneEmailPerEnterprise ? [...byEnterprise.values()] : found.map((t) => [t]);
    for (const group of groups) {
      const t = group[0]!;
      const m = await techMail(pool, t, group);
      const status = await logEmail(pool, {
        type: "send_tech_info",
        enterpriseId: t.enterpriseId,
        customerTrunkId: group.length === 1 ? t.id : null,
        to: m.to,
        sender: await companyMailbox(pool, t.enterpriseId, "techInfo"),
        subject: m.subject,
        body: m.body,
        userId: me.id,
      });
      if (status === "sent") sent += group.length;
      else
        for (const x of group)
          failed.push({ trunkId: x.id, trunk: x.name, reason: "no Technical or Commercial contact" });
    }
    return { sent, failed };
  });
}

// ---------------------------------------------------------------- firewall

/** Normalises an address or CIDR range; null when it is not one. */
async function normaliseIp(c: Db, ip: string): Promise<{ value: string } | { error: string }> {
  const raw = ip.trim();
  const [addr, len] = raw.split("/");
  const v = isIP(addr ?? "");
  if (!v) return { error: "not an IPv4 or IPv6 address" };
  if (len !== undefined && (!/^\d+$/.test(len) || Number(len) > (v === 4 ? 32 : 128)))
    return { error: `prefix length must be 0–${v === 4 ? 32 : 128}` };
  try {
    const { rows } = await c.query(
      "SELECT CASE WHEN masklen($1::cidr) = (CASE family($1::cidr) WHEN 4 THEN 32 ELSE 128 END) THEN host($1::cidr) ELSE text($1::cidr) END AS v",
      [raw],
    );
    return { value: rows[0].v as string };
  } catch {
    return { error: "host bits are set: use the network address of the range" };
  }
}

const loadRule = (c: Db, id: number) => one(c, FIREWALL_RULE_SELECT, FIREWALL_RULE_FROM, "fr.id", id, mapFirewallRule);
const loadFilter = (c: Db, id: number) =>
  one(c, FIREWALL_FILTER_SELECT, FIREWALL_FILTER_FROM, "ff.id", id, mapFirewallFilter);

export function createFirewallRule(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as FirewallRuleInput;
  return withDb(reply, async (pool) => {
    const ip = await normaliseIp(pool, b.ip);
    if ("error" in ip) return badInput(reply, [{ path: "/ip", message: ip.error }]);
    const filter = await loadFilter(pool, b.filterId);
    if (!filter) return badInput(reply, [{ path: "/filterId", message: "filter not found" }]);
    const { rows: clash } = await pool.query(
      "SELECT list FROM firewall_rules WHERE ip = $1::cidr AND filter_id = $2 AND deleted_at IS NULL",
      [ip.value, b.filterId],
    );
    if (clash[0])
      return sendProblem(
        reply,
        409,
        clash[0].list === b.list
          ? `${ip.value} is already ${b.list} for ${filter.name}`
          : `${ip.value} is ${clash[0].list} for ${filter.name}; remove it there first`,
      );
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO firewall_rules (list, ip, filter_id, source, reason, created_by_id) VALUES ($1, $2::cidr, $3, 'manual', $4, $5)
         RETURNING id`,
        [b.list, ip.value, b.filterId, b.reason?.trim() || null, me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "firewall_rule",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { ip: ip.value, list: b.list } }],
        note: `${b.list === "banned" ? "Banned" : "Trusted"} ${ip.value} (${filter.name})`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadRule(pool, id), change });
  });
}

export function archiveFirewallRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Firewall IP", id);
    if (before.archivedAt) return { record: before, change: null };
    const r = await setArchived(request, reply, pool, {
      table: "firewall_rules",
      entityType: "firewall_rule",
      archive: true,
      note: `Removed ${before.list} ${before.ip} (${before.filter})${
        ((request.body ?? {}) as ArchiveRequest).reason ? `: ${(request.body as ArchiveRequest).reason}` : ""
      }`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadRule(pool, id), change: r.change };
  });
}

export function restoreFirewallRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Firewall IP", id);
    if (!before.archivedAt) return sendProblem(reply, 409, "This IP is not removed");
    // Removing and putting back a firewall IP is an everyday NOC action, not admin-only.
    const clash = await pool.query(
      "SELECT list FROM firewall_rules WHERE ip = $1::cidr AND filter_id = $2 AND deleted_at IS NULL",
      [before.ip, before.filterId],
    );
    if (clash.rows[0])
      return sendProblem(reply, 409, `${before.ip} is ${clash.rows[0].list} again for ${before.filter}`);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE firewall_rules SET deleted_at = NULL, updated_at = now() WHERE id = $1", [id]);
      return recordChange(c, {
        entityType: "firewall_rule",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "archived", before: true, after: false }],
        note: `Restored ${before.list} ${before.ip}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadRule(pool, id), change };
  });
}

const FILTER_FIELDS: [keyof FirewallFilterInput, string][] = [
  ["name", "name"],
  ["listener", "listener"],
  ["status", "status"],
  ["failedAttempts", "failed_attempts"],
  ["windowSeconds", "window_seconds"],
  ["banMinutes", "ban_minutes"],
];

async function filterNameTaken(c: Db, name: string, exceptId: number) {
  const { rows } = await c.query(
    "SELECT 1 FROM firewall_filters WHERE lower(name) = lower($1) AND id <> $2 AND deleted_at IS NULL",
    [name, exceptId],
  );
  return !!rows[0];
}

export function createFirewallFilter(request: FastifyRequest, reply: FastifyReply) {
  const b = { ...(request.body as FirewallFilterInput) };
  b.name = b.name.trim();
  return withDb(reply, async (pool) => {
    if (await filterNameTaken(pool, b.name, 0)) return sendProblem(reply, 409, `A filter named ${b.name} exists`);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO firewall_filters (${FILTER_FIELDS.map(([, col]) => col).join(", ")}, updated_by_id)
         VALUES (${FILTER_FIELDS.map((_, i) => `$${i + 1}`).join(", ")}, $${FILTER_FIELDS.length + 1}) RETURNING id`,
        [...FILTER_FIELDS.map(([k]) => b[k]), me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "firewall_filter",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: b.name } }],
        note: `Added firewall filter ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadFilter(pool, id), change });
  });
}

export function updateFirewallFilter(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = { ...(request.body as FirewallFilterInput) };
  b.name = b.name.trim();
  return withDb(reply, async (pool) => {
    const before = await loadFilter(pool, id);
    if (!before) return notFound(reply, "Firewall filter", id);
    if (await filterNameTaken(pool, b.name, id)) return sendProblem(reply, 409, `A filter named ${b.name} exists`);
    const diff: DiffEntry[] = FILTER_FIELDS.filter(([k]) => before[k] !== b[k]).map(([k]) => ({
      entity_id: id,
      field: k,
      before: before[k],
      after: b[k],
    }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE firewall_filters SET ${FILTER_FIELDS.map(([, col], i) => `${col} = $${i + 2}`).join(", ")},
                updated_by_id = $${FILTER_FIELDS.length + 2}, updated_at = now() WHERE id = $1`,
        [id, ...FILTER_FIELDS.map(([k]) => b[k]), me.id],
      );
      return recordChange(c, {
        entityType: "firewall_filter",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed firewall filter ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadFilter(pool, id), change };
  });
}

export function checkFirewallIp(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as FirewallCheckInput;
  const ip = b.ip.trim();
  if (!isIP(ip)) return badInput(reply, [{ path: "/ip", message: "an IPv4 or IPv6 address" }]);
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `SELECT ${FIREWALL_RULE_SELECT} FROM ${FIREWALL_RULE_FROM}
        WHERE $1::inet <<= fr.ip AND fr.deleted_at IS NULL AND ff.status = 'active'
          AND (fr.expires_at IS NULL OR fr.expires_at > now())
        ORDER BY fr.list = 'trusted' DESC, masklen(fr.ip) DESC`,
      [ip],
    );
    const rules = rows.map(mapFirewallRule);
    return { ip, decision: rules[0]?.list ?? "allowed", rules };
  });
}

// ---------------------------------------------------------------- traffic alerts

const ALERT_FIELDS: [keyof TrafficAlertInput, string][] = [
  ["name", "name"],
  ["sampleCount", "sample_count"],
  ["sampleMinutes", "sample_minutes"],
  ["asrThreshold", "asr_threshold"],
  ["dlrThreshold", "dlr_threshold"],
  ["marginThreshold", "margin_threshold"],
  ["customerTrunkId", "customer_trunk_id"],
  ["vendorTrunkId", "vendor_trunk_id"],
  ["senderId", "sender_id"],
  ["mccmnc", "mccmnc"],
  ["delayThreshold", "delay_threshold"],
  ["notificationEmails", "notification_emails"],
  ["contactEmail", "contact_email"],
  ["templateId", "template_id"],
  ["status", "status"],
];
const loadAlert = (c: Db, id: number) => one(c, TRAFFIC_ALERT_SELECT, TRAFFIC_ALERT_FROM, "ta.id", id, mapTrafficAlert);
export const getTrafficAlert = (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadAlert(pool, id)) ?? notFound(reply, "Traffic alert", id));
};

async function checkAlertInput(c: Db, b: TrafficAlertInput): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const { rows: ct } = await c.query("SELECT 1 FROM customer_trunks WHERE id = $1 AND deleted_at IS NULL", [
    b.customerTrunkId,
  ]);
  if (!ct[0]) errors.push({ path: "/customerTrunkId", message: "customer trunk not found" });
  if (b.vendorTrunkId !== null) {
    const { rows } = await c.query("SELECT 1 FROM vendor_trunks WHERE id = $1 AND deleted_at IS NULL", [
      b.vendorTrunkId,
    ]);
    if (!rows[0]) errors.push({ path: "/vendorTrunkId", message: "vendor trunk not found" });
  }
  const { rows: tp } = await c.query("SELECT email_type FROM email_templates WHERE id = $1 AND deleted_at IS NULL", [
    b.templateId,
  ]);
  if (tp[0]?.email_type !== "traffic_alert")
    errors.push({ path: "/templateId", message: "choose a Traffic Alert template" });
  if (!b.notificationEmails.length && b.contactEmail === "none")
    errors.push({ path: "/notificationEmails", message: "add an e-mail or an enterprise contact to notify" });
  return errors;
}

const alertValues = (b: TrafficAlertInput) => ({ ...b, name: b.name.trim(), senderId: b.senderId?.trim() || null });

export function createTrafficAlert(request: FastifyRequest, reply: FastifyReply) {
  const b = alertValues(request.body as TrafficAlertInput);
  return withDb(reply, async (pool) => {
    const errors = await checkAlertInput(pool, b);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const id = await insertAlert(c, b, me.id);
      const change = await recordChange(c, {
        entityType: "traffic_alert",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: b.name } }],
        note: `Added traffic alert ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadAlert(pool, id), change });
  });
}

async function insertAlert(c: Db, b: TrafficAlertInput, userId: number) {
  const { rows } = await c.query(
    `INSERT INTO traffic_alerts (${ALERT_FIELDS.map(([, col]) => col).join(", ")}, updated_by_id)
     VALUES (${ALERT_FIELDS.map((_, i) => `$${i + 1}`).join(", ")}, $${ALERT_FIELDS.length + 1}) RETURNING id`,
    [...ALERT_FIELDS.map(([k]) => b[k]), userId],
  );
  return Number(rows[0].id);
}

export function updateTrafficAlert(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = alertValues(request.body as TrafficAlertInput);
  return withDb(reply, async (pool) => {
    const before = await loadAlert(pool, id);
    if (!before) return notFound(reply, "Traffic alert", id);
    if (before.archivedAt) return sendProblem(reply, 400, "Restore the alert before changing it");
    const errors = await checkAlertInput(pool, b);
    if (errors.length) return badInput(reply, errors);
    const diff: DiffEntry[] = ALERT_FIELDS.filter(
      ([k]) => JSON.stringify(before[k] ?? null) !== JSON.stringify(b[k] ?? null),
    ).map(([k]) => ({ entity_id: id, field: k, before: before[k] ?? null, after: b[k] ?? null }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE traffic_alerts SET ${ALERT_FIELDS.map(([, col], i) => `${col} = $${i + 2}`).join(", ")},
                updated_by_id = $${ALERT_FIELDS.length + 2}, updated_at = now() WHERE id = $1`,
        [id, ...ALERT_FIELDS.map(([k]) => b[k]), me.id],
      );
      return recordChange(c, {
        entityType: "traffic_alert",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed traffic alert ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadAlert(pool, id), change };
  });
}

export function cloneTrafficAlert(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadAlert(pool, id);
    if (!before) return notFound(reply, "Traffic alert", id);
    const me = await getCurrentUser();
    const input = Object.fromEntries(ALERT_FIELDS.map(([k]) => [k, before[k]])) as unknown as TrafficAlertInput;
    const copy = { ...input, name: `${before.name} (copy)`.slice(0, 80), status: "inactive" as const };
    const { newId, change } = await inTransaction(pool, async (c) => {
      const newId = await insertAlert(c, copy, me.id);
      const change = await recordChange(c, {
        entityType: "traffic_alert",
        entityIds: [newId],
        changeType: "clone",
        diff: [{ entity_id: newId, field: "*", before: null, after: { name: copy.name, from: id } }],
        note: `Cloned traffic alert ${before.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { newId, change };
    });
    return reply.code(201).send({ record: await loadAlert(pool, newId), change });
  });
}

/** Measures one alert's last sample interval (ending now; on the fake data at its latest EDR) and records the result. */
export async function runAlertCheck(c: Db, id: number): Promise<TrafficAlertCheck | null> {
  const a = await loadAlert(c, id);
  if (!a) return null;
  // Production (backend step 11): a quiet trunk reads as no traffic, not as its last traffic.
  const cov = production ? null : await edrCoverage();
  const end = cov?.to && cov.to.getTime() < Date.now() ? cov.to : new Date();
  const start = new Date(end.getTime() - a.sampleMinutes * 60_000);
  const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const where = [
    `c_trunk_id = ${Number(a.customerTrunkId)}`,
    `submit_time >= parseDateTime64BestEffort(${lit(start.toISOString())}, 3)`,
    `submit_time < parseDateTime64BestEffort(${lit(end.toISOString())}, 3)`,
    a.vendorTrunkId ? `v_trunk_id = ${Number(a.vendorTrunkId)}` : null,
    a.senderId ? `src_addr = ${lit(a.senderId)}` : null,
    a.mccmnc ? `c_mccmnc = ${lit(a.mccmnc)}` : null,
  ].filter(Boolean);
  const rows = await chRows<{ n: string; ok: string; dlv: string; rev: number; cost: number; delay: number | null }>(
    `SELECT countIf(kind = 'attempt') AS n, countIf(is_submit_success = 1) AS ok, countIf(msg_status = 'DELIVRD') AS dlv,
            toFloat64(sum(revenue_sys)) AS rev, toFloat64(sum(cost_sys)) AS cost,
            avgIf(delivery_delay_ms, msg_status = 'DELIVRD') / 1000 AS delay
       FROM edr_all WHERE ${where.join(" AND ")}`,
    15_000,
  );
  const r = rows?.[0];
  const round = (v: number) => Math.round(v * 100) / 100;
  const values: TrafficAlertValues = r
    ? {
        messages: Number(r.n),
        asr: Number(r.n) ? round((Number(r.ok) / Number(r.n)) * 100) : null,
        dlr: Number(r.ok) ? round((Number(r.dlv) / Number(r.ok)) * 100) : null,
        marginPct: r.rev > 0 ? round(((r.rev - r.cost) / r.rev) * 100) : null,
        delaySeconds: r.delay === null || Number.isNaN(Number(r.delay)) ? null : round(Number(r.delay)),
      }
    : { messages: 0, asr: null, dlr: null, marginPct: null, delaySeconds: null };
  const breaches: string[] = [];
  let state: TrafficAlertCheck["state"];
  if (!r) state = "unknown";
  else if (values.messages < a.sampleCount) state = "too_few";
  else {
    if (values.asr !== null && values.asr <= a.asrThreshold) breaches.push(`ASR ${values.asr} % ≤ ${a.asrThreshold} %`);
    if (values.dlr !== null && values.dlr <= a.dlrThreshold) breaches.push(`DLR ${values.dlr} % ≤ ${a.dlrThreshold} %`);
    if (values.marginPct !== null && values.marginPct <= a.marginThreshold)
      breaches.push(`Margin ${values.marginPct} % ≤ ${a.marginThreshold} %`);
    if (a.delayThreshold !== null && values.delaySeconds !== null && values.delaySeconds >= a.delayThreshold)
      breaches.push(`Delivery delay ${values.delaySeconds} s ≥ ${a.delayThreshold} s`);
    state = breaches.length ? "firing" : "ok";
  }
  let emailed: string[] = [];
  const starts = state === "firing" && a.state !== "firing";
  if (starts) {
    const { rows: ent } = await c.query(
      `SELECT e.id, bc.name AS company FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
         JOIN business_companies bc ON bc.id = e.business_company_id WHERE t.id = $1`,
      [a.customerTrunkId],
    );
    const enterpriseId = Number(ent[0].id);
    emailed = [
      ...a.notificationEmails,
      ...(a.contactEmail === "none" ? [] : await contactEmails(c, enterpriseId, [a.contactEmail])),
    ];
    const { rows: tp } = await c.query("SELECT subject, body FROM email_templates WHERE id = $1", [a.templateId]);
    const vars = {
      ...(await companyVarsOf(c, enterpriseId)),
      alert: a.name,
      trunk: a.customerTrunk,
      enterprise: a.enterprise,
      company: ent[0].company,
      breaches: breaches.join("\n"),
      interval: String(a.sampleMinutes),
    };
    await logEmail(c, {
      type: "traffic_alert",
      enterpriseId,
      customerTrunkId: a.customerTrunkId,
      vendorTrunkId: a.vendorTrunkId,
      to: emailed,
      sender: await companyMailbox(c, enterpriseId, "trafficAlert"),
      subject: fillText(tp[0]?.subject ?? "Traffic alert: {alert}", vars),
      body: fillBody(tp[0]?.body ?? "{breaches}", vars),
    });
  }
  await c.query(
    `UPDATE traffic_alerts SET state = $2, last_values = $3, last_checked_at = now(),
            last_triggered_at = CASE WHEN $4 THEN now() ELSE last_triggered_at END WHERE id = $1`,
    [id, state, JSON.stringify(values), starts],
  );
  return { state, from: start.toISOString(), to: end.toISOString(), values, breaches, emailed };
}

export function checkTrafficAlert(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadAlert(pool, id))) return notFound(reply, "Traffic alert", id);
    const r = await runAlertCheck(pool, id);
    if (r?.state === "unknown") return sendProblem(reply, 503, "The EDR store is not reachable");
    return r;
  });
}

/** Checks every active alert every five minutes (the backend runs this in the alert service). */
export function startTrafficAlertChecks() {
  const tick = async () => {
    try {
      const { rows } = await db().query("SELECT id FROM traffic_alerts WHERE status = 'active' AND deleted_at IS NULL");
      for (const r of rows) await runAlertCheck(db(), Number(r.id));
    } catch {
      // The database or EDR store may be down; the next tick tries again.
    }
  };
  setTimeout(() => void tick(), 20_000).unref();
  setInterval(() => void tick(), 5 * 60_000).unref();
}

// ---------------------------------------------------------------- shared archive / restore

export function archiver(
  table: string,
  entityType: string,
  label: string,
  load: (c: Db, id: number) => Promise<{ archivedAt: string | null; name?: string } | null>,
) {
  return {
    archive: (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as Params;
      return withDb(reply, async (pool) => {
        const before = await load(pool, id);
        if (!before) return notFound(reply, label, id);
        if (before.archivedAt) return { record: before, change: null };
        const r = await setArchived(request, reply, pool, {
          table,
          entityType,
          archive: true,
          note: `Deleted ${label.toLowerCase()} ${before.name ?? id}`,
        });
        if ("reply" in r) return r.reply;
        return { record: await load(pool, id), change: r.change };
      });
    },
    restore: (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as Params;
      return withDb(reply, async (pool) => {
        const before = await load(pool, id);
        if (!before) return notFound(reply, label, id);
        if (!before.archivedAt) return sendProblem(reply, 400, `This ${label.toLowerCase()} is not deleted`);
        const r = await setArchived(request, reply, pool, { table, entityType, archive: false, note: null });
        if ("reply" in r) return r.reply;
        return { record: await load(pool, id), change: r.change };
      });
    },
  };
}

const alertArchiver = archiver("traffic_alerts", "traffic_alert", "Traffic alert", loadAlert);
export const archiveTrafficAlert = alertArchiver.archive;
export const restoreTrafficAlert = alertArchiver.restore;

// ---------------------------------------------------------------- sms to voice

const VOICE_FIELDS: [keyof SmsVoiceRuleInput, string][] = [
  ["senderId", "sender_id"],
  ["receiverId", "receiver_id"],
  ["prefix", "prefix"],
  ["repeat", "repeat_count"],
  ["mccmnc", "mccmnc"],
  ["status", "status"],
];
const loadVoice = (c: Db, id: number) => one(c, SMS_VOICE_SELECT, SMS_VOICE_FROM, "sv.id", id, mapSmsVoiceRule);
export const getSmsVoiceRule = (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadVoice(pool, id)) ?? notFound(reply, "SMS to voice rule", id));
};
const voiceValues = (b: SmsVoiceRuleInput) => ({
  ...b,
  senderId: b.senderId?.trim() || null,
  receiverId: b.receiverId?.trim() || null,
  prefix: b.prefix?.trim() || null,
});

async function checkVoice(c: Db, b: SmsVoiceRuleInput): Promise<FieldError[]> {
  if (!b.senderId && !b.receiverId && !b.prefix && !b.mccmnc)
    return [{ path: "/prefix", message: "set at least one of sender, receiver, prefix or destination" }];
  if (b.mccmnc) {
    const { rows } = await c.query("SELECT 1 FROM mccmnc WHERE mccmnc = $1 AND deleted_at IS NULL", [b.mccmnc]);
    if (!rows[0]) return [{ path: "/mccmnc", message: "unknown MCCMNC" }];
  }
  return [];
}

export function createSmsVoiceRule(request: FastifyRequest, reply: FastifyReply) {
  const b = voiceValues(request.body as SmsVoiceRuleInput);
  return withDb(reply, async (pool) => {
    const errors = await checkVoice(pool, b);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO sms_voice_rules (${VOICE_FIELDS.map(([, col]) => col).join(", ")}, updated_by_id)
         VALUES (${VOICE_FIELDS.map((_, i) => `$${i + 1}`).join(", ")}, $${VOICE_FIELDS.length + 1}) RETURNING id`,
        [...VOICE_FIELDS.map(([k]) => b[k]), me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "sms_voice_rule",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { prefix: b.prefix } }],
        note: `Added SMS to voice rule ${id}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadVoice(pool, id), change });
  });
}

export function updateSmsVoiceRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = voiceValues(request.body as SmsVoiceRuleInput);
  return withDb(reply, async (pool) => {
    const before = await loadVoice(pool, id);
    if (!before) return notFound(reply, "SMS to voice rule", id);
    const errors = await checkVoice(pool, b);
    if (errors.length) return badInput(reply, errors);
    const diff: DiffEntry[] = VOICE_FIELDS.filter(([k]) => (before[k] ?? null) !== (b[k] ?? null)).map(([k]) => ({
      entity_id: id,
      field: k,
      before: before[k] ?? null,
      after: b[k] ?? null,
    }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE sms_voice_rules SET ${VOICE_FIELDS.map(([, col], i) => `${col} = $${i + 2}`).join(", ")},
                updated_by_id = $${VOICE_FIELDS.length + 2}, updated_at = now() WHERE id = $1`,
        [id, ...VOICE_FIELDS.map(([k]) => b[k]), me.id],
      );
      return recordChange(c, {
        entityType: "sms_voice_rule",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed SMS to voice rule ${id}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadVoice(pool, id), change };
  });
}

const voiceArchiver = archiver("sms_voice_rules", "sms_voice_rule", "SMS to voice rule", loadVoice);
export const archiveSmsVoiceRule = voiceArchiver.archive;
export const restoreSmsVoiceRule = voiceArchiver.restore;

/** % = any characters, _ = one character, case-insensitive (§13.25 wildcards). */
export function likeMatch(pattern: string, value: string): boolean {
  const re = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${re}$`, "i").test(value);
}

/** What the call reads: digits spaced out so a code is read one digit at a time, repeated. */
export function spokenText(text: string, repeat: number): string {
  const once = text.replace(/\d+/g, (d) => d.split("").join(" "));
  return Array.from({ length: repeat }, () => once).join(" … ");
}

export function testSmsVoiceRules(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SmsVoiceTestInput;
  return withDb(reply, async (pool) => {
    const receiver = b.receiver.replace(/^\+/, "");
    const lookup = await mccmncLookup(pool);
    const code = lookup(receiver);
    const { rows } = await pool.query(
      `SELECT ${SMS_VOICE_SELECT} FROM ${SMS_VOICE_FROM} WHERE sv.deleted_at IS NULL AND sv.status = 'active' ORDER BY sv.id`,
    );
    for (const r of rows.map(mapSmsVoiceRule)) {
      if (r.senderId && !likeMatch(r.senderId, b.senderId)) continue;
      if (r.receiverId && !likeMatch(r.receiverId, receiver)) continue;
      if (r.prefix && !receiver.startsWith(r.prefix)) continue;
      if (r.mccmnc && r.mccmnc !== code) continue;
      return {
        matched: true,
        rule: r,
        mccmnc: code,
        spoken: spokenText(b.text, r.repeat),
        reason: `Rule ${r.id} matches: the SMS becomes a voice call`,
      };
    }
    return { matched: false, rule: null, mccmnc: code, spoken: null, reason: "No active rule matches: sent as SMS" };
  });
}

// ---------------------------------------------------------------- broadcast

async function audience(c: Db, b: BroadcastAudienceInput) {
  const { rows } = await c.query(
    `SELECT e.id, e.name,
            array(SELECT DISTINCT x FROM enterprise_contacts ec, unnest(ec.emails) x
                   WHERE ec.enterprise_id = e.id AND ec.contact_type = ANY($3)) AS emails
       FROM enterprises e
      WHERE e.deleted_at IS NULL AND e.status = 'active' AND e.business_company_id = $1 AND e.type = ANY($2)
      ORDER BY e.name`,
    [b.businessCompanyId, b.enterpriseTypes, b.contactTypes],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name as string, emails: (r.emails as string[]) ?? [] }));
}

export function previewBroadcast(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as BroadcastAudienceInput;
  return withDb(reply, async (pool) => {
    const list = await audience(pool, b);
    return {
      enterprises: list.length,
      addresses: list.reduce((t, e) => t + e.emails.length, 0),
      sample: list.slice(0, 8).map((e) => e.name),
    };
  });
}

/** Drops scripts, event handlers and javascript: links from the rich text. */
export function sanitiseHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed)[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

const textOf = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();

export function sendBroadcast(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as BroadcastInput;
  return withDb(reply, async (pool) => {
    const { rows: bc } = await pool.query("SELECT name FROM business_companies WHERE id = $1", [b.businessCompanyId]);
    if (!bc[0]) return badInput(reply, [{ path: "/businessCompanyId", message: "business company not found" }]);
    const { rows: mb } = await pool.query(
      "SELECT 1 FROM business_company_mailboxes WHERE business_company_id = $1 AND smtp_email = $2",
      [b.businessCompanyId, b.sender],
    );
    if (!mb[0])
      return badInput(reply, [{ path: "/sender", message: "choose one of the business company's mailboxes" }]);
    if (b.attachment && (b.attachment.contentBase64.length * 3) / 4 > 5 * 1024 * 1024)
      return badInput(reply, [{ path: "/attachment", message: "at most 5 MB" }]);
    const html = sanitiseHtml(b.bodyHtml);
    if (!textOf(html)) return badInput(reply, [{ path: "/bodyHtml", message: "the e-mail is empty" }]);
    const list = await audience(pool, b);
    if (!list.length) return badInput(reply, [{ path: "/enterpriseTypes", message: "nobody to send to" }]);
    const me = await getCurrentUser();
    const id = await inTransaction(pool, async (c) => {
      let failed = 0;
      for (const e of list) {
        const status = await logEmail(c, {
          type: "broadcast",
          enterpriseId: e.id,
          to: e.emails,
          sender: b.sender,
          subject: b.subject.trim(),
          body: html,
          file: b.attachment?.name ?? null,
          attachments: b.attachment
            ? [{ fileName: b.attachment.name, content: Buffer.from(b.attachment.contentBase64, "base64") }]
            : [],
          userId: me.id,
        });
        if (status === "failed") failed++;
      }
      const { rows } = await c.query(
        `INSERT INTO broadcasts (business_company_id, sender, subject, body_html, contact_types, enterprise_types, enterprises,
                                 addresses, failed, attachment_name, sent_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          b.businessCompanyId,
          b.sender,
          b.subject.trim(),
          html,
          b.contactTypes,
          b.enterpriseTypes,
          list.length,
          list.reduce((t, e) => t + e.emails.length, 0),
          failed,
          b.attachment?.name ?? null,
          me.id,
        ],
      );
      return Number(rows[0].id);
    });
    const r = await one(pool, BROADCAST_SELECT, BROADCAST_FROM, "b.id", id, mapBroadcast);
    return reply.code(201).send(r);
  });
}
