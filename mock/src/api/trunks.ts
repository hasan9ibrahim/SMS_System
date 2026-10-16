// Customer and vendor trunks (§5.4, §5.5) with session affinity (§13.1), revenue and cost
// limits (§13.26), the trunk's Rules tab (§13.2), safe delete (§13.29) and the change log
// with undo (§13.10). Both kinds share one implementation driven by a field map.
import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  CustomerTrunkInput,
  DependencyItem,
  TrunkRule,
  TrunkRules,
  TrunkRulesInput,
  VendorTrunkInput,
} from "@sms/contract";
import { withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";
import { archiveGate } from "./enterprises.js";
import {
  archivedInfo,
  dependencies,
  diffPaths,
  flatten,
  insertRow,
  isAdmin,
  isTimezone,
  isUniqueViolation,
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

type Db = pg.Pool | pg.PoolClient;
export type TrunkKind = "customer" | "vendor";
type TrunkInput = CustomerTrunkInput | VendorTrunkInput;

const COMMON: FieldSpec[] = [
  { api: "enterpriseId", col: "enterprise_id" },
  { api: "name", col: "name" },
  { api: "protocol", col: "protocol" },
  { api: "categoryId", col: "product_category_id" },
  { api: "billingType", col: "billing_type" },
  { api: "status", col: "status" },
  { api: "bindType", col: "bind_type" },
  { api: "username", col: "username" },
  { api: "maxConnections", col: "max_connections" },
  { api: "systemType", col: "system_type" },
  { api: "port", col: "port" },
  { api: "sslType", col: "ssl_type" },
  { api: "tps", col: "tps" },
  { api: "overflowBuffer", col: "overflow_buffer" },
  { api: "billingTimezone", col: "billing_timezone" },
];

const CUSTOMER_SPECS: FieldSpec[] = [
  ...COMMON,
  { api: "considerHlrRate", col: "consider_hlr_rate" },
  { api: "serviceTypeRouting", col: "service_type_routing" },
  { api: "partWiseRouting", col: "part_wise_routing" },
  { api: "hostIps", col: "host_ips", read: "ARRAY(SELECT host(x) FROM unnest(t.host_ips) x)", cast: "::inet[]" },
  { api: "dlrPushUrl", col: "dlr_push_url" },
  { api: "moPushUrl", col: "mo_push_url" },
  { api: "delayedSubmit", col: "delayed_submit" },
  { api: "sendBind", col: "send_bind" },
  { api: "dlrSessionAffinity", col: "dlr_session_affinity" },
  { api: "dlrHoldHours", col: "dlr_hold_hours" },
  { api: "loopDetection", col: "loop_detection" },
  { api: "defaultCoding", col: "default_coding" },
  { api: "expressVendorTrunkId", col: "express_vendor_trunk_id" },
  { api: "expressMargin", col: "express_margin" },
  { api: "revenueLimit", col: "revenue_limit" },
  { api: "revenueLimitPeriod", col: "revenue_limit_period" },
];

const HTTP_FIELDS: [string, string][] = [
  ["url", "http_url"],
  ["receiverPort", "http_receiver_port"],
  ["successRegex", "http_success_regex"],
  ["messageIdRegex", "http_message_id_regex"],
  ["callbackUrl", "http_callback_url"],
  ["callbackIntervalS", "http_callback_interval_s"],
  ["dlrStatusRegex", "http_dlr_status_regex"],
  ["dlrMidRegex", "http_dlr_mid_regex"],
  ["dlrSuccessStats", "http_dlr_success_stats"],
  ["dlrFailStats", "http_dlr_fail_stats"],
  ["extraHeaders", "http_extra_headers"],
  ["postData", "http_post_data"],
  ["callbackExtraHeaders", "http_callback_extra_headers"],
  ["callbackPostData", "http_callback_post_data"],
];

const VENDOR_SPECS: FieldSpec[] = [
  ...COMMON,
  { api: "host", col: "host" },
  { api: "sourceHost", col: "source_host", read: "host(t.source_host)", cast: "::inet" },
  { api: "serviceType", col: "service_type" },
  { api: "submitIntervalMs", col: "submit_interval_ms" },
  { api: "submitTimeoutS", col: "submit_timeout_s" },
  { api: "enquireLinkTimeoutS", col: "enquire_link_timeout_s" },
  { api: "msgIdType", col: "msg_id_type" },
  ...HTTP_FIELDS.map(([api, col]) => ({ api: `http.${api}`, col })),
  { api: "windowSize", col: "window_size" },
  { api: "allowedDataCodings", col: "allowed_data_codings" },
  { api: "rerouteOn", col: "reroute_on" },
  { api: "allowedSrcTon", col: "allowed_src_ton" },
  { api: "allowedDstTon", col: "allowed_dst_ton" },
  { api: "allowedSrcNpi", col: "allowed_src_npi" },
  { api: "allowedDstNpi", col: "allowed_dst_npi" },
  { api: "maxMsgLen", col: "max_msg_len" },
  { api: "supportMultipart", col: "support_multipart" },
  { api: "dlrTimeoutS", col: "dlr_timeout_s" },
  { api: "dlrTimeoutStat", col: "dlr_timeout_stat" },
  { api: "bindAddrTon", col: "bind_addr_ton" },
  { api: "bindAddrNpi", col: "bind_addr_npi" },
  { api: "bindAddrRange", col: "bind_addr_range" },
  { api: "costLimit", col: "cost_limit" },
  { api: "costLimitPeriod", col: "cost_limit_period" },
];

interface KindDef {
  kind: TrunkKind;
  entity: "customer_trunk" | "vendor_trunk";
  table: "customer_trunks" | "vendor_trunks";
  label: string;
  specs: FieldSpec[];
  enterpriseTypes: string[];
}

const KINDS: Record<TrunkKind, KindDef> = {
  customer: {
    kind: "customer",
    entity: "customer_trunk",
    table: "customer_trunks",
    label: "Customer trunk",
    specs: CUSTOMER_SPECS,
    enterpriseTypes: ["customer", "reciprocal"],
  },
  vendor: {
    kind: "vendor",
    entity: "vendor_trunk",
    table: "vendor_trunks",
    label: "Vendor trunk",
    specs: VENDOR_SPECS,
    enterpriseTypes: ["vendor", "reciprocal"],
  },
};

const notFound = (reply: FastifyReply, k: KindDef, id: number) => sendProblem(reply, 404, `${k.label} ${id} not found`);
const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

// ---------------------------------------------------------------- loading

type TrunkRecord = Record<string, unknown> & {
  id: number;
  enterpriseId: number;
  categoryId: number | null;
  archived: { at: string; by: string | null } | null;
};

async function loadTrunk(db: Db, k: KindDef, id: number): Promise<TrunkRecord | null> {
  const own = k.kind === "vendor" ? "(SELECT r.id FROM rate_tables r WHERE r.vendor_trunk_id = t.id)" : "NULL::bigint";
  const tables =
    k.kind === "customer"
      ? `, ARRAY(SELECT x.rate_table_id FROM customer_trunk_rate_tables x WHERE x.customer_trunk_id = t.id ORDER BY x.position) AS rate_table_ids`
      : "";
  const { rows } = await db.query(
    `SELECT t.id, ${selectSpecs("t", k.specs)}, e.name AS enterprise_name, (t.password <> '') AS password_set,
            t.deleted_at, du.username AS deleted_by, cb.username AS created_by, t.inserted_at,
            ub.username AS updated_by, t.updated_at, ${own} AS own_rate_table_id ${tables}
       FROM ${k.table} t JOIN enterprises e ON e.id = t.enterprise_id
       LEFT JOIN users du ON du.id = t.deleted_by_id
       LEFT JOIN users cb ON cb.id = t.created_by_id
       LEFT JOIN users ub ON ub.id = t.updated_by_id
      WHERE t.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    enterpriseName: r.enterprise_name,
    passwordSet: r.password_set,
    archived: archivedInfo(r.deleted_at, r.deleted_by),
    ownRateTableId: r.own_rate_table_id ?? null,
    ...rowToObject(r, k.specs),
    ...(k.kind === "customer" ? { rateTableIds: (r.rate_table_ids as number[]).map(Number) } : {}),
    createdBy: r.created_by ?? null,
    createdAt: iso(r.inserted_at),
    updatedBy: r.updated_by ?? "system",
    updatedAt: iso(r.updated_at)!,
  } as unknown as TrunkRecord;
}

// ---------------------------------------------------------------- checks

async function checkInput(db: Db, k: KindDef, input: TrunkInput, before: TrunkRecord | null): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const id = before?.id ?? null;
  if (before && before.enterpriseId !== input.enterpriseId) {
    errors.push({ path: "/enterpriseId", message: "a trunk can't move to another enterprise; clone it instead" });
  } else {
    const { rows } = await db.query("SELECT type, deleted_at FROM enterprises WHERE id = $1", [input.enterpriseId]);
    if (!rows[0]) errors.push({ path: "/enterpriseId", message: "unknown enterprise" });
    else if (rows[0].deleted_at) errors.push({ path: "/enterpriseId", message: "the enterprise is archived" });
    else if (!k.enterpriseTypes.includes(rows[0].type))
      errors.push({ path: "/enterpriseId", message: `a ${rows[0].type} can't have ${k.label.toLowerCase()}s` });
  }
  if (input.billingTimezone != null && !isTimezone(input.billingTimezone))
    errors.push({ path: "/billingTimezone", message: "unknown time zone" });
  if (input.categoryId != null) {
    const { rows } = await db.query("SELECT 1 FROM product_categories WHERE id = $1 AND deleted_at IS NULL", [
      input.categoryId,
    ]);
    if (!rows[0]) errors.push({ path: "/categoryId", message: "unknown product category" });
  }
  // A deleted trunk's name stays reserved (§13.29), so archived trunks count too.
  const { rows: nameClash } = await db.query(
    `SELECT id, deleted_at FROM ${k.table} WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1`,
    [input.name.trim(), id],
  );
  if (nameClash[0])
    errors.push({
      path: "/name",
      message: `already used by trunk ${nameClash[0].id}${nameClash[0].deleted_at ? " (archived)" : ""}`,
    });
  if (k.kind === "customer") {
    // Our SMPP system_id: unique across customer trunks, archived ones included.
    const { rows } = await db.query(
      `SELECT id, deleted_at FROM customer_trunks WHERE lower(username) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1`,
      [input.username.trim(), id],
    );
    if (rows[0])
      errors.push({
        path: "/username",
        message: `already used by customer trunk ${rows[0].id}${rows[0].deleted_at ? " (archived)" : ""}`,
      });
  }
  if (!before && !input.password) errors.push({ path: "/password", message: "required for a new trunk" });

  if (k.kind === "customer") {
    const c = input as CustomerTrunkInput;
    c.hostIps.forEach((ip, i) => {
      if (!isIP(ip)) errors.push({ path: `/hostIps/${i}`, message: "not an IP address" });
    });
    if ((c.revenueLimit == null) !== (c.revenueLimitPeriod == null))
      errors.push({ path: "/revenueLimitPeriod", message: "set both the limit and its period, or neither" });
    const ids = c.rateTableIds ?? [];
    if (new Set(ids).size !== ids.length)
      errors.push({ path: "/rateTableIds", message: "a rate table is listed twice" });
    if (ids.length) {
      const { rows } = await db.query(
        "SELECT id FROM rate_tables WHERE id = ANY($1) AND kind = 'customer' AND deleted_at IS NULL",
        [ids],
      );
      const ok = new Set(rows.map((r) => r.id));
      ids.forEach((rid, i) => {
        if (!ok.has(rid))
          errors.push({ path: `/rateTableIds/${i}`, message: `rate table ${rid} is not a live customer table` });
      });
    }
    if (c.expressVendorTrunkId != null) {
      const { rows } = await db.query("SELECT 1 FROM vendor_trunks WHERE id = $1 AND deleted_at IS NULL", [
        c.expressVendorTrunkId,
      ]);
      if (!rows[0]) errors.push({ path: "/expressVendorTrunkId", message: "unknown or archived vendor trunk" });
    }
  } else {
    const v = input as VendorTrunkInput;
    if (v.sourceHost && !isIP(v.sourceHost)) errors.push({ path: "/sourceHost", message: "not an IP address" });
    if ((v.costLimit == null) !== (v.costLimitPeriod == null))
      errors.push({ path: "/costLimitPeriod", message: "set both the limit and its period, or neither" });
    if (v.protocol === "http" && !v.http?.url && !(before && (before.http as { url?: string | null } | undefined)?.url))
      errors.push({ path: "/http/url", message: "required for an HTTP trunk" });
    for (const key of ["successRegex", "messageIdRegex", "dlrStatusRegex", "dlrMidRegex"] as const) {
      const re = v.http?.[key];
      if (!re) continue;
      try {
        new RegExp(re);
      } catch {
        errors.push({ path: `/http/${key}`, message: "invalid regular expression" });
      }
    }
  }
  return errors;
}

const fieldPaths = (k: KindDef) => [...k.specs.map((s) => s.api), ...(k.kind === "customer" ? ["rateTableIds"] : [])];

function inputValues(k: KindDef, input: TrunkInput): Record<string, unknown> {
  const values = flatten({ ...input, name: input.name.trim(), username: input.username.trim() }, k.specs);
  // Empty optional text becomes null so a cleared field reads the same as an unset one.
  for (const [key, v] of Object.entries(values)) if (v === "") values[key] = null;
  return values;
}

async function writeRateTables(c: pg.PoolClient, trunkId: number, ids: number[]) {
  await c.query("DELETE FROM customer_trunk_rate_tables WHERE customer_trunk_id = $1", [trunkId]);
  for (const [i, rid] of ids.entries()) {
    await c.query(
      "INSERT INTO customer_trunk_rate_tables (customer_trunk_id, rate_table_id, position) VALUES ($1, $2, $3)",
      [trunkId, rid, i + 1],
    );
  }
}

// ---------------------------------------------------------------- handlers

export function getTrunk(kind: TrunkKind) {
  const k = KINDS[kind];
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: number };
    return withDb(reply, async (pool) => (await loadTrunk(pool, k, id)) ?? notFound(reply, k, id));
  };
}

