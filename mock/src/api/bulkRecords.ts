// Bulk delete and restore of a list's records (§13.29, §13.10): POST /lists/{list}/bulk-delete and /bulk-restore.
// One request archives (or restores) the selected rows as ONE change in History, so one Undo brings them all back
// (applyFields in changes.ts reads the same diff entries as each single delete's). The safe-delete rules of the single
// delete apply to every row: its refusals, its dependency check (blocked while billing items are open, live trunks…)
// with the administrator override and written reason, and its extra writes (an enterprise's trunks, a user's
// sessions). Rows that cannot be deleted are skipped and answered with the reason. Access is the list's own single
// delete / restore (auth/listAccess.ts), and records the user's visibility policy hides or masks (§13.17) are never
// touched. A dry run answers the same without changing anything, for the confirmation dialog.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  BulkRecordsRequest,
  BulkRecordsResult,
  CurrentUser,
  Dependencies,
  FilterCondition,
  ListId,
  ListQuery,
} from "@sms/contract";
import { withDb } from "../db.js";
import { listDefs } from "../lists/defs.js";
import { runList, type ListDef } from "../lists/engine.js";
import { sendProblem } from "../problem.js";
import { listArchiveOp, listRestoreOp, mayRun } from "../auth/listAccess.js";
import { currentViewer } from "../visibility/context.js";
import { clearVisibilityCache } from "../visibility/policy.js";
import { invalidateRules } from "../alerts/engine.js";
import { invalidateLiveRoutes } from "../live/routing.js";
import {
  accessGroupSpec,
  departmentSpec,
  emailTemplateSpec,
  portalUserSpec,
  userSpec,
  type Spec,
} from "./admin.js";
import { companyDeps } from "./businessCompanies.js";
import { archiveEnterpriseRows, enterpriseDependencies, restoreEnterpriseRows } from "./enterprises.js";
import { cycleDependencies } from "./finance.js";
import { policyDependencies, providerDependencies } from "./hlr.js";
import { invoiceDependencies, overlapping } from "./invoices.js";
import { lcrProfileSpec } from "./lcr.js";
import { categoryDependencies, destinationDependencies } from "./masterData.js";
import { listDependencies } from "./numberLists.js";
import { clearRoutingCostCache } from "./rateLookup.js";
import { tableDependencies } from "./rates.js";
import { dependencies, isAdmin, isUniqueViolation, recordChange, type DiffEntry } from "./records.js";
import { clearRouteMaps } from "./routeMap.js";
import { applyRouteRuleField, ruleDependencies } from "./routeRules.js";
import { ruleTargetDependencies } from "./ruleTargets.js";
import { getCurrentUser } from "./session.js";
import { trunkDependenciesOf } from "./trunks.js";
import { vendorInvoiceDependencies } from "./vendorInvoices.js";
import { inTransaction } from "./views.js";
import { visibilityPolicySpec } from "./visibility.js";

type Db = pg.Pool | pg.PoolClient;
type Row = Record<string, unknown>;

/** How a list's records are deleted and restored: the single delete's and restore's rules, row by row. */
export interface BulkKind {
  /** Change-history record type, as the single delete records it. */
  entityType: string;
  table: string;
  /** For the change note: "Deleted 12 MCCMNC codes". */
  plural: string;
  /** The record as the list shows it; default its name, username, number, code or IP. */
  name?: (r: Row) => string;
  /** The table keeps who archived it (deleted_by_id). */
  deletedBy?: boolean;
  /** Why the current user may not change this record at all (an administrator's user or group), or null. */
  guard?: (db: Db, id: number) => Promise<string | null>;
  /** The single delete's refusals before its dependency check (the default record, a vendor's buy table). */
  refuse?: (r: Row) => string | null;
  /** The single delete's dependency check (§13.29). */
  deps?: (db: Db, id: number, r: Row) => Promise<Dependencies>;
  /** The archive's writes and diff entries when they are more than deleted_at (an enterprise's trunks). */
  archive?: (c: pg.PoolClient, id: number, userId: number) => Promise<DiffEntry[]>;
  /** Extra writes after the archive in the same transaction (a user's sessions end). */
  onArchive?: (c: pg.PoolClient, id: number) => Promise<void>;
  /** Restored by anyone with the list's Restore; otherwise administrators only, as the single restore. */
  restoreAnyone?: boolean;
  /** The key a live record must not share with a restored one (SQL over the table alias), and what it is. */
  liveKey?: { sql: (alias: string) => string; what: string };
  /** Other reasons the single restore refuses (an archived parent, a period invoiced again). */
  restoreRefuse?: (db: Db, id: number, r: Row) => Promise<string | null>;
  /** The restore's writes and diff entries when they are more than deleted_at. */
  restore?: (c: pg.PoolClient, id: number, userId: number) => Promise<DiffEntry[]>;
  /** The single restore also stamps the row: "by" = updated_by and updated_at, "at" = updated_at. */
  restoreTouch?: "by" | "at";
  /** Caches to forget after a change. */
  after?: () => void;
}

