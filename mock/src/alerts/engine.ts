// Alert engine (§13.6, §13.7): every 15 seconds the active rules are evaluated on the live traffic
// simulator, whether or not anyone has a page open. A rule that holds opens an incident (pop-up,
// sound and e-mail to the people it notifies), re-alerts at its repeat interval, keeps the peak, and
// recovers when the metric is back (OK notice), followed by the rule's cooldown. Warning e-mails go out
// in a 15-minute digest, Info in the daily summary at 07:00 UTC, Critical at once. State lives in
// PostgreSQL, so acknowledgements and snoozes from the API take effect on the next round.
import type pg from "pg";
import type { AlertRuleRow, IncidentEvent, IncidentRow } from "@sms/contract";
import { PLATFORM_CURRENCY } from "../currency.js";
import { db } from "../db.js";
import {
  ALERT_RULE_FROM,
  ALERT_RULE_SELECT,
  INCIDENT_FROM,
  INCIDENT_SELECT,
  mapAlertRule,
  mapIncident,
} from "../lists/alertDefs.js";
import { BASE_DELAY, type Simulator } from "../live/simulator.js";
import { companyMailbox, logEmail } from "../api/emailLog.js";
import { contactEmails } from "../api/switchTools.js";
import { CURRENT_USER_ID } from "../api/session.js";
import {
  conditionLabel,
  entitiesFor,
  evaluate,
  fmtMetric,
  isActiveAt,
  METRIC_LABEL,
  worse,
  type Entity,
  type Series,
} from "./evaluate.js";

type Db = pg.Pool | pg.PoolClient;
export const EVALUATE_EVERY_MS = 15_000;
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:5173";

let push: (topic: string, event: string, payload: object) => void = () => {};
let rulesCache: { at: number; rules: AlertRuleRow[] } | null = null;
let me: { departmentId: number | null } | null = null;
let lastDigestSlot = -1;
let lastSummaryDay = "";

export function setPusher(fn: typeof push) {
  push = fn;
}
/** A rule was saved: the next round reads the rules again. */
export function invalidateRules() {
  rulesCache = null;
}

// ---------------------------------------------------------------- live series

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function seriesOf(sim: Simulator): { customers: Series[]; vendors: Series[] } {
  return {
    customers: sim.trunks.map((t) => ({
      kind: "customer_trunk" as const,
      id: t.id,
      name: t.name,
      enterpriseId: t.enterpriseId,
      enterpriseName: t.enterpriseName,
      tps: t.tps,
      minutes: t.minutes,
      minAsr: t.minAsr,
      minDlr: t.minDlr,
      minDelay: t.minDelay,
      revenue: t.revenue,
      cost: t.cost,
      normalTps: t.base,
      normalAsr: t.asr,
      normalDlr: t.dlr,
      normalDelay: BASE_DELAY,
    })),
    vendors: sim.vendors.map((v) => ({
      kind: "vendor_trunk" as const,
      id: v.id,
      name: v.name,
      enterpriseId: v.enterpriseId,
      enterpriseName: v.enterpriseName,
      tps: v.tps,
      minutes: v.minutes,
      minAsr: v.minAsr,
      minDlr: v.minDlr,
      minDelay: v.minDelay,
      revenue: null,
      cost: v.cost,
      normalTps: avg(v.minutes),
      normalAsr: v.asr,
      normalDlr: v.dlr,
      normalDelay: BASE_DELAY,
    })),
  };
}

// ---------------------------------------------------------------- rules and notifications

async function activeRules(c: Db): Promise<AlertRuleRow[]> {
  if (rulesCache && Date.now() - rulesCache.at < 60_000) return rulesCache.rules;
  const { rows } = await c.query(
    `SELECT ${ALERT_RULE_SELECT} FROM ${ALERT_RULE_FROM} WHERE r.deleted_at IS NULL AND r.status = 'active'`,
  );
  rulesCache = { at: Date.now(), rules: rows.map(mapAlertRule) };
  return rulesCache.rules;
}

