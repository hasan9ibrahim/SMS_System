// Server-side lists for monitoring alerts (§13.6): alert rules and incidents. The SELECT / FROM /
// mapRow parts are shared with the record endpoints (api/alerts.ts) and the engine.
import type { AlertRuleRow, IncidentBreakdownItem, IncidentRow } from "@sms/contract";
import { conditionLabel } from "../alerts/evaluate.js";
import type { ListDef } from "./engine.js";
import { listFields } from "./fields.js";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const str = (v: unknown) => (v as string | null) ?? null;
const num = (v: unknown) => (v == null ? null : Number(v));

const names = (table: string, col = "name") =>
  `(SELECT string_agg(x.${col}, ', ' ORDER BY x.${col}) FROM ${table} x WHERE x.id = ANY(r.scope_ids))`;
const SCOPE_NAMES = `(CASE r.scope_kind
    WHEN 'all' THEN 'All traffic'
    WHEN 'customer' THEN coalesce('Customers: ' || ${names("enterprises")}, 'Each customer')
    WHEN 'vendor' THEN coalesce('Vendors: ' || ${names("enterprises")}, 'Each vendor')
    WHEN 'customer_trunk' THEN coalesce('Customer trunks: ' || ${names("customer_trunks")}, 'Each customer trunk')
    WHEN 'vendor_trunk' THEN coalesce('Vendor trunks: ' || ${names("vendor_trunks")}, 'Each vendor trunk')
    WHEN 'product_category' THEN 'Category: ' || coalesce(${names("product_categories")}, 'any')
    WHEN 'country' THEN 'Country: ' || coalesce(array_to_string(r.scope_values, ', '), 'any')
    WHEN 'mccmnc' THEN 'MCCMNC: ' || coalesce(array_to_string(r.scope_values, ', '), 'any')
    ELSE 'Sender ID: ' || coalesce(array_to_string(r.scope_values, ', '), 'any') END)`;
const OPEN_SQL = "(SELECT count(*)::int FROM incidents i WHERE i.rule_id = r.id AND i.state <> 'recovered')";
const RECENT_SQL =
  "(SELECT count(*)::int FROM incidents i WHERE i.rule_id = r.id AND i.started_at > now() - interval '30 days')";

export const ALERT_RULE_FROM = "alert_rules r LEFT JOIN users ub ON ub.id = r.updated_by_id";
export const ALERT_RULE_SELECT = `r.*, ${SCOPE_NAMES} AS scope_label, ${OPEN_SQL} AS open_incidents, ${RECENT_SQL} AS incidents_30d,
  ub.username AS updated_by`;