const lowerName = { sql: (a: string) => `lower(${a}.name)`, what: "name" };
const archived = (id: number, on: boolean): DiffEntry => ({ entity_id: id, field: "archived", before: !on, after: on });

/** A records() spec (admin.ts) as a bulk kind: its dependencies, guard, extra writes and restore clash. */
function fromSpec<I, R>(spec: Spec<I, R>, extra: Pick<BulkKind, "plural"> & Partial<BulkKind>): BulkKind {
  return {
    entityType: spec.entityType,
    table: spec.table,
    ...(spec.deps ? { deps: (db: Db, id: number) => spec.deps!(db, id) } : {}),
    ...(spec.guard ? { guard: spec.guard } : {}),
    ...(spec.onArchive ? { onArchive: spec.onArchive } : {}),
    ...(spec.restoreClash ? { restoreRefuse: (db: Db, id: number) => spec.restoreClash!(db, id) } : {}),
    ...extra,
  };
}

/** A trunk whose enterprise is archived comes back with the enterprise (the single restore's rule). */
const parentEnterprise = (table: string) => async (db: Db, id: number) => {
  const { rows } = await db.query(
    `SELECT e.deleted_at FROM ${table} t JOIN enterprises e ON e.id = t.enterprise_id WHERE t.id = $1`,
    [id],
  );
  return rows[0]?.deleted_at ? "Its enterprise is archived; restore the enterprise first" : null;
};