async function myDepartment(c: Db) {
  if (!me) {
    const { rows } = await c.query("SELECT department_id FROM users WHERE id = $1", [CURRENT_USER_ID]);
    me = { departmentId: rows[0]?.department_id == null ? null : Number(rows[0].department_id) };
  }
  return me.departmentId;
}

/** Whether a rule's GUI notifications reach a user (both lists empty = everyone). */
export function notifies(
  rule: Pick<AlertRuleRow, "notifyUserIds" | "notifyDepartmentIds">,
  userId: number,
  departmentId: number | null,
) {
  if (!rule.notifyUserIds.length && !rule.notifyDepartmentIds.length) return true;
  return (
    rule.notifyUserIds.includes(userId) || (departmentId !== null && rule.notifyDepartmentIds.includes(departmentId))
  );
}
/** SQL twin of notifies() for the bell list. */
export const NOTIFIES_ME_SQL = (
  userId: number,
) => `((cardinality(r.notify_user_ids) = 0 AND cardinality(r.notify_department_ids) = 0)
  OR ${Number(userId)} = ANY(r.notify_user_ids)
  OR (SELECT department_id FROM users WHERE id = ${Number(userId)}) = ANY(r.notify_department_ids))`;

const PARTY: Record<string, "customer_enterprise" | "vendor_enterprise" | "customer_trunk" | "vendor_trunk"> = {
  customer: "customer_enterprise",
  vendor: "vendor_enterprise",
  customer_trunk: "customer_trunk",
  vendor_trunk: "vendor_trunk",
};

export function toEvent(i: IncidentRow, rule: Pick<AlertRuleRow, "channels">, repeat = false): IncidentEvent {
  const kind = PARTY[i.entityKind];
  return {
    incidentId: i.id,
    ruleId: i.ruleId,
    ruleName: i.ruleName,
    state: i.state,
    severity: i.severity,
    message: i.message,
    metric: i.metric,
    currentValue: i.currentValue,
    baselineValue: i.baselineValue,
    peakValue: i.peakValue,
    scope: kind && i.entityId ? [{ kind, id: i.entityId, name: i.entityName }] : [],
    entityName: i.entityName,
    startedAt: i.startedAt,
    endedAt: i.endedAt,
    acknowledgedBy: i.acknowledgedBy,
    acknowledgedAt: i.acknowledgedAt,
    snoozedUntil: i.snoozedUntil,
    channels: (["popup", "sound", "email"] as const).filter((k) => rule.channels[k]),
    repeat,
  };
}

async function loadIncident(c: Db, id: number) {
  const { rows } = await c.query(`SELECT ${INCIDENT_SELECT} FROM ${INCIDENT_FROM} WHERE i.id = $1`, [id]);
  return rows[0] ? mapIncident(rows[0]) : null;
}

/** Pushes an incident change to the signed-in user when the rule notifies them (§13.6). */
export async function pushIncident(c: Db, id: number, repeat = false) {
  const inc = await loadIncident(c, id);
  if (!inc) return;
  const { rows } = await c.query(`SELECT ${ALERT_RULE_SELECT} FROM ${ALERT_RULE_FROM} WHERE r.id = $1`, [inc.ruleId]);
  if (!rows[0]) return;
  const rule = mapAlertRule(rows[0]);
  if (notifies(rule, CURRENT_USER_ID, await myDepartment(c)))
    push(`alerts:${CURRENT_USER_ID}`, "incident", toEvent(inc, rule, repeat));
}

// ---------------------------------------------------------------- e-mail (§13.7)

async function recipients(c: Db, rule: AlertRuleRow, enterpriseIds: (number | null)[]) {
  const { rows } = await c.query(
    `SELECT DISTINCT email FROM users WHERE deleted_at IS NULL AND status = 'active'
       AND (id = ANY($1) OR department_id = ANY($2))`,
    [rule.notifyUserIds, rule.notifyDepartmentIds],
  );
  const out = new Set<string>([...rows.map((r) => r.email as string), ...rule.emailAddresses]);
  if (rule.partnerContactType)
    for (const e of enterpriseIds)
      if (e) for (const x of await contactEmails(c, e, [rule.partnerContactType])) out.add(x);
  return [...out];
}

