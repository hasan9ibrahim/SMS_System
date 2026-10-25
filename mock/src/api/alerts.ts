// Alert rules and incidents (§13.6, §13.7). Rules: add, edit, clone, enable / disable, delete and test
// against live traffic; every save is one undoable change (§13.10). Incidents: list, export, the bell
// list, detail with notes, acknowledge and snooze. The engine (alerts/engine.ts) raises them.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  AlertRuleInput,
  AlertRuleRow,
  ArchiveRequest,
  CloneInput,
  IncidentAckInput,
  IncidentDetail,
  IncidentNoteInput,
  IncidentSnoozeInput,
} from "@sms/contract";
import { withDb } from "../db.js";
import { invalidateRules, NOTIFIES_ME_SQL, pushIncident, testRule } from "../alerts/engine.js";
import { conditionLabel } from "../alerts/evaluate.js";
import {
  ALERT_RULE_FROM,
  ALERT_RULE_SELECT,
  INCIDENT_FROM,
  INCIDENT_SELECT,
  incidentList,
  mapAlertRule,
  mapIncident,
} from "../lists/alertDefs.js";
import { liveSimulator } from "../live/socket.js";
import { sendProblem } from "../problem.js";
import { archiveGate } from "./enterprises.js";
import { exportList, notFound, setArchived } from "./masterData.js";
import { dependencies, recordChange, type DiffEntry, type FieldError } from "./records.js";
import { currentUserId, getCurrentUser } from "./session.js";
import { badInput } from "./switchTools.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------------------------------------------------------------- rules

const loadRule = async (c: Db, id: number) => {
  const { rows } = await c.query(`SELECT ${ALERT_RULE_SELECT} FROM ${ALERT_RULE_FROM} WHERE r.id = $1`, [id]);
  return rows[0] ? mapAlertRule(rows[0]) : null;
};

/** Form key -> the columns it is stored in (nested parts are flattened). */
const KEYS = [
  "name",
  "status",
  "description",
  "scope",
  "metric",
  "condition",
  "windowMinutes",
  "minSample",
  "activeHours",
  "severity",
  "notifyUserIds",
  "notifyDepartmentIds",
  "channels",
  "emailAddresses",
  "partnerContactType",
  "repeatMinutes",
  "cooldownMinutes",
  "recoveryNotice",
] as const;
type Key = (typeof KEYS)[number];

function columnsOf(key: Key, v: unknown): Record<string, unknown> {
  switch (key) {
    case "scope": {
      const s = v as AlertRuleInput["scope"];
      return { scope_kind: s.kind, scope_ids: s.ids, scope_values: s.values };
    }
    case "condition": {
      const c = v as AlertRuleInput["condition"];
      return { condition_type: c.type, condition_value: c.value, condition_baseline: c.baseline };
    }
    case "activeHours": {
      const h = v as AlertRuleInput["activeHours"];
      return { active_always: h.always, active_days: h.days, active_from_hour: h.fromHour, active_to_hour: h.toHour };
    }
    case "channels": {
      const ch = v as AlertRuleInput["channels"];
      return { channel_popup: ch.popup, channel_sound: ch.sound, channel_email: ch.email };
    }
    default:
      return { [key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)]: v };
  }
}