export function createTrunk(kind: TrunkKind) {
  const k = KINDS[kind];
  return (request: FastifyRequest, reply: FastifyReply) => {
    const input = request.body as TrunkInput;
    return withDb(reply, async (pool) => {
      const me = await getCurrentUser();
      const errors = await checkInput(pool, k, input, null);
      if (errors.length) return badInput(reply, errors);
      try {
        const { id, change } = await inTransaction(pool, async (c) => {
          const values = inputValues(k, input);
          const id = await insertRow(c, k.table, k.specs, values, {
            password: input.password,
            created_by_id: me.id,
            updated_by_id: me.id,
          });
          if (k.kind === "customer") await writeRateTables(c, id, (input as CustomerTrunkInput).rateTableIds ?? []);
          else {
            // Every vendor trunk owns exactly one buy table (§13.12), in the vendor billing currency.
            await c.query(
              `INSERT INTO rate_tables (kind, name, product_category_id, currency, vendor_trunk_id, created_by_id, updated_by_id)
               VALUES ('vendor', $1, $2, COALESCE((SELECT currency FROM enterprise_billing WHERE enterprise_id = $3 AND side = 'vendor'), 'USD'), $4, $5, $5)`,
              [values.name, values.categoryId, input.enterpriseId, id, me.id],
            );
          }
          const change = await recordChange(c, {
            entityType: k.entity,
            entityIds: [id],
            changeType: "create",
            diff: [{ entity_id: id, field: "*", before: null, after: values.name }],
            userId: me.id,
            ip: request.ip,
          });
          return { id, change };
        });
        return reply.code(201).send({ record: await loadTrunk(pool, k, id), change });
      } catch (err) {
        if (isUniqueViolation(err)) return badInput(reply, [{ path: "/username", message: "already in use" }]);
        throw err;
      }
    });
  };
}

