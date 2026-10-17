// EDR Download and Failed EDR Download (§9.2, §12.4): background exports of EDR Search results.
// A request stores the filter, sort and columns; one job at a time streams the rows out of
// ClickHouse into a CSV or Excel 2003 XML file, updating the progress, and can be cancelled.
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { EdrDownloadInput, FieldDescriptor, FilterCondition, FilterGroup, ListFields } from "@sms/contract";
import { db, withDb } from "../db.js";
import { chQuery, chStream } from "../edr.js";
import { chOrder, chWhere, lit, namesOf, type ChListDef } from "../lists/chEngine.js";
import { EDR_DOWNLOAD_FROM, EDR_DOWNLOAD_SELECT, mapEdrDownload } from "../lists/defs.js";
import { edrList, failedEdrList } from "../lists/edrDefs.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { notFound } from "./masterData.js";
import { getCurrentUser } from "./session.js";
import { badInput } from "./switchTools.js";

type Params = { id: number };
const MAX_ROWS = 1_000_000;
const MAX_XLSX_ROWS = 1_048_575;
const DIR = join(tmpdir(), "sms-mock-edr-downloads");

const defOf = (kind: string) => (kind === "failed_edr" ? failedEdrList : edrList) as ChListDef<unknown>;
const fieldsOf = (kind: string): ListFields => (kind === "failed_edr" ? listFields.failed_edrs : listFields.edrs);
const defaultColumns = (kind: string) =>
  fieldsOf(kind)
    .fields.filter((f) => !f.hidden)
    .map((f) => f.field);

// ---------------------------------------------------------------- filter in words

const OP_WORDS: Record<string, string> = {
  eq: "=",
  neq: "≠",
  like: "like",
  not_like: "not like",
  in: "in",
  not_in: "not in",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  empty: "is empty",
  not_empty: "is not empty",
  regex: "matches",
};
const shortTime = (v: unknown) => String(v).replace("T", " ").slice(0, 16);

/** "Start Time between 2026-10-15 00:00 and 2026-10-16 00:00 · Final = Yes" */
export function describeFilter(fields: FieldDescriptor[], group: FilterGroup | undefined, search?: string): string {
  const byName = new Map(fields.map((f) => [f.field, f]));
  const value = (f: FieldDescriptor | undefined, v: unknown) =>
    f?.type === "datetime" || f?.type === "date"
      ? shortTime(v)
      : typeof v === "boolean"
        ? v
          ? "Yes"
          : "No"
        : (f?.enumValues?.find((e) => e.value === String(v))?.label ?? String(v));
  const walk = (g: FilterGroup): string =>
    g.conditions
      .map((n) => {
        if ("logic" in n) return `(${walk(n)})`;
        const c = n as FilterCondition;
        const f = byName.get(c.field);
        const label = f?.label ?? c.field;
        if (c.op === "empty" || c.op === "not_empty") return `${label} ${OP_WORDS[c.op]}`;
        if (c.op === "between") return `${label} between ${value(f, c.values?.[0])} and ${value(f, c.values?.[1])}`;
        if (c.op === "in" || c.op === "not_in")
          return `${label} ${OP_WORDS[c.op]} ${(c.values ?? []).map((v) => value(f, v)).join(", ")}`;
        return `${label} ${OP_WORDS[c.op]} ${value(f, c.value)}`;
      })
      .join(g.logic === "or" ? " or " : " · ");
  const parts = [group?.conditions.length ? walk(group) : "", search?.trim() ? `search "${search.trim()}"` : ""];
  return parts.filter(Boolean).join(" · ") || "All EDRs";
}

// ---------------------------------------------------------------- request / cancel / file

const loadDownload = async (c: pg.Pool, id: number) => {
  const { rows } = await c.query(`SELECT ${EDR_DOWNLOAD_SELECT} FROM ${EDR_DOWNLOAD_FROM} WHERE d.id = $1`, [id]);
  return rows[0] ? { row: mapEdrDownload(rows[0]), raw: rows[0] as Record<string, unknown> } : null;
};

