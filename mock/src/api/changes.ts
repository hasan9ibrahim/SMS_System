// Per-user undo (§13.10). Undo restores only the fields the change touched; if someone
// else changed one of them since, the caller gets 409 with both values and decides.
import { applyBusinessCompanyField } from "./businessCompanies.js";
import { applyAlertRuleField } from "./alerts.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Change, ListQuery, UndoRequest } from "@sms/contract";
import { withDb } from "../db.js";
import { changeSelect, listDefs, mapChange } from "../lists/defs.js";
import { listFields } from "../lists/fields.js";
import { runList, type ListDef } from "../lists/engine.js";
import { checkListQuery } from "../lists/validate.js";
import { isBadRegex } from "./lists.js";
import { withDescriptions } from "../history/describe.js";
import { sendProblem } from "../problem.js";
import { CURRENT_USER_ID, canUndoOthers, getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";
import { applyEnterpriseField } from "./enterprises.js";
import { applyTrunkField } from "./trunks.js";
import { applyRateTableEntries } from "./rates.js";
import { applyRouteRuleField } from "./routeRules.js";
import { applyTranslationRuleField } from "./translationRules.js";
import { applyHlrField } from "./hlr.js";
import { applyCurrencyRate, applyTransactionEntries } from "./finance.js";
import { MIGRATION_TABLES } from "../migration/importer.js";

interface DiffEntry {
  entity_id: number;
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Record fields that are plain columns, for records whose screens don't have their own field
 * map yet. Other fields (e.g. a vendor share inside a route) are history-only until then.
 */
const ENTITY_COLUMNS: Record<string, { table: string; columns: Record<string, string> }> = {
  // Security settings (§13.28): one row.
  security_settings: {
    table: "security_settings",
    columns: {
      passwordLifetimeDays: "password_lifetime_days",
      reminderDays: "reminder_days",
      tempPasswordHours: "temp_password_hours",
      minPasswordLength: "min_password_length",
      passwordHistory: "password_history",
    },
  },
  // Admin (§11). Business companies write nested fields through applyBusinessCompanyField.
  user: {
    table: "users",
    columns: {
      username: "username",
      firstName: "first_name",
      lastName: "last_name",
      email: "email",
      phone: "phone",
      departmentId: "department_id",
      accessGroupId: "access_group_id",
      businessCompanyId: "business_company_id",
      managerId: "manager_id",
      userType: "user_type",
      isAccountManager: "is_account_manager",
      isTeamLead: "is_team_lead",
      status: "status",
      allowMultipleLogin: "allow_multiple_login",
      otpMethod: "otp_method",
      language: "language",
      address1: "address1",
      address2: "address2",
      countryIso: "country_iso",
      state: "state",
      city: "city",
      zip: "zip",
      mustChangePassword: "must_change_password",
    },
  },
  department: {
    table: "departments",
    columns: { name: "name", status: "status", managerId: "manager_id", description: "description" },
  },
  access_group: {
    table: "access_groups",
    columns: { name: "name", status: "status", description: "description", permissions: "permissions" },
  },
  email_template: {
    table: "email_templates",
    columns: {
      name: "name",
      emailType: "email_type",
      subject: "subject",
      body: "body",
      businessCompanyId: "business_company_id",
    },
  },
  portal_user: {
    table: "customer_portal_users",
    columns: {
      email: "email",
      username: "username",
      enterpriseId: "enterprise_id",
      firstName: "first_name",
      lastName: "last_name",
      status: "status",
    },
  },
  business_company: { table: "business_companies", columns: {} },
  // Visibility policies (§13.17)
  visibility_policy: {
    table: "visibility_policies",
    columns: {
      name: "name",
      description: "description",
      status: "status",
      maskOthers: "mask_others",
      includeTeam: "include_team",
      items: "items",
      thresholds: "thresholds",
    },
  },
  // LCR profiles (§13.23)
  lcr_profile: {
    table: "lcr_profiles",
    columns: {
      name: "name",
      description: "description",
      status: "status",
      vendorTrunkMode: "vendor_trunk_mode",
      vendorTrunkIds: "vendor_trunk_ids",
      tiers: "tiers",
      minAsr: "min_asr",
      minDlr: "min_dlr",
      maxDelayS: "max_delay_s",
      maxRate: "max_rate",
      vendorCount: "vendor_count",
      split: "split",
      shares: "shares",
      tieBreaker: "tie_breaker",
      excludeAtTpsLimit: "exclude_at_tps_limit",
      qualityWeighted: "quality_weighted",
      weights: "weights",
    },
  },
  // Alert rules (§13.6) write their nested fields through applyAlertRuleField.
  alert_rule: { table: "alert_rules", columns: {} },
  // Translation rules write every field through applyTranslationRuleField (§6.4).
  translation_rule: { table: "translation_rules", columns: {} },
  // Number lists and their entries (§6.4)
  number_list: { table: "number_lists", columns: { name: "name", listType: "list_type" } },
  number_list_entry: { table: "number_list_entries", columns: {} },
  // HLR (§6.5, §13.24): rules, providers and policies write their fields through applyHlrField.
  hlr_rule: { table: "hlr_rules", columns: {} },
  hlr_provider: { table: "hlr_providers", columns: {} },
  hlr_policy: { table: "hlr_policies", columns: {} },
  hlr_provider_rate: { table: "hlr_provider_rates", columns: { rate: "rate" } },
  // Finance (§7): transactions are written in one statement (applyTransactionEntries); a
  // currency's rate is undone by a new rate row (history is never rewritten).
  transaction: { table: "transactions", columns: {} },
  currency: { table: "currencies", columns: { name: "name", symbol: "symbol" } },
  billing_cycle: {
    table: "billing_cycles",
    columns: {
      name: "name",
      billingType: "billing_type",
      weekDay: "week_day",
      usageDays: "usage_days",
      dueDays: "due_days",
    },
  },
  // Invoices (§7): amounts change only by Regenerate (not undone); these fields are.
  invoice: {
    table: "invoices",
    columns: { dueDate: "due_date", remarks: "remarks", paymentStatus: "payment_status", emailStatus: "email_status" },
  },
  // Vendor invoices (§13.31): the form, our figures and the status; lines and events stay history.
  vendor_invoice: {
    table: "vendor_invoices",
    columns: {
      enterpriseId: "enterprise_id",
      invoiceNumber: "invoice_number",
      chargeVolume: "charge_volume",
      chargeAmount: "charge_amount",
      currency: "currency",
      invoiceDate: "invoice_date",
      dueDate: "due_date",
      periodFrom: "period_from",
      periodTo: "period_to",
      timezone: "timezone",
      remarks: "remarks",
      comparison: "comparison",
      ourVolume: "our_volume",
      ourAmount: "our_amount",
      status: "recon_status",
      emailStatus: "email_status",
    },
  },
  // Manual SOA adds, removes and entries (§13.31): undoing the add takes it back.
  soa_adjustment: { table: "soa_adjustments", columns: {} },
  // Switch utilities (§8)
  firewall_rule: { table: "firewall_rules", columns: {} },
  firewall_filter: {
    table: "firewall_filters",
    columns: {
      name: "name",
      listener: "listener",
      status: "status",
      failedAttempts: "failed_attempts",
      windowSeconds: "window_seconds",
      banMinutes: "ban_minutes",
    },
  },
  traffic_alert: {
    table: "traffic_alerts",
    columns: {
      name: "name",
      sampleCount: "sample_count",
      sampleMinutes: "sample_minutes",
      asrThreshold: "asr_threshold",
      dlrThreshold: "dlr_threshold",
      marginThreshold: "margin_threshold",
      customerTrunkId: "customer_trunk_id",
      vendorTrunkId: "vendor_trunk_id",
      senderId: "sender_id",
      mccmnc: "mccmnc",
      delayThreshold: "delay_threshold",
      notificationEmails: "notification_emails",
      contactEmail: "contact_email",
      templateId: "template_id",
      status: "status",
    },
  },
  scheduled_report: {
    table: "scheduled_reports",
    columns: {
      name: "name",
      description: "description",
      templateKind: "template_kind",
      presetKey: "preset_key",
      viewId: "view_id",
      status: "status",
      businessCompanyId: "business_company_id",
      notificationEmails: "notification_emails",
      cronInterval: "cron_interval",
      cronFrequency: "cron_frequency",
      cronExpression: "cron_expression",
      fileType: "file_type",
      emailBody: "email_body",
    },
  },
  daily_traffic_alert: {
    table: "daily_traffic_alerts",
    columns: {
      name: "name",
      status: "status",
      businessCompanyId: "business_company_id",
      contactType: "contact_type",
      enterpriseId: "enterprise_id",
      sendHour: "send_hour",
      emailBody: "email_body",
    },
  },
  edr_template: { table: "edr_templates", columns: { name: "name", columns: "columns" } },
  sms_voice_rule: {
    table: "sms_voice_rules",
    columns: {
      senderId: "sender_id",
      receiverId: "receiver_id",
      prefix: "prefix",
      repeat: "repeat_count",
      mccmnc: "mccmnc",
      status: "status",
    },
  },
  recon_rule: {
    table: "recon_rules",
    columns: {
      amountPct: "amount_pct",
      amountFixed: "amount_fixed",
      amountCombine: "amount_combine",
      countPct: "count_pct",
      countFixed: "count_fixed",
      countCombine: "count_combine",
      destinationPct: "destination_pct",
      autoSend: "auto_send",
      disputedInSoa: "disputed_in_soa",
    },
  },
  enterprise_doc: { table: "enterprise_docs", columns: {} },
  // MCCMNC master (§6.1); DLR targets live here too (decided 2026-10-16).
  destination: {
    table: "mccmnc",
    columns: {
      dlrTargetPct: "dlr_target_pct",
      mcc: "mcc",
      mnc: "mnc",
      mccmnc: "mccmnc",
      allNetworks: "is_all_networks",
      originalMnc: "original_mnc",
      countryId: "country_id",
      network: "network",
    },
  },
  // QBR vendor stat overrides (§6.3)
  qbr_stat: {
    table: "qbr_stats",
    columns: {
      overridden: "overridden",
      overrideAsr: "override_asr",
      overrideDlr: "override_dlr",
      overrideAddSeconds: "override_add_s",
    },
  },
  // Product reference data (§6.1)
  product_category: { table: "product_categories", columns: { name: "name" } },
  country: { table: "countries", columns: { name: "name", iso: "iso", dialCode: "dial_code", region: "region" } },
  dial_code_profile: { table: "dial_code_profiles", columns: { name: "name" } },
  dial_code: { table: "dial_codes", columns: { prefix: "prefix", destinationId: "mccmnc_id" } },
  mo_number: {
    table: "mo_numbers",
    columns: {
      customerTrunkId: "customer_trunk_id",
      number: "number",
      keyword: "keyword",
      rate: "rate",
      vendorRate: "vendor_rate",
      destinationId: "mccmnc_id",
      setupCharge: "setup_charge",
      fixCharge: "fix_charge",
    },
  },
};

/** Workflow records logged for the history but not undone (§12.2 maker-checker). */
// Passwords, 2FA and uploaded files are never put back by an undo (§13.28: secrets are not kept).
const NOT_UNDOABLE = new Set([
  "rerating_request",
  "user_password",
  "portal_user_password",
  "user_totp",
  "business_company_file",
]);

const TABLES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ENTITY_COLUMNS).map(([k, v]) => [k, v.table])),
  enterprise: "enterprises",
  rate_table: "rate_tables",
  route_rule: "route_rules",
  customer_trunk: "customer_trunks",
  vendor_trunk: "vendor_trunks",
};