async function template(c: Db) {
  const { rows } = await c.query(
    "SELECT subject, body FROM email_templates WHERE email_type = 'monitoring_alert' AND deleted_at IS NULL ORDER BY business_company_id NULLS LAST, id LIMIT 1",
  );
  return (
    (rows[0] as { subject: string; body: string } | undefined) ?? {
      subject: "[{severity}] {rule}: {entity}",
      body: "{state_line}\n\nNow: {current} (baseline {baseline})\nStarted: {started} UTC\n{link}",
    }
  );
}

const fill = (t: string, v: Record<string, string>) => t.replace(/\{([a-z_]+)\}/g, (m, k: string) => v[k] ?? m);

async function enterpriseOf(c: Db, inc: IncidentRow): Promise<number | null> {
  if (inc.entityKind === "customer" || inc.entityKind === "vendor") return inc.entityId;
  if (inc.entityKind === "customer_trunk" || inc.entityKind === "vendor_trunk") {
    const table = inc.entityKind === "customer_trunk" ? "customer_trunks" : "vendor_trunks";
    const { rows } = await c.query(`SELECT enterprise_id FROM ${table} WHERE id = $1`, [inc.entityId]);
    return rows[0] ? Number(rows[0].enterprise_id) : null;
  }
  return null;
}

/** One e-mail for one or more incidents of a rule (alert, recovery or digest). */
export async function sendIncidentEmail(
  c: Db,
  rule: AlertRuleRow,
  incs: IncidentRow[],
  kind: "alert" | "recovery" | "digest",
) {
  if (!incs.length) return;
  const enterprises = await Promise.all(incs.map((i) => enterpriseOf(c, i)));
  const to = await recipients(c, rule, enterprises);
  const tpl = await template(c);
  const ent = enterprises.find((e) => e) ?? null;
  const { rows: bc } = await c.query(
    "SELECT name FROM business_companies WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
  );
  const company = (bc[0]?.name as string | undefined) ?? "";
  const first = incs[0]!;
  const f = (v: number | null) => fmtMetric(first.metric, v, PLATFORM_CURRENCY);
  const stateLine =
    kind === "recovery"
      ? `Recovered: ${first.message} (back to normal at ${first.endedAt?.slice(0, 16).replace("T", " ")} UTC)`
      : kind === "digest"
        ? `${incs.length} incident${incs.length === 1 ? "" : "s"} for this rule:\n${incs
            .map(
              (i) =>
                `- ${i.state === "recovered" ? "[recovered] " : ""}${i.message} (since ${i.startedAt.slice(11, 16)} UTC)`,
            )
            .join("\n")}`
        : first.message;
  const values = {
    severity: kind === "recovery" ? "OK" : first.severity.toUpperCase(),
    rule: rule.name,
    entity: incs.length > 1 ? `${incs.length} incidents` : first.entityName,
    metric: `${METRIC_LABEL[first.metric]} – ${conditionLabel(rule)}`,
    current: f(first.currentValue),
    baseline: f(first.baselineValue),
    started: first.startedAt.slice(0, 16).replace("T", " "),
    link: `${PUBLIC_URL}/monitoring/incidents?incident=${first.id}`,
    company,
    state_line: stateLine,
  };
  await logEmail(c, {
    type: "monitoring_alert",
    enterpriseId: rule.partnerContactType ? ent : null,
    to,
    sender: ent ? await companyMailbox(c, ent, "noc") : null,
    subject: fill(tpl.subject, values),
    body: fill(tpl.body, values),
  });
  await c.query("UPDATE incidents SET emailed_at = now(), digest_pending = false WHERE id = ANY($1)", [
    incs.map((i) => i.id),
  ]);
}

// ---------------------------------------------------------------- one round

interface OpenRow {
  id: number;
  key: string;
  state: string;
  peak: number | null;
  lastNotified: number;
  snoozedUntil: number | null;
}
export const keyOf = (ruleId: number, e: Pick<Entity, "kind" | "id" | "name">) =>
  `${ruleId}|${e.kind}|${e.id ?? e.name}`;

