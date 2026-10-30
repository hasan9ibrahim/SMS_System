// Enterprise record (§5.1–5.3): General info, contacts, billing, beneficiary, docs,
// account manager history and handover (§13.30), safe delete (§13.29). Every save writes
// one change with a field-level diff (§13.10) that undo can apply back.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  AmPeriod,
  ArchiveRequest,
  BillingSide,
  BillingSideInput,
  Contact,
  DependencyItem,
  EnterpriseBilling,
  EnterpriseBillingInput,
  EnterpriseDetail,
  EnterpriseDoc,
  EnterpriseDocUpload,
  EnterpriseInput,
  HandoverRequest,
} from "@sms/contract";
import { withDb } from "../db.js";
import { enterpriseList } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";
import {
  archivedInfo,
  dependencies,
  diffPaths,
  flatten,
  getPath,
  insertRow,
  isAdmin,
  isTimezone,
  iso,
  recordChange,
  rowToObject,
  same,
  selectSpecs,
  setPath,
  updateColumns,
  type DiffEntry,
  type FieldError,
  type FieldSpec,
} from "./records.js";
import { maskEnterpriseDetail, refuseMasked } from "../visibility/records.js";
import { currentViewer } from "../visibility/context.js";
import { resolveSql } from "../visibility/sql.js";
import { companyDetails, companyPlaceholders, companyTemplate, logEmail } from "./emailLog.js";
import { fillBody, fillText } from "../email/html.js";
import { platformDateTime } from "../platform.js";
import { money } from "../currency.js";

type Db = pg.Pool | pg.PoolClient;

// ---------------------------------------------------------------- field maps

const SPECS: FieldSpec[] = [
  { api: "name", col: "name" },
  { api: "alias", col: "alias" },
  { api: "type", col: "type" },
  { api: "tier", col: "tier" },
  { api: "status", col: "status" },
  { api: "businessCompanyId", col: "business_company_id" },
  { api: "bindAlert", col: "bind_alert" },
  { api: "creditAlert", col: "credit_alert" },
  { api: "creditAlertPercent.notice", col: "credit_alert_notice" },
  { api: "creditAlertPercent.warning", col: "credit_alert_warning" },
  { api: "creditAlertPercent.critical", col: "credit_alert_critical" },
  { api: "address.line1", col: "address_line1" },
  { api: "address.line2", col: "address_line2" },
  { api: "address.city", col: "city" },
  { api: "address.state", col: "state" },
  { api: "address.countryId", col: "country_id" },
  { api: "address.zip", col: "zip" },
  { api: "website", col: "website" },
  { api: "fax", col: "fax" },
  { api: "registrationNumber", col: "registration_number" },
  { api: "vatNumber", col: "vat_number" },
  { api: "accountNumber", col: "account_number" },
  { api: "billingTimezone", col: "billing_timezone" },
  { api: "rateNoticeDays", col: "rate_notice_days" },
  { api: "rateNoticeDaysDecrease", col: "rate_notice_days_decrease" },
  { api: "rateNoticeDaysNew", col: "rate_notice_days_new" },
  { api: "allNetworksCode", col: "all_networks_code" },
];

const CONTACT_TYPES = ["commercial", "technical", "rates", "finance"] as const;
const CONTACT_COLS = { name: "name", phone: "phone", emails: "emails" } as const;
const CONTACT_PATHS = CONTACT_TYPES.flatMap((t) => Object.keys(CONTACT_COLS).map((p) => `contacts.${t}.${p}`));

const BILLING_SPECS: FieldSpec[] = [
  { api: "currency", col: "currency" },
  { api: "billingCycleId", col: "billing_cycle_id" },
  { api: "timezone", col: "timezone" },
  { api: "billingType", col: "billing_type" },
  { api: "creditLimit", col: "credit_limit" },
  { api: "openingBalance", col: "opening_balance" },
  { api: "autoInvoicing", col: "auto_invoicing" },
  { api: "sendPaymentConfirmation", col: "send_payment_confirmation" },
  { api: "description", col: "description" },
  // Prepaid vendor balance alerts (Q22, product owner 2026-10-25, migration 073).
  { api: "balanceAlert", col: "balance_alert" },
  { api: "balanceAlertPercent.notice", col: "balance_alert_notice" },
  { api: "balanceAlertPercent.warning", col: "balance_alert_warning" },
  { api: "balanceAlertPercent.critical", col: "balance_alert_critical" },
];

const BENEFICIARY_SPECS: FieldSpec[] = [
  { api: "beneficiaryName", col: "beneficiary_name" },
  { api: "address", col: "address" },
  { api: "bank", col: "bank" },
  { api: "bankAddress", col: "bank_address" },
  { api: "currency", col: "currency" },
  { api: "accountNumber", col: "account_number" },
  { api: "iban", col: "iban" },
  { api: "swift", col: "swift" },
  { api: "walletAddress", col: "wallet_address" },
];

const SIDES = ["customer", "vendor"] as const;
type Side = (typeof SIDES)[number];
/** Which billing sides an enterprise type has (§5.3). */
const sidesOf = (type: string): Side[] =>
  type === "reciprocal" ? ["customer", "vendor"] : type === "vendor" ? ["vendor"] : ["customer"];

// ---------------------------------------------------------------- loading

/** Applies handovers whose effective time has passed (the backend runs this as a job, §13.30). */
async function applyDueHandovers(db: Db, id: number) {
  await db.query(
    `UPDATE enterprises e SET account_manager_id = h.user_id
       FROM enterprise_am_history h
      WHERE e.id = $1 AND h.enterprise_id = e.id AND h.starts_at <= now() AND (h.ends_at IS NULL OR h.ends_at > now())
        AND e.account_manager_id IS DISTINCT FROM h.user_id`,
    [id],
  );
}