export function updateTrunk(kind: TrunkKind) {
  const k = KINDS[kind];
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: number };
    const input = request.body as TrunkInput;
    return withDb(reply, async (pool) => {
      const me = await getCurrentUser();
      const before = await loadTrunk(pool, k, id);
      if (!before) return notFound(reply, k, id);
      if (before.archived)
        return sendProblem(reply, 400, `This ${k.label.toLowerCase()} is archived; restore it before editing`);
      const errors = await checkInput(pool, k, input, before);
      if (errors.length) return badInput(reply, errors);

      const after = structuredClone(before) as Record<string, unknown>;
      for (const [path, v] of Object.entries(inputValues(k, input))) if (v !== undefined) setPath(after, path, v);
      if (k.kind === "customer" && (input as CustomerTrunkInput).rateTableIds)
        after.rateTableIds = (input as CustomerTrunkInput).rateTableIds;
      const diff = diffPaths(id, before, after, fieldPaths(k));
      // Credentials never enter the change log (§13.22): only the fact that it changed.
      if (input.password) diff.push({ entity_id: id, field: "password", before: "(hidden)", after: "(changed)" });
      if (diff.length === 0) return { record: before, change: null };
      try {
        const change = await inTransaction(pool, async (c) => {
          for (const d of diff) await applyTrunkField(c, kind, id, d.field, d.after, d.before, me.id);
          if (input.password) await c.query(`UPDATE ${k.table} SET password = $2 WHERE id = $1`, [id, input.password]);
          await c.query(`UPDATE ${k.table} SET updated_by_id = $2, updated_at = now() WHERE id = $1`, [id, me.id]);
          const onlyStatus = diff.length === 1 && diff[0]!.field === "status";
          return recordChange(c, {
            entityType: k.entity,
            entityIds: [id],
            changeType: onlyStatus ? (diff[0]!.after === "active" ? "enable" : "disable") : "edit",
            diff,
            userId: me.id,
            ip: request.ip,
          });
        });
        return { record: await loadTrunk(pool, k, id), change };
      } catch (err) {
        if (isUniqueViolation(err)) return badInput(reply, [{ path: "/username", message: "already in use" }]);
        throw err;
      }
    });
  };
}