export function requestEdrDownload(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as EdrDownloadInput;
  return withDb(reply, async (pool) => {
    const fields = fieldsOf(b.kind);
    const errors = checkListQuery({ ...b.query, limit: 100, withTotal: false }, fields).map((e) => ({
      ...e,
      path: `/query${e.path}`,
    }));
    let columns = b.columns ?? defaultColumns(b.kind);
    let templateName: string | null = null;
    if (b.templateId) {
      const { rows } = await pool.query(
        "SELECT name, columns FROM edr_templates WHERE id = $1 AND deleted_at IS NULL",
        [b.templateId],
      );
      if (!rows[0]) errors.push({ path: "/templateId", message: "unknown EDR template" });
      else {
        templateName = rows[0].name;
        columns = rows[0].columns;
      }
    }
    const known = new Set(fields.fields.map((f) => f.field));
    for (const c of columns)
      if (!known.has(c)) errors.push({ path: "/columns", message: `"${c}" is not a column of this list` });
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `INSERT INTO edr_downloads (kind, file_type, query, columns, template_id, template_name, filter_summary, requested_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        b.kind,
        b.fileType,
        JSON.stringify(b.query),
        columns,
        b.templateId,
        templateName,
        describeFilter(fields.fields, b.query.filter, b.query.search),
        me.id,
      ],
    );
    setImmediate(() => void tick());
    return reply.code(201).send((await loadDownload(pool, Number(rows[0].id)))!.row);
  });
}

export function cancelEdrDownload(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const d = await loadDownload(pool, id);
    if (!d) return notFound(reply, "EDR download", id);
    if (d.row.status !== "pending" && d.row.status !== "inprogress")
      return sendProblem(reply, 409, `This download is already ${d.row.status}`);
    await pool.query("UPDATE edr_downloads SET status = 'cancelled', finished_at = now() WHERE id = $1", [id]);
    running?.id === id && running.abort.abort();
    return (await loadDownload(pool, id))!.row;
  });
}

export function downloadEdrFile(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const d = await loadDownload(pool, id);
    if (!d) return notFound(reply, "EDR download", id);
    if (d.row.status !== "success") return sendProblem(reply, 409, `The file is not ready (status ${d.row.status})`);
    let path = d.raw.file_path as string | null;
    // Seeded downloads (and files lost with the temp folder) are built again from the stored request.
    if (!path || !existsSync(path)) path = (await runExport(pool, d.raw, new AbortController().signal)).path;
    const xlsx = d.row.fileType === "xlsx";
    return reply
      .type(xlsx ? "application/vnd.ms-excel" : "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${d.row.fileName ?? `edr_${id}.${xlsx ? "xls" : "csv"}`}"`)
      .send(createReadStream(path));
  });
}

// ---------------------------------------------------------------- export

/** SELECT list with column labels as the header: names as text, booleans as Yes / No. */
async function exportSelect(pool: pg.Pool, kind: string, columns: string[]) {
  const def = defOf(kind);
  const byName = new Map(fieldsOf(kind).fields.map((f) => [f.field, f]));
  const parts: string[] = [];
  for (const c of columns) {
    const col = def.columns[c]!;
    const f = byName.get(c)!;
    let expr = col.sql;
    if (col.names) {
      const names = [...(await namesOf(pool, col.names)).entries()];
      expr = `transform(${col.names.idSql}, [${names.map(([id]) => id).join(",") || 0}], [${names.map(([, n]) => lit(n)).join(",") || "''"}], '')`;
    } else if (f.type === "boolean") expr = `if(${col.sql} = 1, 'Yes', 'No')`;
    else if (c.endsWith("RuleIds")) expr = `arrayStringConcat(arrayMap(x -> toString(x), ${col.sql}), ' ')`;
    else if (f.type === "datetime") expr = `toString(${col.sql})`;
    parts.push(`${expr} AS \`${f.label.replace(/`/g, "")}\``);
  }
  return { select: parts.join(", "), fields: columns.map((c) => byName.get(c)!) };
}

const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NUMERIC = new Set(["integer", "decimal", "money", "percent"]);

