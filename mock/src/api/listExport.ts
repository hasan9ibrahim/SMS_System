// One export for every list page without one of its own (§13.22, §13.25): POST /lists/{list}/export with the page's
// query and visible columns answers a CSV of every matching row, streamed. It runs on the list engine
// (lists/engine.ts) with the list's own definition, scoped as the page's query is (Change history, QBR stats' side,
// the Billing report's period), so the file holds exactly the rows the page finds. AM visibility (§13.17) masks and
// hides as on the page; credential columns never leave here (they stay in the Migration Center's encrypted,
// administrator-only export); cells that would start a formula are escaped like every other export (team trial
// round 12, csvSafe.ts).
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  CurrentUser,
  FieldDescriptor,
  ListExportRequest,
  ListId,
  ListQuery,
  MaskedCell,
  RateTableRow,
} from "@sms/contract";
import { withDb } from "../db.js";
import { listDefs } from "../lists/defs.js";
import { listFields } from "../lists/fields.js";
import { applyVisibility, compileQuery, viewDef, type ListDef } from "../lists/engine.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { mayExport } from "../auth/listAccess.js";
import { contentDisposition, fillFileName, nowValues } from "../billing/fileNames.js";
import { CREDENTIAL, SECRET } from "../migration/entities.js";
import { validZone } from "../reports/period.js";
import { currentViewer } from "../visibility/context.js";
import { restricts } from "../visibility/policy.js";
import { maskPayload } from "../visibility/walk.js";
import { scopedChangeList } from "./changes.js";
import { isBadRegex } from "./lists.js";
import { csvCell } from "./masterData.js";
import { addTrafficFigures } from "./rates.js";
import { billingReportSource } from "./reports.js";
import { getCurrentUser } from "./session.js";
import { chProblem } from "./observation.js";

/** Rows in one export at most; more matching rows end the file with a line saying so. */
export const EXPORT_MAX_ROWS = 100_000;
/** Rows read per query while streaming. */
const BATCH = 5_000;

/**
 * Lists that export elsewhere: a parent record's rows (a rate table's lines, a profile's dial codes, a number list's
 * entries, a provider's prices, a trunk's route map, an RN's lines; each exports from its record), the signed-in
 * user's own sessions, and the lists on the EDR store with their own exports and downloads.
 */
const ELSEWHERE: ReadonlySet<string> = new Set([
  "rate_lines",
  "dial_codes",
  "number_list_entries",
  "hlr_provider_rates",
  "route_map",
  "rate_notification_lines",
  "user_sessions",
  "edrs",
  "failed_edrs",
  "master_report",
  "enterprise_report",
  "portal_rates",
  "portal_messages",
]);

interface Source {
  /** The list as the page queries it for this user (Change history is scoped to the user's pages and people). */
  def: (c: pg.PoolClient, me: CurrentUser) => Promise<ListDef<unknown> | string>;
  /** Why the page could not send this query (QBR stats need their side), or null. */
  check?: (query: ListQuery) => string | null;
  /** Figures the page's query adds after the list engine (Rate manager's money and margin today). */
  decorate?: (c: pg.PoolClient, rows: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
}

const plain = (list: string): Source => ({ def: async () => (listDefs as Record<string, ListDef<unknown>>)[list]! });

const topEq = (query: ListQuery, field: string) =>
  (!query.filter || query.filter.logic === "and") &&
  (query.filter?.conditions ?? []).some((c) => !("logic" in c) && c.field === field && c.op === "eq");

function sourceOf(list: string, body: ListExportRequest): Source | null {
  if (ELSEWHERE.has(list)) return null;
  if (list === "changes") return { def: async (c, me) => (await scopedChangeList(c, me)).def as ListDef<unknown> };
  if (list === "qbr_stats")
    return { ...plain(list), check: (q) => (topEq(q, "side") ? null : "the filter needs a top-level side eq condition") };
  if (list === "rate_tables")
    return {
      ...plain(list),
      decorate: async (c, rows) =>
        (await addTrafficFigures(c, rows as unknown as RateTableRow[])) as unknown as Record<string, unknown>[],
    };
  if (list === "billing_report")
    return {
      def: async (c) => {
        if (!body.params) return "the Billing report needs its period (params)";
        const source = await billingReportSource(body.params);
        if (typeof source === "string") return source;
        await source.fill(c);
        return source.def;
      },
    };
  return list in listDefs ? plain(list) : null;
}

/**
 * Credential fields: the Migration Center's rules (migration/entities.ts) on the field's column name, so a trunk's
 * username and host, a portal user's login and anything about passwords stay out; a staff user's username is their
 * login name, business data, as in the migration package.
 */
export function isCredentialField(list: string, field: string): boolean {
  const col = field.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
  return SECRET.test(col) || (list !== "users" && CREDENTIAL.test(col));
}

// ---------------------------------------------------------------- values as the grid shows them

function zoned(tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return (t: number) => {
    const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value])) as Record<string, string>;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  };
}

