// Product reference data (§6.1): product categories, countries, MCCMNC codes, Master Table
// profiles and their dial codes, and the MO reference book. Every save is one undoable
// change (§13.10); delete archives and is blocked while the record is in use (§13.29);
// imports run as a dry run first and save all or nothing.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  Change,
  Country,
  CountryInput,
  Destination,
  DestinationInput,
  DialCode,
  DialCodeInput,
  DialCodeProfile,
  DialCodeProfileInput,
  DialCodeProfileUpdate,
  DialCodeUpdate,
  IdList,
  ImportIssue,
  ImportRequest,
  ImportResult,
  ListQuery,
  MoNumber,
  MoNumberInput,
  ProductCategory,
  ProductCategoryInput,
} from "@sms/contract";
import { withDb } from "../db.js";
import { chRows } from "../edr.js";
import {
  countryList,
  destinationList,
  dialCodeList,
  dialCodeProfileList,
  moNumberList,
  productCategoryList,
  trunkCurrencySql,
} from "../lists/defs.js";
import { compileQuery, runList, type ListDef } from "../lists/engine.js";
import { checkListQuery } from "../lists/validate.js";
import { listFields } from "../lists/fields.js";
import { sendProblem } from "../problem.js";
import { archiveGate } from "./enterprises.js";
import { dependencies, isAdmin, isUniqueViolation, recordChange, type DiffEntry } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };

/** One record by id through its list definition, archived ones included. */
export async function load<Row>(db: Db, def: ListDef<Row>, id: number): Promise<Row | null> {
  const from = typeof def.from === "function" ? def.from({} as ListQuery) : def.from;
  const { rows } = await db.query(`SELECT ${def.select} FROM ${from} WHERE ${def.idSql} = $1`, [id]);
  return rows[0] ? def.mapRow(rows[0]) : null;
}

export const notFound = (reply: FastifyReply, what: string, id: number) =>
  sendProblem(reply, 404, `${what} ${id} not found`);
export const conflict = (reply: FastifyReply, detail: string) => sendProblem(reply, 409, detail);

/** Field-level diff over the given keys (undo restores each, §13.10). */
export function diffFields(id: number, before: object, after: object, keys: string[]): DiffEntry[] {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  return keys
    .filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null))
    .map((k) => ({ entity_id: id, field: k, before: b[k] ?? null, after: a[k] ?? null }));
}

/** Archive or restore one record as one change. Restore is for administrators (§13.29). */
export async function setArchived(
  request: FastifyRequest,
  reply: FastifyReply,
  pool: pg.Pool,
  opts: {
    table: string;
    entityType: string;
    archive: boolean;
    note: string | null;
    /** Checked before a restore: a live record with the same key answers 409. */
    restoreClash?: (db: Db) => Promise<string | null>;
  },
): Promise<{ change: Change | null } | { reply: FastifyReply }> {
  const { id } = request.params as Params;
  const me = await getCurrentUser();
  const { rows } = await pool.query(`SELECT deleted_at FROM ${opts.table} WHERE id = $1`, [id]);
  if (!rows[0] || (rows[0].deleted_at !== null) === opts.archive) return { change: null };
  if (!opts.archive) {
    if (!isAdmin(me)) return { reply: sendProblem(reply, 403, "Only administrators can restore archived records") };
    const clash = await opts.restoreClash?.(pool);
    if (clash) return { reply: conflict(reply, clash) };
  }
  const change = await inTransaction(pool, async (c) => {
    await c.query(`UPDATE ${opts.table} SET deleted_at = ${opts.archive ? "now()" : "NULL"} WHERE id = $1`, [id]);
    return recordChange(c, {
      entityType: opts.entityType,
      entityIds: [id],
      changeType: opts.archive ? "delete" : "edit",
      diff: [{ entity_id: id, field: "archived", before: !opts.archive, after: opts.archive }],
      note: opts.archive ? opts.note : "Restored",
      userId: me.id,
      ip: request.ip,
    });
  });
  return { change };
}

// ---------------------------------------------------------------- CSV

export const csvCell = (v: unknown) => {
  if (v == null) return "";
  const s = String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Parses CSV text (comma or semicolon, quotes, CRLF, BOM) into header-keyed rows with line numbers. */
export function parseCsv(text: string): { header: string[]; rows: { line: number; values: Record<string, string> }[] } {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      cells.push(cell);
      records.push({ line: startLine, cells });
      cells = [];
      cell = "";
      line++;
      startLine = line;
    } else cell += ch;
  }
  if (cell !== "" || cells.length) {
    cells.push(cell);
    records.push({ line: startLine, cells });
  }
  const nonEmpty = records.filter((r) => r.cells.some((c) => c.trim() !== ""));
  const header = (nonEmpty[0]?.cells ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return {
    header,
    rows: nonEmpty.slice(1).map((r) => ({
      line: r.line,
      values: Object.fromEntries(header.map((h, i) => [h, (r.cells[i] ?? "").trim()])),
    })),
  };
}

/** Streams the rows of a list query as CSV with the given columns. */
export async function exportList<Row>(
  request: FastifyRequest,
  reply: FastifyReply,
  list: keyof typeof listFields,
  def: ListDef<Row>,
  cols: [string, (r: Row) => unknown][],
  file: string,
) {
  const query = { ...(request.body as ListQuery), limit: 100_000, cursor: null };
  const errors = checkListQuery(query, listFields[list]);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, async (pool) => {
    const q = compileQuery(def as ListDef<unknown>, query);
    const { rows } = await pool.query(q.sql, q.values);
    const lines = rows.slice(0, q.limit).map((r) => cols.map(([, f]) => csvCell(f(def.mapRow(r)))).join(","));
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${file}"`)
      .send([cols.map(([h]) => h).join(","), ...lines].join("\r\n") + "\r\n");
  });
}

const MAX_ISSUES = 200;

/** Collects an import's counts and issues; `apply` runs only when it is not a dry run and nothing failed. */
export class ImportRun {
  readonly errors: ImportIssue[] = [];
  readonly warnings: ImportIssue[] = [];
  readonly kept: ImportIssue[] = [];
  added = 0;
  updated = 0;
  unchanged = 0;
  archived = 0;
  constructor(readonly total: number) {}
  error(line: number | null, key: string | null, message: string) {
    if (this.errors.length < MAX_ISSUES) this.errors.push({ line, key, message });
    else if (this.errors.length === MAX_ISSUES)
      this.errors.push({ line: null, key: null, message: "More errors not listed" });
  }
  warn(line: number | null, key: string | null, message: string) {
    if (this.warnings.length < MAX_ISSUES) this.warnings.push({ line, key, message });
  }
  keep(key: string, message: string) {
    if (this.kept.length < MAX_ISSUES) this.kept.push({ line: null, key, message });
  }
  result(applied: boolean, dryRun: boolean, change: ImportResult["change"]): ImportResult {
    return {
      applied,
      dryRun,
      total: this.total,
      added: this.added,
      updated: this.updated,
      unchanged: this.unchanged,
      archived: this.archived,
      errors: this.errors,
      warnings: this.warnings,
      kept: this.kept,
      change,
    };
  }
}