/** Every list whose rows have a Delete, with the rules of its single delete and restore. */
export const BULK_KINDS: Partial<Record<ListId, BulkKind>> = {
  enterprises: {
    entityType: "enterprise",
    table: "enterprises",
    plural: "enterprises",
    deps: (db, id) => enterpriseDependencies(db, id),
    archive: archiveEnterpriseRows,
    restore: (c, id) => restoreEnterpriseRows(c, id),
  },
  customer_trunks: {
    entityType: "customer_trunk",
    table: "customer_trunks",
    plural: "customer trunks",
    deletedBy: true,
    deps: (db, id) => trunkDependenciesOf(db, "customer", id),
    liveKey: { sql: (a) => `${a}.username`, what: "username" },
    restoreRefuse: parentEnterprise("customer_trunks"),
  },
  vendor_trunks: {
    entityType: "vendor_trunk",
    table: "vendor_trunks",
    plural: "vendor trunks",
    deletedBy: true,
    deps: (db, id) => trunkDependenciesOf(db, "vendor", id),
    restoreRefuse: parentEnterprise("vendor_trunks"),
  },
  rate_tables: {
    entityType: "rate_table",
    table: "rate_tables",
    plural: "rate tables",
    deletedBy: true,
    refuse: (r) => (r.kind === "vendor" ? "A vendor's buy table is archived with its vendor trunk" : null),
    deps: (db, id) => tableDependencies(db, id),
  },
  route_rules: {
    entityType: "route_rule",
    table: "route_rules",
    plural: "route rules",
    deps: (db, id) => ruleDependencies(db, id),
    archive: async (c, id, userId) => {
      await applyRouteRuleField(c, id, "archived", true, userId);
      return [archived(id, true)];
    },
    restore: async (c, id, userId) => {
      await applyRouteRuleField(c, id, "archived", false, userId);
      return [archived(id, false)];
    },
  },
  product_categories: {
    entityType: "product_category",
    table: "product_categories",
    plural: "product categories",
    deps: (db, id) => categoryDependencies(db, id),
    liveKey: lowerName,
  },
  destinations: {
    entityType: "destination",
    table: "mccmnc",
    plural: "MCCMNC codes",
    name: (r) => String(r.mccmnc),
    deps: (db, id) => destinationDependencies(db, id),
    liveKey: { sql: (a) => `${a}.mccmnc`, what: "code" },
  },
  dial_code_profiles: {
    entityType: "dial_code_profile",
    table: "dial_code_profiles",
    plural: "dial-code profiles",
    refuse: (r) => (r.isDefault ? 'The "All" profile cannot be deleted' : null),
  },
  mo_numbers: {
    entityType: "mo_number",
    table: "mo_numbers",
    plural: "MO numbers",
    name: (r) => [r.number, r.keyword].filter((x) => x != null && x !== "").join(" "),
    liveKey: { sql: (a) => `(${a}.number, coalesce(lower(${a}.keyword), ''))`, what: "number and keyword" },
  },
  number_lists: {
    entityType: "number_list",
    table: "number_lists",
    plural: "number lists",
    deps: (db, id) => listDependencies(db, id),
    liveKey: lowerName,
  },
  translation_rules: {
    entityType: "translation_rule",
    table: "translation_rules",
    plural: "translation rules",
    deps: (db, id, r) => ruleTargetDependencies(db, "translation", id, Number(r.usedBy ?? 0)),
    // Rules are restored by anyone who may edit them: nothing else depends on a deleted rule.
    restoreAnyone: true,
    restoreTouch: "by",
  },
  hlr_providers: {
    entityType: "hlr_provider",
    table: "hlr_providers",
    plural: "HLR providers",
    deps: (db, id) => providerDependencies(db, id),
  },
  hlr_rules: {
    entityType: "hlr_rule",
    table: "hlr_rules",
    plural: "HLR rules",
    deps: (db, id, r) => ruleTargetDependencies(db, "hlr", id, Number(r.usedBy ?? 0)),
    restoreAnyone: true,
    restoreTouch: "by",
    restoreRefuse: async (db, id) => {
      const { rows } = await db.query(
        "SELECT p.name, p.deleted_at FROM hlr_rules r JOIN hlr_providers p ON p.id = r.hlr_provider_id WHERE r.id = $1",
        [id],
      );
      return rows[0]?.deleted_at ? `Its provider ${rows[0].name} is deleted; restore it first` : null;
    },
  },
  hlr_policies: {
    entityType: "hlr_policy",
    table: "hlr_policies",
    plural: "HLR policies",
    deps: (db, id) => policyDependencies(db, id),
    liveKey: lowerName,
  },
  transactions: { entityType: "transaction", table: "transactions", plural: "transactions", name: (r) => `TX-${r.id}` },
  billing_cycles: {
    entityType: "billing_cycle",
    table: "billing_cycles",
    plural: "billing cycles",
    deps: (db, id) => cycleDependencies(db, id),
  },
  invoices: {
    entityType: "invoice",
    table: "invoices",
    plural: "invoices",
    deps: (db, id) => invoiceDependencies(db, id),
    restoreRefuse: async (db, id) => {
      const { rows } = await db.query(
        "SELECT enterprise_id, usage_start::text AS f, usage_end::text AS t, kind, status FROM invoices WHERE id = $1",
        [id],
      );
      const i = rows[0];
      if (!i || i.kind !== "traffic" || i.status === "failed") return null;
      const other = await overlapping(db, Number(i.enterprise_id), i.f, i.t, id);
      return other ? `The period is invoiced again in ${other}` : null;
    },
  },
  vendor_invoices: {
    entityType: "vendor_invoice",
    table: "vendor_invoices",
    plural: "vendor invoices",
    deps: (db, id) => vendorInvoiceDependencies(db, id),
  },
  recon_rules: {
    entityType: "recon_rule",
    table: "recon_rules",
    plural: "reconciliation rules",
    name: (r) => String(r.enterprise ?? "Default rule"),
    refuse: (r) => (r.enterpriseId == null ? "The default rule cannot be removed" : null),
    liveKey: { sql: (a) => `coalesce(${a}.enterprise_id, 0)`, what: "enterprise" },
  },
  firewall_rules: {
    entityType: "firewall_rule",
    table: "firewall_rules",
    plural: "firewall IPs",
    name: (r) => String(r.ip),
    // Removing and putting back a firewall IP is an everyday NOC action, not admin-only.
    restoreAnyone: true,
    restoreTouch: "at",
    liveKey: { sql: (a) => `(${a}.ip, ${a}.filter_id)`, what: "IP in its filter" },
  },
  traffic_alerts: { entityType: "traffic_alert", table: "traffic_alerts", plural: "traffic alerts" },
  sms_voice_rules: {
    entityType: "sms_voice_rule",
    table: "sms_voice_rules",
    plural: "SMS to voice rules",
    name: (r) => `SMS to voice rule ${r.id}`,
  },
  edr_templates: { entityType: "edr_template", table: "edr_templates", plural: "EDR templates", liveKey: lowerName },
  scheduled_reports: {
    entityType: "scheduled_report",
    table: "scheduled_reports",
    plural: "scheduled reports",
    liveKey: lowerName,
  },
  daily_traffic_alerts: {
    entityType: "daily_traffic_alert",
    table: "daily_traffic_alerts",
    plural: "daily traffic alerts",
    liveKey: lowerName,
  },
  users: fromSpec(userSpec, { plural: "users", after: clearVisibilityCache }),
  departments: fromSpec(departmentSpec, { plural: "departments" }),
  access_groups: fromSpec(accessGroupSpec, { plural: "access groups" }),
  email_templates: fromSpec(emailTemplateSpec, { plural: "e-mail templates" }),
  customer_portal_users: fromSpec(portalUserSpec, { plural: "portal users" }),
  business_companies: {
    entityType: "business_company",
    table: "business_companies",
    plural: "business companies",
    deps: (db, id) => companyDeps(db, id),
    liveKey: lowerName,
  },
  alert_rules: {
    entityType: "alert_rule",
    table: "alert_rules",
    plural: "alert rules",
    // Incidents keep their rule; open ones recover on the engine's next round.
    deps: async (_db, _id, r) =>
      dependencies([
        {
          key: "open_incidents",
          label: "Open incidents (they close)",
          count: Number(r.openIncidents ?? 0),
          blocking: false,
          detail: null,
        },
      ]),
    liveKey: lowerName,
    after: invalidateRules,
  },
  lcr_profiles: fromSpec(lcrProfileSpec, { plural: "LCR profiles", liveKey: lowerName }),
  visibility_policies: fromSpec(visibilityPolicySpec, {
    plural: "visibility policies",
    liveKey: lowerName,
    after: clearVisibilityCache,
  }),
};