export async function loadEnterprise(db: Db, id: number): Promise<EnterpriseDetail | null> {
  await applyDueHandovers(db, id);
  // The list's select names trunks through visibility rules; resolve them for this viewer (§13.17).
  const { rows } = await db.query(
    `SELECT ${resolveSql(enterpriseList.select, await currentViewer())}, ${selectSpecs("e", SPECS)}, du.username AS deleted_by,
            (SELECT count(*)::int FROM customer_trunks t WHERE t.enterprise_id = e.id AND t.deleted_at IS NULL) AS ct_count,
            (SELECT count(*)::int FROM vendor_trunks t WHERE t.enterprise_id = e.id AND t.deleted_at IS NULL) AS vt_count
       FROM ${enterpriseList.from} LEFT JOIN users du ON du.id = e.deleted_by_id
      WHERE e.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const { rows: contactRows } = await db.query(
    "SELECT contact_type, name, phone, emails FROM enterprise_contacts WHERE enterprise_id = $1",
    [id],
  );
  const contacts = Object.fromEntries(
    CONTACT_TYPES.map((t) => {
      const c = contactRows.find((x) => x.contact_type === t);
      return [t, { name: c?.name ?? null, phone: c?.phone ?? null, emails: c?.emails ?? [] } satisfies Contact];
    }),
  ) as EnterpriseDetail["contacts"];
  return {
    ...enterpriseList.mapRow(r),
    ...(rowToObject(r, SPECS) as Partial<EnterpriseDetail>),
    contacts,
    archived: archivedInfo(r.archived_at, r.deleted_by),
    trunkCounts: { customer: r.ct_count, vendor: r.vt_count },
  } as EnterpriseDetail;
}

// ---------------------------------------------------------------- checks

const normContact = (c: Contact | undefined): Contact => ({
  name: c?.name?.trim() || null,
  phone: c?.phone?.trim() || null,
  emails: (c?.emails ?? []).map((e) => e.trim().toLowerCase()),
});

async function checkInput(db: Db, input: EnterpriseInput, id: number | null): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  // Archived names stay reserved (§13.29), so the check includes archived enterprises.
  const { rows: clash } = await db.query(
    `SELECT id, name, deleted_at FROM enterprises WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1`,
    [input.name.trim(), id],
  );
  if (clash[0]) {
    errors.push({
      path: "/name",
      message: `already used by ${clash[0].name} (${clash[0].id})${clash[0].deleted_at ? ", archived: rename that one with a suffix first" : ""}`,
    });
  }
  const { rows: bc } = await db.query("SELECT 1 FROM business_companies WHERE id = $1 AND deleted_at IS NULL", [
    input.businessCompanyId,
  ]);
  if (!bc[0]) errors.push({ path: "/businessCompanyId", message: "unknown business company" });
  // The country is required (team trial round 4).
  if (input.address.countryId == null) errors.push({ path: "/address/countryId", message: "required" });
  else {
    const { rows } = await db.query("SELECT 1 FROM countries WHERE id = $1", [input.address.countryId]);
    if (!rows[0]) errors.push({ path: "/address/countryId", message: "unknown country" });
  }
  const p = input.creditAlertPercent;
  if (!(p.notice < p.warning && p.warning < p.critical))
    errors.push({ path: "/creditAlertPercent", message: "levels must rise: notice < warning < critical" });
  if (input.billingTimezone !== undefined && !isTimezone(input.billingTimezone))
    errors.push({ path: "/billingTimezone", message: "unknown time zone" });
  if (id === null) {
    if (input.accountManagerId === undefined)
      errors.push({ path: "/accountManagerId", message: "required when adding an enterprise" });
    else if (!(await isAccountManager(db, input.accountManagerId)))
      errors.push({ path: "/accountManagerId", message: "not an active account manager" });
  }
  return errors;
}

async function isAccountManager(db: Db, userId: number) {
  const { rows } = await db.query(
    "SELECT 1 FROM users WHERE id = $1 AND is_account_manager AND status = 'active' AND deleted_at IS NULL",
    [userId],
  );
  return !!rows[0];
}

const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

async function writeContact(c: pg.PoolClient, id: number, type: string, contact: Contact) {
  await c.query(
    `INSERT INTO enterprise_contacts (enterprise_id, contact_type, name, phone, emails) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (enterprise_id, contact_type)
     DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, emails = EXCLUDED.emails, updated_at = now()`,
    [id, type, contact.name, contact.phone, contact.emails],
  );
}

// ---------------------------------------------------------------- general info

export function getEnterprise(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    // Archived enterprises stay readable (§13.29: history and billing keep their names).
    const e = await loadEnterprise(pool, id);
    // Another AM's enterprise is masked for a viewer with a visibility policy (§13.17).
    return e ? maskEnterpriseDetail(e) : sendProblem(reply, 404, `Enterprise ${id} not found`);
  });
}

export function createEnterprise(request: FastifyRequest, reply: FastifyReply) {
  const input = request.body as EnterpriseInput;
  // A vendor has no client account number (team trial round 4).
  if (input.type === "vendor") input.accountNumber = null;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const errors = await checkInput(pool, input, null);
    if (errors.length) return badInput(reply, errors);
    const { id, change } = await inTransaction(pool, async (c) => {
      const values = flatten({ ...input, name: input.name.trim(), alias: input.alias.trim() }, SPECS);
      const id = await insertRow(c, "enterprises", SPECS, values, {
        account_manager_id: input.accountManagerId,
        created_by_id: me.id,
        updated_by_id: me.id,
      });
      for (const t of CONTACT_TYPES) await writeContact(c, id, t, normContact(input.contacts[t]));
      await c.query(
        `INSERT INTO enterprise_am_history (enterprise_id, user_id, starts_at, note, created_by_id)
         VALUES ($1, $2, now(), 'Initial assignment', $3)`,
        [id, input.accountManagerId, me.id],
      );
      const change = await recordChange(c, {
        entityType: "enterprise",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: values.name }],
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadEnterprise(pool, id), change });
  });
}

export function updateEnterprise(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const input = request.body as EnterpriseInput;
  if (input.type === "vendor") input.accountNumber = null;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const before = await loadEnterprise(pool, id);
    if (!before) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    if (await refuseMasked(reply, id)) return reply;
    if (before.archived) return sendProblem(reply, 400, "This enterprise is archived; restore it before editing");
    const errors = await checkInput(pool, input, id);
    if (input.type !== before.type && input.type !== "reciprocal" && before.type !== "reciprocal")
      // Team trial round 4: a customer or a vendor can only become Bilateral, never the other side. Round 6: a
      // Bilateral partner can become a customer when it has no vendor trunks, or a vendor with no customer trunks
      // (checked below).
      errors.push({ path: "/type", message: "a customer or a vendor can only be changed to Bilateral" });
    if (input.type !== before.type) {
      // A side that has trunks can't disappear (§5.3: trunks need their billing side).
      const keep = sidesOf(input.type);
      if (!keep.includes("customer") && before.trunkCounts.customer > 0)
        errors.push({
          path: "/type",
          message: `has ${before.trunkCounts.customer} customer trunks; archive them first`,
        });
      if (!keep.includes("vendor") && before.trunkCounts.vendor > 0)
        errors.push({ path: "/type", message: `has ${before.trunkCounts.vendor} vendor trunks; archive them first` });
    }
    if (errors.length) return badInput(reply, errors);

    // Omitted optional fields keep their value; contacts are always sent whole.
    const after = structuredClone(before) as unknown as Record<string, unknown>;
    const values = flatten({ ...input, name: input.name.trim(), alias: input.alias.trim() }, SPECS);
    for (const [path, v] of Object.entries(values)) if (v !== undefined) setPath(after, path, v);
    for (const t of CONTACT_TYPES) setPath(after, `contacts.${t}`, normContact(input.contacts[t]));
    const diff = diffPaths(id, before, after, [...SPECS.map((s) => s.api), ...CONTACT_PATHS]);
    if (diff.length === 0) return { record: before, change: null };

    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) await applyEnterpriseField(c, id, d.field, d.after, d.before, me.id);
      await c.query("UPDATE enterprises SET updated_by_id = $2, updated_at = now() WHERE id = $1", [id, me.id]);
      const onlyStatus = diff.length === 1 && diff[0]!.field === "status";
      return recordChange(c, {
        entityType: "enterprise",
        entityIds: [id],
        changeType: onlyStatus ? (diff[0]!.after === "active" ? "enable" : "disable") : "edit",
        diff,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadEnterprise(pool, id), change };
  });
}

// ---------------------------------------------------------------- undo support

/**
 * Sets one recorded field back (undo, §13.10). `value` is the value to restore, `other`
 * the one it replaces (needed for set-like fields such as the trunks archived with it).
 */
export async function applyEnterpriseField(
  c: pg.PoolClient,
  id: number,
  field: string,
  value: unknown,
  other: unknown,
  userId: number,
): Promise<void> {
  const spec = SPECS.find((s) => s.api === field);
  if (spec) return updateColumns(c, "enterprises", id, [spec], { [field]: value }, userId);

  const [head, a, ...rest] = field.split(".");
  const b = rest.join(".");
  if (head === "contacts" && a && b && b in CONTACT_COLS) {
    await c.query(
      `UPDATE enterprise_contacts SET ${CONTACT_COLS[b as keyof typeof CONTACT_COLS]} = $3, updated_at = now()
        WHERE enterprise_id = $1 AND contact_type = $2`,
      [id, a, value],
    );
    return;
  }
  if (head === "billing" && (a === "customer" || a === "vendor")) {
    if (!b) {
      if (value === null)
        await c.query("DELETE FROM enterprise_billing WHERE enterprise_id = $1 AND side = $2", [id, a]);
      else await upsertBillingSide(c, id, a, value as BillingSideInput, userId);
      return;
    }
    const s = BILLING_SPECS.find((x) => x.api === b);
    if (s)
      await c.query(
        `UPDATE enterprise_billing SET ${s.col} = $3, updated_by_id = $4, updated_at = now() WHERE enterprise_id = $1 AND side = $2`,
        [id, a, value, userId],
      );
    return;
  }
  if (head === "beneficiary" && a) {
    const s = BENEFICIARY_SPECS.find((x) => x.api === a);
    if (s)
      await c.query(
        `INSERT INTO enterprise_beneficiaries (enterprise_id, ${s.col}) VALUES ($1, $2)
         ON CONFLICT (enterprise_id) DO UPDATE SET ${s.col} = EXCLUDED.${s.col}, updated_at = now()`,
        [id, value],
      );
    return;
  }
  if (field === "accountManagers") {
    await c.query("DELETE FROM enterprise_am_history WHERE enterprise_id = $1", [id]);
    for (const p of (value as AmRow[]) ?? []) {
      await c.query(
        `INSERT INTO enterprise_am_history (enterprise_id, user_id, starts_at, ends_at, note, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, p.userId, p.startsAt, p.endsAt, p.note, userId],
      );
    }
    await applyDueHandovers(c, id);
    return;
  }
  if (field === "archived") {
    await c.query(
      `UPDATE enterprises SET deleted_at = ${value ? "now()" : "NULL"}, deleted_by_id = ${value ? "$2" : "NULL"} WHERE id = $1`,
      value ? [id, userId] : [id],
    );
    return;
  }
  if (field === "archivedCustomerTrunkIds" || field === "archivedVendorTrunkIds") {
    const table = field === "archivedCustomerTrunkIds" ? "customer_trunks" : "vendor_trunks";
    const want = new Set((value as number[] | null) ?? []);
    const had = new Set((other as number[] | null) ?? []);
    const archive = [...want].filter((x) => !had.has(x));
    const restore = [...had].filter((x) => !want.has(x));
    if (archive.length)
      await c.query(`UPDATE ${table} SET deleted_at = now(), deleted_by_id = $2 WHERE id = ANY($1)`, [archive, userId]);
    if (restore.length)
      await c.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by_id = NULL WHERE id = ANY($1)`, [restore]);
  }
}

// ---------------------------------------------------------------- billing (§5.3)

/** Live balances (§7, `balance_ledger`, migrations 072–073): opening + payments − invoices − traffic since the
 * last invoice, in each side's currency (positive = the partner's credit, negative = owed). */
async function sideBalances(db: Db, id: number): Promise<Record<Side, number>> {
  const { rows } = await db.query("SELECT side, balance FROM balance_ledger WHERE enterprise_id = $1", [id]);
  const of = (side: Side) => Number(rows.find((r) => r.side === side)?.balance ?? 0);
  return { customer: of("customer"), vendor: of("vendor") };
}

async function loadBilling(db: Db, id: number): Promise<EnterpriseBilling> {
  const { rows } = await db.query(
    `SELECT b.side, ${selectSpecs("b", BILLING_SPECS)}, bc.name AS cycle_name, u.username AS updated_by, b.updated_at
       FROM enterprise_billing b JOIN billing_cycles bc ON bc.id = b.billing_cycle_id
       LEFT JOIN users u ON u.id = b.updated_by_id
      WHERE b.enterprise_id = $1`,
    [id],
  );
  const balances = await sideBalances(db, id);
  const side = (s: Side): BillingSide | null => {
    const r = rows.find((x) => x.side === s);
    if (!r) return null;
    return {
      ...(rowToObject(r, BILLING_SPECS) as unknown as BillingSideInput),
      balance: money(balances[s]),
      billingCycleName: r.cycle_name,
      updatedBy: r.updated_by ?? null,
      updatedAt: iso(r.updated_at)!,
    };
  };
  const { rows: ben } = await db.query(
    `SELECT ${selectSpecs("x", BENEFICIARY_SPECS)} FROM enterprise_beneficiaries x WHERE x.enterprise_id = $1`,
    [id],
  );
  return {
    customer: side("customer"),
    vendor: side("vendor"),
    beneficiary: ben[0]
      ? (rowToObject(ben[0], BENEFICIARY_SPECS) as EnterpriseBilling["beneficiary"])
      : Object.fromEntries(BENEFICIARY_SPECS.map((s) => [s.api, null])),
  };
}

async function upsertBillingSide(c: pg.PoolClient, id: number, side: Side, input: BillingSideInput, userId: number) {
  const v = sideValues(side, input);
  await c.query(
    `INSERT INTO enterprise_billing (enterprise_id, side, ${BILLING_SPECS.map((s) => s.col).join(", ")}, updated_by_id)
     VALUES ($1, $2, ${BILLING_SPECS.map((_, i) => `$${i + 3}`).join(", ")}, $${BILLING_SPECS.length + 3})
     ON CONFLICT (enterprise_id, side) DO UPDATE SET
       ${BILLING_SPECS.map((s) => `${s.col} = EXCLUDED.${s.col}`).join(", ")}, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`,
    [id, side, ...BILLING_SPECS.map((s) => v[s.api]), userId],
  );
}

/** Customer-only fields are cleared on the vendor side; credit limit is postpaid only. A vendor may be prepaid
 * (we pay it in advance), with balance alerts (Q22, product owner 2026-10-25). */
function sideValues(side: Side, input: BillingSideInput): Record<string, unknown> {
  const customer = side === "customer";
  const billingType = input.billingType ?? "postpaid";
  const levels = input.balanceAlertPercent ?? { notice: 50, warning: 70, critical: 90 };
  return {
    balanceAlert: input.balanceAlert ?? true,
    "balanceAlertPercent.notice": levels.notice,
    "balanceAlertPercent.warning": levels.warning,
    "balanceAlertPercent.critical": levels.critical,
    currency: input.currency.toUpperCase(),
    billingCycleId: input.billingCycleId,
    timezone: input.timezone,
    billingType,
    creditLimit: customer && billingType === "postpaid" ? (input.creditLimit ?? null) : null,
    openingBalance: input.openingBalance,
    autoInvoicing: customer ? (input.autoInvoicing ?? true) : false, // on by default (team trial round 2)
    sendPaymentConfirmation: input.sendPaymentConfirmation ?? false,
    description: input.description?.trim() || null,
  };
}

export function getEnterpriseBilling(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM enterprises WHERE id = $1", [id]);
    if (!rows[0]) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    return loadBilling(pool, id);
  });
}

export function updateEnterpriseBilling(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const input = request.body as EnterpriseBillingInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const ent = await loadEnterprise(pool, id);
    if (!ent) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    if (ent.archived) return sendProblem(reply, 400, "This enterprise is archived; restore it before editing");
    const before = await loadBilling(pool, id);
    const errors: FieldError[] = [];
    const allowed = sidesOf(ent.type);
    for (const side of SIDES) {
      const s = input[side];
      if (!s) continue;
      if (!allowed.includes(side)) {
        errors.push({ path: `/${side}`, message: `a ${ent.type} has no ${side} billing` });
        continue;
      }
      const { rows: cur } = await pool.query("SELECT 1 FROM currencies WHERE iso = $1", [s.currency.toUpperCase()]);
      if (!cur[0]) errors.push({ path: `/${side}/currency`, message: "unknown currency" });
      const { rows: cyc } = await pool.query("SELECT 1 FROM billing_cycles WHERE id = $1 AND deleted_at IS NULL", [
        s.billingCycleId,
      ]);
      if (!cyc[0]) errors.push({ path: `/${side}/billingCycleId`, message: "unknown billing cycle" });
      if (!isTimezone(s.timezone)) errors.push({ path: `/${side}/timezone`, message: "unknown time zone" });
      const lv = s.balanceAlertPercent;
      if (lv && !(lv.notice < lv.warning && lv.warning < lv.critical))
        errors.push({ path: `/${side}/balanceAlertPercent`, message: "levels must rise: notice < warning < critical" });
      // Invoices are issued in the side's currency; changing it would break balances.
      const old = before[side];
      if (old && old.currency !== s.currency.toUpperCase()) {
        const { rows: docs } = await pool.query(
          side === "customer"
            ? "SELECT 1 FROM invoices WHERE enterprise_id = $1 AND deleted_at IS NULL LIMIT 1"
            : "SELECT 1 FROM vendor_invoices WHERE enterprise_id = $1 AND deleted_at IS NULL LIMIT 1",
          [id],
        );
        if (docs[0]) errors.push({ path: `/${side}/currency`, message: "can't change once invoices exist" });
      }
    }
    // A bilateral partner is billed in one currency (team trial round 12): the vendor side takes the customer side's.
    // Sides saved apart before keep their currencies until one of them changes.
    const cur = (s: { currency: string } | null | undefined) => s?.currency.toUpperCase() ?? null;
    const customer = cur(input.customer ?? before.customer);
    const vendor = cur(input.vendor ?? before.vendor);
    const changed =
      (!!input.customer && cur(input.customer) !== cur(before.customer)) ||
      (!!input.vendor && cur(input.vendor) !== cur(before.vendor));
    if (customer && vendor && customer !== vendor && changed)
      errors.push({ path: "/vendor/currency", message: `uses the customer billing's currency (${customer})` });
    if (errors.length) return badInput(reply, errors);

    const diff: DiffEntry[] = [];
    for (const side of SIDES) {
      const s = input[side];
      if (!s) continue;
      const next = sideValues(side, s);
      const old = before[side];
      if (!old) diff.push({ entity_id: id, field: `billing.${side}`, before: null, after: next });
      else
        for (const spec of BILLING_SPECS) {
          const b = getPath(old, spec.api) ?? null;
          if (!same(b, next[spec.api]))
            diff.push({ entity_id: id, field: `billing.${side}.${spec.api}`, before: b, after: next[spec.api] });
        }
    }
    // Credit alert follows the customer credit limit (team trial round 2): a non-zero limit ticks it, no limit unticks
    // it. Part of the same save, so one undo restores both.
    const cust = input.customer ? sideValues("customer", input.customer) : null;
    if (cust) {
      const oldLimit = Number(before.customer?.creditLimit ?? 0);
      const newLimit = Number(cust.creditLimit ?? 0);
      const want = newLimit > 0 ? (oldLimit > 0 ? ent.creditAlert : true) : false;
      if (want !== ent.creditAlert)
        diff.push({ entity_id: id, field: "creditAlert", before: ent.creditAlert, after: want });
    }
    if (input.beneficiary) {
      for (const spec of BENEFICIARY_SPECS) {
        const raw = getPath(input.beneficiary, spec.api);
        if (raw === undefined) continue;
        const next = typeof raw === "string" ? raw.trim() || null : raw;
        const b = getPath(before.beneficiary, spec.api) ?? null;
        if (!same(b, next)) diff.push({ entity_id: id, field: `beneficiary.${spec.api}`, before: b, after: next });
      }
    }
    if (diff.length === 0) return { record: before, change: null };
    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) await applyEnterpriseField(c, id, d.field, d.after, d.before, me.id);
      return recordChange(c, {
        entityType: "enterprise",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: "Billing",
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadBilling(pool, id), change };
  });
}