/** Writes one form field (also used by undo, §13.10). */
export async function applyAlertRuleField(c: pg.PoolClient, id: number, key: string, value: unknown) {
  if (
    !(KEYS as readonly string[]).includes(key) ||
    (value === null && ["scope", "condition", "activeHours", "channels"].includes(key))
  )
    return;
  const cols = columnsOf(key as Key, value);
  const names = Object.keys(cols);
  await c.query(
    `UPDATE alert_rules SET ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
    [id, ...names.map((n) => cols[n])],
  );
  invalidateRules();
}

function values(b: AlertRuleInput): AlertRuleInput {
  const c = b.condition;
  const needsValue = ["above", "below", "increase_pct", "decrease_pct"].includes(c.type);
  return {
    ...b,
    name: b.name.trim(),
    description: b.description?.trim() || null,
    scope: {
      kind: b.scope.kind,
      ids: ["customer", "customer_trunk", "vendor", "vendor_trunk", "product_category"].includes(b.scope.kind)
        ? b.scope.ids
        : [],
      values: ["country", "mccmnc", "sender_id"].includes(b.scope.kind)
        ? b.scope.values.map((v) => v.trim()).filter(Boolean)
        : [],
    },
    // Bind status pairs with "bind down" and nothing else.
    condition:
      b.metric === "bind_status" || c.type === "bind_down"
        ? { type: "bind_down", value: null, baseline: null }
        : {
            type: c.type,
            value: needsValue ? c.value : null,
            baseline: c.type === "increase_pct" || c.type === "decrease_pct" ? (c.baseline ?? "previous_window") : null,
          },
    metric: c.type === "bind_down" ? "bind_status" : b.metric,
    emailAddresses: [...new Set(b.emailAddresses.map((e) => e.trim().toLowerCase()))],
  };
}

async function check(c: Db, b: AlertRuleInput, id: number | null): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const t = b.condition.type;
  if (
    ["above", "below", "increase_pct", "decrease_pct"].includes(t) &&
    (b.condition.value === null || b.condition.value < 0)
  )
    errors.push({ path: "/condition/value", message: "enter a value (0 or more)" });
  if ((t === "increase_pct" || t === "decrease_pct") && (b.condition.value ?? 0) <= 0)
    errors.push({ path: "/condition/value", message: "a change of more than 0 %" });
  if ((t === "started" || t === "stopped") && !["attempts", "submitted", "delivered", "tps"].includes(b.metric))
    errors.push({ path: "/metric", message: "started / stopped sending is about volume or TPS" });
  if (["country", "mccmnc", "sender_id"].includes(b.scope.kind) && !b.scope.values.length)
    errors.push({ path: "/scope/values", message: "enter at least one value" });
  if (b.scope.kind === "product_category" && !b.scope.ids.length)
    errors.push({ path: "/scope/ids", message: "choose at least one category" });
  if (!b.activeHours.always) {
    if (!b.activeHours.days.length) errors.push({ path: "/activeHours/days", message: "choose at least one day" });
    if (b.activeHours.toHour <= b.activeHours.fromHour)
      errors.push({ path: "/activeHours/toHour", message: "after the start hour" });
  }
  if (!b.channels.popup && !b.channels.sound && !b.channels.email)
    errors.push({ path: "/channels", message: "choose at least one way to notify" });
  if (
    b.channels.email &&
    !b.emailAddresses.length &&
    !b.notifyUserIds.length &&
    !b.notifyDepartmentIds.length &&
    !b.partnerContactType
  )
    errors.push({
      path: "/emailAddresses",
      message: "e-mail needs a recipient: users, departments, addresses or the partner",
    });
  if (b.metric === "revenue" || b.metric === "margin" || b.metric === "margin_pct")
    if (b.scope.kind === "vendor" || b.scope.kind === "vendor_trunk")
      errors.push({ path: "/metric", message: "revenue and margin are measured on the customer side" });
  const { rows } = await c.query(
    "SELECT 1 FROM alert_rules WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> coalesce($2, 0)",
    [b.name, id],
  );
  if (rows[0]) errors.push({ path: "/name", message: "another alert rule has this name" });
  return errors;
}

async function insertRule(c: pg.PoolClient, b: AlertRuleInput, userId: number) {
  const cols = Object.assign({}, ...KEYS.map((k) => columnsOf(k, b[k]))) as Record<string, unknown>;
  const names = Object.keys(cols);
  const { rows } = await c.query(
    `INSERT INTO alert_rules (${names.join(", ")}, updated_by_id) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}, $${names.length + 1}) RETURNING id`,
    [...names.map((n) => cols[n]), userId],
  );
  return Number(rows[0].id);
}

export const getAlertRule = (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadRule(pool, id)) ?? notFound(reply, "Alert rule", id));
};

export function createAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const b = values(request.body as AlertRuleInput);
  return withDb(reply, async (pool) => {
    const errors = await check(pool, b, null);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const id = await insertRule(c, b, me.id);
      const change = await recordChange(c, {
        entityType: "alert_rule",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: b.name } }],
        note: `Added alert rule ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    invalidateRules();
    return reply.code(201).send({ record: await loadRule(pool, id), change });
  });
}

async function saveFields(
  request: FastifyRequest,
  pool: pg.Pool,
  id: number,
  before: AlertRuleRow,
  b: AlertRuleInput,
  note: string,
) {
  const diff: DiffEntry[] = KEYS.filter((k) => !same(before[k], b[k])).map((k) => ({
    entity_id: id,
    field: k,
    before: before[k] ?? null,
    after: b[k] ?? null,
  }));
  if (!diff.length) return null;
  const me = await getCurrentUser();
  const change = await inTransaction(pool, async (c) => {
    for (const d of diff) await applyAlertRuleField(c, id, d.field, d.after);
    await c.query("UPDATE alert_rules SET updated_by_id = $2 WHERE id = $1", [id, me.id]);
    return recordChange(c, {
      entityType: "alert_rule",
      entityIds: [id],
      changeType: "edit",
      diff,
      note,
      userId: me.id,
      ip: request.ip,
    });
  });
  invalidateRules();
  return change;
}