function requireColumns(reply: FastifyReply, header: string[], needed: string[]) {
  const missing = needed.filter((c) => !header.includes(c));
  return missing.length
    ? sendProblem(reply, 400, `The file needs the column(s) ${missing.join(", ")} in its header row`, {
        errors: missing.map((m) => ({ path: "/csv", message: `missing column ${m}` })),
      })
    : null;
}

const num = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s.replace(",", ".")));

// ---------------------------------------------------------------- product categories

const loadCategory = (db: Db, id: number) => load<ProductCategory>(db, productCategoryList, id);

async function categoryNameTaken(db: Db, name: string, exceptId: number | null) {
  const { rows } = await db.query(
    "SELECT 1 FROM product_categories WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> $2",
    [name, exceptId ?? 0],
  );
  return rows.length > 0;
}

export function createProductCategory(request: FastifyRequest, reply: FastifyReply) {
  const name = (request.body as ProductCategoryInput).name.trim();
  return withDb(reply, async (pool) => {
    if (!name)
      return sendProblem(reply, 400, "Enter a category name", { errors: [{ path: "/name", message: "required" }] });
    if (await categoryNameTaken(pool, name, null)) return conflict(reply, `A category named "${name}" exists`);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        "INSERT INTO product_categories (name, updated_by_id) VALUES ($1, $2) RETURNING id",
        [name, me.id],
      );
      const id = rows[0].id as number;
      const change = await recordChange(c, {
        entityType: "product_category",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name } }],
        note: `Added product category ${name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadCategory(pool, id), change });
  });
}

export function updateProductCategory(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const name = (request.body as ProductCategoryInput).name.trim();
  return withDb(reply, async (pool) => {
    const before = await loadCategory(pool, id);
    if (!before) return notFound(reply, "Product category", id);
    if (before.name === name) return { record: before, change: null };
    if (await categoryNameTaken(pool, name, id)) return conflict(reply, `A category named "${name}" exists`);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE product_categories SET name = $2, updated_by_id = $3, updated_at = now() WHERE id = $1", [
        id,
        name,
        me.id,
      ]);
      return recordChange(c, {
        entityType: "product_category",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "name", before: before.name, after: name }],
        note: `Renamed product category ${before.name} to ${name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadCategory(pool, id), change };
  });
}

async function categoryDependencies(db: Db, id: number) {
  const count = async (sql: string) => Number((await db.query(sql, [id])).rows[0].n);
  const [ct, vt, rt, rr, tr, hr] = await Promise.all([
    count("SELECT count(*) AS n FROM customer_trunks WHERE product_category_id = $1 AND deleted_at IS NULL"),
    count("SELECT count(*) AS n FROM vendor_trunks WHERE product_category_id = $1 AND deleted_at IS NULL"),
    count("SELECT count(*) AS n FROM rate_tables WHERE product_category_id = $1 AND deleted_at IS NULL"),
    count(
      "SELECT count(*) AS n FROM route_rules WHERE ($1 = ANY(category_ids) OR $1 = ANY(vendor_category_ids)) AND deleted_at IS NULL",
    ),
    count(
      `SELECT count(DISTINCT t.translation_rule_id) AS n FROM translation_rule_targets t
         JOIN translation_rules r ON r.id = t.translation_rule_id
        WHERE t.target_type = 'category' AND t.target_id = $1 AND r.deleted_at IS NULL`,
    ),
    count(
      `SELECT count(DISTINCT t.hlr_rule_id) AS n FROM hlr_rule_targets t JOIN hlr_rules r ON r.id = t.hlr_rule_id
        WHERE t.target_type = 'category' AND t.target_id = $1 AND r.deleted_at IS NULL`,
    ),
  ]);
  return dependencies([
    { key: "customer_trunks", label: "Customer trunks", count: ct, blocking: true, detail: null },
    { key: "vendor_trunks", label: "Vendor trunks", count: vt, blocking: true, detail: null },
    { key: "rate_tables", label: "Rate tables", count: rt, blocking: true, detail: null },
    { key: "route_rules", label: "Route rules", count: rr, blocking: true, detail: null },
    { key: "translation_rules", label: "Translation rules", count: tr, blocking: true, detail: null },
    { key: "hlr_rules", label: "HLR rules", count: hr, blocking: true, detail: null },
  ]);
}

export function getProductCategoryDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadCategory(pool, id))) return notFound(reply, "Product category", id);
    return categoryDependencies(pool, id);
  });
}

