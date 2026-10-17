// Number lists (§6.4, §12.4): Random, Tag and Sender ID Template lists that translation and
// route rules use. Every save is one undoable change (§13.10); delete archives and is blocked
// while rules use the list (§13.29); imports run as a dry run first and save all or nothing.
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  IdList,
  ImportRequest,
  ListQuery,
  NumberList,
  NumberListEntriesInput,
  NumberListInput,
} from "@sms/contract";
import { withDb } from "../db.js";
import { numberListEntryList, numberListList } from "../lists/defs.js";
import { runList } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { archiveGate } from "./enterprises.js";
import { ImportRun, conflict, csvCell, load, notFound, parseCsv, setArchived } from "./masterData.js";
import { dependencies, recordChange, type DiffEntry } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };
type ListType = NumberList["listType"];

const loadList = (db: Db, id: number) => load<NumberList>(db, numberListList, id);

/** Why a value does not fit the list type, or null when it does. */
export function entryProblem(type: ListType, value: string): string | null {
  if (type === "random") return /^[0-9]{3,20}$/.test(value) ? null : "a Random list holds numbers of 3-20 digits";
  if (type === "sender_id_template")
    return /^(?:[A-Za-z0-9 ._-]|\{n\}){1,20}$/.test(value) && value.replaceAll("{n}", "0").length <= 11
      ? null
      : "a template is up to 11 letters, digits or {n} (one random digit each)";
  return value.length >= 1 && value.length <= 64 && !/[\r\n]/.test(value) ? null : "1-64 characters on one line";
}

async function nameTaken(db: Db, name: string, exceptId: number) {
  const { rows } = await db.query(
    "SELECT 1 FROM number_lists WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> $2",
    [name, exceptId],
  );
  return rows.length > 0;
}

