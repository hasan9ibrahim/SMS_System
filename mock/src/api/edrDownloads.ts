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
import type {
  EdrDownloadInput,
  FieldDescriptor,
  FilterCondition,
  FilterGroup,
  ListFields,
  ListQuery,
} from "@sms/contract";
import { db, withDb } from "../db.js";
import { chQuery, chStream, onePerRowKey } from "../edr.js";
import { chOrder, chWhere, lit, namesOf, outcomeJoin, type ChListDef } from "../lists/chEngine.js";
import { EDR_DOWNLOAD_FROM, EDR_DOWNLOAD_SELECT, edrDownloadList, mapEdrDownload } from "../lists/defs.js";
import { runList, type ListDef } from "../lists/engine.js";
import { edrList, failedEdrList } from "../lists/edrDefs.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { notFound } from "./masterData.js";
import { getCurrentUser } from "./session.js";
import { badInput } from "./switchTools.js";
import { csvTextSql } from "../csvSafe.js";
import { restrictingViewer, runAsUser } from "../visibility/context.js";
import { viewChDef } from "../visibility/edr.js";
import { loadMaps } from "../visibility/walk.js";

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

/** A period in words: "2026-10-16 00:00 – 01:00 UTC", or both dates when it spans days (team trial round 6). */
const period = (a: unknown, b: unknown) => {
  const [x, y] = [shortTime(a), shortTime(b)];
  return `${x} – ${x.slice(0, 10) === y.slice(0, 10) ? y.slice(11) : y} UTC`;
};

/** ID fields of the EDR lists and where their names live, so the Filters column shows names (team trial round 6). */
const NAMED: Record<string, { table: string; name: string }> = {
  customerEnterpriseId: { table: "enterprises", name: "name" },
  vendorEnterpriseId: { table: "enterprises", name: "name" },
  enterpriseId: { table: "enterprises", name: "name" },
  customerTrunkId: { table: "customer_trunks", name: "name" },
  vendorTrunkId: { table: "vendor_trunks", name: "name" },
  routeRuleId: { table: "route_rules", name: "name" },
  customerRateTableId: { table: "rate_tables", name: "name" },
  vendorRateTableId: { table: "rate_tables", name: "name" },
  productCategoryId: { table: "product_categories", name: "name" },
  businessCompanyId: { table: "business_companies", name: "name" },
  hlrProviderId: { table: "hlr_providers", name: "name" },
};

/** Names of the IDs a filter uses, keyed "field:id". */
export async function filterNames(c: pg.Pool, group: FilterGroup | undefined): Promise<Map<string, string>> {
  const wanted = new Map<string, Set<number>>();
  const walk = (g: FilterGroup) =>
    g.conditions.forEach((n) => {
      if ("logic" in n) return walk(n);
      const cond = n as FilterCondition;
      if (!NAMED[cond.field]) return;
      for (const v of cond.values ?? [cond.value])
        if (Number.isInteger(Number(v))) wanted.set(cond.field, (wanted.get(cond.field) ?? new Set()).add(Number(v)));
    });
  if (group) walk(group);
  const out = new Map<string, string>();
  // Other AMs' enterprises and trunks stay neutral IDs in the summary (§13.17).
  const v = await restrictingViewer();
  const m = v?.policy.maskOthers ? await loadMaps() : null;
  const own = new Set(v?.own ?? []);
  const masked = (field: string, id: number) => {
    if (!m) return false;
    if (field.endsWith("EnterpriseId")) return !own.has(id);
    if (field === "customerTrunkId" || field === "vendorTrunkId")
      return !own.has((field === "customerTrunkId" ? m.customerTrunk : m.vendorTrunk).get(id) ?? -1);
    return false;
  };
  for (const [field, ids] of wanted) {
    const { table, name } = NAMED[field]!;
    const { rows } = await c.query(`SELECT id, ${name} AS name FROM ${table} WHERE id = ANY($1)`, [[...ids]]);
    for (const r of rows) if (!masked(field, Number(r.id))) out.set(`${field}:${r.id}`, String(r.name));
  }
  return out;
}

/**
 * The filter in words for the downloads list (§9.2): "Start Time 2026-10-15 00:00 – 2026-10-16 00:00 UTC · Final:
 * Yes · Customer Enterprise: ALDEX". IDs show as names when `names` has them (team trial round 6).
 */