export function archiveProductCategory(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadCategory(pool, id);
    if (!before) return notFound(reply, "Product category", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(reply, (request.body ?? {}) as ArchiveRequest, await categoryDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "product_categories",
      entityType: "product_category",
      archive: true,
      note: gate.note ?? `Deleted product category ${before.name}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadCategory(pool, id), change: r.change };
  });
}

export function restoreProductCategory(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadCategory(pool, id);
    if (!before) return notFound(reply, "Product category", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This category is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "product_categories",
      entityType: "product_category",
      archive: false,
      note: null,
      restoreClash: async (db) =>
        (await categoryNameTaken(db, before.name, id)) ? `A live category is named "${before.name}"` : null,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadCategory(pool, id), change: r.change };
  });
}

// ---------------------------------------------------------------- countries

const loadCountry = (db: Db, id: number) => load<Country>(db, countryList, id);
const COUNTRY_FIELDS = ["name", "iso", "dialCode", "region"] as const;

function countryValues(input: CountryInput) {
  return {
    name: input.name.trim(),
    iso: input.iso.toUpperCase(),
    dialCode: input.dialCode,
    region: input.region.trim(),
  };
}

export function createCountry(request: FastifyRequest, reply: FastifyReply) {
  const v = countryValues(request.body as CountryInput);
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    try {
      const { id, change } = await inTransaction(pool, async (c) => {
        const { rows } = await c.query(
          "INSERT INTO countries (name, iso, dial_code, region, updated_by_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [v.name, v.iso, v.dialCode, v.region, me.id],
        );
        const id = rows[0].id as number;
        const change = await recordChange(c, {
          entityType: "country",
          entityIds: [id],
          changeType: "create",
          diff: [{ entity_id: id, field: "*", before: null, after: v }],
          note: `Added country ${v.name}`,
          userId: me.id,
          ip: request.ip,
        });
        return { id, change };
      });
      return reply.code(201).send({ record: await loadCountry(pool, id), change });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(reply, `A country named "${v.name}" exists`);
      throw err;
    }
  });
}

export function updateCountry(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const v = countryValues(request.body as CountryInput);
  return withDb(reply, async (pool) => {
    const before = await loadCountry(pool, id);
    if (!before) return notFound(reply, "Country", id);
    const diff = diffFields(id, before, v, [...COUNTRY_FIELDS]);
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    try {
      const change = await inTransaction(pool, async (c) => {
        await c.query(
          `UPDATE countries SET name = $2, iso = $3, dial_code = $4, region = $5, updated_by_id = $6, updated_at = now()
            WHERE id = $1`,
          [id, v.name, v.iso, v.dialCode, v.region, me.id],
        );
        return recordChange(c, {
          entityType: "country",
          entityIds: [id],
          changeType: "edit",
          diff,
          note: `Changed country ${before.name}`,
          userId: me.id,
          ip: request.ip,
        });
      });
      return { record: await loadCountry(pool, id), change };
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(reply, `A country named "${v.name}" exists`);
      throw err;
    }
  });
}

export const exportCountries = (request: FastifyRequest, reply: FastifyReply) =>
  exportList<Country>(
    request,
    reply,
    "countries",
    countryList,
    [
      ["name", (r) => r.name],
      ["iso", (r) => r.iso],
      ["dial_code", (r) => r.dialCode],
      ["region", (r) => r.region],
      ["mccmnc_codes", (r) => r.networks],
    ],
    "countries.csv",
  );

// ---------------------------------------------------------------- MCCMNC codes

const loadDestination = (db: Db, id: number) => load<Destination>(db, destinationList, id);

/** The stored form of a code: mccmnc, is_all_networks and the columns undo restores. */
function destinationColumns(input: DestinationInput) {
  const mnc = input.mnc.trim();
  return {
    mcc: input.mcc,
    mnc,
    mccmnc: input.mcc + mnc,
    allNetworks: mnc === "",
    originalMnc: input.originalMnc?.trim() || null,
    countryId: input.countryId,
    network: mnc === "" ? "All networks" : input.network.trim(),
  };
}
const DESTINATION_FIELDS = ["mcc", "mnc", "mccmnc", "allNetworks", "originalMnc", "countryId", "network"];

async function codeTaken(db: Db, code: string, exceptId: number) {
  const { rows } = await db.query("SELECT 1 FROM mccmnc WHERE mccmnc = $1 AND deleted_at IS NULL AND id <> $2", [
    code,
    exceptId,
  ]);
  return rows.length > 0;
}

async function destinationDependencies(db: Db, id: number) {
  const { rows } = await db.query("SELECT mccmnc FROM mccmnc WHERE id = $1", [id]);
  const code = rows[0]?.mccmnc as string;
  const count = async (sql: string, args: unknown[]) => Number((await db.query(sql, args)).rows[0].n);
  const [lines, rules, translations, dialCodes, mo, traffic] = await Promise.all([
    count(
      "SELECT count(*) AS n FROM rate_lines WHERE mccmnc_id = $1 AND (valid_to IS NULL OR valid_to > now()) AND NOT is_blocked",
      [id],
    ),
    count("SELECT count(*) AS n FROM route_rules WHERE $1 = ANY(mccmncs) AND deleted_at IS NULL", [code]),
    count("SELECT count(*) AS n FROM translation_rules WHERE $1 = ANY(mccmncs) AND deleted_at IS NULL", [code]),
    count(
      `SELECT count(*) AS n FROM dial_codes d JOIN dial_code_profiles p ON p.name = d.profile
        WHERE d.mccmnc_id = $1 AND d.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [id],
    ),
    count("SELECT count(*) AS n FROM mo_numbers WHERE mccmnc_id = $1 AND deleted_at IS NULL", [id]),
    chRows<{ n: string }>(
      `SELECT count() AS n FROM edr WHERE c_mccmnc = '${code.replace(/\D/g, "")}' AND submit_time > now() - INTERVAL 30 DAY`,
    ),
  ]);
  return dependencies([
    { key: "rate_lines", label: "Open or scheduled rate lines", count: lines, blocking: true, detail: null },
    { key: "route_rules", label: "Route rules", count: rules, blocking: true, detail: null },
    { key: "translation_rules", label: "Translation rules", count: translations, blocking: true, detail: null },
    { key: "dial_codes", label: "Dial codes", count: dialCodes, blocking: true, detail: null },
    { key: "mo_numbers", label: "MO reference book entries", count: mo, blocking: true, detail: null },
    {
      key: "traffic_30d",
      label: "Messages in the last 30 days",
      count: traffic ? Number(traffic[0]?.n ?? 0) : null,
      blocking: false,
      detail: "History stays with the archived code",
    },
  ]);
}

export function createDestination(request: FastifyRequest, reply: FastifyReply) {
  const v = destinationColumns(request.body as DestinationInput);
  return withDb(reply, async (pool) => {
    const { rows: co } = await pool.query("SELECT name FROM countries WHERE id = $1", [v.countryId]);
    if (!co[0])
      return sendProblem(reply, 400, "Unknown country", { errors: [{ path: "/countryId", message: "unknown" }] });
    if (await codeTaken(pool, v.mccmnc, 0)) return conflict(reply, `MCCMNC ${v.mccmnc} exists`);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO mccmnc (mcc, mnc, mccmnc, country_id, network, is_all_networks, original_mnc, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [v.mcc, v.mnc, v.mccmnc, v.countryId, v.network, v.allNetworks, v.originalMnc, me.id],
      );
      const id = rows[0].id as number;
      const change = await recordChange(c, {
        entityType: "destination",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: v }],
        note: `Added MCCMNC ${v.mccmnc} ${co[0].name} · ${v.network}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadDestination(pool, id), change });
  });
}

export function updateDestination(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const v = destinationColumns(request.body as DestinationInput);
  return withDb(reply, async (pool) => {
    const before = await loadDestination(pool, id);
    if (!before) return notFound(reply, "MCCMNC code", id);
    const was = { ...before, network: before.allNetworks ? "All networks" : before.network };
    const diff = diffFields(id, was, v, DESTINATION_FIELDS);
    if (!diff.length) return { record: before, change: null };
    if (v.mccmnc !== before.mccmnc) {
      if ((await destinationDependencies(pool, id)).blocked)
        return conflict(reply, `MCCMNC ${before.mccmnc} is in use; its MCC and MNC cannot change`);
      if (await codeTaken(pool, v.mccmnc, id)) return conflict(reply, `MCCMNC ${v.mccmnc} exists`);
    }
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE mccmnc SET mcc = $2, mnc = $3, mccmnc = $4, country_id = $5, network = $6, is_all_networks = $7,
                original_mnc = $8, updated_by_id = $9, updated_at = now() WHERE id = $1`,
        [id, v.mcc, v.mnc, v.mccmnc, v.countryId, v.network, v.allNetworks, v.originalMnc, me.id],
      );
      return recordChange(c, {
        entityType: "destination",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed MCCMNC ${before.mccmnc}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadDestination(pool, id), change };
  });
}