// ---------------------------------------------------------------- account managers (§13.30)

interface AmRow {
  userId: number;
  startsAt: string;
  endsAt: string | null;
  note: string | null;
}

async function amRows(db: Db, id: number): Promise<AmRow[]> {
  const { rows } = await db.query(
    "SELECT user_id, starts_at, ends_at, note FROM enterprise_am_history WHERE enterprise_id = $1 ORDER BY starts_at",
    [id],
  );
  return rows.map((r) => ({ userId: r.user_id, startsAt: iso(r.starts_at)!, endsAt: iso(r.ends_at), note: r.note }));
}

async function amPeriods(db: Db, id: number): Promise<AmPeriod[]> {
  const { rows } = await db.query(
    `SELECT h.user_id, u.first_name || ' ' || u.last_name AS user_name, h.starts_at, h.ends_at, h.note
       FROM enterprise_am_history h JOIN users u ON u.id = h.user_id
      WHERE h.enterprise_id = $1 ORDER BY h.starts_at DESC`,
    [id],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    userName: r.user_name,
    startsAt: iso(r.starts_at)!,
    endsAt: iso(r.ends_at),
    note: r.note ?? null,
  }));
}

export function getAccountManagerHistory(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM enterprises WHERE id = $1", [id]);
    if (!rows[0]) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    await applyDueHandovers(pool, id);
    return amPeriods(pool, id);
  });
}