export function describeFilter(
  fields: FieldDescriptor[],
  group: FilterGroup | undefined,
  search?: string,
  names: Map<string, string> = new Map(),
): string {
  const byName = new Map(fields.map((f) => [f.field, f]));
  const value = (f: FieldDescriptor | undefined, field: string, v: unknown) =>
    names.get(`${field}:${v}`) ??
    (f?.type === "datetime" || f?.type === "date"
      ? shortTime(v)
      : typeof v === "boolean"
        ? v
          ? "Yes"
          : "No"
        : (f?.enumValues?.find((e) => e.value === String(v))?.label ?? String(v)));
  const walk = (g: FilterGroup): string =>
    g.conditions
      .map((n) => {
        if ("logic" in n) return `(${walk(n)})`;
        const c = n as FilterCondition;
        const f = byName.get(c.field);
        // "Customer Enterprise ID" reads "Customer Enterprise" once its IDs are names.
        const named = [c.value, ...(c.values ?? [])].some((v) => names.has(`${c.field}:${v}`));
        const label = (f?.label ?? c.field).replace(named ? / ID$/ : /$^/, "");
        if (c.op === "empty" || c.op === "not_empty") return `${label} ${OP_WORDS[c.op]}`;
        if (c.op === "between")
          return f?.type === "datetime"
            ? `${label} ${period(c.values?.[0], c.values?.[1])}`
            : `${label} ${value(f, c.field, c.values?.[0])} to ${value(f, c.field, c.values?.[1])}`;
        if (c.op === "in") return `${label}: ${(c.values ?? []).map((v) => value(f, c.field, v)).join(", ")}`;
        if (c.op === "not_in") return `${label} not ${(c.values ?? []).map((v) => value(f, c.field, v)).join(", ")}`;
        if (c.op === "eq") return `${label}: ${value(f, c.field, c.value)}`;
        return `${label} ${OP_WORDS[c.op]} ${value(f, c.field, c.value)}`;
      })
      .join(g.logic === "or" ? " or " : " · ");
  const parts = [group?.conditions.length ? walk(group) : "", search?.trim() ? `search "${search.trim()}"` : ""];
  return parts.filter(Boolean).join(" · ") || "All EDRs";
}

/**
 * The file's name: the kind, the request number and the EDR template it was made with (team trial round 6), e.g.
 * "EDR_42_All_message_details.csv"; without a template, "EDR_42.csv".
 */
export function downloadFileName(raw: Record<string, unknown>, id: number, xlsx: boolean): string {
  const kind = raw.kind === "failed_edr" ? "Failed_EDR" : "EDR";
  const template = String(raw.template_name ?? "")
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${kind}_${id}${template ? `_${template}` : ""}.${xlsx ? "xls" : "csv"}`;
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
        describeFilter(fields.fields, b.query.filter, b.query.search, await filterNames(pool, b.query.filter)),
        me.id,
      ],
    );
    setImmediate(() => void tick());
    return reply.code(201).send((await loadDownload(pool, Number(rows[0].id)))!.row);
  });
}

/**
 * The downloads list (§9.2). A viewer whose visibility policy restricts anything sees only their own downloads: a
 * file made for someone else shows what that person may see (§13.17).
 */
export async function queryEdrDownloads(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.edr_downloads);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  const v = await restrictingViewer();
  const def = edrDownloadList as ListDef<unknown>;
  return withDb(reply, (pool) =>
    runList(pool, v ? { ...def, baseWhere: `d.requested_by_id = ${Number(v.userId)}` } : def, query),
  );
}

/** A restricted viewer may only open or cancel their own downloads (§13.17). */
async function refuseOthers(reply: FastifyReply, raw: Record<string, unknown>): Promise<boolean> {
  const v = await restrictingViewer();
  if (!v || Number(raw.requested_by_id) === v.userId) return false;
  void sendProblem(reply, 403, "This download belongs to another user", {
    detail: "Your visibility policy lets you open only the EDR downloads you asked for.",
  });
  return true;
}

export function cancelEdrDownload(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const d = await loadDownload(pool, id);
    if (!d) return notFound(reply, "EDR download", id);
    if (await refuseOthers(reply, d.raw)) return reply;
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
    if (await refuseOthers(reply, d.raw)) return reply;
    if (d.row.status !== "success") return sendProblem(reply, 409, `The file is not ready (status ${d.row.status})`);
    let path = d.raw.file_path as string | null;
    // Seeded downloads (and files lost with the temp folder) are built again from the stored request, as its requester.
    if (!path || !existsSync(path))
      path = (await asRequester(d.raw, () => runExport(pool, d.raw, new AbortController().signal))).path;
    const xlsx = d.row.fileType === "xlsx";
    return reply
      .type(xlsx ? "application/vnd.ms-excel" : "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${d.row.fileName ?? `edr_${id}.${xlsx ? "xls" : "csv"}`}"`)
      .send(createReadStream(path));
  });
}