const inputOf = (r: AlertRuleRow): AlertRuleInput => Object.fromEntries(KEYS.map((k) => [k, r[k]])) as AlertRuleInput;

export function updateAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = values(request.body as AlertRuleInput);
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Alert rule", id);
    if (before.archivedAt) return sendProblem(reply, 409, "This alert rule is deleted; restore it first");
    const errors = await check(pool, b, id);
    if (errors.length) return badInput(reply, errors);
    const change = await saveFields(request, pool, id, before, b, `Changed alert rule ${b.name}`);
    return { record: await loadRule(pool, id), change };
  });
}

export function setAlertRuleStatus(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { status } = request.body as { status: "active" | "inactive" };
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Alert rule", id);
    const change = await saveFields(
      request,
      pool,
      id,
      before,
      { ...inputOf(before), status },
      `${status === "active" ? "Enabled" : "Disabled"} alert rule ${before.name}`,
    );
    return { record: await loadRule(pool, id), change };
  });
}

export function cloneAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { name } = request.body as CloneInput;
  return withDb(reply, async (pool) => {
    const src = await loadRule(pool, id);
    if (!src) return notFound(reply, "Alert rule", id);
    const b = { ...inputOf(src), name: name.trim() };
    const errors = await check(pool, b, null);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { newId, change } = await inTransaction(pool, async (c) => {
      const newId = await insertRule(c, b, me.id);
      const change = await recordChange(c, {
        entityType: "alert_rule",
        entityIds: [newId],
        changeType: "create",
        diff: [{ entity_id: newId, field: "*", before: null, after: { name: b.name } }],
        note: `Cloned alert rule ${src.name} as ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { newId, change };
    });
    invalidateRules();
    return reply.code(201).send({ record: await loadRule(pool, newId), change });
  });
}

export function archiveAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = (request.body ?? {}) as ArchiveRequest;
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Alert rule", id);
    if (before.archivedAt) return { record: before, change: null };
    // Incidents keep their rule; open ones recover on the engine's next round.
    const gate = await archiveGate(
      reply,
      body,
      dependencies([
        {
          key: "open_incidents",
          label: "Open incidents (they close)",
          count: before.openIncidents,
          blocking: false,
          detail: null,
        },
      ]),
    );
    if (!gate.ok) return gate.reply;
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE alert_rules SET deleted_at = now() WHERE id = $1", [id]);
      return recordChange(c, {
        entityType: "alert_rule",
        entityIds: [id],
        changeType: "delete",
        diff: [{ entity_id: id, field: "archived", before: false, after: true }],
        note: [`Deleted alert rule ${before.name}`, gate.note].filter(Boolean).join(" – "),
        userId: me.id,
        ip: request.ip,
      });
    });
    invalidateRules();
    return { record: await loadRule(pool, id), change };
  });
}

export function restoreAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadRule(pool, id);
    if (!before) return notFound(reply, "Alert rule", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This alert rule is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "alert_rules",
      entityType: "alert_rule",
      archive: false,
      note: null,
      restoreClash: async (c) => {
        const { rows } = await c.query(
          "SELECT 1 FROM alert_rules WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> $2",
          [before.name, id],
        );
        return rows[0] ? "Another live alert rule has this name" : null;
      },
    });
    if ("reply" in r) return r.reply;
    invalidateRules();
    return { record: await loadRule(pool, id), change: r.change };
  });
}

export function testAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const b = values(request.body as AlertRuleInput);
  return withDb(reply, async (pool) => testRule(b, await liveSimulator(), pool));
}

// ---------------------------------------------------------------- incidents

async function loadDetail(c: Db, id: number): Promise<IncidentDetail | null> {
  const { rows } = await c.query(
    `SELECT ${INCIDENT_SELECT}, r.metric AS r_metric, r.condition_type, r.condition_value, r.condition_baseline, r.window_minutes, r.min_sample
       FROM ${INCIDENT_FROM} WHERE i.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const { rows: notes } = await c.query(
    "SELECT n.id, n.text, n.inserted_at, u.username FROM incident_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.incident_id = $1 ORDER BY n.id",
    [id],
  );
  return {
    ...mapIncident(r),
    windowMinutes: Number(r.window_minutes),
    conditionLabel: conditionLabel({
      metric: r.r_metric,
      condition: {
        type: r.condition_type,
        value: r.condition_value == null ? null : Number(r.condition_value),
        baseline: r.condition_baseline,
      },
      windowMinutes: Number(r.window_minutes) as 1,
      minSample: Number(r.min_sample),
    }),
    notes: notes.map((n) => ({
      id: Number(n.id),
      text: n.text as string,
      user: (n.username as string | null) ?? null,
      at: (n.inserted_at as Date).toISOString(),
    })),
  };
}

export const getIncident = (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadDetail(pool, id)) ?? notFound(reply, "Incident", id));
};

export function listOpenIncidents(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    const where = `i.state <> 'recovered' AND ${NOTIFIES_ME_SQL(currentUserId())}`;
    const { rows } = await pool.query(
      `SELECT ${INCIDENT_SELECT} FROM ${INCIDENT_FROM} WHERE ${where} ORDER BY i.started_at DESC LIMIT 50`,
    );
    const { rows: n } = await pool.query(`SELECT count(*)::int AS n FROM ${INCIDENT_FROM} WHERE ${where}`);
    return { incidents: rows.map(mapIncident), open: Number(n[0].n) };
  });
}

export function acknowledgeIncident(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = (request.body ?? {}) as IncidentAckInput;
  return withDb(reply, async (pool) => {
    const inc = await loadDetail(pool, id);
    if (!inc) return notFound(reply, "Incident", id);
    if (inc.state === "recovered") return sendProblem(reply, 409, "This incident has recovered already");
    const me = await getCurrentUser();
    await inTransaction(pool, async (c) => {
      if (inc.state === "open")
        await c.query(
          "UPDATE incidents SET state = 'acknowledged', acknowledged_by_id = $2, acknowledged_at = now() WHERE id = $1",
          [id, me.id],
        );
      if (b.note?.trim())
        await c.query("INSERT INTO incident_notes (incident_id, user_id, text) VALUES ($1, $2, $3)", [
          id,
          me.id,
          b.note.trim(),
        ]);
    });
    await pushIncident(pool, id);
    return loadDetail(pool, id);
  });
}

export function snoozeIncident(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as IncidentSnoozeInput;
  return withDb(reply, async (pool) => {
    const inc = await loadDetail(pool, id);
    if (!inc) return notFound(reply, "Incident", id);
    if (inc.state === "recovered") return sendProblem(reply, 409, "This incident has recovered already");
    const now = new Date();
    const until =
      b.for === "15m"
        ? new Date(now.getTime() + 15 * 60_000)
        : b.for === "1h"
          ? new Date(now.getTime() + 3_600_000)
          : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 7));
    await pool.query("UPDATE incidents SET snoozed_until = $2 WHERE id = $1", [id, until]);
    await pushIncident(pool, id);
    return loadDetail(pool, id);
  });
}