export function handOverEnterprise(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const input = request.body as HandoverRequest;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const ent = await loadEnterprise(pool, id);
    if (!ent) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    if (ent.archived) return sendProblem(reply, 400, "This enterprise is archived; restore it first");
    const errors: FieldError[] = [];
    if (!(await isAccountManager(pool, input.userId)))
      errors.push({ path: "/userId", message: "not an active account manager" });
    const now = Date.now();
    const at = input.effectiveAt ? new Date(input.effectiveAt).getTime() : now;
    // Past results stay with the AM who earned them, so a handover can't start in the past.
    if (at < now - 60_000) errors.push({ path: "/effectiveAt", message: "can't be in the past" });
    if (input.userId === ent.accountManagerId && at <= now + 60_000)
      errors.push({ path: "/userId", message: "is already the account manager" });
    if (input.templateId != null) {
      const { rows: t } = await pool.query(
        "SELECT 1 FROM email_templates WHERE id = $1 AND email_type = 'am_handover' AND deleted_at IS NULL",
        [input.templateId],
      );
      if (!t[0]) errors.push({ path: "/templateId", message: "not an AM handover e-mail template" });
    }
    if (errors.length) return badInput(reply, errors);

    const before = await amRows(pool, id);
    let emailed = 0;
    const change = await inTransaction(pool, async (c) => {
      const effective = new Date(Math.max(at, now)).toISOString();
      // A new handover replaces a scheduled one that hasn't started yet.
      await c.query("DELETE FROM enterprise_am_history WHERE enterprise_id = $1 AND starts_at > now()", [id]);
      await c.query(
        `UPDATE enterprise_am_history SET ends_at = $2
          WHERE id = (SELECT id FROM enterprise_am_history WHERE enterprise_id = $1 ORDER BY starts_at DESC LIMIT 1)`,
        [id, effective],
      );
      await c.query(
        `INSERT INTO enterprise_am_history (enterprise_id, user_id, starts_at, note, created_by_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          input.userId,
          effective,
          input.note?.trim() || (at > now + 60_000 ? "Scheduled handover" : "Handover"),
          me.id,
        ],
      );
      await applyDueHandovers(c, id);
      const after = await amRows(c, id);
      if (input.notify !== false)
        emailed = await sendHandoverEmail(c, id, ent.accountManagerId ?? null, input, effective);
      // The note names the new account manager (team trial round 12: "user 9" told the reader nothing).
      const { rows: to } = await c.query("SELECT first_name || ' ' || last_name AS name FROM users WHERE id = $1", [
        input.userId,
      ]);
      return recordChange(c, {
        entityType: "enterprise",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "accountManagers", before, after }],
        note: `Handover to ${to[0]?.name ?? `user ${input.userId}`} effective ${effective.slice(0, 16).replace("T", " ")} UTC`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { periods: await amPeriods(pool, id), change, emailed };
  });
}

/**
 * Tells the client about its new account manager (team trial round 2): the AM handover template (the one
 * picked, else the business company's), to the commercial contact (else rates), copying both AMs, from the
 * new AM. Logged in Email logs as am_handover. Answers how many e-mails were logged.
 */
async function sendHandoverEmail(
  c: pg.PoolClient,
  enterpriseId: number,
  oldAmId: number | null,
  input: HandoverRequest,
  effective: string,
): Promise<number> {
  const tpl =
    input.templateId != null
      ? (await c.query("SELECT id, subject, body FROM email_templates WHERE id = $1", [input.templateId])).rows[0]
      : await companyTemplate(c, { enterpriseId }, "am_handover");
  if (!tpl) return 0;
  const { rows: people } = await c.query(
    `SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.email, u.phone FROM users u WHERE u.id = ANY($1)`,
    [[input.userId, oldAmId].filter((x) => x !== null)],
  );
  const newAm = people.find((p) => Number(p.id) === input.userId);
  const oldAm = people.find((p) => Number(p.id) === oldAmId);
  const { rows: e } = await c.query(
    `SELECT e.name, (SELECT ct.emails FROM enterprise_contacts ct WHERE ct.enterprise_id = e.id
                      AND ct.contact_type IN ('commercial', 'rates') ORDER BY ct.contact_type = 'commercial' DESC LIMIT 1) AS emails
       FROM enterprises e WHERE e.id = $1`,
    [enterpriseId],
  );
  const vars: Record<string, string> = {
    ...companyPlaceholders(await companyDetails(c, { enterpriseId })),
    enterprise: String(e[0]?.name ?? ""),
    old_am: oldAm?.name ?? "your previous account manager",
    new_am: newAm?.name ?? "",
    new_am_email: newAm?.email ?? "",
    new_am_phone: newAm?.phone ?? "",
    new_am_phone_line: newAm?.phone ? ` or ${newAm.phone}` : "",
    effective_date: platformDateTime(effective),
    note: input.note?.trim() ?? "",
  };
  await logEmail(c, {
    type: "am_handover",
    enterpriseId,
    to: (e[0]?.emails as string[] | null) ?? [],
    cc: people.map((p) => String(p.email)).filter(Boolean),
    sender: newAm?.email ?? null,
    subject: fillText(String(tpl.subject), vars),
    body: fillBody(String(tpl.body), vars),
  });
  return 1;
}

// ---------------------------------------------------------------- docs (§5.2)

const MAX_DOC_BYTES = 10 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  zip: "application/zip",
};

const docRow = (r: Record<string, unknown>): EnterpriseDoc => ({
  id: r.id as number,
  name: r.name as string,
  fileName: r.file_name as string,
  contentType: r.content_type as string,
  size: r.size as number,
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: iso(r.inserted_at)!,
});

const DOC_SELECT = `SELECT d.id, d.name, d.file_name, d.content_type, d.size, u.username AS created_by, d.inserted_at
  FROM enterprise_docs d LEFT JOIN users u ON u.id = d.created_by_id`;

export function listEnterpriseDocs(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows: e } = await pool.query("SELECT 1 FROM enterprises WHERE id = $1", [id]);
    if (!e[0]) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    const { rows } = await pool.query(
      `${DOC_SELECT} WHERE d.enterprise_id = $1 AND d.deleted_at IS NULL ORDER BY d.inserted_at DESC, d.id DESC`,
      [id],
    );
    return rows.map(docRow);
  });
}

export function uploadEnterpriseDoc(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const input = request.body as EnterpriseDocUpload;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows: e } = await pool.query("SELECT deleted_at FROM enterprises WHERE id = $1", [id]);
    if (!e[0]) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    if (e[0].deleted_at) return sendProblem(reply, 400, "This enterprise is archived; restore it first");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64))
      return badInput(reply, [{ path: "/dataBase64", message: "not valid base64" }]);
    const data = Buffer.from(input.dataBase64, "base64");
    if (data.length === 0) return badInput(reply, [{ path: "/dataBase64", message: "the file is empty" }]);
    if (data.length > MAX_DOC_BYTES) return badInput(reply, [{ path: "/dataBase64", message: "larger than 10 MB" }]);
    const ext = input.fileName.split(".").pop()?.toLowerCase() ?? "";
    const contentType = input.contentType?.trim() || CONTENT_TYPES[ext] || "application/octet-stream";
    const doc = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO enterprise_docs (enterprise_id, name, file_name, content_type, size, data, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [id, input.name.trim(), input.fileName.trim(), contentType, data.length, data, me.id],
      );
      const docId = rows[0].id as number;
      await recordChange(c, {
        entityType: "enterprise_doc",
        entityIds: [docId],
        changeType: "create",
        diff: [{ entity_id: docId, field: "*", before: null, after: input.name.trim() }],
        note: `Document for enterprise ${id}`,
        userId: me.id,
        ip: request.ip,
      });
      const { rows: out } = await c.query(`${DOC_SELECT} WHERE d.id = $1`, [docId]);
      return docRow(out[0]);
    });
    return reply.code(201).send(doc);
  });
}

export function deleteEnterpriseDoc(request: FastifyRequest, reply: FastifyReply) {
  const { id, docId } = request.params as { id: number; docId: number };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      "SELECT name FROM enterprise_docs WHERE id = $1 AND enterprise_id = $2 AND deleted_at IS NULL",
      [docId, id],
    );
    if (!rows[0]) return sendProblem(reply, 404, `Document ${docId} not found`);
    // Delete archives (§13.29); undo restores it.
    await inTransaction(pool, async (c) => {
      await c.query("UPDATE enterprise_docs SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1", [docId, me.id]);
      await recordChange(c, {
        entityType: "enterprise_doc",
        entityIds: [docId],
        changeType: "delete",
        diff: [{ entity_id: docId, field: "archived", before: false, after: true }],
        note: `${rows[0].name} (enterprise ${id})`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return reply.code(204).send();
  });
}

export function downloadEnterpriseDoc(request: FastifyRequest, reply: FastifyReply) {
  const { id, docId } = request.params as { id: number; docId: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      "SELECT file_name, content_type, data FROM enterprise_docs WHERE id = $1 AND enterprise_id = $2 AND deleted_at IS NULL",
      [docId, id],
    );
    if (!rows[0]) return sendProblem(reply, 404, `Document ${docId} not found`);
    const name = String(rows[0].file_name).replace(/["\\\r\n]/g, "_");
    return reply
      .type("application/octet-stream")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("x-content-type", rows[0].content_type)
      .send(rows[0].data as Buffer);
  });
}

// ---------------------------------------------------------------- safe delete (§13.29)

async function enterpriseDependencies(db: Db, id: number) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM customer_trunks WHERE enterprise_id = $1 AND deleted_at IS NULL) AS customer_trunks,
       (SELECT count(*)::int FROM vendor_trunks WHERE enterprise_id = $1 AND deleted_at IS NULL) AS vendor_trunks,
       (SELECT count(*)::int FROM route_rules r WHERE r.deleted_at IS NULL AND (
          r.customer_trunk_ids && ARRAY(SELECT id FROM customer_trunks WHERE enterprise_id = $1 AND deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM route_rule_vendors v JOIN vendor_trunks t ON t.id = v.vendor_trunk_id
                      WHERE v.route_rule_id = r.id AND t.enterprise_id = $1 AND t.deleted_at IS NULL))) AS route_rules,
       (SELECT count(*)::int FROM invoices WHERE enterprise_id = $1 AND deleted_at IS NULL
          AND (payment_status <> 'paid' OR status IN ('pending', 'inprogress'))) AS unpaid_invoices,
       (SELECT count(*)::int FROM vendor_invoices WHERE enterprise_id = $1 AND deleted_at IS NULL
          AND recon_status = 'disputed') AS disputes`,
    [id],
  );
  const r = rows[0];
  const billing = await loadBilling(db, id);
  const items: DependencyItem[] = [
    { key: "live_binds", label: "Live binds", count: 0, blocking: true, detail: "Disconnect the trunks first" },
    // Team trial round 3: an enterprise with live trunks cannot be deleted, not even with an override.
    {
      key: "customer_trunks",
      label: "Customer trunks",
      count: r.customer_trunks,
      blocking: true,
      noOverride: true,
      detail: r.customer_trunks ? "Delete its customer trunks first" : null,
    },
    {
      key: "vendor_trunks",
      label: "Vendor trunks",
      count: r.vendor_trunks,
      blocking: true,
      noOverride: true,
      detail: r.vendor_trunks ? "Delete its vendor trunks first" : null,
    },
    {
      key: "route_rules",
      label: "Route rules using its trunks",
      count: r.route_rules,
      blocking: false,
      detail: "The trunks drop out of these rules",
    },
    {
      key: "unpaid_invoices",
      label: "Unpaid or draft invoices",
      count: r.unpaid_invoices,
      blocking: true,
      detail: r.unpaid_invoices ? "Settle or credit them first" : null,
    },
  ];
  for (const side of SIDES) {
    const b = billing[side];
    if (!b) continue;
    const open = Math.abs(b.balance) >= 0.01;
    items.push({
      key: side === "customer" ? "balance" : "vendor_balance",
      label: side === "customer" ? "Customer balance" : "Vendor balance",
      count: open ? b.balance : 0,
      blocking: true,
      detail: `${b.currency}${open ? " · settle to zero first" : ""}`,
    });
  }
  items.push(
    {
      key: "disputes",
      label: "Open disputes",
      count: r.disputes,
      blocking: true,
      detail: r.disputes ? "Partner invoices in mismatch or pending" : null,
    },
    {
      key: "traffic_30d",
      label: "Traffic in the last 30 days",
      count: null,
      blocking: false,
      detail: "Checked against the EDR store by the backend",
    },
  );
  return dependencies(items);
}

export function getEnterpriseDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM enterprises WHERE id = $1", [id]);
    if (!rows[0]) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    return enterpriseDependencies(pool, id);
  });
}