/** Puts each entry's `before` value back (undo restores what the change replaced). */
async function applyFields(c: pg.PoolClient, entityType: string, entries: DiffEntry[], userId: number) {
  // A Cleanup Center change (§13.19) spans record types: each entry names its own.
  if (entityType === "cleanup") {
    for (const e of entries) await applyFields(c, (e as DiffEntry & { entityType: string }).entityType, [e], userId);
    return;
  }
  // A Migration Center import or go-live (§13.22): each entry names its table. "*" = a record the import
  // created (undo archives it, redo restores it); "row" = columns it changed (undo writes `before` back).
  if (entityType === "migration") {
    for (const e of entries as (DiffEntry & { table: string })[]) {
      if (!MIGRATION_TABLES.has(e.table)) continue;
      if (e.field === "*") {
        await c.query(
          `UPDATE ${e.table} SET deleted_at = ${e.before == null ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`,
          [e.entity_id],
        );
        continue;
      }
      const cols = Object.keys((e.before ?? {}) as object).filter((k) => /^[a-z_0-9]+$/.test(k));
      if (!cols.length) continue;
      const values = e.before as Record<string, unknown>;
      await c.query(
        `UPDATE ${e.table} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
        [e.entity_id, ...cols.map((k) => values[k])],
      );
    }
    return;
  }
  if (entityType === "rate_table") {
    // Rate lines need ordered writes (no overlapping versions at any step).
    const rest = entries.filter((e) => e.field === "*");
    await applyRateTableEntries(
      c,
      entries.filter((e) => e.field !== "*"),
      "before",
      userId,
    );
    entries = rest;
  }
  if (entityType === "transaction") {
    await applyTransactionEntries(c, entries, userId);
    return;
  }
  for (const e of entries) {
    if (entityType === "currency" && e.field === "rate") {
      await applyCurrencyRate(c, e.entity_id, e.before, userId);
      continue;
    }
    // "*" = the record itself: no value before means it was created, so undo archives it;
    // a value before means it was deleted, so undo restores it (§13.10, §13.29).
    if (e.field === "*" || (e.field === "archived" && entityType in ENTITY_COLUMNS)) {
      const table = TABLES[entityType];
      const archive = e.field === "*" ? e.before == null : e.before === true;
      if (table)
        await c.query(`UPDATE ${table} SET deleted_at = ${archive ? "now()" : "NULL"} WHERE id = $1`, [e.entity_id]);
      // A balance-changing manual SOA entry carries its transaction along (§13.31, decided 2026-10-17).
      if (entityType === "soa_adjustment")
        await c.query(
          `UPDATE transactions SET deleted_at = ${archive ? "now()" : "NULL"}, updated_at = now()
            WHERE id = (SELECT transaction_id FROM soa_adjustments WHERE id = $1)`,
          [e.entity_id],
        );
      continue;
    }
    if (entityType === "alert_rule") {
      await applyAlertRuleField(c, e.entity_id, e.field, e.before);
      continue;
    }
    if (entityType === "business_company") {
      await applyBusinessCompanyField(c, e.entity_id, e.field, e.before);
      continue;
    }
    if (entityType === "enterprise") {
      await applyEnterpriseField(c, e.entity_id, e.field, e.before, e.after, userId);
      continue;
    }
    if (entityType === "route_rule") {
      await applyRouteRuleField(c, e.entity_id, e.field, e.before, userId);
      continue;
    }
    if (entityType === "hlr_provider" || entityType === "hlr_rule" || entityType === "hlr_policy") {
      await applyHlrField(c, entityType, e.entity_id, e.field, e.before, userId);
      continue;
    }
    if (entityType === "translation_rule") {
      await applyTranslationRuleField(c, e.entity_id, e.field, e.before, userId);
      continue;
    }
    if (entityType === "customer_trunk" || entityType === "vendor_trunk") {
      await applyTrunkField(
        c,
        entityType === "customer_trunk" ? "customer" : "vendor",
        e.entity_id,
        e.field,
        e.before,
        e.after,
        userId,
      );
      continue;
    }
    // Vendor invoice history (§13.31) records every status change, undone ones too.
    if (entityType === "vendor_invoice" && e.field === "status")
      await c.query(
        `INSERT INTO vendor_invoice_events (vendor_invoice_id, kind, status_from, status_to, note, user_id)
         VALUES ($1, 'status', $2, $3, 'Change undone', $4)`,
        [e.entity_id, e.after, e.before, userId],
      );
    const target = ENTITY_COLUMNS[entityType];
    const column = target?.columns[e.field];
    if (target && column)
      await c.query(`UPDATE ${target.table} SET ${column} = $2, updated_at = now() WHERE id = $1`, [
        e.entity_id,
        e.before,
      ]);
  }
}

export function undoChange(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const body = (request.body ?? {}) as UndoRequest;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      `SELECT ${changeSelect} FROM changes c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [id],
    );
    const target = rows[0];
    if (!target) return sendProblem(reply, 404, `Change ${id} not found`);
    if (NOT_UNDOABLE.has(target.entity_type))
      return sendProblem(reply, 400, "Re-rating requests are not undone: edit or decline a pending request instead");
    if (target.undone_by_id)
      return sendProblem(reply, 400, `Change #${id} was already undone by #${target.undone_by_id}`);
    const me = await getCurrentUser();
    if (target.user_id !== me.id && !canUndoOthers(me)) {
      return sendProblem(
        reply,
        403,
        "You can undo your own changes only; undoing others' needs the \"Undo others' changes\" permission",
      );
    }

    // Later changes by other users to the same record and field, still in force.
    const diff = target.diff as DiffEntry[];
    const { rows: later } = await pool.query(
      `SELECT c.id, c.diff, c.inserted_at, u.first_name || ' ' || u.last_name AS user_name
         FROM changes c JOIN users u ON u.id = c.user_id
        WHERE c.id > $1 AND c.user_id <> $2 AND c.entity_type = $3 AND c.entity_ids && $4::bigint[]
          AND c.change_type <> 'undo' AND NOT EXISTS (SELECT 1 FROM changes x WHERE x.undo_of_id = c.id)
        ORDER BY c.id DESC`,
      [id, target.user_id, target.entity_type, target.entity_ids],
    );
    const conflicts: {
      entityId: number;
      field: string;
      mine: unknown;
      current: unknown;
      changedBy: string;
      changedAt: string;
    }[] = [];
    for (const d of diff) {
      for (const l of later) {
        const hit = (l.diff as DiffEntry[]).find((x) => x.entity_id === d.entity_id && x.field === d.field);
        if (hit) {
          conflicts.push({
            entityId: d.entity_id,
            field: d.field,
            mine: d.after,
            current: hit.after,
            changedBy: l.user_name,
            changedAt: l.inserted_at.toISOString(),
          });
          break;
        }
      }
    }
    if (conflicts.length && !body.resolution) {
      return reply
        .code(409)
        .type("application/problem+json")
        .send({
          type: "about:blank",
          title: "Someone changed the same field since",
          status: 409,
          detail: conflicts
            .map((c) => `you set ${JSON.stringify(c.mine)}, ${c.changedBy} later set ${JSON.stringify(c.current)}`)
            .join("; "),
          conflicts,
        });
    }
    const conflicted = new Set(conflicts.map((c) => `${c.entityId}:${c.field}`));
    const revert =
      body.resolution === "keep_current" ? diff.filter((d) => !conflicted.has(`${d.entity_id}:${d.field}`)) : diff;
    if (revert.length === 0)
      return sendProblem(reply, 400, "Nothing left to undo: every field was changed by someone else since");

    const newId = await inTransaction(pool, async (c) => {
      await applyFields(c, target.entity_type, revert, me.id);
      // Undoing a Cleanup Center change opens its findings again (§13.19); undoing that undo applies them again.
      if (target.entity_type === "cleanup")
        await c.query(
          target.undo_of_id
            ? "UPDATE cleanup_findings SET state = 'applied' WHERE change_id = $1"
            : "UPDATE cleanup_findings SET state = 'open' WHERE change_id = $1",
          [target.undo_of_id ?? id],
        );
      const { rows: ins } = await c.query(
        `INSERT INTO changes (entity_type, entity_ids, change_type, diff, note, undo_of_id, user_id, ip)
         VALUES ($1, $2, 'undo', $3, $4, $5, $6, $7) RETURNING id`,
        [
          target.entity_type,
          // Same records as the change it undoes (rate edits list line ids in the diff only).
          target.entity_ids,
          // The inverse runs the entries backwards, so undoing this undo replays them in order.
          JSON.stringify([...revert].reverse().map((d) => ({ ...d, before: d.after, after: d.before }))),
          body.note ?? `Undo of #${id} by ${me.displayName}`,
          id,
          CURRENT_USER_ID,
          request.ip,
        ],
      );
      return ins[0].id as number;
    });
    const { rows: out } = await pool.query(
      `SELECT ${changeSelect} FROM changes c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [newId],
    );
    return (await withDescriptions(pool, [mapChange(out[0])]))[0];
  });
}

/** Change history list (§13.10) with record names, a summary and readable fields (team trial round 1). */
export function queryChanges(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.changes);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, async (pool) => {
    try {
      const page = await runList(pool, listDefs.changes as ListDef<Change>, query);
      return { ...page, rows: await withDescriptions(pool, page.rows) };
    } catch (err) {
      if (isBadRegex(err))
        return sendProblem(reply, 400, "Invalid list query", {
          errors: [{ path: "/filter", message: "invalid regular expression" }],
        });
      throw err;
    }
  });
}