export function getDestinationDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadDestination(pool, id))) return notFound(reply, "MCCMNC code", id);
    return destinationDependencies(pool, id);
  });
}

export function archiveDestination(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadDestination(pool, id);
    if (!before) return notFound(reply, "MCCMNC code", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(
      reply,
      (request.body ?? {}) as ArchiveRequest,
      await destinationDependencies(pool, id),
    );
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "mccmnc",
      entityType: "destination",
      archive: true,
      note: gate.note ?? `Deleted MCCMNC ${before.mccmnc} ${before.country} · ${before.network}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadDestination(pool, id), change: r.change };
  });
}

export function restoreDestination(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadDestination(pool, id);
    if (!before) return notFound(reply, "MCCMNC code", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This code is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "mccmnc",
      entityType: "destination",
      archive: false,
      note: null,
      restoreClash: async (db) => ((await codeTaken(db, before.mccmnc, id)) ? `MCCMNC ${before.mccmnc} exists` : null),
    });
    if ("reply" in r) return r.reply;
    return { record: await loadDestination(pool, id), change: r.change };
  });
}

/** Codes in use anywhere (rate lines, rules, dial codes, MO numbers), for import "replace". */
async function codesInUse(db: Db): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT m.mccmnc FROM mccmnc m WHERE m.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM rate_lines l WHERE l.mccmnc_id = m.id AND (l.valid_to IS NULL OR l.valid_to > now()))
     OR EXISTS (SELECT 1 FROM dial_codes d WHERE d.mccmnc_id = m.id AND d.deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM mo_numbers o WHERE o.mccmnc_id = m.id AND o.deleted_at IS NULL))
     UNION SELECT unnest(mccmncs) FROM route_rules WHERE deleted_at IS NULL
     UNION SELECT unnest(mccmncs) FROM translation_rules WHERE deleted_at IS NULL`,
  );
  return new Set(rows.map((r) => r.mccmnc as string));
}