export function addIncidentNote(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as IncidentNoteInput;
  return withDb(reply, async (pool) => {
    if (!(await loadDetail(pool, id))) return notFound(reply, "Incident", id);
    if (!b.text.trim()) return badInput(reply, [{ path: "/text", message: "write a note" }]);
    const me = await getCurrentUser();
    await pool.query("INSERT INTO incident_notes (incident_id, user_id, text) VALUES ($1, $2, $3)", [
      id,
      me.id,
      b.text.trim(),
    ]);
    return reply.code(201).send(await loadDetail(pool, id));
  });
}

export const exportIncidents = (request: FastifyRequest, reply: FastifyReply) =>
  exportList(
    request,
    reply,
    "incidents",
    incidentList,
    [
      ["incident", (r) => r.id],
      ["started_at", (r) => r.startedAt],
      ["ended_at", (r) => r.endedAt],
      ["duration_s", (r) => r.durationSeconds],
      ["severity", (r) => r.severity],
      ["state", (r) => r.state],
      ["rule", (r) => r.ruleName],
      ["scope", (r) => r.entityName],
      ["metric", (r) => r.metric],
      ["message", (r) => r.message],
      ["current", (r) => r.currentValue],
      ["baseline", (r) => r.baselineValue],
      ["peak", (r) => r.peakValue],
      ["acknowledged_by", (r) => r.acknowledgedBy],
      ["acknowledged_at", (r) => r.acknowledgedAt],
      ["notes", (r) => r.notesCount],
    ],
    "incidents.csv",
  );