/** Evaluates every active rule once; returns how many incidents were opened and recovered. */
export async function evaluateRound(
  sim: Simulator,
  now = Date.now(),
  c: Db = db(),
): Promise<{ opened: number; recovered: number }> {
  const rules = await activeRules(c);
  const { customers, vendors } = seriesOf(sim);
  const { rows: openRows } = await c.query(
    `SELECT id, rule_id, entity_kind, coalesce(entity_id::text, entity_name) AS ek, state, peak_value, last_notified_at, snoozed_until
       FROM incidents WHERE state <> 'recovered'`,
  );
  const open = new Map<string, OpenRow>(
    openRows.map((r) => [
      `${r.rule_id}|${r.entity_kind}|${r.ek}`,
      {
        id: Number(r.id),
        key: `${r.rule_id}|${r.entity_kind}|${r.ek}`,
        state: r.state as string,
        peak: r.peak_value == null ? null : Number(r.peak_value),
        lastNotified: r.last_notified_at ? (r.last_notified_at as Date).getTime() : 0,
        snoozedUntil: r.snoozed_until ? (r.snoozed_until as Date).getTime() : null,
      },
    ]),
  );
  const { rows: rec } = await c.query(
    `SELECT rule_id, entity_kind, coalesce(entity_id::text, entity_name) AS ek, max(ended_at) AS ended
       FROM incidents WHERE ended_at > now() - interval '1 day' GROUP BY 1, 2, 3`,
  );
  const lastRecovered = new Map(rec.map((r) => [`${r.rule_id}|${r.entity_kind}|${r.ek}`, (r.ended as Date).getTime()]));
  const bindRules = rules.some((r) => r.metric === "bind_status" || r.condition.type === "bind_down");
  const down = new Set<string>();
  if (bindRules) {
    const { rows } = await c.query("SELECT side, trunk_id FROM trunk_binds WHERE status = 'offline'");
    for (const r of rows) down.add(`${r.side === "customer" ? "customer_trunk" : "vendor_trunk"}|${r.trunk_id}`);
  }
  const seen = new Set<string>();
  let opened = 0;
  let recovered = 0;
  for (const rule of rules) {
    if (!isActiveAt(rule.activeHours, now)) continue;
    for (const entity of entitiesFor(rule, customers, vendors)) {
      const key = keyOf(rule.id, entity);
      const ev = evaluate(rule, entity, down.has(`${entity.kind}|${entity.id}`), PLATFORM_CURRENCY);
      const cur = open.get(key);
      if (ev.firing) {
        seen.add(key);
        if (!cur) {
          const quiet = lastRecovered.get(key);
          if (quiet && now - quiet < rule.cooldownMinutes * 60_000) continue;
          const { rows } = await c.query(
            `INSERT INTO incidents (rule_id, severity, metric, entity_kind, entity_id, entity_name, message, current_value,
                                    baseline_value, peak_value, started_at, last_notified_at, digest_pending)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $10, $10, $11) RETURNING id`,
            [
              rule.id,
              rule.severity,
              rule.metric,
              entity.kind,
              entity.id,
              entity.name,
              ev.message,
              ev.value,
              ev.baseline,
              new Date(now),
              rule.channels.email && rule.severity !== "critical",
            ],
          );
          const id = Number(rows[0].id);
          await c.query("UPDATE alert_rules SET last_triggered_at = $2 WHERE id = $1", [rule.id, new Date(now)]);
          opened++;
          await pushIncident(c, id);
          if (rule.channels.email && rule.severity === "critical") {
            const inc = await loadIncident(c, id);
            if (inc) await sendIncidentEmail(c, rule, [inc], "alert");
          }
        } else {
          const peak = worse(rule, cur.peak, ev.value);
          await c.query("UPDATE incidents SET current_value = $2, peak_value = $3, message = $4 WHERE id = $1", [
            cur.id,
            ev.value,
            peak,
            ev.message,
          ]);
          const snoozed = cur.snoozedUntil !== null && cur.snoozedUntil > now;
          if (
            rule.repeatMinutes &&
            cur.state === "open" &&
            !snoozed &&
            now - cur.lastNotified >= rule.repeatMinutes * 60_000
          ) {
            await c.query("UPDATE incidents SET last_notified_at = $2 WHERE id = $1", [cur.id, new Date(now)]);
            await pushIncident(c, cur.id, true);
          }
        }
      }
    }
  }
  // Everything open that no longer holds (or whose rule is off) recovers.
  for (const [key, cur] of open) {
    if (seen.has(key)) continue;
    const { rows } = await c.query(
      "UPDATE incidents SET state = 'recovered', ended_at = $2 WHERE id = $1 AND state <> 'recovered' RETURNING rule_id, emailed_at",
      [cur.id, new Date(now)],
    );
    if (!rows[0]) continue;
    recovered++;
    const rule = rules.find((r) => r.id === Number(rows[0].rule_id));
    if (!rule || rule.recoveryNotice) await pushIncident(c, cur.id);
    if (rule?.channels.email && rule.recoveryNotice && rows[0].emailed_at) {
      const inc = await loadIncident(c, cur.id);
      if (inc) await sendIncidentEmail(c, rule, [inc], "recovery");
    }
  }
  await digests(c, rules, now);
  return { opened, recovered };
}