export function importDestinations(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as ImportRequest;
  const { header, rows } = parseCsv(body.csv);
  const missingCols = requireColumns(reply, header, ["mcc", "mnc", "network"]);
  if (missingCols) return missingCols;
  if (!header.includes("country") && !header.includes("iso"))
    return sendProblem(reply, 400, "The file needs a country or iso column", {
      errors: [{ path: "/csv", message: "missing column country" }],
    });
  return withDb(reply, async (pool) => {
    const run = new ImportRun(rows.length);
    const { rows: countries } = await pool.query("SELECT id, name, iso FROM countries");
    const byName = new Map(countries.map((c) => [String(c.name).toLowerCase(), c.id as number]));
    const byIso = new Map<string, number[]>();
    for (const c of countries) byIso.set(String(c.iso), [...(byIso.get(String(c.iso)) ?? []), c.id as number]);
    const { rows: live } = await pool.query(
      "SELECT id, mcc, mnc, mccmnc, country_id, network, is_all_networks, original_mnc FROM mccmnc WHERE deleted_at IS NULL",
    );
    const existing = new Map(live.map((r) => [r.mccmnc as string, r]));
    const seen = new Map<string, number>();
    const inserts: ReturnType<typeof destinationColumns>[] = [];
    const updates: { id: number; v: ReturnType<typeof destinationColumns>; diff: DiffEntry[] }[] = [];
    for (const { line, values } of rows) {
      const mcc = values.mcc ?? "";
      const mnc = values.mnc ?? "";
      const code = mcc + mnc;
      if (!/^[0-9]{3}$/.test(mcc)) {
        run.error(line, code || null, "MCC must be 3 digits");
        continue;
      }
      if (!/^([0-9]{2,3})?$/.test(mnc)) {
        run.error(line, code, "MNC must be empty (All networks) or 2-3 digits");
        continue;
      }
      if (values.mccmnc && values.mccmnc !== code) {
        run.error(line, code, `mccmnc ${values.mccmnc} does not match MCC + MNC (${code})`);
        continue;
      }
      if (seen.has(code)) {
        run.error(line, code, `Code ${code} is also on line ${seen.get(code)}`);
        continue;
      }
      seen.set(code, line);
      let countryId = values.country ? byName.get(values.country.toLowerCase()) : undefined;
      if (countryId === undefined && values.iso) {
        const ids = byIso.get(values.iso.toUpperCase()) ?? [];
        if (ids.length > 1) {
          run.error(line, code, `ISO ${values.iso} is shared by several countries; give the country name`);
          continue;
        }
        countryId = ids[0];
      }
      if (countryId === undefined) {
        run.error(line, code, `Unknown country ${values.country || values.iso || "(empty)"}`);
        continue;
      }
      if (mnc !== "" && !values.network) {
        run.error(line, code, "Network name is empty");
        continue;
      }
      const v = destinationColumns({
        mcc,
        mnc,
        countryId,
        network: values.network ?? "",
        originalMnc: values.original_mnc || null,
      });
      const old = existing.get(code);
      if (!old) {
        inserts.push(v);
        run.added++;
        continue;
      }
      const was = {
        mcc: String(old.mcc),
        mnc: old.mnc,
        mccmnc: old.mccmnc,
        allNetworks: old.is_all_networks,
        originalMnc: old.original_mnc ?? null,
        countryId: Number(old.country_id),
        network: old.is_all_networks ? "All networks" : old.network,
      };
      const diff = diffFields(old.id as number, was, v, DESTINATION_FIELDS);
      if (diff.length) {
        updates.push({ id: old.id as number, v, diff });
        run.updated++;
      } else run.unchanged++;
    }
    const archives: number[] = [];
    if (body.mode === "replace") {
      const used = await codesInUse(pool);
      for (const [code, r] of existing) {
        if (seen.has(code)) continue;
        if (used.has(code)) run.keep(code, `Not in the file but still used; kept (${r.network})`);
        else archives.push(r.id as number);
      }
      run.archived = archives.length;
    } else {
      const missing = [...existing.keys()].filter((c) => !seen.has(c)).length;
      if (missing) run.warn(null, null, `${missing} codes in the master are not in the file; they stay (merge mode)`);
    }
    if (body.dryRun || run.errors.length) return run.result(false, body.dryRun, null);
    if (!inserts.length && !updates.length && !archives.length) return run.result(true, false, null);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      const diff: DiffEntry[] = [];
      const ids: number[] = [];
      for (const v of inserts) {
        const { rows: ins } = await c.query(
          `INSERT INTO mccmnc (mcc, mnc, mccmnc, country_id, network, is_all_networks, original_mnc, updated_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [v.mcc, v.mnc, v.mccmnc, v.countryId, v.network, v.allNetworks, v.originalMnc, me.id],
        );
        ids.push(ins[0].id);
        diff.push({ entity_id: ins[0].id, field: "*", before: null, after: v });
      }
      for (const u of updates) {
        await c.query(
          `UPDATE mccmnc SET country_id = $2, network = $3, original_mnc = $4, updated_by_id = $5, updated_at = now()
            WHERE id = $1`,
          [u.id, u.v.countryId, u.v.network, u.v.originalMnc, me.id],
        );
        ids.push(u.id);
        diff.push(...u.diff);
      }
      if (archives.length) {
        await c.query("UPDATE mccmnc SET deleted_at = now() WHERE id = ANY($1)", [archives]);
        ids.push(...archives);
        diff.push(...archives.map((id) => ({ entity_id: id, field: "archived", before: false, after: true })));
      }
      return recordChange(c, {
        entityType: "destination",
        entityIds: ids,
        changeType: "import",
        diff,
        note: `MCCMNC import: ${run.added} added, ${run.updated} changed, ${run.archived} archived`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return run.result(true, false, change);
  });
}

export const exportDestinations = (request: FastifyRequest, reply: FastifyReply) =>
  exportList<Destination>(
    request,
    reply,
    "destinations",
    destinationList,
    [
      ["mccmnc", (r) => r.mccmnc],
      ["mcc", (r) => r.mcc],
      ["mnc", (r) => r.mnc],
      ["original_mnc", (r) => r.originalMnc],
      ["country", (r) => r.country],
      ["iso", (r) => r.countryIso],
      ["country_code", (r) => r.dialCode],
      ["network", (r) => (r.allNetworks ? "" : r.network)],
    ],
    "mccmnc_codes.csv",
  );

// ---------------------------------------------------------------- Master Table profiles and dial codes

const loadProfile = (db: Db, id: number) => load<DialCodeProfile>(db, dialCodeProfileList, id);
const loadDialCode = (db: Db, id: number) => load<DialCode>(db, dialCodeList, id);

export function createDialCodeProfile(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as DialCodeProfileInput;
  const name = body.name.trim();
  return withDb(reply, async (pool) => {
    let source: string | null = null;
    if (body.copyFromId) {
      const src = await loadProfile(pool, body.copyFromId);
      if (!src || src.archivedAt)
        return sendProblem(reply, 400, "Unknown profile to copy", {
          errors: [{ path: "/copyFromId", message: "unknown" }],
        });
      source = src.name;
    }
    const me = await getCurrentUser();
    try {
      const { id, change } = await inTransaction(pool, async (c) => {
        const { rows } = await c.query(
          "INSERT INTO dial_code_profiles (name, updated_by_id) VALUES ($1, $2) RETURNING id",
          [name, me.id],
        );
        const id = rows[0].id as number;
        let copied = 0;
        if (source) {
          const r = await c.query(
            `INSERT INTO dial_codes (profile, prefix, mccmnc_id, updated_by_id)
             SELECT $1, prefix, mccmnc_id, $3 FROM dial_codes WHERE profile = $2 AND deleted_at IS NULL`,
            [name, source, me.id],
          );
          copied = r.rowCount ?? 0;
        }
        const change = await recordChange(c, {
          entityType: "dial_code_profile",
          entityIds: [id],
          changeType: "create",
          diff: [{ entity_id: id, field: "*", before: null, after: { name, copyFrom: source } }],
          note: source ? `Added profile ${name}, ${copied} dial codes copied from ${source}` : `Added profile ${name}`,
          userId: me.id,
          ip: request.ip,
        });
        return { id, change };
      });
      return reply.code(201).send({ record: await loadProfile(pool, id), change });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(reply, `A profile named "${name}" exists (maybe deleted)`);
      throw err;
    }
  });
}

export function updateDialCodeProfile(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const name = (request.body as DialCodeProfileUpdate).name.trim();
  return withDb(reply, async (pool) => {
    const before = await loadProfile(pool, id);
    if (!before) return notFound(reply, "Profile", id);
    if (before.name === name) return { record: before, change: null };
    if (before.isDefault) return sendProblem(reply, 400, 'The "All" profile keeps its name');
    const me = await getCurrentUser();
    try {
      const change = await inTransaction(pool, async (c) => {
        await c.query("UPDATE dial_code_profiles SET name = $2, updated_by_id = $3, updated_at = now() WHERE id = $1", [
          id,
          name,
          me.id,
        ]);
        return recordChange(c, {
          entityType: "dial_code_profile",
          entityIds: [id],
          changeType: "edit",
          diff: [{ entity_id: id, field: "name", before: before.name, after: name }],
          note: `Renamed profile ${before.name} to ${name}`,
          userId: me.id,
          ip: request.ip,
        });
      });
      return { record: await loadProfile(pool, id), change };
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(reply, `A profile named "${name}" exists (maybe deleted)`);
      throw err;
    }
  });
}

export function archiveDialCodeProfile(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadProfile(pool, id);
    if (!before) return notFound(reply, "Profile", id);
    if (before.isDefault) return sendProblem(reply, 400, 'The "All" profile cannot be deleted');
    const r = await setArchived(request, reply, pool, {
      table: "dial_code_profiles",
      entityType: "dial_code_profile",
      archive: true,
      note: (request.body as ArchiveRequest | undefined)?.reason?.trim() || `Deleted profile ${before.name}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadProfile(pool, id), change: r.change };
  });
}

export function restoreDialCodeProfile(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadProfile(pool, id);
    if (!before) return notFound(reply, "Profile", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This profile is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "dial_code_profiles",
      entityType: "dial_code_profile",
      archive: false,
      note: null,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadProfile(pool, id), change: r.change };
  });
}

/** The dial-codes list needs one profile (rule 4: never all prefixes of all profiles). */
export function queryDialCodes(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const top = query.filter?.logic === "and" || !query.filter ? (query.filter?.conditions ?? []) : [];
  const has = top.some((c) => !("logic" in c) && c.field === "profileId" && c.op === "eq");
  if (!has)
    return sendProblem(reply, 400, "Invalid list query", {
      errors: [{ path: "/filter", message: "the filter needs a top-level profileId eq condition" }],
    });
  const errors = checkListQuery(query, listFields.dial_codes);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, dialCodeList, query));
}

async function liveProfileName(db: Db, id: number): Promise<string | null> {
  const { rows } = await db.query("SELECT name FROM dial_code_profiles WHERE id = $1 AND deleted_at IS NULL", [id]);
  return (rows[0]?.name as string | undefined) ?? null;
}

async function liveDestination(db: Db, id: number): Promise<string | null> {
  const { rows } = await db.query("SELECT mccmnc FROM mccmnc WHERE id = $1 AND deleted_at IS NULL", [id]);
  return (rows[0]?.mccmnc as string | undefined) ?? null;
}