// ---------------------------------------------------------------- rows as the user sees them

const recordName = (k: BulkKind, r: Row) =>
  k.name?.(r) ?? String(r.name ?? r.username ?? r.invoiceNumber ?? r.mccmnc ?? r.ip ?? `#${String(r.id)}`);

const isArchived = (r: Row) => r.archived === true || (r.archivedAt !== null && r.archivedAt !== undefined);

/** A neutral ID instead of a name (§13.17): "Customer #2481", "Vendor trunk #12". */
const MASKED = /^(Customer|Vendor|Enterprise)( trunk)? #\d+$/;

/** The rows by ID as the list shows them to this user, archived ones too, and as they are (to tell masked ones). */
async function loadRows(pool: pg.Pool, def: ListDef<unknown>, ids: number[]) {
  const conditions: FilterCondition[] = [{ field: "id", op: "in", values: ids }];
  if (def.archivedField) conditions.push({ field: def.archivedField, op: "in", values: [true, false] });
  const query: ListQuery = { filter: { logic: "and", conditions }, limit: ids.length, withTotal: false };
  const [seen, plain] = await Promise.all([
    runList(pool, def, query, await currentViewer()),
    runList(pool, def, query, null),
  ]);
  const byId = (rows: unknown[]) => new Map((rows as Row[]).map((r) => [Number(r.id), r]));
  return { seen: byId(seen.rows), plain: byId(plain.rows) };
}

/** Whether the user's policy masks this record: a name shows as a neutral ID that is not its real value. */
function masked(seen: Row, plain: Row | undefined): boolean {
  return Object.entries(seen).some(([k, v]) => typeof v === "string" && MASKED.test(v) && plain?.[k] !== v);
}

/** "MCCMNC codes" → "MCCMNC code", "HLR policies" → "HLR policy". */
const singular = (plural: string) => plural.replace(/ies$/, "y").replace(/s$/, "");

const fmtCount = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2));