/** Warning e-mails every 15 minutes, Info once a day at 07:00 UTC (§13.7). */
async function digests(c: Db, rules: AlertRuleRow[], now: number) {
  const slot = Math.floor(now / (15 * 60_000));
  const d = new Date(now);
  const day = d.toISOString().slice(0, 10);
  const severities: string[] = [];
  if (slot !== lastDigestSlot) {
    lastDigestSlot = slot;
    severities.push("warning");
  }
  if (d.getUTCHours() >= 7 && day !== lastSummaryDay) {
    lastSummaryDay = day;
    severities.push("info");
  }
  if (!severities.length) return;
  const { rows } = await c.query(
    `SELECT ${INCIDENT_SELECT} FROM ${INCIDENT_FROM} WHERE i.digest_pending AND i.severity = ANY($1) ORDER BY i.started_at`,
    [severities],
  );
  const byRule = new Map<number, IncidentRow[]>();
  for (const r of rows) {
    const inc = mapIncident(r);
    byRule.set(inc.ruleId, [...(byRule.get(inc.ruleId) ?? []), inc]);
  }
  for (const [ruleId, incs] of byRule) {
    const rule = rules.find((r) => r.id === ruleId);
    if (rule) await sendIncidentEmail(c, rule, incs, "digest");
    else await c.query("UPDATE incidents SET digest_pending = false WHERE id = ANY($1)", [incs.map((i) => i.id)]);
  }
}

/** Test a rule now (no incident): per entity, the value, the baseline and whether it would fire. */
export async function testRule(
  rule: Omit<
    AlertRuleRow,
    | "id"
    | "scopeLabel"
    | "conditionLabel"
    | "lastTriggeredAt"
    | "openIncidents"
    | "incidents30d"
    | "updatedBy"
    | "updatedAt"
    | "archivedAt"
  >,
  sim: Simulator,
  c: Db = db(),
) {
  const { customers, vendors } = seriesOf(sim);
  const down = new Set<string>();
  if (rule.metric === "bind_status" || rule.condition.type === "bind_down") {
    const { rows } = await c.query("SELECT side, trunk_id FROM trunk_binds WHERE status = 'offline'");
    for (const r of rows) down.add(`${r.side === "customer" ? "customer_trunk" : "vendor_trunk"}|${r.trunk_id}`);
  }
  const results = entitiesFor(rule, customers, vendors).map((e) => ({
    name: e.name,
    ...evaluate(rule, e, down.has(`${e.kind}|${e.id}`), PLATFORM_CURRENCY),
  }));
  const firing = results.filter((r) => r.firing).length;
  const active = isActiveAt(rule.activeHours, Date.now());
  return {
    evaluatedAt: new Date().toISOString(),
    firing,
    entities: results
      .sort((a, b) => Number(b.firing) - Number(a.firing) || b.sample - a.sample)
      .slice(0, 50)
      .map(({ name, value, baseline, sample, firing: f, reason }) => ({
        name,
        value,
        baseline,
        sample,
        firing: f,
        reason: active ? reason : `${reason} (outside the rule's active hours now)`,
      })),
  };
}