async function prefixTaken(db: Db, profile: string, prefix: string, exceptId: number) {
  const { rows } = await db.query(
    "SELECT 1 FROM dial_codes WHERE profile = $1 AND prefix = $2 AND deleted_at IS NULL AND id <> $3",
    [profile, prefix, exceptId],
  );
  return rows.length > 0;
}

export function createDialCode(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as DialCodeInput;
  return withDb(reply, async (pool) => {
    const profile = await liveProfileName(pool, body.profileId);
    if (!profile)
      return sendProblem(reply, 400, "Unknown profile", { errors: [{ path: "/profileId", message: "unknown" }] });
    const code = await liveDestination(pool, body.destinationId);
    if (!code)
      return sendProblem(reply, 400, "Unknown MCCMNC code", {
        errors: [{ path: "/destinationId", message: "unknown" }],
      });
    if (await prefixTaken(pool, profile, body.prefix, 0))
      return conflict(reply, `Dial code ${body.prefix} is already in profile ${profile}`);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        "INSERT INTO dial_codes (profile, prefix, mccmnc_id, updated_by_id) VALUES ($1, $2, $3, $4) RETURNING id",
        [profile, body.prefix, body.destinationId, me.id],
      );
      const id = rows[0].id as number;
      const change = await recordChange(c, {
        entityType: "dial_code",
        entityIds: [id],
        changeType: "create",
        diff: [
          {
            entity_id: id,
            field: "*",
            before: null,
            after: { prefix: body.prefix, destinationId: body.destinationId },
          },
        ],
        note: `Added dial code ${body.prefix} → ${code} (${profile})`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadDialCode(pool, id), change });
  });
}

export function updateDialCode(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = request.body as DialCodeUpdate;
  return withDb(reply, async (pool) => {
    const before = await loadDialCode(pool, id);
    if (!before) return notFound(reply, "Dial code", id);
    const diff = diffFields(id, before, body, ["prefix", "destinationId"]);
    if (!diff.length) return { record: before, change: null };
    const code = await liveDestination(pool, body.destinationId);
    if (!code)
      return sendProblem(reply, 400, "Unknown MCCMNC code", {
        errors: [{ path: "/destinationId", message: "unknown" }],
      });
    if (await prefixTaken(pool, before.profile, body.prefix, id))
      return conflict(reply, `Dial code ${body.prefix} is already in profile ${before.profile}`);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE dial_codes SET prefix = $2, mccmnc_id = $3, updated_by_id = $4, updated_at = now() WHERE id = $1",
        [id, body.prefix, body.destinationId, me.id],
      );
      return recordChange(c, {
        entityType: "dial_code",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed dial code ${before.prefix} → ${body.prefix} ${code} (${before.profile})`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadDialCode(pool, id), change };
  });
}

export function deleteDialCodes(request: FastifyRequest, reply: FastifyReply) {
  const { ids } = request.body as IdList;
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(
      "SELECT id, prefix, profile FROM dial_codes WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY prefix",
      [ids],
    );
    if (!rows.length) return { change: null };
    const me = await getCurrentUser();
    const live = rows.map((r) => r.id as number);
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE dial_codes SET deleted_at = now(), updated_by_id = $2, updated_at = now() WHERE id = ANY($1)",
        [live, me.id],
      );
      return recordChange(c, {
        entityType: "dial_code",
        entityIds: live,
        changeType: "delete",
        diff: live.map((id) => ({ entity_id: id, field: "archived", before: false, after: true })),
        note:
          rows.length === 1
            ? `Deleted dial code ${rows[0].prefix} (${rows[0].profile})`
            : `Deleted ${rows.length} dial codes (${rows[0].profile})`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { change };
  });
}

export function importDialCodes(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = request.body as ImportRequest;
  const { header, rows } = parseCsv(body.csv);
  const missingCols = requireColumns(reply, header, ["prefix", "mccmnc"]);
  if (missingCols) return missingCols;
  return withDb(reply, async (pool) => {
    const profile = await liveProfileName(pool, id);
    if (!profile) return notFound(reply, "Profile", id);
    const run = new ImportRun(rows.length);
    const { rows: codes } = await pool.query("SELECT id, mccmnc FROM mccmnc WHERE deleted_at IS NULL");
    const codeId = new Map(codes.map((c) => [c.mccmnc as string, c.id as number]));
    const { rows: live } = await pool.query(
      "SELECT id, prefix, mccmnc_id FROM dial_codes WHERE profile = $1 AND deleted_at IS NULL",
      [profile],
    );
    const existing = new Map(live.map((r) => [r.prefix as string, r]));
    const seen = new Map<string, number>();
    const inserts: { prefix: string; destinationId: number }[] = [];
    const updates: { id: number; destinationId: number; before: number }[] = [];
    for (const { line, values } of rows) {
      const prefix = (values.prefix ?? "").replace(/^\+/, "");
      if (!/^[0-9]{1,15}$/.test(prefix)) {
        run.error(line, prefix || null, "Prefix must be 1-15 digits");
        continue;
      }
      if (seen.has(prefix)) {
        run.error(line, prefix, `Prefix ${prefix} is also on line ${seen.get(prefix)}`);
        continue;
      }
      seen.set(prefix, line);
      const destinationId = codeId.get(values.mccmnc ?? "");
      if (destinationId === undefined) {
        run.error(line, prefix, `MCCMNC ${values.mccmnc || "(empty)"} is not a live code`);
        continue;
      }
      const old = existing.get(prefix);
      if (!old) {
        inserts.push({ prefix, destinationId });
        run.added++;
      } else if (Number(old.mccmnc_id) !== destinationId) {
        updates.push({ id: old.id as number, destinationId, before: Number(old.mccmnc_id) });
        run.updated++;
      } else run.unchanged++;
    }
    const archives =
      body.mode === "replace" ? [...existing].filter(([p]) => !seen.has(p)).map(([, r]) => r.id as number) : [];
    run.archived = archives.length;
    if (body.dryRun || run.errors.length) return run.result(false, body.dryRun, null);
    if (!inserts.length && !updates.length && !archives.length) return run.result(true, false, null);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      const diff: DiffEntry[] = [];
      const ids: number[] = [];
      for (const v of inserts) {
        const { rows: ins } = await c.query(
          "INSERT INTO dial_codes (profile, prefix, mccmnc_id, updated_by_id) VALUES ($1, $2, $3, $4) RETURNING id",
          [profile, v.prefix, v.destinationId, me.id],
        );
        ids.push(ins[0].id);
        diff.push({ entity_id: ins[0].id, field: "*", before: null, after: v });
      }
      for (const u of updates) {
        await c.query("UPDATE dial_codes SET mccmnc_id = $2, updated_by_id = $3, updated_at = now() WHERE id = $1", [
          u.id,
          u.destinationId,
          me.id,
        ]);
        ids.push(u.id);
        diff.push({ entity_id: u.id, field: "destinationId", before: u.before, after: u.destinationId });
      }
      if (archives.length) {
        await c.query("UPDATE dial_codes SET deleted_at = now(), updated_by_id = $2 WHERE id = ANY($1)", [
          archives,
          me.id,
        ]);
        ids.push(...archives);
        diff.push(...archives.map((x) => ({ entity_id: x, field: "archived", before: false, after: true })));
      }
      return recordChange(c, {
        entityType: "dial_code",
        entityIds: ids,
        changeType: "import",
        diff,
        note: `Master data import (${profile}): ${run.added} added, ${run.updated} changed, ${run.archived} archived`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return run.result(true, false, change);
  });
}

export function exportDialCodes(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const profile = await loadProfile(pool, id);
    if (!profile) return notFound(reply, "Profile", id);
    const { rows } = await pool.query(
      `SELECT d.prefix, m.mccmnc, co.name AS country, CASE WHEN m.is_all_networks THEN '' ELSE m.network END AS network
         FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id JOIN countries co ON co.id = m.country_id
        WHERE d.profile = $1 AND d.deleted_at IS NULL ORDER BY d.prefix`,
      [profile.name],
    );
    const lines = rows.map((r) => [r.prefix, r.mccmnc, r.country, r.network].map(csvCell).join(","));
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="dial_codes_${profile.name.replace(/[^\w.-]+/g, "_")}.csv"`)
      .send(["prefix,mccmnc,country,network", ...lines].join("\r\n") + "\r\n");
  });
}

