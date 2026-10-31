// Voice gateways (§8 SMS To Voice, decided 2026-10-31, docs/SMS_TO_VOICE.md): the operator's own voice switches that
// the SMS-to-voice calls go to over SIP, placed by the local Asterisk. The password is write-only and stored encrypted
// like a mailbox's SMTP password (§13.22). Every save is one undoable change (§13.10); delete archives and is refused
// while a rule names the gateway (§13.29). Lives on the SMS To Voice page's access (contract/access.json).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { isIP } from "node:net";
import type { ArchiveRequest, VoiceGatewayInput, VoiceGatewayRow } from "@sms/contract";
import { encryptSecret } from "../admin/passwords.js";
import { withDb } from "../db.js";
import { mapVoiceGateway, VOICE_GATEWAY_FROM, VOICE_GATEWAY_SELECT } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { archiveGate } from "./enterprises.js";
import { notFound, setArchived } from "./masterData.js";
import { dependencies, recordChange, same, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };
type GatewayFields = Omit<VoiceGatewayInput, "password">;

const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

/** Form field → column; every one of them is undoable (the password is not, §13.22). */
const COLUMNS: [keyof GatewayFields, string][] = [
  ["name", "name"],
  ["host", "host"],
  ["port", "port"],
  ["transport", "transport"],
  ["username", "username"],
  ["fromDomain", "from_domain"],
  ["callerIdMode", "caller_id_mode"],
  ["fixedCallerId", "fixed_caller_id"],
  ["dialPrefix", "dial_prefix"],
  ["codecs", "codecs"],
  ["maxCalls", "max_calls"],
  ["ringTimeoutS", "ring_timeout_s"],
  ["retryDelayS", "retry_delay_s"],
  ["priority", "priority"],
  ["status", "status"],
];

export async function loadVoiceGateway(c: Db, id: number): Promise<VoiceGatewayRow | null> {
  const { rows } = await c.query(`SELECT ${VOICE_GATEWAY_SELECT} FROM ${VOICE_GATEWAY_FROM} WHERE vg.id = $1`, [id]);
  return rows[0] ? mapVoiceGateway(rows[0]) : null;
}

export function getVoiceGateway(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadVoiceGateway(pool, id)) ?? notFound(reply, "Voice gateway", id));
}

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Trimmed text, empty as null; codecs once each in the order given. */
function gatewayValues(b: VoiceGatewayInput): GatewayFields {
  const text = (v: string | null) => v?.trim() || null;
  return {
    name: b.name.trim(),
    host: b.host.trim().toLowerCase(),
    port: b.port,
    transport: b.transport,
    username: text(b.username),
    fromDomain: text(b.fromDomain)?.toLowerCase() ?? null,
    callerIdMode: b.callerIdMode,
    fixedCallerId: text(b.fixedCallerId),
    dialPrefix: b.dialPrefix.trim(),
    codecs: [...new Set(b.codecs)],
    maxCalls: b.maxCalls,
    ringTimeoutS: b.ringTimeoutS,
    retryDelayS: b.retryDelayS,
    priority: b.priority,
    status: b.status,
  };
}

/** Field errors, or a conflict text when another gateway has the name. */
async function checkGateway(c: Db, v: GatewayFields, exceptId: number): Promise<FieldError[] | string> {
  const errors: FieldError[] = [];
  if (!v.name) errors.push({ path: "/name", message: "required" });
  if (!(HOST.test(v.host) || isIP(v.host.replace(/^\[|\]$/g, ""))))
    errors.push({ path: "/host", message: "a host name or an IP address" });
  if (v.fromDomain && !HOST.test(v.fromDomain)) errors.push({ path: "/fromDomain", message: "a domain name" });
  if (v.callerIdMode === "fixed" && !v.fixedCallerId)
    errors.push({ path: "/fixedCallerId", message: "required when the caller ID is always the fixed one" });
  if (errors.length) return errors;
  const { rows } = await c.query("SELECT deleted_at FROM voice_gateways WHERE lower(name) = lower($1) AND id <> $2", [
    v.name,
    exceptId,
  ]);
  if (rows[0])
    return `A voice gateway named "${v.name}" exists${rows[0].deleted_at ? " (deleted; restore it instead)" : ""}`;
  return [];
}