/** Shared archive rules: blocked items need an admin override with a written reason. */
export async function archiveGate(
  reply: FastifyReply,
  body: ArchiveRequest,
  deps: Awaited<ReturnType<typeof enterpriseDependencies>>,
): Promise<{ ok: true; note: string | null } | { ok: false; reply: FastifyReply }> {
  const me = await getCurrentUser();
  const reason = body.reason?.trim() || null;
  // Blockers nobody can override (team trial round 3), e.g. an enterprise's live trunks.
  const hard = deps.items.filter((i) => i.blocking && i.noOverride && i.count);
  if (hard.length)
    return {
      ok: false,
      reply: reply
        .code(409)
        .type("application/problem+json")
        .send({
          type: "about:blank",
          title: "This cannot be deleted yet",
          status: 409,
          detail: hard.map((i) => `${i.label}: ${i.count}${i.detail ? ` (${i.detail})` : ""}`).join(", "),
          dependencies: deps,
        }),
    };
  if (body.override && !isAdmin(me))
    return { ok: false, reply: sendProblem(reply, 403, "Only administrators can override delete blockers") };
  if (deps.blocked && !body.override) {
    return {
      ok: false,
      reply: reply
        .code(409)
        .type("application/problem+json")
        .send({
          type: "about:blank",
          title: "Settle these items before deleting",
          status: 409,
          detail: deps.items
            .filter((i) => i.blocking && i.count)
            .map((i) => i.label)
            .join(", "),
          dependencies: deps,
        }),
    };
  }
  if (deps.blocked && !reason) {
    return {
      ok: false,
      reply: reply.code(409).type("application/problem+json").send({
        type: "about:blank",
        title: "An override needs a written reason",
        status: 409,
        dependencies: deps,
      }),
    };
  }
  const note = [deps.blocked ? "Override" : null, reason].filter(Boolean).join(": ") || null;
  return { ok: true, note };
}