// ---------------------------------------------------------------- MO reference book

const loadMo = (db: Db, id: number) => load<MoNumber>(db, moNumberList, id);
const MO_FIELDS = [
  "customerTrunkId",
  "number",
  "keyword",
  "rate",
  "vendorRate",
  "destinationId",
  "setupCharge",
  "fixCharge",
];

function moValues(input: MoNumberInput) {
  return {
    customerTrunkId: input.customerTrunkId,
    number: input.number,
    keyword: input.keyword?.trim() || null,
    rate: input.rate,
    vendorRate: input.vendorRate,
    destinationId: input.destinationId,
    setupCharge: input.setupCharge,
    fixCharge: input.fixCharge,
  };
}
type MoValues = ReturnType<typeof moValues>;

async function moTaken(db: Db, number: string, keyword: string | null, exceptId: number) {
  const { rows } = await db.query(
    `SELECT 1 FROM mo_numbers WHERE number = $1 AND coalesce(lower(keyword), '') = coalesce(lower($2), '')
        AND deleted_at IS NULL AND id <> $3`,
    [number, keyword, exceptId],
  );
  return rows.length > 0;
}

/** Field errors for an MO entry: live trunk and live destination (amounts are in the trunk's currency). */
async function checkMo(db: Db, v: MoValues) {
  const errors: { path: string; message: string }[] = [];
  const [t, d] = await Promise.all([
    db.query("SELECT 1 FROM customer_trunks WHERE id = $1 AND deleted_at IS NULL", [v.customerTrunkId]),
    v.destinationId === null
      ? null
      : db.query("SELECT 1 FROM mccmnc WHERE id = $1 AND deleted_at IS NULL", [v.destinationId]),
  ]);
  if (!t.rows.length) errors.push({ path: "/customerTrunkId", message: "unknown or deleted customer trunk" });
  if (d && !d.rows.length) errors.push({ path: "/destinationId", message: "unknown MCCMNC code" });
  return errors;
}

const MO_COLUMNS = `customer_trunk_id, number, keyword, rate, vendor_rate, mccmnc_id, setup_charge, fix_charge`;
const moParams = (v: MoValues) => [
  v.customerTrunkId,
  v.number,
  v.keyword,
  v.rate,
  v.vendorRate,
  v.destinationId,
  v.setupCharge,
  v.fixCharge,
];
const moLabel = (v: { number: string; keyword: string | null }) => (v.keyword ? `${v.number} ${v.keyword}` : v.number);

export function createMoNumber(request: FastifyRequest, reply: FastifyReply) {
  const v = moValues(request.body as MoNumberInput);
  return withDb(reply, async (pool) => {
    const errors = await checkMo(pool, v);
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    if (await moTaken(pool, v.number, v.keyword, 0)) return conflict(reply, `${moLabel(v)} is already in the book`);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO mo_numbers (${MO_COLUMNS}, created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [...moParams(v), me.id],
      );
      const id = rows[0].id as number;
      const change = await recordChange(c, {
        entityType: "mo_number",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: v }],
        note: `Added MO number ${moLabel(v)}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadMo(pool, id), change });
  });
}

export function updateMoNumber(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const v = moValues(request.body as MoNumberInput);
  return withDb(reply, async (pool) => {
    const before = await loadMo(pool, id);
    if (!before) return notFound(reply, "MO reference book entry", id);
    const diff = diffFields(id, before, v, MO_FIELDS);
    if (!diff.length) return { record: before, change: null };
    const errors = await checkMo(pool, v);
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    if (await moTaken(pool, v.number, v.keyword, id)) return conflict(reply, `${moLabel(v)} is already in the book`);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE mo_numbers SET (${MO_COLUMNS}) = ($2, $3, $4, $5, $6, $7, $8, $9), updated_by_id = $10,
                updated_at = now() WHERE id = $1`,
        [id, ...moParams(v), me.id],
      );
      return recordChange(c, {
        entityType: "mo_number",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed MO number ${moLabel(before)}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadMo(pool, id), change };
  });
}