// ---------------------------------------------------------------- export

/** A download is made as the user who asked for it would see the EDRs (§13.17); seeded ones without a user as is. */
const asRequester = <T>(raw: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  raw.requested_by_id == null ? fn() : runAsUser(Number(raw.requested_by_id), fn);

/** SELECT list with column labels as the header: names as text, booleans as Yes / No. */
async function exportSelect(
  pool: pg.Pool,
  kind: string,
  def: ChListDef<unknown>,
  columns: string[],
  expr: (field: string) => string,
  csv = false,
) {
  const byName = new Map(fieldsOf(kind).fields.map((f) => [f.field, f]));
  const parts: string[] = [];
  for (const c of columns) {
    const col = def.columns[c]!;
    const f = byName.get(c)!;
    const sql = expr(c);
    let out = sql;
    if (col.names) {
      const names = [...(await namesOf(pool, col.names)).entries()];
      out = `transform(${col.names.idSql}, [${names.map(([id]) => id).join(",") || 0}], [${names.map(([, n]) => lit(n)).join(",") || "''"}], '')`;
    } else if (f.type === "boolean") out = `if(${sql} = 1, 'Yes', 'No')`;
    else if (c.endsWith("RuleIds")) out = `arrayStringConcat(arrayMap(x -> toString(x), ${sql}), ' ')`;
    else if (f.type === "datetime") out = `toString(${sql})`;
    // Text that starts like a formula opens as text in a spreadsheet (security audit, team trial round 12).
    if (csv && !NUMERIC.has(f.type) && f.type !== "boolean" && f.type !== "datetime") out = csvTextSql(out);
    parts.push(`${out} AS \`${f.label.replace(/`/g, "")}\``);
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
  // Masked names, withheld values and others' traffic as the requester sees them (§13.17).
  const def = await viewChDef(defOf(kind));
  const [where, order] = await Promise.all([chWhere(pool, def, query), chOrder(pool, def, query)]);
  // The switch's outcome rows merged in (final status, delay, receipt-billed money; backend step 11b).
  const joined = outcomeJoin(def, raw.columns as string[], where);
  const sel = await exportSelect(pool, kind, def, raw.columns as string[], joined.expr, !xlsx);
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${kind}_${raw.id}.${xlsx ? "xls" : "csv"}`);
  // An attempt the switch wrote twice once (ClickHouse 010, S-7.3).
  const once = def.rowKey ? ` ${onePerRowKey()}` : "";
  const sql = `SELECT ${sel.select} FROM ${joined.from} WHERE ${where} ORDER BY ${order}${once} LIMIT ${xlsx ? MAX_XLSX_ROWS : MAX_ROWS}
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
    const query = raw.query as { filter?: FilterGroup; search?: string };
    const total = await asRequester(raw, async () => {
      const def = await viewChDef(defOf(raw.kind as string));
      const where = await chWhere(pool, def, query);
      return Number((await chQuery<{ n: string }>(`SELECT count() AS n FROM ${def.table} WHERE ${where}`))[0]?.n ?? 0);
    });
    const limit = xlsx ? MAX_XLSX_ROWS : MAX_ROWS;
    if (total > limit)
      throw new Error(
        `${total.toLocaleString("en-US")} rows match; the limit is ${limit.toLocaleString("en-US")}. Narrow the date range or filters.`,
      );
    let last = Date.now();
    const abort = running.abort.signal;
    const out = await asRequester(raw, () =>
      runExport(pool, raw, abort, (n) => {
        if (Date.now() - last < 1000) return;
        last = Date.now();
        void pool.query("UPDATE edr_downloads SET progress = $2 WHERE id = $1 AND status = 'inprogress'", [
          id,
          Math.min(99, Math.floor((n / Math.max(1, total)) * 100)),
        ]);
      }),
    );
    await pool.query(
      `UPDATE edr_downloads SET status = 'success', progress = 100, file_name = $2, finished_at = now()
        WHERE id = $1 AND status = 'inprogress'`,
      [id, downloadFileName(raw, id, xlsx)],
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