export function archiveEnterprise(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const body = (request.body ?? {}) as ArchiveRequest;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const ent = await loadEnterprise(pool, id);
    if (!ent) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    if (ent.archived) return { record: ent, change: null };
    const gate = await archiveGate(reply, body, await enterpriseDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const change = await inTransaction(pool, async (c) => {
      // Archiving a parent archives its trunks with it, never a hard delete (§13.29).
      const { rows: ct } = await c.query(
        "UPDATE customer_trunks SET deleted_at = now(), deleted_by_id = $2 WHERE enterprise_id = $1 AND deleted_at IS NULL RETURNING id",
        [id, me.id],
      );
      const { rows: vt } = await c.query(
        "UPDATE vendor_trunks SET deleted_at = now(), deleted_by_id = $2 WHERE enterprise_id = $1 AND deleted_at IS NULL RETURNING id",
        [id, me.id],
      );
      await c.query("UPDATE enterprises SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1", [id, me.id]);
      const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);
      const diff: DiffEntry[] = [{ entity_id: id, field: "archived", before: false, after: true }];
      if (ct.length) diff.push({ entity_id: id, field: "archivedCustomerTrunkIds", before: [], after: ids(ct) });
      if (vt.length) diff.push({ entity_id: id, field: "archivedVendorTrunkIds", before: [], after: ids(vt) });
      return recordChange(c, {
        entityType: "enterprise",
        entityIds: [id],
        changeType: "delete",
        diff,
        note: gate.note,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadEnterprise(pool, id), change };
  });
}

export function restoreEnterprise(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!isAdmin(me)) return sendProblem(reply, 403, "Only administrators can restore archived records");
    const { rows } = await pool.query("SELECT deleted_at FROM enterprises WHERE id = $1", [id]);
    if (!rows[0]) return sendProblem(reply, 404, `Enterprise ${id} not found`);
    if (!rows[0].deleted_at) return sendProblem(reply, 400, "This enterprise is not archived");
    const change = await inTransaction(pool, async (c) => {
      // Trunks archived together with the enterprise come back with it.
      const { rows: ct } = await c.query(
        "UPDATE customer_trunks SET deleted_at = NULL, deleted_by_id = NULL WHERE enterprise_id = $1 AND deleted_at = $2 RETURNING id",
        [id, rows[0].deleted_at],
      );
      const { rows: vt } = await c.query(
        "UPDATE vendor_trunks SET deleted_at = NULL, deleted_by_id = NULL WHERE enterprise_id = $1 AND deleted_at = $2 RETURNING id",
        [id, rows[0].deleted_at],
      );
      await c.query("UPDATE enterprises SET deleted_at = NULL, deleted_by_id = NULL WHERE id = $1", [id]);
      const ids = (r: { id: number }[]) => r.map((x) => x.id).sort((a, b) => a - b);
      const diff: DiffEntry[] = [{ entity_id: id, field: "archived", before: true, after: false }];
      if (ct.length) diff.push({ entity_id: id, field: "archivedCustomerTrunkIds", before: ids(ct), after: [] });
      if (vt.length) diff.push({ entity_id: id, field: "archivedVendorTrunkIds", before: ids(vt), after: [] });
      return recordChange(c, {
        entityType: "enterprise",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: "Restored",
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadEnterprise(pool, id), change };
  });
}