export function archiveMoNumber(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadMo(pool, id);
    if (!before) return notFound(reply, "MO reference book entry", id);
    const r = await setArchived(request, reply, pool, {
      table: "mo_numbers",
      entityType: "mo_number",
      archive: true,
      note: (request.body as ArchiveRequest | undefined)?.reason?.trim() || `Deleted MO number ${moLabel(before)}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadMo(pool, id), change: r.change };
  });
}

export function restoreMoNumber(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadMo(pool, id);
    if (!before) return notFound(reply, "MO reference book entry", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This entry is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "mo_numbers",
      entityType: "mo_number",
      archive: false,
      note: null,
      restoreClash: async (db) =>
        (await moTaken(db, before.number, before.keyword, id)) ? `${moLabel(before)} is already in the book` : null,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadMo(pool, id), change: r.change };
  });
}

export function importMoNumbers(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as ImportRequest;
  const { header, rows } = parseCsv(body.csv);
  const missingCols = requireColumns(reply, header, ["customer_trunk", "number", "rate"]);
  if (missingCols) return missingCols;
  return withDb(reply, async (pool) => {
    const run = new ImportRun(rows.length);
    const [{ rows: trunks }, { rows: codes }, { rows: live }] = await Promise.all([
      pool.query(
        `SELECT t.id, t.name, ${trunkCurrencySql("customer", "t")} AS currency FROM customer_trunks t WHERE t.deleted_at IS NULL`,
      ),
      pool.query("SELECT id, mccmnc FROM mccmnc WHERE deleted_at IS NULL"),
      pool.query(`SELECT id, ${MO_COLUMNS} FROM mo_numbers WHERE deleted_at IS NULL`),
    ]);
    const trunkIds = new Map<string, number[]>();
    for (const t of trunks) {
      const k = String(t.name).toLowerCase();
      trunkIds.set(k, [...(trunkIds.get(k) ?? []), t.id as number]);
    }
    const trunkCurrency = new Map(trunks.map((t) => [t.id as number, String(t.currency)]));
    const codeId = new Map(codes.map((c) => [c.mccmnc as string, c.id as number]));
    const keyOf = (n: string, k: string | null) => `${n}|${(k ?? "").toLowerCase()}`;
    const existing = new Map(live.map((r) => [keyOf(r.number, r.keyword), r]));
    const seen = new Map<string, number>();
    const inserts: MoValues[] = [];
    const updates: { id: number; v: MoValues; diff: DiffEntry[] }[] = [];
    for (const { line, values } of rows) {
      const number = (values.number ?? "").replace(/^\+/, "");
      const keyword = values.keyword || null;
      const key = keyOf(number, keyword);
      const label = moLabel({ number, keyword });
      if (!/^[0-9]{3,20}$/.test(number)) {
        run.error(line, number || null, "Number must be 3-20 digits");
        continue;
      }
      if (seen.has(key)) {
        run.error(line, label, `Also on line ${seen.get(key)}`);
        continue;
      }
      seen.set(key, line);
      const ids = trunkIds.get((values.customer_trunk ?? "").toLowerCase()) ?? [];
      if (ids.length !== 1) {
        run.error(
          line,
          label,
          ids.length
            ? `Several customer trunks are named ${values.customer_trunk}`
            : `Unknown customer trunk ${values.customer_trunk || "(empty)"}`,
        );
        continue;
      }
      // Amounts are in the trunk's currency (decided 2026-10-17); a currency column must agree.
      const currency = trunkCurrency.get(ids[0]!)!;
      if (values.currency && values.currency.toUpperCase() !== currency) {
        run.error(line, label, `${values.customer_trunk} bills in ${currency}, not ${values.currency.toUpperCase()}`);
        continue;
      }
      let destinationId: number | null = null;
      if (values.mccmnc) {
        destinationId = codeId.get(values.mccmnc) ?? null;
        if (destinationId === null) {
          run.error(line, label, `MCCMNC ${values.mccmnc} is not a live code`);
          continue;
        }
      }
      const amounts = {
        rate: num(values.rate),
        vendorRate: num(values.vendor_rate),
        setupCharge: num(values.setup_charge) ?? 0,
        fixCharge: num(values.fix_charge) ?? 0,
      };
      const bad = Object.entries(amounts).find(([k, x]) => (x === null ? k === "rate" : !Number.isFinite(x) || x < 0));
      if (bad) {
        run.error(line, label, `${bad[0]} must be a number of 0 or more`);
        continue;
      }
      const v: MoValues = {
        customerTrunkId: ids[0]!,
        number,
        keyword,
        rate: amounts.rate!,
        vendorRate: amounts.vendorRate,
        destinationId,
        setupCharge: amounts.setupCharge,
        fixCharge: amounts.fixCharge,
      };
      const old = existing.get(key);
      if (!old) {
        inserts.push(v);
        run.added++;
        continue;
      }
      const was = {
        customerTrunkId: Number(old.customer_trunk_id),
        number: old.number,
        keyword: old.keyword,
        rate: Number(old.rate),
        vendorRate: old.vendor_rate == null ? null : Number(old.vendor_rate),
        destinationId: old.mccmnc_id == null ? null : Number(old.mccmnc_id),
        setupCharge: Number(old.setup_charge),
        fixCharge: Number(old.fix_charge),
      };
      const diff = diffFields(old.id as number, was, v, MO_FIELDS);
      if (diff.length) {
        updates.push({ id: old.id as number, v, diff });
        run.updated++;
      } else run.unchanged++;
    }
    const archives =
      body.mode === "replace" ? [...existing].filter(([k]) => !seen.has(k)).map(([, r]) => r.id as number) : [];
    run.archived = archives.length;
    if (body.dryRun || run.errors.length) return run.result(false, body.dryRun, null);
    if (!inserts.length && !updates.length && !archives.length) return run.result(true, false, null);
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      const diff: DiffEntry[] = [];
      const ids: number[] = [];
      for (const v of inserts) {
        const { rows: ins } = await c.query(
          `INSERT INTO mo_numbers (${MO_COLUMNS}, created_by_id, updated_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
          [...moParams(v), me.id],
        );
        ids.push(ins[0].id);
        diff.push({ entity_id: ins[0].id, field: "*", before: null, after: v });
      }
      for (const u of updates) {
        await c.query(
          `UPDATE mo_numbers SET (${MO_COLUMNS}) = ($2, $3, $4, $5, $6, $7, $8, $9), updated_by_id = $10,
                  updated_at = now() WHERE id = $1`,
          [u.id, ...moParams(u.v), me.id],
        );
        ids.push(u.id);
        diff.push(...u.diff);
      }
      if (archives.length) {
        await c.query("UPDATE mo_numbers SET deleted_at = now() WHERE id = ANY($1)", [archives]);
        ids.push(...archives);
        diff.push(...archives.map((x) => ({ entity_id: x, field: "archived", before: false, after: true })));
      }
      return recordChange(c, {
        entityType: "mo_number",
        entityIds: ids,
        changeType: "import",
        diff,
        note: `MO reference book import: ${run.added} added, ${run.updated} changed, ${run.archived} archived`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return run.result(true, false, change);
  });
}

export const exportMoNumbers = (request: FastifyRequest, reply: FastifyReply) =>
  exportList<MoNumber>(
    request,
    reply,
    "mo_numbers",
    moNumberList,
    [
      ["customer_trunk", (r) => r.customerTrunk],
      ["number", (r) => r.number],
      ["keyword", (r) => r.keyword],
      ["rate", (r) => r.rate],
      ["vendor_rate", (r) => r.vendorRate],
      ["currency", (r) => r.currency],
      ["mccmnc", (r) => r.mccmnc],
      ["destination", (r) => r.destination],
      ["setup_charge", (r) => r.setupCharge],
      ["fix_charge", (r) => r.fixCharge],
      ["created", (r) => r.createdAt],
      ["created_by", (r) => r.createdBy],
    ],
    "mo_reference_book.csv",
  );