export function createVoiceGateway(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as VoiceGatewayInput;
  return withDb(reply, async (pool) => {
    const v = gatewayValues(b);
    const check = await checkGateway(pool, v, 0);
    if (typeof check === "string") return sendProblem(reply, 409, check);
    if (check.length) return badInput(reply, check);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const cols = COLUMNS.map(([, col]) => col);
      const { rows } = await c.query(
        `INSERT INTO voice_gateways (${cols.join(", ")}, password_enc, updated_by_id)
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, $${cols.length + 1}, $${cols.length + 2}) RETURNING id`,
        [...COLUMNS.map(([k]) => v[k]), b.password ? encryptSecret(b.password) : null, me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "voice_gateway",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: v.name }],
        note: `Added voice gateway ${v.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadVoiceGateway(pool, id), change });
  });
}

export function updateVoiceGateway(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as VoiceGatewayInput;
  return withDb(reply, async (pool) => {
    const before = await loadVoiceGateway(pool, id);
    if (!before) return notFound(reply, "Voice gateway", id);
    if (before.archivedAt) return sendProblem(reply, 400, "This gateway is deleted; restore it before editing");
    const v = gatewayValues(b);
    const diff: DiffEntry[] = COLUMNS.filter(([k]) => !same(before[k] ?? null, v[k] ?? null)).map(([k]) => ({
      entity_id: id,
      field: k as string,
      before: before[k] ?? null,
      after: v[k] ?? null,
    }));
    // The password is never kept in the change log (§13.22): logged as changed, not undone.
    const passwordChanged = b.password !== null && !(b.password === "" && !before.passwordSet);
    if (passwordChanged)
      diff.push({
        entity_id: id,
        field: "password",
        before: before.passwordSet ? "(hidden)" : null,
        after: b.password ? "(hidden)" : null,
      });
    if (!diff.length) return { record: before, change: null };
    const check = await checkGateway(pool, v, id);
    if (typeof check === "string") return sendProblem(reply, 409, check);
    // The stored password goes to the gateway's host: it does not follow the gateway to another host unless it is
    // typed again (as the HLR provider and SMTP checks, round 13 security review).
    if (!passwordChanged && before.passwordSet && before.host !== v.host)
      check.push({ path: "/password", message: "enter the password again: the gateway moved to another host" });
    if (check.length) return badInput(reply, check);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) await applyVoiceGatewayField(c, id, d.field, d.after, me.id);
      if (passwordChanged)
        await c.query(
          "UPDATE voice_gateways SET password_enc = $2, updated_by_id = $3, updated_at = now() WHERE id = $1",
          [id, b.password ? encryptSecret(b.password) : null, me.id],
        );
      return recordChange(c, {
        entityType: "voice_gateway",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed voice gateway ${v.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadVoiceGateway(pool, id), change };
  });
}

/** Puts one field back (undo, §13.10); the password is never put back. */
export async function applyVoiceGatewayField(
  c: pg.PoolClient,
  id: number,
  field: string,
  value: unknown,
  userId: number,
) {
  const col = COLUMNS.find(([k]) => k === field)?.[1];
  if (!col) return;
  await c.query(`UPDATE voice_gateways SET ${col} = $2, updated_by_id = $3, updated_at = now() WHERE id = $1`, [
    id,
    value,
    userId,
  ]);
}

/** Live rules naming the gateway block its delete, for administrators too (a rule must always reach a gateway). */
export async function voiceGatewayDependencies(c: Db, id: number) {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n, string_agg(id::text, ', ' ORDER BY id) FILTER (WHERE rn <= 10) AS ids
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM sms_voice_rules
              WHERE gateway_id = $1 AND deleted_at IS NULL) x`,
    [id],
  );
  const n = Number(rows[0]?.n ?? 0);
  return dependencies([
    {
      key: "sms_voice_rules",
      label: "SMS to voice rules using it",
      count: n,
      blocking: true,
      noOverride: true,
      detail: n ? `rule${n === 1 ? "" : "s"} ${rows[0].ids}${n > 10 ? ", …" : ""}` : null,
    },
  ]);
}

export function getVoiceGatewayDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadVoiceGateway(pool, id))) return notFound(reply, "Voice gateway", id);
    return voiceGatewayDependencies(pool, id);
  });
}

export function archiveVoiceGateway(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadVoiceGateway(pool, id);
    if (!before) return notFound(reply, "Voice gateway", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(
      reply,
      (request.body ?? {}) as ArchiveRequest,
      await voiceGatewayDependencies(pool, id),
    );
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "voice_gateways",
      entityType: "voice_gateway",
      archive: true,
      note: gate.note ?? `Deleted voice gateway ${before.name}`,
    });
    if ("reply" in r) return r.reply;
    await touchArchived(pool, "voice_gateways", id);
    return { record: await loadVoiceGateway(pool, id), change: r.change };
  });
}

export function restoreVoiceGateway(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadVoiceGateway(pool, id);
    if (!before) return notFound(reply, "Voice gateway", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This gateway is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "voice_gateways",
      entityType: "voice_gateway",
      archive: false,
      note: null,
      restoreClash: async (db) => {
        const { rows } = await db.query(
          "SELECT 1 FROM voice_gateways WHERE lower(name) = lower($1) AND id <> $2 AND deleted_at IS NULL",
          [before.name, id],
        );
        return rows[0] ? `A live voice gateway is named "${before.name}"; rename it first` : null;
      },
    });
    if ("reply" in r) return r.reply;
    await touchArchived(pool, "voice_gateways", id);
    return { record: await loadVoiceGateway(pool, id), change: r.change };
  });
}

/**
 * Moves updated_at after an archive or restore, so the switch's configuration fingerprint (row count and latest
 * updated_at) sees it: migration 099's trigger covers only the tables it names, not the SMS-to-voice ones.
 */
export async function touchArchived(c: Db, table: "voice_gateways" | "sms_voice_rules", id: number) {
  await c.query(`UPDATE ${table} SET updated_at = clock_timestamp() WHERE id = $1`, [id]);
}