/** The single delete's gate (archiveGate in enterprises.ts) for one row, without answering. */
function judge(
  deps: Dependencies | null,
  override: boolean,
): { ok: true; warnings: string[]; overridden: boolean } | { ok: false; reason: string; overridable: boolean } {
  if (!deps) return { ok: true, warnings: [], overridden: false };
  const counted = (i: Dependencies["items"][number]) => i.count !== null && i.count !== 0;
  // Blockers nobody can override (team trial round 3), e.g. an enterprise's live trunks.
  const hard = deps.items.filter((i) => i.blocking && i.noOverride && i.count);
  if (hard.length)
    return {
      ok: false,
      reason: hard.map((i) => `${i.label}: ${i.count}${i.detail ? ` (${i.detail})` : ""}`).join(", "),
      overridable: false,
    };
  const warnings = deps.items.filter((i) => !i.blocking && counted(i)).map((i) => `${i.label}: ${fmtCount(i.count!)}`);
  if (deps.blocked && !override)
    return {
      ok: false,
      reason: `Settle these first: ${deps.items
        .filter((i) => i.blocking && counted(i))
        .map((i) => `${i.label} ${fmtCount(i.count!)}`)
        .join(", ")}`,
      overridable: true,
    };
  return { ok: true, warnings, overridden: deps.blocked };
}