/** One cell's text: enum labels, Yes / No, lists joined, times in the zone; numbers stay plain numbers. */
export function cellText(f: FieldDescriptor, value: unknown, at: (t: number) => string): string {
  if (value === null || value === undefined || value === "") return "";
  if (f.type === "enum") return f.enumValues?.find((e) => e.value === String(value))?.label ?? String(value);
  if (f.type === "boolean" || typeof value === "boolean") return value === true || value === "true" ? "Yes" : "No";
  if (f.type === "datetime") {
    const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(t) ? at(t) : String(value);
  }
  if (f.type === "date") return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (Array.isArray(value)) return value.map((v) => (v === null || typeof v !== "object" ? String(v) : JSON.stringify(v))).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------- handler

export function exportList(request: FastifyRequest, reply: FastifyReply) {
  const { list } = request.params as { list: ListId };
  const body = request.body as ListExportRequest;
  const catalogue = listFields[list as keyof typeof listFields];
  const source = catalogue ? sourceOf(list, body) : null;
  if (!catalogue || !source)
    return sendProblem(reply, 400, "This list is not exported here", {
      detail: "Its rows export from their record's page or from the list's own Export.",
    });
  const tz = body.timezone?.trim() || "UTC";
  if (!validZone(tz))
    return sendProblem(reply, 400, "Invalid export", { errors: [{ path: "/timezone", message: "unknown time zone" }] });
  const byName = new Map(catalogue.fields.map((f) => [f.field, f]));
  const unknown = body.columns.filter((c) => !byName.has(c));
  if (unknown.length)
    return sendProblem(reply, 400, "Invalid export", {
      errors: unknown.map((c) => ({ path: "/columns", message: `unknown field "${c}"` })),
    });
  // Filter-only fields have no column; credential fields never leave here (§13.22).
  const columns = [...new Set(body.columns)]
    .map((c) => byName.get(c)!)
    .filter((f) => !f.filterOnly && !isCredentialField(list, f.field));
  if (!columns.length)
    return sendProblem(reply, 400, "Invalid export", { errors: [{ path: "/columns", message: "no column to export" }] });
  const query: ListQuery = { ...body.query, cursor: null, limit: 1 };
  const errors = checkListQuery(query, catalogue).map((e) => ({ ...e, path: `/query${e.path}` }));
  const scoped = source.check?.(query);
  if (scoped) errors.push({ path: "/query/filter", message: scoped });
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });

  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!mayExport(me.permissions, list))
      return sendProblem(reply, 403, "Your access group does not allow this", {
        detail: `Exporting ${list.replaceAll("_", " ")} is not given to your user. Ask an administrator.`,
        code: "not_allowed",
      });
    const viewer = await currentViewer();
    const masking = restricts(viewer) && viewer.policy.maskOthers;
    // One snapshot for the whole file; the Billing report's traffic table lives in it.
    const c = await pool.connect();
    let streaming = false;
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      let base: ListDef<unknown> | string;
      try {
        base = await source.def(c, me);
      } catch (err) {
        if (list === "billing_report") return chProblem(reply, err);
        throw err;
      }
      if (typeof base === "string")
        return sendProblem(reply, 400, "Invalid export", { errors: [{ path: "/params", message: base }] });
      const def = base;
      const view = viewDef(def, viewer);
      // Each column's own SQL as well, for fields the row does not carry under their name.
      const extra = [...view.extra, ...columns.map((f, i) => `${view.def.columns[f.field]!.sql} AS "__x_${i}"`)];
      const first = compileQuery(view.def, { ...query, limit: BATCH }, extra);
      let total: number;
      try {
        total = Number((await c.query<{ n: number }>(first.countSql, first.countValues)).rows[0]?.n ?? 0);
      } catch (err) {
        if (isBadRegex(err))
          return sendProblem(reply, 400, "Invalid list query", {
            errors: [{ path: "/query/filter", message: "invalid regular expression" }],
          });
        throw err;
      }
      const at = zoned(tz);
      const capped = total > EXPORT_MAX_ROWS;
      // Times carry the zone they are written in (a label saying UTC drops that).
      const header = columns
        .map((f) => csvCell(f.type === "datetime" ? `${f.label.replace(/\s*\(UTC\)$/, "")} (${tz})` : f.label))
        .join(",");
      const rowsOf = async (offset: number) => {
        const q = compileQuery(view.def, { ...query, limit: Math.min(BATCH, EXPORT_MAX_ROWS - offset) }, extra);
        const values = [...q.values.slice(0, -1), offset];
        const { rows } = await c.query(q.sql, values);
        let out = rows.slice(0, q.limit).map((raw) => {
          const r = raw as Record<string, unknown>;
          const row = def.mapRow(r) as Record<string, unknown>;
          // Hidden values (§13.17) show as the page shows them: Hidden, Low / Normal / High, Above limit.
          const hidden: MaskedCell[] = [];
          if (view.extra.length) applyVisibility(def, r, row, hidden);
          for (const m of hidden) row[`__h_${m.field}`] = m.text;
          // A field the row does not carry under its name comes from its column's SQL.
          columns.forEach((f, i) => {
            const key = def.columns[f.field]?.rowKey ?? f.field;
            if (!(key in row)) row[key] = r[`__x_${i}`];
          });
          return row;
        });
        if (source.decorate) out = await source.decorate(c, out);
        if (masking) await maskPayload(out, viewer!);
        return out;
      };
      async function* lines() {
        try {
          yield `\uFEFF${header}\r\n`;
          for (let offset = 0; offset < Math.min(total, EXPORT_MAX_ROWS); offset += BATCH) {
            const rows = await rowsOf(offset);
            if (!rows.length) break;
            yield rows
              .map((row) =>
                columns
                  .map((f) => {
                    const key = def.columns[f.field]?.rowKey ?? f.field;
                    const text = typeof row[`__h_${f.field}`] === "string" ? row[`__h_${f.field}`] : null;
                    return csvCell(text ?? cellText(f, row[key], at));
                  })
                  .join(","),
              )
              .join("\r\n")
              .concat("\r\n");
          }
          if (capped)
            yield `${csvCell(
              `Export stopped at ${EXPORT_MAX_ROWS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows. Narrow the filters to export the rest.`,
            )}\r\n`;
          await c.query("COMMIT");
        } catch (err) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          c.release();
        }
      }
      const name = fillFileName("{List}_{DateTime}", { ...nowValues(me.username), list }, list, "csv");
      streaming = true;
      reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", contentDisposition(name))
        .header("x-total-rows", String(total));
      if (capped) reply.header("x-export-capped", String(EXPORT_MAX_ROWS));
      return reply.send(Readable.from(lines()));
    } finally {
      if (!streaming) {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
  });
}
