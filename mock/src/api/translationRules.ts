// Translation rules (§6.4) assigned straight to trunks (§13.2): the rule carries its Applies To
// targets, so it runs on those trunks as soon as it is saved. Every save is one undoable change
// (§13.10, each field restorable, targets as one field); delete archives (§13.29). The Test runs
// the engine in routing/translate.ts on a sample message, for one rule or a trunk's whole list.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  RuleUsedBy,
  TranslationCloneInput,
  TranslationRuleDetail,
  TranslationRuleFields,
  TranslationRuleInput,
  TranslationTarget,
  TranslationTargetInput,
  TranslationTestInput,
  TrunkRulesTestInput,
  TrunkRulesTestResult,
} from "@sms/contract";
import { withDb } from "../db.js";
import { translationUsedBySql } from "../lists/defs.js";
import { sendProblem } from "../problem.js";
import { compile, runRules, type EngineContext, type EngineRule } from "../routing/translate.js";
import { archiveGate } from "./enterprises.js";
import { notFound, setArchived } from "./masterData.js";
import { dependencies, iso, recordChange, same, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { trunkRuleOrder } from "./trunks.js";
import { inTransaction } from "./views.js";
import { ruleTargetDependencies } from "./ruleTargets.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };
type Fields = Required<TranslationRuleFields>;
type TrunkKind = "customer" | "vendor";

/** API field → column. dlrMap and contentWords are jsonb; everything else is a plain column. */
const COLUMNS: [keyof Fields, string][] = [
  ["name", "name"],
  ["direction", "direction"],
  ["action", "action"],
  ["status", "status"],
  ["continueAfter", "continue_after"],
  ["senderPattern", "sender_pattern"],
  ["senderPatternNegate", "sender_pattern_negate"],
  ["senderMatchCase", "sender_match_case"],
  ["receiverPattern", "receiver_pattern"],
  ["receiverPatternNegate", "receiver_pattern_negate"],
  ["mccmncs", "mccmncs"],
  ["mccmncNegate", "mccmnc_negate"],
  ["mccmncPattern", "mccmnc_pattern"],
  ["contentPattern", "content_pattern"],
  ["contentPatternNegate", "content_pattern_negate"],
  ["senderListId", "sender_list_id"],
  ["senderListNegate", "sender_list_negate"],
  ["receiverListId", "receiver_list_id"],
  ["receiverListNegate", "receiver_list_negate"],
  ["senderConversion", "sender_conversion"],
  ["senderConversionValue", "sender_conversion_value"],
  ["senderConversionReplacement", "sender_conversion_replacement"],
  ["senderConversionListId", "sender_conversion_list_id"],
  ["receiverConversion", "receiver_conversion"],
  ["receiverConversionValue", "receiver_conversion_value"],
  ["receiverConversionReplacement", "receiver_conversion_replacement"],
  ["senderTon", "sender_ton"],
  ["senderNpi", "sender_npi"],
  ["destTon", "dest_ton"],
  ["destNpi", "dest_npi"],
  ["billingType", "billing_type"],
  ["registeredDelivery", "registered_delivery"],
  ["dlrMap", "dlr_status_map"],
  ["contentRegex", "content_regex"],
  ["contentRegexIndex", "content_regex_index"],
  ["contentReplacement", "content_replacement"],
  ["msgTemplate", "msg_template"],
  ["contentWords", "content_words"],
  ["contentNumberFormat", "content_number_format"],
  ["contentNumberMinDigits", "content_number_min_digits"],
  ["senderMinLength", "sender_min_len"],
  ["senderMaxLength", "sender_max_len"],
  ["receiverMinLength", "receiver_min_len"],
  ["receiverMaxLength", "receiver_max_len"],
  ["startsAt", "starts_at"],
  ["stopsAt", "stops_at"],
  ["insertAt", "insert_at"],
];
const FIELD_COLUMN = new Map<string, string>(COLUMNS);
const JSON_FIELDS = new Set(["dlrMap", "contentWords"]);
const toDb = (field: string, v: unknown) => (JSON_FIELDS.has(field) ? JSON.stringify(v ?? []) : v);

function fieldsOf(r: Record<string, unknown>): Fields {
  const out: Record<string, unknown> = {};
  for (const [api, col] of COLUMNS) {
    const v = r[col];
    out[api] =
      v instanceof Date
        ? v.toISOString()
        : api === "mccmncs"
          ? ((v as string[]) ?? [])
          : JSON_FIELDS.has(api)
            ? ((v as unknown[]) ?? [])
            : (v ?? null);
  }
  return out as Fields;
}

async function loadTargets(db: Db, ids: number[]): Promise<Map<number, TranslationTarget[]>> {
  const { rows } = await db.query(
    `SELECT tg.translation_rule_id AS rule_id, tg.target_type, tg.trunk_kind, tg.target_id,
            COALESCE(ct.name, vt.name, e.name, pc.name) AS label
       FROM translation_rule_targets tg
       LEFT JOIN customer_trunks ct ON tg.target_type = 'trunk' AND tg.trunk_kind = 'customer' AND ct.id = tg.target_id
       LEFT JOIN vendor_trunks vt ON tg.target_type = 'trunk' AND tg.trunk_kind = 'vendor' AND vt.id = tg.target_id
       LEFT JOIN enterprises e ON tg.target_type = 'enterprise' AND e.id = tg.target_id
       LEFT JOIN product_categories pc ON tg.target_type = 'category' AND pc.id = tg.target_id
      WHERE tg.translation_rule_id = ANY($1)
      ORDER BY tg.trunk_kind, array_position(ARRAY['all','category','enterprise','trunk'], tg.target_type), label`,
    [ids],
  );
  const out = new Map<number, TranslationTarget[]>();
  for (const r of rows) {
    const list = out.get(Number(r.rule_id)) ?? [];
    list.push({
      type: r.target_type,
      trunkKind: r.trunk_kind,
      id: r.target_id === null ? null : Number(r.target_id),
      label: r.target_type === "all" ? `All ${r.trunk_kind} trunks` : ((r.label as string | null) ?? `#${r.target_id}`),
    });
    out.set(Number(r.rule_id), list);
  }
  return out;
}

const targetKey = (t: TranslationTargetInput) => `${t.trunkKind}:${t.type}:${t.id ?? ""}`;
const plainTargets = (ts: TranslationTargetInput[]) =>
  ts
    .map((t) => ({ type: t.type, trunkKind: t.trunkKind, id: t.id }))
    .sort((a, b) => (targetKey(a) < targetKey(b) ? -1 : 1));

export async function loadTranslationRule(db: Db, id: number): Promise<TranslationRuleDetail | null> {
  const { rows } = await db.query(
    `SELECT r.*, cb.username AS created_by, ub.username AS updated_by, ${translationUsedBySql("r")} AS used_by
       FROM translation_rules r LEFT JOIN users cb ON cb.id = r.created_by_id LEFT JOIN users ub ON ub.id = r.updated_by_id
      WHERE r.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    ...fieldsOf(r),
    targets: (await loadTargets(db, [id])).get(id) ?? [],
    usedBy: Number(r.used_by),
    createdBy: r.created_by ?? null,
    updatedBy: r.updated_by ?? null,
    updatedAt: iso(r.updated_at)!,
    archivedAt: iso(r.deleted_at),
  };
}

export function getTranslationRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(
    reply,
    async (pool) => (await loadTranslationRule(pool, id)) ?? notFound(reply, "Translation rule", id),
  );
}

// ---------------------------------------------------------------- validation

const DIGITS = /^[0-9]{1,2}$/;

/** Checks one rule input against the database; returns field errors (400). */
async function checkRule(db: Db, input: TranslationRuleInput): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (!input.name.trim()) err("/name", "required");
  for (const f of ["senderPattern", "receiverPattern", "mccmncPattern", "contentPattern", "contentRegex"] as const) {
    const v = input[f];
    if (v && !compile(v)) err(`/${f}`, "not a valid regular expression");
  }
  const sc = input.senderConversion;
  if (sc === "left_strip" || sc === "right_strip") {
    if (!DIGITS.test(input.senderConversionValue ?? "")) err("/senderConversionValue", "number of characters, 1-99");
  } else if (sc === "prepend" || sc === "append") {
    if (!input.senderConversionValue) err("/senderConversionValue", "the text to add");
  } else if (sc === "translation") {
    if (!input.senderConversionValue) err("/senderConversionValue", "the new Sender ID");
  } else if (sc === "regex_replace") {
    if (!input.senderConversionValue) err("/senderConversionValue", "the pattern to replace");
    else if (!compile(input.senderConversionValue)) err("/senderConversionValue", "not a valid regular expression");
  } else if (sc === "random_number" || sc === "sender_id_template") {
    if (input.senderConversionListId === null) err("/senderConversionListId", "pick a number list");
  }
  const rc = input.receiverConversion;
  if (rc === "left_strip" || rc === "right_strip") {
    if (!DIGITS.test(input.receiverConversionValue ?? ""))
      err("/receiverConversionValue", "number of characters, 1-99");
  } else if (rc === "prepend" || rc === "append") {
    if (!input.receiverConversionValue) err("/receiverConversionValue", "the text to add");
  } else if (rc === "translation") {
    if (!input.receiverConversionValue) err("/receiverConversionValue", "the new Receiver ID");
  } else if (rc === "regex_replace") {
    if (!input.receiverConversionValue) err("/receiverConversionValue", "the pattern to replace");
    else if (!compile(input.receiverConversionValue)) err("/receiverConversionValue", "not a valid regular expression");
  }
  // Team trial round 6: an ingress rule runs on customer trunks only, an egress rule on vendor trunks only; implied
  // by the trunk can target both.
  if (input.direction === "ingress" && input.targets.some((t) => t.trunkKind === "vendor"))
    err("/targets", "an ingress rule applies to customer trunks only");
  if (input.direction === "egress" && input.targets.some((t) => t.trunkKind === "customer"))
    err("/targets", "an egress rule applies to vendor trunks only");
  if (input.senderMinLength > input.senderMaxLength) err("/senderMinLength", "must not exceed the maximum");
  if (input.receiverMinLength > input.receiverMaxLength) err("/receiverMinLength", "must not exceed the maximum");
  if (input.startsAt && input.stopsAt && input.startsAt >= input.stopsAt) err("/stopsAt", "must be after the start");
  if ((input.contentRegexIndex !== null || input.contentReplacement !== null) && !input.contentRegex)
    err("/contentRegex", "needed for Regex Index and Message Text");
  if (input.contentRegex && input.contentReplacement === null)
    err("/contentReplacement", "the Message Text that replaces the match");
  if (input.contentRegex && input.contentRegexIndex !== null) {
    const groups = new RegExp(`${input.contentRegex}|`).exec("")?.length ?? 1;
    if (input.contentRegexIndex > groups - 1)
      err("/contentRegexIndex", `the pattern has ${groups - 1} group${groups === 2 ? "" : "s"}`);
  }

  // Lists: any type can be a match list (decided 2026-10-17); conversion lists fit the conversion.
  const listIds = [input.senderListId, input.receiverListId, input.senderConversionListId].filter(
    (x): x is number => x !== null,
  );
  const { rows: lists } = await db.query(
    "SELECT id, list_type FROM number_lists WHERE id = ANY($1) AND deleted_at IS NULL",
    [listIds],
  );
  const typeOf = new Map(lists.map((l) => [Number(l.id), l.list_type as string]));
  for (const f of ["senderListId", "receiverListId"] as const) {
    const v = input[f];
    if (v === null) continue;
    if (!typeOf.has(v)) err(`/${f}`, "unknown number list");
  }
  if (input.senderConversionListId !== null) {
    const want = sc === "random_number" ? "random" : sc === "sender_id_template" ? "sender_id_template" : null;
    const have = typeOf.get(input.senderConversionListId);
    if (!have) err("/senderConversionListId", "unknown number list");
    else if (!want) err("/senderConversionListId", "only Random Number and Sender ID Template use a list");
    else if (have !== want)
      err("/senderConversionListId", `pick a ${want === "random" ? "Random" : "Sender ID Template"} list`);
  }

  // MCCMNC codes: live codes, or a country's 3-digit MCC.
  if (input.mccmncs.length) {
    const { rows } = await db.query(
      `SELECT c FROM unnest($1::text[]) AS c
        WHERE NOT EXISTS (SELECT 1 FROM mccmnc m WHERE m.deleted_at IS NULL AND m.mccmnc = c)`,
      [input.mccmncs],
    );
    if (rows.length) err("/mccmncs", `unknown code${rows.length > 1 ? "s" : ""} ${rows.map((r) => r.c).join(", ")}`);
  }

  // Targets point to live trunks, enterprises or categories.
  const seen = new Set<string>();
  for (const [i, t] of input.targets.entries()) {
    if (seen.has(targetKey(t))) err(`/targets/${i}`, "listed twice");
    seen.add(targetKey(t));
    if ((t.type === "all") !== (t.id === null)) err(`/targets/${i}/id`, t.type === "all" ? "must be null" : "required");
    if (t.id === null) continue;
    const table =
      t.type === "trunk"
        ? t.trunkKind === "customer"
          ? "customer_trunks"
          : "vendor_trunks"
        : t.type === "enterprise"
          ? "enterprises"
          : "product_categories";
    const { rows } = await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [t.id]);
    if (!rows[0]) err(`/targets/${i}/id`, `unknown ${t.type}`);
  }
  return errors;
}

const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });

// ---------------------------------------------------------------- writes

async function writeTargets(
  c: pg.PoolClient,
  id: number,
  targets: TranslationTargetInput[],
  insertAt: string,
  userId: number,
) {
  await c.query("DELETE FROM translation_rule_targets WHERE translation_rule_id = $1", [id]);
  if (!targets.length) return;
  await c.query(
    `INSERT INTO translation_rule_targets (translation_rule_id, target_type, trunk_kind, target_id, insert_at, created_by_id)
     SELECT $1, t, k, x, $5, $6 FROM unnest($2::text[], $3::text[], $4::bigint[]) AS u(t, k, x)`,
    [id, targets.map((t) => t.type), targets.map((t) => t.trunkKind), targets.map((t) => t.id), insertAt, userId],
  );
}

/** Switches a rule on or off for one trunk, keeping its position and Continue there. */
async function setTrunkEnabled(c: pg.PoolClient, ruleId: number, kind: string, trunkId: number, enabled: boolean) {
  await c.query(
    `INSERT INTO translation_rule_trunk_settings (translation_rule_id, trunk_kind, trunk_id, continue_after, enabled)
     SELECT $1, $2, $3, r.continue_after, $4 FROM translation_rules r WHERE r.id = $1
     ON CONFLICT (trunk_kind, trunk_id, translation_rule_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [ruleId, kind, trunkId, enabled],
  );
}

/**
 * Undo (§13.10): puts one field of a rule back; `targets` replaces the whole target list and
 * `trunkEnabled:<kind>:<id>` is the rule's on/off on one trunk (Duplicate to trunk).
 */
export async function applyTranslationRuleField(
  c: pg.PoolClient,
  id: number,
  field: string,
  value: unknown,
  userId: number,
) {
  if (field.startsWith("trunkEnabled:")) {
    const [, kind, trunkId] = field.split(":");
    await setTrunkEnabled(c, id, kind!, Number(trunkId), value === true);
  } else if (field === "targets") {
    const { rows } = await c.query("SELECT insert_at FROM translation_rules WHERE id = $1", [id]);
    await writeTargets(c, id, (value as TranslationTargetInput[]) ?? [], rows[0]?.insert_at ?? "bottom", userId);
  } else {
    const col = FIELD_COLUMN.get(field);
    if (!col) return;
    await c.query(`UPDATE translation_rules SET ${col} = $2, updated_by_id = $3, updated_at = now() WHERE id = $1`, [
      id,
      toDb(field, value),
      userId,
    ]);
    if (field === "insertAt")
      await c.query("UPDATE translation_rule_targets SET insert_at = $2 WHERE translation_rule_id = $1", [id, value]);
  }
}

async function insertRule(c: pg.PoolClient, input: TranslationRuleInput, userId: number): Promise<number> {
  const cols = COLUMNS.map(([, col]) => col);
  const values = COLUMNS.map(([api]) => toDb(api, input[api]));
  const { rows } = await c.query(
    `INSERT INTO translation_rules (${cols.join(", ")}, created_by_id, updated_by_id)
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, $${cols.length + 1}, $${cols.length + 1}) RETURNING id`,
    [...values, userId],
  );
  const id = rows[0].id as number;
  await writeTargets(c, id, input.targets, input.insertAt, userId);
  return id;
}

const normalise = (input: TranslationRuleInput): TranslationRuleInput => ({
  ...input,
  name: input.name.trim(),
  mccmncs: [...new Set(input.mccmncs)].sort(),
  // The replacement belongs to Regex Replace only.
  senderConversionReplacement: input.senderConversion === "regex_replace" ? input.senderConversionReplacement : null,
  receiverConversionReplacement:
    input.receiverConversion === "regex_replace" ? input.receiverConversionReplacement : null,
  targets: plainTargets(input.targets),
  // Missing (older clients) means no words; blank rows are dropped.
  contentWords: (input.contentWords ?? []).filter((w) => w.find.trim() !== ""),
  // Missing (older clients) means Match case on for the Sender ID conditions (team trial round 1).
  senderMatchCase: input.senderMatchCase ?? true,
  // Missing (older clients) means no MCCMNC regex (team trial round 2).
  mccmncPattern: input.mccmncPattern?.trim() || null,
});

export function createTranslationRule(request: FastifyRequest, reply: FastifyReply) {
  const input = normalise(request.body as TranslationRuleInput);
  return withDb(reply, async (pool) => {
    const errors = await checkRule(pool, input);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const id = await insertRule(c, input, me.id);
      const change = await recordChange(c, {
        entityType: "translation_rule",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: input.name } }],
        note: `Added translation rule ${input.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadTranslationRule(pool, id), change });
  });
}

export function updateTranslationRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const input = normalise(request.body as TranslationRuleInput);
  return withDb(reply, async (pool) => {
    const before = await loadTranslationRule(pool, id);
    if (!before) return notFound(reply, "Translation rule", id);
    if (before.archivedAt) return sendProblem(reply, 400, "This rule is deleted; restore it before editing");
    const diff: DiffEntry[] = [];
    for (const [api] of COLUMNS)
      if (!same(before[api] ?? null, input[api] ?? null))
        diff.push({ entity_id: id, field: api, before: before[api] ?? null, after: input[api] ?? null });
    const beforeTargets = plainTargets(before.targets);
    if (!same(beforeTargets, input.targets))
      diff.push({ entity_id: id, field: "targets", before: beforeTargets, after: input.targets });
    if (!diff.length) return { record: before, change: null };
    const errors = await checkRule(pool, input);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      for (const d of diff) await applyTranslationRuleField(c, id, d.field, d.after, me.id);
      return recordChange(c, {
        entityType: "translation_rule",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed translation rule ${input.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadTranslationRule(pool, id), change };
  });
}

export function getTranslationRuleUsedBy(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool): Promise<RuleUsedBy | FastifyReply> => {
    const { rows: exists } = await pool.query("SELECT 1 FROM translation_rules WHERE id = $1", [id]);
    if (!exists[0]) return notFound(reply, "Translation rule", id);
    const side = (kind: TrunkKind) => `
      SELECT DISTINCT ON (t.id) '${kind}' AS kind, t.id, t.name, e.name AS enterprise_name, tg.target_type AS via,
             COALESCE(s.enabled, true) AS enabled
        FROM translation_rule_targets tg
        JOIN ${kind}_trunks t ON t.deleted_at IS NULL
         AND (tg.target_type = 'all' OR (tg.target_type = 'trunk' AND tg.target_id = t.id)
              OR (tg.target_type = 'enterprise' AND tg.target_id = t.enterprise_id)
              OR (tg.target_type = 'category' AND tg.target_id = t.product_category_id))
        JOIN enterprises e ON e.id = t.enterprise_id
        LEFT JOIN translation_rule_trunk_settings s
               ON s.translation_rule_id = tg.translation_rule_id AND s.trunk_kind = '${kind}' AND s.trunk_id = t.id
       WHERE tg.translation_rule_id = $1 AND tg.trunk_kind = '${kind}'
       ORDER BY t.id, array_position(ARRAY['trunk','enterprise','category','all'], tg.target_type)`;
    const { rows } = await pool.query(
      `SELECT * FROM (${side("customer")}) a UNION ALL SELECT * FROM (${side("vendor")}) b ORDER BY kind, name`,
      [id],
    );
    return {
      trunks: rows.map((r) => ({
        kind: r.kind,
        id: Number(r.id),
        name: r.name,
        enterpriseName: r.enterprise_name,
        via: r.via,
        enabled: r.enabled,
      })),
    };
  });
}

export function cloneTranslationRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = (request.body ?? {}) as TranslationCloneInput;
  return withDb(reply, async (pool) => {
    const src = await loadTranslationRule(pool, id);
    if (!src) return notFound(reply, "Translation rule", id);
    const target = body.targetTrunk ?? null;
    let trunkName: string | null = null;
    if (target) {
      const { rows } = await pool.query(`SELECT name FROM ${target.kind}_trunks WHERE id = $1 AND deleted_at IS NULL`, [
        target.id,
      ]);
      if (!rows[0]) return badInput(reply, [{ path: "/targetTrunk/id", message: `unknown ${target.kind} trunk` }]);
      trunkName = rows[0].name;
    }
    const name = body.name?.trim() || (trunkName ? `${src.name} (${trunkName})` : `${src.name} (copy)`);
    const input: TranslationRuleInput = {
      ...(Object.fromEntries(COLUMNS.map(([api]) => [api, src[api]])) as Fields),
      name,
      // An independent copy: inactive until reviewed, unless it is the variant for one trunk.
      status: target ? "active" : "inactive",
      targets: target ? [{ type: "trunk", trunkKind: target.kind, id: target.id }] : [],
    };
    const me = await getCurrentUser();
    const { newId, change } = await inTransaction(pool, async (c) => {
      const newId = await insertRule(c, input, me.id);
      let wasEnabled = true;
      if (target) {
        // The trunk runs the variant where it ran the original, and no longer the original.
        const { rows } = await c.query(
          `SELECT position, continue_after, enabled FROM translation_rule_trunk_settings
            WHERE translation_rule_id = $1 AND trunk_kind = $2 AND trunk_id = $3`,
          [id, target.kind, target.id],
        );
        wasEnabled = rows[0]?.enabled ?? true;
        await c.query(
          `INSERT INTO translation_rule_trunk_settings (translation_rule_id, trunk_kind, trunk_id, position, continue_after, enabled)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [newId, target.kind, target.id, rows[0]?.position ?? null, rows[0]?.continue_after ?? src.continueAfter],
        );
        // ... and the original is switched off on that trunk only (its other trunks keep it).
        await setTrunkEnabled(c, id, target.kind, target.id, false);
      }
      const diff: DiffEntry[] = [{ entity_id: newId, field: "*", before: null, after: { name, clonedFrom: id } }];
      if (target)
        diff.push({
          entity_id: id,
          field: `trunkEnabled:${target.kind}:${target.id}`,
          before: wasEnabled,
          after: false,
        });
      const change = await recordChange(c, {
        entityType: "translation_rule",
        entityIds: target ? [newId, id] : [newId],
        changeType: "create",
        diff,
        note: target ? `Duplicated ${src.name} to trunk ${trunkName}` : `Cloned translation rule ${src.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { newId, change };
    });
    return reply.code(201).send({ record: await loadTranslationRule(pool, newId), change });
  });
}

export function archiveTranslationRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadTranslationRule(pool, id);
    if (!before) return notFound(reply, "Translation rule", id);
    if (before.archivedAt) return { record: before, change: null };
    // Nothing blocks: the rule just stops running on the trunks it touched (shown in the answer).
    // Assigned to a live trunk or enterprise: cannot be deleted (team trial round 3).
    const gate = await archiveGate(
      reply,
      (request.body ?? {}) as ArchiveRequest,
      await ruleTargetDependencies(pool, "translation", id, before.usedBy),
    );
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "translation_rules",
      entityType: "translation_rule",
      archive: true,
      note: gate.note ?? `Deleted translation rule ${before.name} (ran on ${before.usedBy} trunks)`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadTranslationRule(pool, id), change: r.change };
  });
}

export function restoreTranslationRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadTranslationRule(pool, id);
    if (!before) return notFound(reply, "Translation rule", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This rule is not deleted");
    // Rules are restored by anyone who may edit them: nothing else depends on a deleted rule.
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE translation_rules SET deleted_at = NULL, updated_by_id = $2, updated_at = now() WHERE id = $1",
        [id, me.id],
      );
      return recordChange(c, {
        entityType: "translation_rule",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "archived", before: true, after: false }],
        note: "Restored",
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadTranslationRule(pool, id), change };
  });
}

// ---------------------------------------------------------------- Test (§13.2)

let prefixCache: { at: number; map: Map<string, string>; longest: number } | null = null;

/** Receiver → MCCMNC by the longest "All" profile dial code, cached a minute. */
export async function mccmncLookup(db: Db): Promise<(receiver: string) => string | null> {
  if (!prefixCache || Date.now() - prefixCache.at > 60_000) {
    const { rows } = await db.query(
      `SELECT d.prefix, m.mccmnc FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id
        WHERE d.profile = 'All' AND d.deleted_at IS NULL AND m.deleted_at IS NULL`,
    );
    const map = new Map(rows.map((r) => [r.prefix as string, r.mccmnc as string]));
    prefixCache = { at: Date.now(), map, longest: Math.max(0, ...[...map.keys()].map((p) => p.length)) };
  }
  const { map, longest } = prefixCache;
  return (receiver) => {
    const digits = receiver.replace(/^\+/, "");
    for (let n = Math.min(longest, digits.length); n > 0; n--) {
      const hit = map.get(digits.slice(0, n));
      if (hit) return hit;
    }
    return null;
  };
}

async function engineContext(db: Db, rules: EngineRule[]): Promise<EngineContext> {
  const ids = [...new Set(rules.flatMap((r) => [r.senderListId, r.receiverListId, r.senderConversionListId]))].filter(
    (x): x is number => x !== null,
  );
  const { rows } = await db.query(
    "SELECT number_list_id, value, content FROM number_list_entries WHERE number_list_id = ANY($1) AND deleted_at IS NULL",
    [ids],
  );
  const lists = new Map<number, string[]>();
  const templates = new Map<number, Map<string, string[]>>();
  for (const r of rows) {
    const id = Number(r.number_list_id);
    const value = r.value as string;
    if (!(lists.get(id) ?? []).includes(value)) lists.set(id, [...(lists.get(id) ?? []), value]);
    if (r.content !== null) {
      const byValue = templates.get(id) ?? new Map<string, string[]>();
      byValue.set(value, [...(byValue.get(value) ?? []), r.content as string]);
      templates.set(id, byValue);
    }
  }
  return { lists, templates, mccmncOf: await mccmncLookup(db), now: new Date(), rand: Math.random };
}

async function engineRules(db: Db, ids: number[]): Promise<Map<number, EngineRule>> {
  const { rows } = await db.query("SELECT * FROM translation_rules WHERE id = ANY($1)", [ids]);
  return new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), ...fieldsOf(r) }]));
}

export function testTranslationRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = request.body as TranslationTestInput;
  return withDb(reply, async (pool) => {
    const saved = (await engineRules(pool, [id])).get(id);
    if (!saved) return notFound(reply, "Translation rule", id);
    let rule = saved;
    if (body.rule) {
      const errors = (await checkRule(pool, normalise(body.rule))).filter((e) => !e.path.startsWith("/targets"));
      if (errors.length)
        return badInput(
          reply,
          errors.map((e) => ({ ...e, path: `/rule${e.path}` })),
        );
      rule = { id, ...(Object.fromEntries(COLUMNS.map(([api]) => [api, body.rule![api]])) as Fields) };
    }
    return runRules([{ rule }], body.message, await engineContext(pool, [rule]));
  });
}

/**
 * Runs a sample message through every translation rule on a trunk, and finds the HLR rule. Null when
 * the trunk does not exist. Also used by the Route Simulator (§9.2).
 */
export async function runTrunkRules(
  pool: pg.Pool,
  kind: TrunkKind,
  id: number,
  message: TrunkRulesTestInput["message"],
): Promise<TrunkRulesTestResult | null> {
  const order = await trunkRuleOrder(pool, kind, "translation", id);
  if (!order) return null;
  const running = order.filter((r) => r.enabled && r.ruleActive);
  const rules = await engineRules(
    pool,
    running.map((r) => r.ruleId),
  );
  const list = running.map((r) => ({ rule: rules.get(r.ruleId)!, continueAfter: r.continueAfter }));
  const result = runRules(
    list,
    message,
    await engineContext(
      pool,
      list.map((x) => x.rule),
    ),
  );
  let hlr: TrunkRulesTestResult["hlr"] = null;
  if (kind === "customer" && !result.blocked) {
    const hlrOrder = ((await trunkRuleOrder(pool, kind, "hlr", id)) ?? []).filter((r) => r.enabled && r.ruleActive);
    if (hlrOrder.length) {
      const { rows } = await pool.query(
        `SELECT r.id, r.name, r.dnid_pattern, p.id AS provider_id, p.name AS provider_name
           FROM hlr_rules r JOIN hlr_providers p ON p.id = r.hlr_provider_id WHERE r.id = ANY($1)`,
        [hlrOrder.map((r) => r.ruleId)],
      );
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      for (const h of hlrOrder) {
        const r = byId.get(h.ruleId);
        if (r && compile(r.dnid_pattern)?.test(result.after.receiver)) {
          hlr = {
            ruleId: Number(r.id),
            ruleName: r.name,
            providerId: Number(r.provider_id),
            providerName: r.provider_name,
          };
          break;
        }
      }
    }
  }
  return { ...result, hlr };
}

export function testTrunkRules(kind: TrunkKind) {
  return (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as Params;
    const { message } = request.body as TrunkRulesTestInput;
    return withDb(reply, async (pool): Promise<TrunkRulesTestResult | FastifyReply> => {
      const result = await runTrunkRules(pool, kind, id, message);
      return result ?? sendProblem(reply, 404, `${kind === "customer" ? "Customer" : "Vendor"} trunk ${id} not found`);
    });
  };
}

export function getTranslationRuleDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const rule = await loadTranslationRule(pool, id);
    if (!rule) return notFound(reply, "Translation rule", id);
    return ruleTargetDependencies(pool, "translation", id, rule.usedBy);
  });
}