/** Runs `fn` over the items with a few at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

type Done = BulkRecordsResult["done"][number] & { overridden?: boolean };
type Refused = BulkRecordsResult["refused"][number];

async function evaluate(
  pool: pg.Pool,
  kind: BulkKind,
  def: ListDef<unknown>,
  ids: number[],
  mode: "delete" | "restore",
  override: boolean,
): Promise<{ done: Done[]; refused: Refused[] }> {
  const { seen, plain } = await loadRows(pool, def, ids);
  const verdicts = new Map<number, Done | Refused>();
  await eachLimited(ids, 8, async (id) => {
    const r = seen.get(id);
    const no = (reason: string, overridable = false, name = r ? recordName(kind, r) : `#${id}`) =>
      verdicts.set(id, { id, name, reason, overridable });
    // A record the policy hides is not in the list at all; a masked one is another account manager's (§13.17).
    if (!r) return void no("Not found, or hidden by your visibility policy");
    const name = recordName(kind, r);
    if (masked(r, plain.get(id))) return void no("Another account manager's record (masked by your visibility policy)");
    const refused = await kind.guard?.(pool, id);
    if (refused) return void no(refused);
    if (mode === "delete") {
      if (isArchived(r)) return void no("Already deleted");
      const why = kind.refuse?.(r);
      if (why) return void no(why);
      const verdict = judge(kind.deps ? await kind.deps(pool, id, r) : null, override);
      if (!verdict.ok) return void no(verdict.reason, verdict.overridable);
      verdicts.set(id, { id, name, warnings: verdict.warnings, overridden: verdict.overridden });
      return;
    }
    if (!isArchived(r)) return void no("Not deleted");
    if (kind.liveKey) {
      const k = kind.liveKey;
      const { rows } = await pool.query(
        `SELECT 1 FROM ${kind.table} x JOIN ${kind.table} t ON ${k.sql("x")} = ${k.sql("t")}
          WHERE t.id = $1 AND x.id <> t.id AND x.deleted_at IS NULL LIMIT 1`,
        [id],
      );
      if (rows[0]) return void no(`Another live record has this ${k.what}`);
    }
    const clash = await kind.restoreRefuse?.(pool, id, r);
    if (clash) return void no(clash);
    verdicts.set(id, { id, name, warnings: [] });
  });
  const done: Done[] = [];
  const refused: Refused[] = [];
  for (const id of ids) {
    const v = verdicts.get(id)!;
    if ("reason" in v) refused.push(v);
    else done.push(v);
  }
  return { done, refused };
}

async function archiveOne(c: pg.PoolClient, kind: BulkKind, id: number, userId: number): Promise<DiffEntry[]> {
  if (kind.archive) return kind.archive(c, id, userId);
  await c.query(
    `UPDATE ${kind.table} SET deleted_at = now()${kind.deletedBy ? ", deleted_by_id = $2" : ""} WHERE id = $1`,
    kind.deletedBy ? [id, userId] : [id],
  );
  await kind.onArchive?.(c, id);
  return [archived(id, true)];
}

async function restoreOne(c: pg.PoolClient, kind: BulkKind, id: number, userId: number): Promise<DiffEntry[]> {
  if (kind.restore) return kind.restore(c, id, userId);
  const touch = kind.restoreTouch === "by" ? ", updated_by_id = $2, updated_at = now()" : kind.restoreTouch === "at" ? ", updated_at = now()" : "";
  await c.query(
    `UPDATE ${kind.table} SET deleted_at = NULL${kind.deletedBy ? ", deleted_by_id = NULL" : ""}${touch} WHERE id = $1`,
    kind.restoreTouch === "by" ? [id, userId] : [id],
  );
  return [archived(id, false)];
}

// ---------------------------------------------------------------- handlers

function bulk(mode: "delete" | "restore") {
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { list } = request.params as { list: ListId };
    const body = request.body as BulkRecordsRequest;
    const kind = BULK_KINDS[list];
    const def = (listDefs as Partial<Record<string, ListDef<unknown>>>)[list];
    const op = mode === "delete" ? listArchiveOp(list) : listRestoreOp(list);
    if (!kind || !def || !op)
      return sendProblem(reply, 400, `This list's rows have no ${mode === "delete" ? "Delete" : "Restore"}`);
    const ids = [...new Set(body.ids)];
    const reason = body.reason?.trim() || null;
    const override = mode === "delete" && body.override === true;
    return withDb(reply, async (pool) => {
      const me: CurrentUser = await getCurrentUser();
      if (!mayRun(me.permissions, op))
        return sendProblem(reply, 403, "Your access group does not allow this", {
          detail: `${mode === "delete" ? "Deleting" : "Restoring"} ${list.replaceAll("_", " ")} is not given to your user. Ask an administrator.`,
          code: "not_allowed",
        });
      if (mode === "restore" && !kind.restoreAnyone && !isAdmin(me))
        return sendProblem(reply, 403, "Only administrators can restore archived records");
      if (override && !isAdmin(me)) return sendProblem(reply, 403, "Only administrators can override delete blockers");
      if (override && !reason)
        return sendProblem(reply, 400, "An override needs a written reason", {
          errors: [{ path: "/reason", message: "required with override" }],
        });
      const { done, refused } = await evaluate(pool, kind, def, ids, mode, override);
      const answer = (change: BulkRecordsResult["change"], rows: Done[]): BulkRecordsResult => ({
        dryRun: body.dryRun === true,
        done: rows.map(({ id, name, warnings }) => ({ id, name, warnings })),
        refused,
        change,
      });
      if (body.dryRun || !done.length) return answer(null, done);
      const saved: Done[] = [];
      const change = await inTransaction(pool, async (c) => {
        const diff: DiffEntry[] = [];
        for (const row of done) {
          // A row that clashes after all (a unique name taken meanwhile) is refused; the others go on.
          await c.query("SAVEPOINT bulk_row");
          try {
            diff.push(...(await (mode === "delete" ? archiveOne : restoreOne)(c, kind, row.id, me.id)));
            await c.query("RELEASE SAVEPOINT bulk_row");
            saved.push(row);
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            await c.query("ROLLBACK TO SAVEPOINT bulk_row");
            refused.push({ id: row.id, name: row.name, reason: "Another live record has the same name or code", overridable: false });
          }
        }
        if (!saved.length) return null;
        const what = `${saved.length} ${saved.length === 1 ? singular(kind.plural) : kind.plural}`;
        const overridden = saved.some((r) => r.overridden);
        return recordChange(c, {
          entityType: kind.entityType,
          entityIds: saved.map((r) => r.id),
          changeType: mode === "delete" ? "delete" : "edit",
          diff,
          note: [
            `${mode === "delete" ? "Deleted" : "Restored"} ${what}`,
            overridden ? `Override: ${reason}` : reason,
          ]
            .filter(Boolean)
            .join(" – "),
          userId: me.id,
          ip: request.ip,
        });
      });
      if (change) {
        kind.after?.();
        // What these records feed: routing costs, route maps and live routes, and who sees which enterprise.
        clearRoutingCostCache();
        clearRouteMaps();
        invalidateLiveRoutes();
        if (list === "enterprises") clearVisibilityCache();
      }
      return answer(change, saved);
    });
  };
}

export const bulkDeleteRecords = bulk("delete");
export const bulkRestoreRecords = bulk("restore");