/** Streams the export to a file, reporting written rows; throws when cancelled or ClickHouse fails. */
async function runExport(
  pool: pg.Pool,
  raw: Record<string, unknown>,
  signal: AbortSignal,
  onRows?: (n: number) => void,
): Promise<{ path: string; rows: number; size: number }> {
  const kind = raw.kind as string;
  const xlsx = raw.file_type === "xlsx";
  const query = raw.query as { filter?: FilterGroup; search?: string; sort?: { field: string; dir: "asc" | "desc" }[] };
  const def = defOf(kind);
  const [where, order, sel] = await Promise.all([
    chWhere(pool, def, query),
    chOrder(pool, def, query),
    exportSelect(pool, kind, raw.columns as string[]),
  ]);
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${kind}_${raw.id}.${xlsx ? "xls" : "csv"}`);
  const sql = `SELECT ${sel.select} FROM ${def.table} WHERE ${where} ORDER BY ${order} LIMIT ${xlsx ? MAX_XLSX_ROWS : MAX_ROWS}
    FORMAT ${xlsx ? "JSONCompactEachRow" : "CSVWithNames"}`;
  const body = Readable.fromWeb((await chStream(sql)) as unknown as WebStream<Uint8Array>, { signal });
  let rows = 0;
  let rest = "";
  const header = sel.fields.map((f) => `<Cell><Data ss:Type="String">${xmlEsc(f.label)}</Data></Cell>`).join("");
  const toXml = (line: string) => {
    const cells = JSON.parse(line) as unknown[];
    return `<Row>${cells
      .map((v, i) =>
        NUMERIC.has(sel.fields[i]!.type) && v !== null && v !== ""
          ? `<Cell><Data ss:Type="Number">${Number(v)}</Data></Cell>`
          : `<Cell><Data ss:Type="String">${xmlEsc(String(v ?? ""))}</Data></Cell>`,
      )
      .join("")}</Row>\n`;
  };
  const shape = new Transform({
    transform(chunk: Buffer, _enc, done) {
      const text = rest + chunk.toString("utf8");
      const lines = text.split("\n");
      rest = lines.pop()!;
      rows += lines.length;
      onRows?.(rows);
      done(null, xlsx ? lines.map(toXml).join("") : lines.map((l) => `${l}\n`).join(""));
    },
    flush(done) {
      if (rest) rows += 1;
      done(null, xlsx ? (rest ? toXml(rest) : "") + "</Table></Worksheet>\n</Workbook>\n" : rest);
    },
  });
  if (xlsx)
    shape.push(
      `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n` +
        `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n` +
        `<Worksheet ss:Name="EDR"><Table>\n<Row>${header}</Row>\n`,
    );
  await pipeline(body, shape, createWriteStream(path), { signal });
  // CSV: the header line is not a row.
  const dataRows = xlsx ? rows : Math.max(0, rows - 1);
  await pool.query("UPDATE edr_downloads SET file_path = $2, row_count = $3, size_bytes = $4 WHERE id = $1", [
    raw.id,
    path,
    dataRows,
    statSync(path).size,
  ]);
  return { path, rows: dataRows, size: statSync(path).size };
}

// ---------------------------------------------------------------- job

let running: { id: number; abort: AbortController } | null = null;

async function tick() {
  if (running) return;
  let pool: pg.Pool;
  try {
    pool = db();
  } catch {
    return;
  }
  const { rows } = await pool
    .query(`SELECT * FROM edr_downloads WHERE status = 'pending' ORDER BY requested_at LIMIT 1`)
    .catch(() => ({ rows: [] as Record<string, unknown>[] }));
  const raw = rows[0];
  if (!raw) return;
  const id = Number(raw.id);
  running = { id, abort: new AbortController() };
  const xlsx = raw.file_type === "xlsx";
  try {
    await pool.query("UPDATE edr_downloads SET status = 'inprogress', progress = 0 WHERE id = $1", [id]);
    const def = defOf(raw.kind as string);
    const query = raw.query as { filter?: FilterGroup; search?: string };
    const total = Number(
      (
        await chQuery<{ n: string }>(`SELECT count() AS n FROM ${def.table} WHERE ${await chWhere(pool, def, query)}`)
      )[0]?.n ?? 0,
    );
    const limit = xlsx ? MAX_XLSX_ROWS : MAX_ROWS;
    if (total > limit)
      throw new Error(
        `${total.toLocaleString("en-US")} rows match; the limit is ${limit.toLocaleString("en-US")}. Narrow the date range or filters.`,
      );
    let last = Date.now();
    const out = await runExport(pool, raw, running.abort.signal, (n) => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      void pool.query("UPDATE edr_downloads SET progress = $2 WHERE id = $1 AND status = 'inprogress'", [
        id,
        Math.min(99, Math.floor((n / Math.max(1, total)) * 100)),
      ]);
    });
    await pool.query(
      `UPDATE edr_downloads SET status = 'success', progress = 100, file_name = $2, finished_at = now()
        WHERE id = $1 AND status = 'inprogress'`,
      [id, `${raw.kind}_${id}.${xlsx ? "xls" : "csv"}`],
    );
    void out;
  } catch (err) {
    const cancelled = running.abort.signal.aborted;
    if (!cancelled)
      await pool
        .query("UPDATE edr_downloads SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [
          id,
          String((err as Error).message ?? err)
            .split("\n")[0]!
            .slice(0, 300),
        ])
        .catch(() => undefined);
  } finally {
    running = null;
    setImmediate(() => void tick());
  }
}

/** Runs queued downloads; at start, downloads that were running when the mock stopped are queued again. */
export function startEdrDownloads() {
  void db()
    .query("UPDATE edr_downloads SET status = 'pending', progress = 0 WHERE status = 'inprogress'")
    .catch(() => undefined)
    .finally(() => void tick());
  setInterval(() => void tick(), 3000).unref();
}