export function createNumberList(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as NumberListInput;
  const name = body.name.trim();
  return withDb(reply, async (pool) => {
    if (!name) return sendProblem(reply, 400, "Enter a name", { errors: [{ path: "/name", message: "required" }] });
    if (await nameTaken(pool, name, 0)) return conflict(reply, `A number list named "${name}" exists`);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        "INSERT INTO number_lists (name, list_type, updated_by_id) VALUES ($1, $2, $3) RETURNING id",
        [name, body.listType, me.id],
      );
      const id = rows[0].id as number;
      const change = await recordChange(c, {
        entityType: "number_list",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name, listType: body.listType } }],
        note: `Added number list ${name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadList(pool, id), change });
  });
}

export function updateNumberList(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = request.body as NumberListInput;
  const name = body.name.trim();
  return withDb(reply, async (pool) => {
    const before = await loadList(pool, id);
    if (!before) return notFound(reply, "Number list", id);
    if (before.name === name && before.listType === body.listType) return { record: before, change: null };
    if (!name) return sendProblem(reply, 400, "Enter a name", { errors: [{ path: "/name", message: "required" }] });
    if (await nameTaken(pool, name, id)) return conflict(reply, `A number list named "${name}" exists`);
    if (before.listType !== body.listType) {
      const { rows } = await pool.query(
        "SELECT value FROM number_list_entries WHERE number_list_id = $1 AND deleted_at IS NULL",
        [id],
      );
      const bad = rows.filter((r) => entryProblem(body.listType, r.value));
      if (bad.length)
        return sendProblem(reply, 400, `${bad.length} entries do not fit the new type`, {
          errors: [{ path: "/listType", message: `${bad[0].value}: ${entryProblem(body.listType, bad[0].value)}` }],
        });
    }
    const me = await getCurrentUser();
    const diff: DiffEntry[] = [];
    if (before.name !== name) diff.push({ entity_id: id, field: "name", before: before.name, after: name });
    if (before.listType !== body.listType)
      diff.push({ entity_id: id, field: "listType", before: before.listType, after: body.listType });
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE number_lists SET name = $2, list_type = $3, updated_by_id = $4, updated_at = now() WHERE id = $1",
        [id, name, body.listType, me.id],
      );
      return recordChange(c, {
        entityType: "number_list",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed number list ${name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadList(pool, id), change };
  });
}

async function listDependencies(db: Db, id: number) {
  const count = async (sql: string) => Number((await db.query(sql, [id])).rows[0].n);
  const [tr, rr] = await Promise.all([
    count(
      `SELECT count(*) AS n FROM translation_rules WHERE deleted_at IS NULL
          AND $1 IN (sender_list_id, receiver_list_id, sender_conversion_list_id)`,
    ),
    count(
      `SELECT count(*) AS n FROM route_rules r WHERE r.deleted_at IS NULL
          AND ($1 IN (r.sender_list_id, r.receiver_list_id)
               OR EXISTS (SELECT 1 FROM route_rule_whitelists w WHERE w.route_rule_id = r.id AND w.number_list_id = $1))`,
    ),
  ]);
  return dependencies([
    { key: "translation_rules", label: "Translation rules", count: tr, blocking: true, detail: null },
    { key: "route_rules", label: "Route rules", count: rr, blocking: true, detail: null },
  ]);
}

export function getNumberListDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    if (!(await loadList(pool, id))) return notFound(reply, "Number list", id);
    return listDependencies(pool, id);
  });
}

export function archiveNumberList(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadList(pool, id);
    if (!before) return notFound(reply, "Number list", id);
    if (before.archivedAt) return { record: before, change: null };
    const gate = await archiveGate(reply, (request.body ?? {}) as ArchiveRequest, await listDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const r = await setArchived(request, reply, pool, {
      table: "number_lists",
      entityType: "number_list",
      archive: true,
      note: gate.note ?? `Deleted number list ${before.name}`,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadList(pool, id), change: r.change };
  });
}

export function restoreNumberList(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const before = await loadList(pool, id);
    if (!before) return notFound(reply, "Number list", id);
    if (!before.archivedAt) return sendProblem(reply, 400, "This number list is not deleted");
    const r = await setArchived(request, reply, pool, {
      table: "number_lists",
      entityType: "number_list",
      archive: false,
      note: null,
      restoreClash: async (db) =>
        (await nameTaken(db, before.name, id)) ? `A live number list is named "${before.name}"` : null,
    });
    if ("reply" in r) return r.reply;
    return { record: await loadList(pool, id), change: r.change };
  });
}

export function queryNumberListEntries(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const top = query.filter?.logic === "and" || !query.filter ? (query.filter?.conditions ?? []) : [];
  if (!top.some((c) => !("logic" in c) && c.field === "numberListId" && c.op === "eq"))
    return sendProblem(reply, 400, "Invalid list query", {
      errors: [{ path: "/filter", message: "the filter needs a top-level numberListId eq condition" }],
    });
  const errors = checkListQuery(query, listFields.number_list_entries);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, (pool) => runList(pool, numberListEntryList, query));
}

/** A live list, or a 404 / 400 reply. */
/** The list when it can be edited; otherwise sends the problem and returns null (a reply is thenable). */
async function liveList(db: Db, reply: FastifyReply, id: number): Promise<NumberList | null> {
  const list = await loadList(db, id);
  if (!list) {
    notFound(reply, "Number list", id);
    return null;
  }
  if (list.archivedAt) {
    sendProblem(reply, 400, "This number list is deleted; restore it before editing");
    return null;
  }
  return list;
}

/** Inserts entries and archives others as one change. */
async function saveEntries(
  request: FastifyRequest,
  pool: pg.Pool,
  list: NumberList,
  add: string[],
  remove: { id: number; value: string }[],
  changeType: "edit" | "import" | "delete",
  note: string,
) {
  const me = await getCurrentUser();
  return inTransaction(pool, async (c) => {
    const diff: DiffEntry[] = [];
    if (add.length) {
      const { rows } = await c.query(
        `INSERT INTO number_list_entries (number_list_id, value, created_by_id)
         SELECT $1, v, $3 FROM unnest($2::text[]) AS v RETURNING id, value`,
        [list.id, add, me.id],
      );
      for (const r of rows) diff.push({ entity_id: r.id, field: "*", before: null, after: { value: r.value } });
    }
    if (remove.length) {
      await c.query("UPDATE number_list_entries SET deleted_at = now() WHERE id = ANY($1)", [remove.map((r) => r.id)]);
      for (const r of remove) diff.push({ entity_id: r.id, field: "archived", before: false, after: true });
    }
    await c.query("UPDATE number_lists SET updated_by_id = $2, updated_at = now() WHERE id = $1", [list.id, me.id]);
    return recordChange(c, {
      entityType: "number_list_entry",
      entityIds: diff.map((d) => d.entity_id),
      changeType,
      diff,
      note,
      userId: me.id,
      ip: request.ip,
    });
  });
}

async function liveValues(db: Db, id: number) {
  const { rows } = await db.query(
    "SELECT id, value FROM number_list_entries WHERE number_list_id = $1 AND deleted_at IS NULL",
    [id],
  );
  return new Map(rows.map((r) => [r.value as string, r.id as number]));
}

export function addNumberListEntries(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { values } = request.body as NumberListEntriesInput;
  return withDb(reply, async (pool) => {
    const list = await liveList(pool, reply, id);
    if (!list) return reply;
    const existing = await liveValues(pool, id);
    const errors = [];
    const add = new Set<string>();
    let skipped = 0;
    for (const [i, raw] of values.entries()) {
      const value = raw.trim();
      const problem = entryProblem(list.listType, value);
      if (problem) {
        if (errors.length < 200) errors.push({ line: i + 1, key: value, message: problem });
        continue;
      }
      if (existing.has(value) || add.has(value)) skipped++;
      else add.add(value);
    }
    if (errors.length) return { added: 0, skipped, errors, change: null };
    if (!add.size) return { added: 0, skipped, errors, change: null };
    const change = await saveEntries(
      request,
      pool,
      list,
      [...add],
      [],
      "edit",
      add.size === 1 ? `Added ${[...add][0]} to ${list.name}` : `Added ${add.size} entries to ${list.name}`,
    );
    return { added: add.size, skipped, errors, change };
  });
}

export function deleteNumberListEntries(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const { ids } = request.body as IdList;
  return withDb(reply, async (pool) => {
    const list = await liveList(pool, reply, id);
    if (!list) return reply;
    const { rows } = await pool.query(
      "SELECT id, value FROM number_list_entries WHERE id = ANY($1) AND number_list_id = $2 AND deleted_at IS NULL",
      [ids, id],
    );
    if (!rows.length) return { change: null };
    const change = await saveEntries(
      request,
      pool,
      list,
      [],
      rows as { id: number; value: string }[],
      "delete",
      rows.length === 1
        ? `Deleted ${rows[0].value} from ${list.name}`
        : `Deleted ${rows.length} entries from ${list.name}`,
    );
    return { change };
  });
}

export function importNumberListEntries(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const body = request.body as ImportRequest;
  // One value per line, or a CSV with a value (or number) column.
  const parsed = parseCsv(body.csv);
  const col = ["value", "number"].find((c) => parsed.header.includes(c));
  const rows = col
    ? parsed.rows.map((r) => ({ line: r.line, value: r.values[col] ?? "" }))
    : body.csv
        .replace(/^﻿/, "")
        .split(/\r?\n/)
        .map((v, i) => ({ line: i + 1, value: v.trim() }))
        .filter((r) => r.value !== "");
  return withDb(reply, async (pool) => {
    const list = await liveList(pool, reply, id);
    if (!list) return reply;
    const run = new ImportRun(rows.length);
    const existing = await liveValues(pool, id);
    const seen = new Map<string, number>();
    const add: string[] = [];
    for (const { line, value } of rows) {
      const problem = entryProblem(list.listType, value);
      if (problem) {
        run.error(line, value || null, problem);
        continue;
      }
      if (seen.has(value)) {
        run.warn(line, value, `also on line ${seen.get(value)}; counted once`);
        continue;
      }
      seen.set(value, line);
      if (existing.has(value)) run.unchanged++;
      else {
        add.push(value);
        run.added++;
      }
    }
    const remove =
      body.mode === "replace"
        ? [...existing].filter(([v]) => !seen.has(v)).map(([value, entryId]) => ({ id: entryId, value }))
        : [];
    run.archived = remove.length;
    if (body.dryRun || run.errors.length) return run.result(false, body.dryRun, null);
    if (!add.length && !remove.length) return run.result(true, false, null);
    const change = await saveEntries(
      request,
      pool,
      list,
      add,
      remove,
      "import",
      `Imported into ${list.name}: ${run.added} added, ${run.archived} removed`,
    );
    return run.result(true, false, change);
  });
}

export function exportNumberListEntries(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const list = await loadList(pool, id);
    if (!list) return notFound(reply, "Number list", id);
    const { rows } = await pool.query(
      "SELECT value FROM number_list_entries WHERE number_list_id = $1 AND deleted_at IS NULL ORDER BY value",
      [id],
    );
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="number_list_${list.name.replace(/[^\w.-]+/g, "_")}.csv"`)
      .send(["value", ...rows.map((r) => csvCell(r.value))].join("\r\n") + "\r\n");
  });
}