/** Sets one recorded field back (undo, §13.10). `other` is the value being replaced. */
export async function applyTrunkField(
  c: pg.PoolClient,
  kind: TrunkKind,
  id: number,
  field: string,
  value: unknown,
  other: unknown,
  userId: number,
): Promise<void> {
  const k = KINDS[kind];
  const spec = k.specs.find((s) => s.api === field);
  if (spec) return updateColumns(c, k.table, id, [spec], { [field]: value }, userId);
  if (field === "rateTableIds" && kind === "customer") return writeRateTables(c, id, (value as number[]) ?? []);
  if (field === "archived") {
    await c.query(
      `UPDATE ${k.table} SET deleted_at = ${value ? "now()" : "NULL"}, deleted_by_id = ${value ? "$2" : "NULL"} WHERE id = $1`,
      value ? [id, userId] : [id],
    );
    return;
  }
  if (field === "rules.translation" || field === "rules.hlr") {
    await applyRuleState(c, kind, field === "rules.hlr" ? "hlr" : "translation", id, (value as RuleState[]) ?? []);
  }
  // "password" is recorded without its value, so undo can't bring an old password back.
  void other;
}

// ---------------------------------------------------------------- safe delete (§13.29)

async function trunkDependencies(db: Db, k: KindDef, id: number) {
  const items: DependencyItem[] = [
    { key: "live_binds", label: "Live binds", count: 0, blocking: true, detail: "Disconnect the sessions first" },
  ];
  if (k.kind === "customer") {
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM route_rules WHERE deleted_at IS NULL AND $1 = ANY(customer_trunk_ids)) AS route_rules,
         (SELECT count(*)::int FROM customer_trunk_rate_tables WHERE customer_trunk_id = $1) AS rate_tables,
         (SELECT count(*)::int FROM translation_rule_targets WHERE trunk_kind = 'customer' AND target_type = 'trunk' AND target_id = $1) AS rules`,
      [id],
    );
    items.push(
      {
        key: "route_rules",
        label: "Route rules naming it",
        count: rows[0].route_rules,
        blocking: false,
        detail: "It drops out of these rules",
      },
      {
        key: "rate_tables",
        label: "Rate tables attached",
        count: rows[0].rate_tables,
        blocking: false,
        detail: "Tables stay; only the link goes",
      },
      {
        key: "translation_rules",
        label: "Rules attached directly",
        count: rows[0].rules,
        blocking: false,
        detail: null,
      },
    );
  } else {
    const { rows } = await db.query(
      `SELECT
         (SELECT count(DISTINCT v.route_rule_id)::int FROM route_rule_vendors v JOIN route_rules r ON r.id = v.route_rule_id
           WHERE v.vendor_trunk_id = $1 AND r.deleted_at IS NULL) AS route_rules,
         (SELECT count(*)::int FROM customer_trunks WHERE express_vendor_trunk_id = $1 AND deleted_at IS NULL) AS express,
         (SELECT count(*)::int FROM translation_rule_targets WHERE trunk_kind = 'vendor' AND target_type = 'trunk' AND target_id = $1) AS rules`,
      [id],
    );
    items.push(
      {
        key: "route_rules",
        label: "Route rules sending to it",
        count: rows[0].route_rules,
        blocking: false,
        detail: "Routing skips it from now on",
      },
      {
        key: "express",
        label: "Customer trunks using it as express vendor",
        count: rows[0].express,
        blocking: false,
        detail: "Those trunks fall back to routing",
      },
      {
        key: "rate_tables",
        label: "Own buy rate table",
        count: 1,
        blocking: false,
        detail: "Kept with its full history",
      },
      {
        key: "translation_rules",
        label: "Rules attached directly",
        count: rows[0].rules,
        blocking: false,
        detail: null,
      },
    );
  }
  items.push({
    key: "traffic_30d",
    label: "Traffic in the last 30 days",
    count: null,
    blocking: false,
    detail: "Checked against the EDR store by the backend",
  });
  return dependencies(items);
}

export function getTrunkDependencies(kind: TrunkKind) {
  const k = KINDS[kind];
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: number };
    return withDb(reply, async (pool) => {
      const { rows } = await pool.query(`SELECT 1 FROM ${k.table} WHERE id = $1`, [id]);
      if (!rows[0]) return notFound(reply, k, id);
      return trunkDependencies(pool, k, id);
    });
  };
}

export function archiveTrunk(kind: TrunkKind) {
  const k = KINDS[kind];
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: number };
    const body = (request.body ?? {}) as ArchiveRequest;
    return withDb(reply, async (pool) => {
      const me = await getCurrentUser();
      const before = await loadTrunk(pool, k, id);
      if (!before) return notFound(reply, k, id);
      if (before.archived) return { record: before, change: null };
      const gate = await archiveGate(reply, body, await trunkDependencies(pool, k, id));
      if (!gate.ok) return gate.reply;
      const change = await inTransaction(pool, async (c) => {
        await c.query(`UPDATE ${k.table} SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1`, [id, me.id]);
        return recordChange(c, {
          entityType: k.entity,
          entityIds: [id],
          changeType: "delete",
          diff: [{ entity_id: id, field: "archived", before: false, after: true }],
          note: gate.note,
          userId: me.id,
          ip: request.ip,
        });
      });
      return { record: await loadTrunk(pool, k, id), change };
    });
  };
}

export function restoreTrunk(kind: TrunkKind) {
  const k = KINDS[kind];
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: number };
    return withDb(reply, async (pool) => {
      const me = await getCurrentUser();
      if (!isAdmin(me)) return sendProblem(reply, 403, "Only administrators can restore archived records");
      const { rows } = await pool.query(
        `SELECT t.deleted_at, e.deleted_at AS enterprise_deleted_at FROM ${k.table} t JOIN enterprises e ON e.id = t.enterprise_id WHERE t.id = $1`,
        [id],
      );
      if (!rows[0]) return notFound(reply, k, id);
      if (!rows[0].deleted_at) return sendProblem(reply, 400, `This ${k.label.toLowerCase()} is not archived`);
      if (rows[0].enterprise_deleted_at)
        return sendProblem(reply, 400, "Its enterprise is archived; restore the enterprise first");
      try {
        const change = await inTransaction(pool, async (c) => {
          await c.query(`UPDATE ${k.table} SET deleted_at = NULL, deleted_by_id = NULL WHERE id = $1`, [id]);
          return recordChange(c, {
            entityType: k.entity,
            entityIds: [id],
            changeType: "edit",
            diff: [{ entity_id: id, field: "archived", before: true, after: false }],
            note: "Restored",
            userId: me.id,
            ip: request.ip,
          });
        });
        return { record: await loadTrunk(pool, k, id), change };
      } catch (err) {
        if (isUniqueViolation(err))
          return sendProblem(reply, 400, "Another live trunk uses this username; rename one of them first");
        throw err;
      }
    });
  };
}

// ---------------------------------------------------------------- Rules tab (§13.2)

/** Per-trunk state of one rule, as stored in the change log. */
interface RuleState {
  ruleId: number;
  position: number | null;
  enabled: boolean;
  continueAfter: boolean;
  /** The rule targets this trunk directly (detaching removes that target). */
  direct: boolean;
}

const SPECIFICITY = { trunk: 0, enterprise: 1, category: 2, all: 3 } as const;
type Source = keyof typeof SPECIFICITY;

interface Reach {
  rule: TrunkRule;
  top: boolean;
  direct: boolean;
}

async function trunkRef(db: Db, k: KindDef, id: number) {
  const { rows } = await db.query(
    `SELECT t.id, t.enterprise_id, t.product_category_id, e.name AS enterprise_name, pc.name AS category_name
       FROM ${k.table} t JOIN enterprises e ON e.id = t.enterprise_id
       LEFT JOIN product_categories pc ON pc.id = t.product_category_id WHERE t.id = $1`,
    [id],
  );
  return rows[0] as
    | {
        id: number;
        enterprise_id: number;
        product_category_id: number | null;
        enterprise_name: string;
        category_name: string | null;
      }
    | undefined;
}

/**
 * Rules that reach the trunk through any of their targets, in run order: rules with a
 * position on this trunk by position, unpositioned rules targeted "top" before them and the
 * rest after, ties by rule id (same order as the generator's rulesForTrunk).
 */
async function reachingRules(db: Db, k: KindDef, which: "translation" | "hlr", trunkId: number): Promise<Reach[]> {
  const t = await trunkRef(db, k, trunkId);
  if (!t) return [];
  const { rows } =
    which === "translation"
      ? await db.query(
          `SELECT r.id, r.name, r.status, tg.target_type, tg.insert_at, s.position, s.enabled, s.continue_after,
                  concat_ws(' · ', r.action,
                    CASE WHEN r.sender_pattern IS NOT NULL THEN 'sender ' || CASE WHEN r.sender_pattern_negate THEN 'not ' ELSE '' END || r.sender_pattern END,
                    CASE WHEN r.receiver_pattern IS NOT NULL THEN 'receiver ' || CASE WHEN r.receiver_pattern_negate THEN 'not ' ELSE '' END || r.receiver_pattern END,
                    CASE WHEN r.sender_conversion IS NOT NULL THEN 'sender ' || replace(r.sender_conversion, '_', ' ') || COALESCE(' ' || r.sender_conversion_value, '') END,
                    CASE WHEN r.receiver_conversion IS NOT NULL THEN 'receiver ' || replace(r.receiver_conversion, '_', ' ') || COALESCE(' ' || r.receiver_conversion_value, '') END
                  ) AS detail
             FROM translation_rule_targets tg
             JOIN translation_rules r ON r.id = tg.translation_rule_id AND r.deleted_at IS NULL
             LEFT JOIN translation_rule_trunk_settings s
                    ON s.translation_rule_id = r.id AND s.trunk_kind = $1 AND s.trunk_id = $2
            WHERE tg.trunk_kind = $1 AND (tg.target_type = 'all'
               OR (tg.target_type = 'trunk' AND tg.target_id = $2)
               OR (tg.target_type = 'enterprise' AND tg.target_id = $3)
               OR (tg.target_type = 'category' AND tg.target_id = $4))`,
          [k.kind, trunkId, t.enterprise_id, t.product_category_id],
        )
      : await db.query(
          `SELECT r.id, r.name, r.status, tg.target_type, tg.insert_at, s.position, s.enabled, true AS continue_after,
                  p.name || ' · DNID ' || r.dnid_pattern AS detail
             FROM hlr_rule_targets tg
             JOIN hlr_rules r ON r.id = tg.hlr_rule_id AND r.deleted_at IS NULL
             JOIN hlr_providers p ON p.id = r.hlr_provider_id
             LEFT JOIN hlr_rule_trunk_settings s ON s.hlr_rule_id = r.id AND s.customer_trunk_id = $1
            WHERE tg.target_type = 'all'
               OR (tg.target_type = 'trunk' AND tg.target_id = $1)
               OR (tg.target_type = 'enterprise' AND tg.target_id = $2)
               OR (tg.target_type = 'category' AND tg.target_id = $3)`,
          [trunkId, t.enterprise_id, t.product_category_id],
        );
  const byRule = new Map<number, Reach>();
  const label = (s: Source) =>
    s === "trunk"
      ? "This trunk"
      : s === "enterprise"
        ? `Enterprise: ${t.enterprise_name}`
        : s === "category"
          ? `Category: ${t.category_name ?? "?"}`
          : `All ${k.kind} trunks`;
  for (const r of rows) {
    const src = r.target_type as Source;
    const cur = byRule.get(r.id);
    if (!cur) {
      byRule.set(r.id, {
        rule: {
          ruleId: r.id,
          kind: which,
          name: r.name,
          source: { type: src, label: label(src) },
          position: r.position ?? null,
          enabled: r.enabled ?? true,
          continueAfter: r.continue_after ?? true,
          ruleActive: r.status === "active",
          detail: r.detail || null,
        },
        top: r.insert_at === "top",
        direct: src === "trunk",
      });
      continue;
    }
    cur.top ||= r.insert_at === "top";
    cur.direct ||= src === "trunk";
    if (SPECIFICITY[src] < SPECIFICITY[cur.rule.source.type as Source])
      cur.rule.source = { type: src, label: label(src) };
  }
  const rank = (x: Reach): [number, number] => (x.rule.position != null ? [1, x.rule.position] : [x.top ? 0 : 2, 0]);
  return [...byRule.values()].sort((a, b) => {
    const [ga, pa] = rank(a);
    const [gb, pb] = rank(b);
    return ga - gb || pa - pb || a.rule.ruleId - b.rule.ruleId;
  });
}

async function loadRules(db: Db, k: KindDef, id: number): Promise<TrunkRules> {
  return {
    translation: (await reachingRules(db, k, "translation", id)).map((x) => x.rule),
    hlr: k.kind === "customer" ? (await reachingRules(db, k, "hlr", id)).map((x) => x.rule) : [],
  };
}

const stateOf = (list: Reach[]): RuleState[] =>
  list
    .map((x) => ({
      ruleId: x.rule.ruleId,
      position: x.rule.position,
      enabled: x.rule.enabled,
      continueAfter: x.rule.continueAfter,
      direct: x.direct,
    }))
    .sort((a, b) => a.ruleId - b.ruleId);

async function applyRuleState(
  c: pg.PoolClient,
  kind: TrunkKind,
  which: "translation" | "hlr",
  trunkId: number,
  state: RuleState[],
) {
  for (const s of state) {
    const isDefault = s.position === null && s.enabled && s.continueAfter;
    if (which === "translation") {
      if (s.direct)
        await c.query(
          `INSERT INTO translation_rule_targets (translation_rule_id, target_type, trunk_kind, target_id)
           VALUES ($1, 'trunk', $2, $3) ON CONFLICT DO NOTHING`,
          [s.ruleId, kind, trunkId],
        );
      else
        await c.query(
          "DELETE FROM translation_rule_targets WHERE translation_rule_id = $1 AND target_type = 'trunk' AND trunk_kind = $2 AND target_id = $3",
          [s.ruleId, kind, trunkId],
        );
      if (isDefault)
        await c.query(
          "DELETE FROM translation_rule_trunk_settings WHERE translation_rule_id = $1 AND trunk_kind = $2 AND trunk_id = $3",
          [s.ruleId, kind, trunkId],
        );
      else
        await c.query(
          `INSERT INTO translation_rule_trunk_settings (translation_rule_id, trunk_kind, trunk_id, position, continue_after, enabled)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (trunk_kind, trunk_id, translation_rule_id)
           DO UPDATE SET position = EXCLUDED.position, continue_after = EXCLUDED.continue_after, enabled = EXCLUDED.enabled`,
          [s.ruleId, kind, trunkId, s.position, s.continueAfter, s.enabled],
        );
    } else {
      if (s.direct)
        await c.query(
          `INSERT INTO hlr_rule_targets (hlr_rule_id, target_type, target_id) VALUES ($1, 'trunk', $2) ON CONFLICT DO NOTHING`,
          [s.ruleId, trunkId],
        );
      else
        await c.query(
          "DELETE FROM hlr_rule_targets WHERE hlr_rule_id = $1 AND target_type = 'trunk' AND target_id = $2",
          [s.ruleId, trunkId],
        );
      if (s.position === null && s.enabled)
        await c.query("DELETE FROM hlr_rule_trunk_settings WHERE hlr_rule_id = $1 AND customer_trunk_id = $2", [
          s.ruleId,
          trunkId,
        ]);
      else
        await c.query(
          `INSERT INTO hlr_rule_trunk_settings (hlr_rule_id, customer_trunk_id, position, enabled) VALUES ($1, $2, $3, $4)
           ON CONFLICT (customer_trunk_id, hlr_rule_id) DO UPDATE SET position = EXCLUDED.position, enabled = EXCLUDED.enabled`,
          [s.ruleId, trunkId, s.position, s.enabled],
        );
    }
  }
}

export function getTrunkRules(kind: TrunkKind) {
  const k = KINDS[kind];
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: number };
    return withDb(reply, async (pool) => {
      const { rows } = await pool.query(`SELECT 1 FROM ${k.table} WHERE id = $1`, [id]);
      if (!rows[0]) return notFound(reply, k, id);
      return loadRules(pool, k, id);
    });
  };
}

export function updateTrunkRules(kind: TrunkKind) {
  const k = KINDS[kind];
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: number };
    const input = request.body as TrunkRulesInput;
    return withDb(reply, async (pool) => {
      const me = await getCurrentUser();
      const t = await loadTrunk(pool, k, id);
      if (!t) return notFound(reply, k, id);
      if (t.archived)
        return sendProblem(reply, 400, `This ${k.label.toLowerCase()} is archived; restore it before editing`);
      if (k.kind === "vendor" && (input.hlr?.length || input.detachHlrRuleIds?.length))
        return badInput(reply, [{ path: "/hlr", message: "HLR rules run on customer trunks only" }]);

      const errors: FieldError[] = [];
      const diff: DiffEntry[] = [];
      const plans: { which: "translation" | "hlr"; next: RuleState[] }[] = [];
      for (const which of ["translation", "hlr"] as const) {
        const settings = input[which];
        const detach = which === "translation" ? input.detachTranslationRuleIds : input.detachHlrRuleIds;
        if (!settings && !detach?.length) continue;
        const reach = await reachingRules(pool, k, which, id);
        const byId = new Map(reach.map((x) => [x.rule.ruleId, x]));
        (settings ?? []).forEach((s, i) => {
          if (!byId.has(s.ruleId))
            errors.push({ path: `/${which}/${i}/ruleId`, message: `rule ${s.ruleId} does not run on this trunk` });
        });
        if (new Set((settings ?? []).map((s) => s.ruleId)).size !== (settings ?? []).length)
          errors.push({ path: `/${which}`, message: "a rule is listed twice" });
        (detach ?? []).forEach((rid, i) => {
          if (!byId.get(rid)?.direct)
            errors.push({
              path: `/${which === "translation" ? "detachTranslationRuleIds" : "detachHlrRuleIds"}/${i}`,
              message: `rule ${rid} is not attached to this trunk directly; change the rule's targets instead`,
            });
        });
        const before = stateOf(reach);
        const next = new Map(before.map((s) => [s.ruleId, { ...s }]));
        if (settings?.length) {
          // The listed rules take positions 1..n; other positioned rules keep their order after them.
          const listed = new Set(settings.map((s) => s.ruleId));
          settings.forEach((s, i) => {
            const cur = next.get(s.ruleId);
            if (!cur) return;
            cur.position = i + 1;
            cur.enabled = s.enabled;
            if (s.continueAfter !== undefined && which === "translation") cur.continueAfter = s.continueAfter;
          });
          let pos = settings.length;
          for (const x of reach)
            if (!listed.has(x.rule.ruleId) && x.rule.position != null) next.get(x.rule.ruleId)!.position = ++pos;
        }
        for (const rid of detach ?? []) {
          const cur = next.get(rid);
          if (cur) cur.direct = false;
        }
        const after = [...next.values()].sort((a, b) => a.ruleId - b.ruleId);
        if (!same(before, after)) {
          diff.push({ entity_id: id, field: `rules.${which}`, before, after });
          plans.push({ which, next: after });
        }
      }
      if (errors.length) return badInput(reply, errors);
      if (diff.length === 0) return { record: await loadRules(pool, k, id), change: null };
      const onlyOrder = diff.every((d) =>
        (d.after as RuleState[]).every((s, i) => {
          const b = (d.before as RuleState[])[i]!;
          return s.enabled === b.enabled && s.continueAfter === b.continueAfter && s.direct === b.direct;
        }),
      );
      const change = await inTransaction(pool, async (c) => {
        for (const p of plans) await applyRuleState(c, kind, p.which, id, p.next);
        return recordChange(c, {
          entityType: k.entity,
          entityIds: [id],
          changeType: onlyOrder ? "reorder" : "edit",
          diff,
          note: "Rules",
          userId: me.id,
          ip: request.ip,
        });
      });
      return { record: await loadRules(pool, k, id), change };
    });
  };
}