export function mapAlertRule(r: Record<string, unknown>): AlertRuleRow {
  const base = {
    name: r.name as string,
    status: r.status as AlertRuleRow["status"],
    description: str(r.description),
    scope: {
      kind: r.scope_kind as AlertRuleRow["scope"]["kind"],
      ids: ((r.scope_ids as number[]) ?? []).map(Number),
      values: (r.scope_values as string[]) ?? [],
    },
    metric: r.metric as AlertRuleRow["metric"],
    condition: {
      type: r.condition_type as AlertRuleRow["condition"]["type"],
      value: num(r.condition_value),
      baseline: (r.condition_baseline as AlertRuleRow["condition"]["baseline"]) ?? null,
    },
    windowMinutes: Number(r.window_minutes) as AlertRuleRow["windowMinutes"],
    minSample: Number(r.min_sample),
    activeHours: {
      always: r.active_always as boolean,
      days: ((r.active_days as number[]) ?? []).map(Number),
      fromHour: Number(r.active_from_hour),
      toHour: Number(r.active_to_hour),
    },
    severity: r.severity as AlertRuleRow["severity"],
    notifyUserIds: ((r.notify_user_ids as number[]) ?? []).map(Number),
    notifyDepartmentIds: ((r.notify_department_ids as number[]) ?? []).map(Number),
    channels: {
      popup: r.channel_popup as boolean,
      sound: r.channel_sound as boolean,
      email: r.channel_email as boolean,
    },
    emailAddresses: (r.email_addresses as string[]) ?? [],
    partnerContactType: (r.partner_contact_type as AlertRuleRow["partnerContactType"]) ?? null,
    repeatMinutes: num(r.repeat_minutes),
    cooldownMinutes: Number(r.cooldown_minutes),
    recoveryNotice: r.recovery_notice as boolean,
  };
  return {
    ...base,
    id: Number(r.id),
    scopeLabel: (r.scope_label as string) ?? "",
    conditionLabel: conditionLabel(base),
    lastTriggeredAt: iso(r.last_triggered_at),
    openIncidents: Number(r.open_incidents ?? 0),
    incidents30d: Number(r.incidents_30d ?? 0),
    updatedBy: str(r.updated_by),
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

const CHANNELS_SQL = `(array_to_string(ARRAY[CASE WHEN r.channel_popup THEN 'popup' END, CASE WHEN r.channel_sound THEN 'sound' END,
  CASE WHEN r.channel_email THEN 'email' END], ', '))`;

export const alertRuleList: ListDef<AlertRuleRow> = {
  fields: listFields.alert_rules,
  from: ALERT_RULE_FROM,
  baseWhere: "r.deleted_at IS NULL",
  archivedField: "archived",
  columns: {
    id: { sql: "r.id" },
    name: { sql: "r.name" },
    scopeLabel: { sql: SCOPE_NAMES },
    metric: { sql: "r.metric" },
    conditionType: { sql: "r.condition_type" },
    severity: { sql: "r.severity" },
    channels: { sql: CHANNELS_SQL },
    status: { sql: "r.status" },
    lastTriggeredAt: { sql: "r.last_triggered_at" },
    openIncidents: { sql: OPEN_SQL },
    incidents30d: { sql: RECENT_SQL },
    updatedBy: { sql: "ub.username" },
    updatedAt: { sql: "r.updated_at" },
    archived: { sql: "(r.deleted_at IS NOT NULL)" },
  },
  search: ["name", "scopeLabel"],
  idSql: "r.id",
  select: ALERT_RULE_SELECT,
  mapRow: mapAlertRule,
};

const DURATION_SQL = "extract(epoch FROM (coalesce(i.ended_at, now()) - i.started_at))::int";
export const INCIDENT_FROM = `incidents i JOIN alert_rules r ON r.id = i.rule_id LEFT JOIN users ak ON ak.id = i.acknowledged_by_id`;
export const INCIDENT_SELECT = `i.*, r.name AS rule_name, ak.username AS acknowledged_by, ${DURATION_SQL} AS duration_s,
  (SELECT count(*)::int FROM incident_notes n WHERE n.incident_id = i.id) AS notes_count,
  r.condition_type AS rule_condition_type, r.condition_value AS rule_condition_value,
  r.condition_baseline AS rule_condition_baseline, r.window_minutes AS rule_window_minutes`;

/** The worst destinations stored as JSON (v0.90.0); older rows held a sentence and read as none. */
export function parseBreakdown(v: unknown): IncidentBreakdownItem[] {
  if (typeof v !== "string" || !v.startsWith("[")) return [];
  try {
    return JSON.parse(v) as IncidentBreakdownItem[];
  } catch {
    return [];
  }
}

export function mapIncident(r: Record<string, unknown>): IncidentRow {
  return {
    id: Number(r.id),
    ruleId: Number(r.rule_id),
    ruleName: r.rule_name as string,
    severity: r.severity as IncidentRow["severity"],
    metric: r.metric as IncidentRow["metric"],
    entityKind: r.entity_kind as string,
    entityId: num(r.entity_id),
    entityName: r.entity_name as string,
    message: r.message as string,
    state: r.state as IncidentRow["state"],
    currentValue: num(r.current_value),
    baselineValue: num(r.baseline_value),
    peakValue: num(r.peak_value),
    startedAt: iso(r.started_at)!,
    endedAt: iso(r.ended_at),
    durationSeconds: Number(r.duration_s ?? 0),
    acknowledgedBy: str(r.acknowledged_by),
    acknowledgedAt: iso(r.acknowledged_at),
    snoozedUntil: iso(r.snoozed_until),
    notesCount: Number(r.notes_count ?? 0),
    emailedAt: iso(r.emailed_at),
    condition: r.rule_condition_type
      ? {
          type: r.rule_condition_type as NonNullable<IncidentRow["condition"]>["type"],
          value: num(r.rule_condition_value),
          baseline: (r.rule_condition_baseline as NonNullable<IncidentRow["condition"]>["baseline"]) ?? null,
        }
      : null,
    windowMinutes: num(r.rule_window_minutes),
    breakdown: parseBreakdown(r.breakdown),
  };
}

export const incidentList: ListDef<IncidentRow> = {
  fields: listFields.incidents,
  from: INCIDENT_FROM,
  columns: {
    id: { sql: "i.id" },
    startedAt: { sql: "i.started_at" },
    endedAt: { sql: "i.ended_at" },
    durationSeconds: { sql: DURATION_SQL },
    severity: { sql: "i.severity" },
    state: { sql: "i.state" },
    ruleName: { sql: "r.name" },
    ruleId: { sql: "i.rule_id" },
    entityName: { sql: "i.entity_name" },
    entityKind: { sql: "i.entity_kind" },
    metric: { sql: "i.metric" },
    message: { sql: "i.message" },
    peakValue: { sql: "i.peak_value" },
    acknowledgedBy: { sql: "ak.username" },
    acknowledgedAt: { sql: "i.acknowledged_at" },
    notesCount: { sql: "(SELECT count(*)::int FROM incident_notes n WHERE n.incident_id = i.id)" },
  },
  search: ["message", "ruleName", "entityName"],
  idSql: "i.id",
  select: INCIDENT_SELECT,
  mapRow: mapIncident,
};
