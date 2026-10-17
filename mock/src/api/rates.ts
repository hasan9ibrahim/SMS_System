// Rate Manager (§13.12): rate table records, the rate grid of one table, CSV export and
// rate edits. A rate never changes in place: a new rate opens a new version from its
// effective date and closes the one before (§6.2 history), so billing keeps the rate each
// message was sent at (§13.29). Every batch of edits is one undoable change (§13.10).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  ArchiveRequest,
  ListQuery,
  RateLineChanges,
  RateLineEdit,
  RateTableDetail,
  RateTableInput,
  RateTableRow,
  RateTableUpdate,
} from "@sms/contract";
import { PLATFORM_CURRENCY } from "../currency.js";
import { withDb } from "../db.js";
import { marginPct, trafficTodayByRateTable } from "../edr.js";
import { listFields } from "../lists/fields.js";
import { negativeMarginSql, rateLineList, rateTableList } from "../lists/defs.js";
import { compileQuery, exportRows, runList } from "../lists/engine.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { scheduleBestBuyRefresh } from "./bestbuy.js";
import { archiveGate } from "./enterprises.js";
import { archivedInfo, dependencies, isAdmin, iso, recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
const notFound = (reply: FastifyReply, id: number) => sendProblem(reply, 404, `Rate table ${id} not found`);
const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });
/** Edits may start up to a minute in the past (clock skew); never earlier (§13.32). */
const SKEW_MS = 60_000;

// ---------------------------------------------------------------- traffic figures

/** Today's revenue (sell table) or cost (buy table) in the table currency, and its margin. */
async function trafficFigures(db: Db, rows: { id: number; kind: string; currency: string }[]) {
  const traffic = await trafficTodayByRateTable();
  if (!traffic || rows.length === 0)
    return new Map<number, { money: number | null; margin: number | null; n: number | null }>();
  const { rows: fx } = await db.query("SELECT iso, rate_per_usd FROM currency_latest");
  const perUsd = new Map(fx.map((r) => [String(r.iso), Number(r.rate_per_usd)]));
  // Traffic money is in the platform currency; show it in the table's currency.
  const platformPerUsd = perUsd.get(PLATFORM_CURRENCY) ?? 1;
  return new Map(
    rows.map((r) => {
      const t = (r.kind === "customer" ? traffic.customer : traffic.vendor).get(r.id);
      const sys = t ? (r.kind === "customer" ? t.revenueSys : t.costSys) : 0;
      return [
        r.id,
        {
          money: Math.round((sys / platformPerUsd) * (perUsd.get(r.currency) ?? 1) * 100) / 100,
          margin: marginPct(t),
          n: t?.messages ?? 0,
        },
      ];
    }),
  );
}

export function queryRateTables(request: FastifyRequest, reply: FastifyReply) {
  const query = request.body as ListQuery;
  const errors = checkListQuery(query, listFields.rate_tables);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  return withDb(reply, async (pool) => {
    const page = await runList(pool, rateTableList, query);
    const figures = await trafficFigures(pool, page.rows);
    page.rows = page.rows.map((r): RateTableRow => {
      const f = figures.get(r.id);
      return f ? { ...r, avgMarginPct: f.margin, moneyToday: f.money } : r;
    });
    return page;
  });
}

// ---------------------------------------------------------------- rate grid

/** The rate grid always belongs to one table; `view` defaults to current lines. */
function scopedLineQuery(query: ListQuery): ListQuery | string {
  const top = query.filter?.logic === "and" ? query.filter.conditions : [];
  const table = top.find((c) => !("logic" in c) && c.field === "rateTableId" && c.op === "eq");
  if (!table) return "the filter needs a top-level rateTableId eq condition";
  const mentionsView = JSON.stringify(query.filter).includes('"field":"view"');
  if (mentionsView) return query;
  return {
    ...query,
    filter: { logic: "and", conditions: [...top, { field: "view", op: "eq", value: "current" }] },
  };
}

export function queryRateLines(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as ListQuery;
  const errors = checkListQuery(body, listFields.rate_lines);
  if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
  const query = scopedLineQuery(body);
  if (typeof query === "string")
    return sendProblem(reply, 400, "Invalid list query", { errors: [{ path: "/filter", message: query }] });
  return withDb(reply, async (pool) => {
    try {
      return await runList(pool, rateLineList, query);
    } catch (err) {
      if ((err as { code?: string }).code === "2201B")
        return sendProblem(reply, 400, "Invalid list query", {
          errors: [{ path: "/filter", message: "invalid regular expression" }],
        });
      throw err;
    }
  });
}

const csvCell = (v: unknown) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function exportRateLines(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const { view = "current" } = request.query as { view?: string };
  return withDb(reply, async (pool) => {
    const { rows: t } = await pool.query("SELECT name FROM rate_tables WHERE id = $1", [id]);
    if (!t[0]) return notFound(reply, id);
    // As the viewer sees it (§13.17).
    const rows = await exportRows(pool, rateLineList, {
      filter: {
        logic: "and",
        conditions: [
          { field: "rateTableId", op: "eq", value: id },
          { field: "view", op: "eq", value: view },
        ],
      },
      limit: 100_000,
    } as ListQuery);
    const cols: [string, string][] = [
      ["Country", "country"],
      ["Network", "network"],
      ["MCCMNC", "mccmnc"],
      ["Dial Code", "dialCode"],
      ["Sender ID", "senderId"],
      ["Rate", "rate"],
      ["Currency", "currency"],
      ["Sys Rate (USD)", "sysRate"],
      ["Best Buy", "bestBuy"],
      ["Best Vendor", "bestVendor"],
      ["Margin", "margin"],
      ["Margin %", "marginPct"],
      ["Change", "changeType"],
      ["From Date (UTC)", "validFrom"],
      ["To Date (UTC)", "validTo"],
      ["Blocked", "isBlocked"],
      ["Rate Note", "rateNote"],
    ];
    const lines = rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return cols.map(([, k]) => csvCell(row[k])).join(",");
    });
    const file = `${String(t[0].name).replace(/[^\w.-]+/g, "_")}_${view}.csv`;
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${file}"`)
      .send([cols.map(([h]) => h).join(","), ...lines].join("\r\n") + "\r\n");
  });
}

// ---------------------------------------------------------------- table record

async function loadTable(db: Db, id: number): Promise<RateTableDetail | null> {
  const { rows } = await db.query(
    `SELECT rt.*, pc.name AS category, vt.name AS vendor_trunk_name, du.username AS deleted_by,
            cb.username AS created_by, ub.username AS updated_by, ${negativeMarginSql} AS negative_lines,
            vt.deleted_at AS trunk_deleted_at
       FROM rate_tables rt JOIN product_categories pc ON pc.id = rt.product_category_id
       LEFT JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id
       LEFT JOIN users du ON du.id = rt.deleted_by_id
       LEFT JOIN users cb ON cb.id = rt.created_by_id
       LEFT JOIN users ub ON ub.id = rt.updated_by_id
      WHERE rt.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const [trunks, counts, imp] = await Promise.all([
    db.query(
      r.kind === "customer"
        ? `SELECT t.id, t.name, 'customer' AS kind, t.enterprise_id, e.name AS enterprise_name, t.status
             FROM customer_trunk_rate_tables x JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
             JOIN enterprises e ON e.id = t.enterprise_id WHERE x.rate_table_id = $1 ORDER BY t.name`
        : `SELECT t.id, t.name, 'vendor' AS kind, t.enterprise_id, e.name AS enterprise_name, t.status
             FROM vendor_trunks t JOIN enterprises e ON e.id = t.enterprise_id WHERE t.id = $1`,
      r.kind === "customer" ? [id] : [r.vendor_trunk_id],
    ),
    db.query(
      `SELECT
         count(*) FILTER (WHERE l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now()))::int AS active,
         count(DISTINCT m.country_id) FILTER (WHERE l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now()))::int AS countries,
         count(*) FILTER (WHERE l.valid_from > now())::int AS scheduled,
         min(l.valid_from) FILTER (WHERE l.valid_from > now()) AS next_at,
         count(*) FILTER (WHERE l.valid_to IS NOT NULL AND l.valid_to <= now())::int AS closed,
         count(*) FILTER (WHERE l.valid_from > now() AND EXISTS (
           SELECT 1 FROM rate_lines p WHERE p.rate_table_id = l.rate_table_id AND p.mccmnc_id = l.mccmnc_id
              AND p.sender_id IS NOT DISTINCT FROM l.sender_id AND p.valid_to = l.valid_from AND p.rate < l.rate))::int AS increases
         FROM rate_lines l JOIN mccmnc m ON m.id = l.mccmnc_id WHERE l.rate_table_id = $1`,
      [id],
    ),
    db.query(
      `SELECT i.uploaded_at, u.username, i.file_name, i.operation, i.status FROM rate_imports i
         LEFT JOIN users u ON u.id = i.uploaded_by_id WHERE i.rate_table_id = $1 ORDER BY i.uploaded_at DESC LIMIT 1`,
      [id],
    ),
  ]);
  const c = counts.rows[0];
  const figures = (await trafficFigures(db, [{ id, kind: r.kind, currency: String(r.currency) }])).get(id);
  const i = imp.rows[0];
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    categoryId: r.product_category_id,
    category: r.category,
    currency: String(r.currency),
    description: r.description ?? null,
    vendorTrunkId: r.vendor_trunk_id ?? null,
    vendorTrunkName: r.vendor_trunk_name ?? null,
    trunks: trunks.rows.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      enterpriseId: t.enterprise_id,
      enterpriseName: t.enterprise_name,
      status: t.status,
    })),
    lastImport: i
      ? {
          at: iso(i.uploaded_at)!,
          by: i.username ?? null,
          fileName: i.file_name,
          operation: i.operation,
          status: i.status,
        }
      : null,
    archived: archivedInfo(r.deleted_at ?? r.trunk_deleted_at, r.deleted_by),
    summary: {
      activeRates: c.active,
      countries: c.countries,
      scheduledChanges: c.scheduled,
      nextChangeAt: iso(c.next_at),
      scheduledIncreases: c.increases,
      closedLines: c.closed,
      negativeMarginLines: r.negative_lines ?? null,
      avgMarginPct: figures?.margin ?? null,
      moneyToday: figures?.money ?? null,
      messagesToday: figures?.n ?? null,
    },
    createdBy: r.created_by ?? null,
    createdAt: iso(r.inserted_at),
    updatedBy: r.updated_by ?? "system",
    updatedAt: iso(r.updated_at)!,
  };
}

export function getRateTable(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => (await loadTable(pool, id)) ?? notFound(reply, id));
}

async function nameTaken(db: Db, name: string, id: number | null) {
  // Archived names stay reserved (§13.29).
  const { rows } = await db.query(
    "SELECT id, deleted_at FROM rate_tables WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1",
    [name.trim(), id],
  );
  return rows[0] ? `already used by rate table ${rows[0].id}${rows[0].deleted_at ? " (archived)" : ""}` : null;
}

export function createRateTable(request: FastifyRequest, reply: FastifyReply) {
  const input = request.body as RateTableInput;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const errors: FieldError[] = [];
    const taken = await nameTaken(pool, input.name, null);
    if (taken) errors.push({ path: "/name", message: taken });
    const { rows: cat } = await pool.query("SELECT 1 FROM product_categories WHERE id = $1 AND deleted_at IS NULL", [
      input.categoryId,
    ]);
    if (!cat[0]) errors.push({ path: "/categoryId", message: "unknown product category" });
    const currency = input.currency.toUpperCase();
    const { rows: cur } = await pool.query("SELECT 1 FROM currencies WHERE iso = $1", [currency]);
    if (!cur[0]) errors.push({ path: "/currency", message: "unknown currency" });
    let source: { id: number; name: string } | null = null;
    if (input.copyFrom) {
      const { rows } = await pool.query(
        `SELECT rt.id, vt.name FROM vendor_trunks vt JOIN rate_tables rt ON rt.vendor_trunk_id = vt.id
          WHERE vt.id = $1 AND vt.deleted_at IS NULL`,
        [input.copyFrom.vendorTrunkId],
      );
      if (!rows[0]) errors.push({ path: "/copyFrom/vendorTrunkId", message: "unknown or archived vendor trunk" });
      else source = rows[0];
    }
    if (errors.length) return badInput(reply, errors);
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO rate_tables (kind, name, product_category_id, currency, description, created_by_id, updated_by_id)
         VALUES ('customer', $1, $2, $3, $4, $5, $5) RETURNING id`,
        [input.name.trim(), input.categoryId, currency, input.description?.trim() || null, me.id],
      );
      const id = rows[0].id as number;
      let copied = 0;
      if (source && input.copyFrom) {
        // Sell = buy converted to the table currency + margin, rounded to 6 decimals (§6.2).
        const res = await c.query(
          `INSERT INTO rate_lines (rate_table_id, mccmnc_id, mccmnc, dial_code, sender_id, rate, currency, valid_from,
                                  change_type, rate_note, created_by_id, updated_by_id)
           SELECT $1, l.mccmnc_id, l.mccmnc, l.dial_code, l.sender_id,
                  round(l.rate / src.rate_per_usd * dst.rate_per_usd * (1 + $3::numeric / 100), 6), $4, now(),
                  'new', 'Copied from vendor trunk ' || $5, $6, $6
             FROM rate_lines l
             JOIN currency_latest src ON src.iso = l.currency
             JOIN currency_latest dst ON dst.iso = $4
            WHERE l.rate_table_id = $2 AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())`,
          [id, source.id, input.copyFrom.marginPct, currency, source.name, me.id],
        );
        copied = res.rowCount ?? 0;
      }
      await c.query("SELECT refresh_rate_table_stats($1::bigint[])", [[id]]);
      const change = await recordChange(c, {
        entityType: "rate_table",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: input.name.trim() }],
        note: source ? `Copied ${copied} rates from ${source.name} + ${input.copyFrom!.marginPct}%` : null,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadTable(pool, id), change });
  });
}

export function updateRateTable(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const input = request.body as RateTableUpdate;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const before = await loadTable(pool, id);
    if (!before) return notFound(reply, id);
    if (before.archived) return sendProblem(reply, 400, "This rate table is archived; restore it before editing");
    const taken = await nameTaken(pool, input.name, id);
    if (taken) return badInput(reply, [{ path: "/name", message: taken }]);
    const next = { name: input.name.trim(), description: input.description?.trim() || null };
    const diff: DiffEntry[] = (["name", "description"] as const)
      .filter((k) => (before[k] ?? null) !== next[k])
      .map((k) => ({ entity_id: id, field: k, before: before[k] ?? null, after: next[k] }));
    if (diff.length === 0) return { record: before, change: null };
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE rate_tables SET name = $2, description = $3, updated_by_id = $4, updated_at = now() WHERE id = $1",
        [id, next.name, next.description, me.id],
      );
      return recordChange(c, {
        entityType: "rate_table",
        entityIds: [id],
        changeType: "edit",
        diff,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadTable(pool, id), change };
  });
}

// ---------------------------------------------------------------- safe delete (§13.29)

async function tableDependencies(db: Db, id: number) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM customer_trunk_rate_tables x
       JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL WHERE x.rate_table_id = $1`,
    [id],
  );
  return dependencies([
    {
      key: "customer_trunks",
      label: "Customer trunks pricing with it",
      count: rows[0].n,
      blocking: true,
      detail: rows[0].n ? "Remove the table from these trunks first" : null,
    },
    { key: "rate_history", label: "Rate history", count: null, blocking: false, detail: "Kept with every version" },
    {
      key: "traffic_30d",
      label: "Traffic in the last 30 days",
      count: null,
      blocking: false,
      detail: "Checked against the EDR store by the backend",
    },
  ]);
}

export function getRateTableDependencies(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query("SELECT 1 FROM rate_tables WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    return tableDependencies(pool, id);
  });
}

export function archiveRateTable(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const body = (request.body ?? {}) as ArchiveRequest;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const before = await loadTable(pool, id);
    if (!before) return notFound(reply, id);
    if (before.kind === "vendor")
      return sendProblem(reply, 403, "A vendor's buy table is archived with its vendor trunk");
    if (before.archived) return { record: before, change: null };
    const gate = await archiveGate(reply, body, await tableDependencies(pool, id));
    if (!gate.ok) return gate.reply;
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE rate_tables SET deleted_at = now(), deleted_by_id = $2 WHERE id = $1", [id, me.id]);
      return recordChange(c, {
        entityType: "rate_table",
        entityIds: [id],
        changeType: "delete",
        diff: [{ entity_id: id, field: "archived", before: false, after: true }],
        note: gate.note,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadTable(pool, id), change };
  });
}

export function restoreRateTable(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!isAdmin(me)) return sendProblem(reply, 403, "Only administrators can restore archived records");
    const { rows } = await pool.query("SELECT deleted_at, kind FROM rate_tables WHERE id = $1", [id]);
    if (!rows[0]) return notFound(reply, id);
    if (!rows[0].deleted_at) return sendProblem(reply, 400, "This rate table is not archived");
    const change = await inTransaction(pool, async (c) => {
      await c.query("UPDATE rate_tables SET deleted_at = NULL, deleted_by_id = NULL WHERE id = $1", [id]);
      return recordChange(c, {
        entityType: "rate_table",
        entityIds: [id],
        changeType: "edit",
        diff: [{ entity_id: id, field: "archived", before: true, after: false }],
        note: "Restored",
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadTable(pool, id), change };
  });
}

// ---------------------------------------------------------------- rate edits

/** One rate line as stored in the change log: everything needed to put it back. */
interface LineSnap {
  id: number;
  tableId: number;
  mccmncId: number;
  mccmnc: string;
  senderId: string | null;
  dialCode: string | null;
  rate: number;
  currency: string;
  from: string;
  to: string | null;
  statedFrom: string | null;
  blocked: boolean;
  changeType: string;
  note: string | null;
}

const LINE_COLS = `id, rate_table_id, mccmnc_id, mccmnc, sender_id, dial_code, rate, currency, valid_from, valid_to,
  stated_valid_from, is_blocked, change_type, rate_note`;

const snap = (r: Record<string, unknown>): LineSnap => ({
  id: r.id as number,
  tableId: r.rate_table_id as number,
  mccmncId: r.mccmnc_id as number,
  mccmnc: r.mccmnc as string,
  senderId: (r.sender_id as string | null) ?? null,
  dialCode: (r.dial_code as string | null) ?? null,
  rate: Number(r.rate),
  currency: String(r.currency),
  from: iso(r.valid_from)!,
  to: iso(r.valid_to),
  statedFrom: iso(r.stated_valid_from),
  blocked: r.is_blocked as boolean,
  changeType: r.change_type as string,
  note: (r.rate_note as string | null) ?? null,
});

/**
 * Puts rate lines back to the given snapshots (undo). Removals run first, then updates, then
 * inserts, so no two versions of a destination overlap at any step (exclusion constraint).
 */
async function applyRateLineSnapshots(
  c: pg.PoolClient,
  entries: { id: number; value: LineSnap | null; other: LineSnap | null }[],
  userId: number,
): Promise<void> {
  const write = async (s: LineSnap, insert: boolean) => {
    const values = [
      s.id,
      s.tableId,
      s.mccmncId,
      s.mccmnc,
      s.senderId,
      s.dialCode,
      s.rate,
      s.currency,
      s.from,
      s.to,
      s.statedFrom,
      s.blocked,
      s.changeType,
      s.note,
      userId,
    ];
    if (insert)
      await c.query(
        `INSERT INTO rate_lines (id, rate_table_id, mccmnc_id, mccmnc, sender_id, dial_code, rate, currency, valid_from,
           valid_to, stated_valid_from, is_blocked, change_type, rate_note, created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
        values,
      );
    else
      await c.query(
        `UPDATE rate_lines SET rate_table_id = $2, mccmnc_id = $3, mccmnc = $4, sender_id = $5, dial_code = $6, rate = $7,
           currency = $8, valid_from = $9, valid_to = $10, stated_valid_from = $11, is_blocked = $12, change_type = $13,
           rate_note = $14, updated_by_id = $15, updated_at = now() WHERE id = $1`,
        values,
      );
  };
  for (const e of entries)
    if (e.value === null && e.other !== null) await c.query("DELETE FROM rate_lines WHERE id = $1", [e.id]);
  for (const e of entries) if (e.value && e.other) await write(e.value, false);
  for (const e of entries) if (e.value && !e.other) await write(e.value, true);
}

/**
 * Puts a rate table's recorded fields to their `before` (undo) or `after` (redo) values:
 * name, description, archived and rate lines. A line edited twice in one batch (e.g. set
 * twice) collapses to its first and last state.
 */
export async function applyRateTableEntries(
  c: pg.PoolClient,
  entries: DiffEntry[],
  pick: "before" | "after",
  userId: number,
): Promise<void> {
  const byLine = new Map<number, DiffEntry[]>();
  for (const e of entries) if (e.field === "line") byLine.set(e.entity_id, [...(byLine.get(e.entity_id) ?? []), e]);
  const lines = [...byLine.entries()]
    .map(([id, list]) => {
      const first = list[0]!.before as LineSnap | null;
      const last = list.at(-1)!.after as LineSnap | null;
      return pick === "before" ? { id, value: first, other: last } : { id, value: last, other: first };
    })
    // A line created and replaced within the same batch has nothing to put back.
    .filter((l) => l.value !== null || l.other !== null);
  await applyRateLineSnapshots(c, lines, userId);
  for (const e of entries) {
    if (e.field === "name" || e.field === "description")
      await c.query(`UPDATE rate_tables SET ${e.field} = $2, updated_by_id = $3, updated_at = now() WHERE id = $1`, [
        e.entity_id,
        e[pick],
        userId,
      ]);
    if (e.field === "archived")
      await c.query(`UPDATE rate_tables SET deleted_at = ${e[pick] ? "now()" : "NULL"} WHERE id = $1`, [e.entity_id]);
  }
  const tables = [...new Set(lines.map((l) => (l.value ?? l.other)!.tableId))];
  if (tables.length) {
    const { rows } = await c.query(
      "UPDATE rate_tables SET updated_by_id = $2, updated_at = now() WHERE id = ANY($1) RETURNING kind",
      [tables, userId],
    );
    await c.query("SELECT refresh_rate_table_stats($1::bigint[])", [tables]);
    // Vendor rates feed the best-buy view.
    if (rows.some((r) => r.kind === "vendor")) scheduleBestBuyRefresh();
  }
}

export interface Breach {
  mccmnc: string;
  currentRate: number;
  newRate: number;
  effectiveFrom: string;
  noticeDays: number;
  earliestAllowed: string;
  enterpriseName: string;
  rateTableId?: number;
  table?: string;
}

/** A rate table being edited, with the longest notice period of the clients using it (§13.14). */
export interface EditTable {
  id: number;
  name: string;
  kind: string;
  currency: string;
  notice: { days: number; name: string } | null;
}

/** Longest notice period among the clients pricing with each customer table (§13.14). */
export async function noticePeriods(db: Db, ids: number[]): Promise<Map<number, { days: number; name: string }>> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (x.rate_table_id) x.rate_table_id AS id, e.rate_notice_days AS days, e.name
       FROM customer_trunk_rate_tables x
       JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
       JOIN enterprises e ON e.id = t.enterprise_id
      WHERE x.rate_table_id = ANY($1) AND e.rate_notice_days > 0
      ORDER BY x.rate_table_id, e.rate_notice_days DESC, e.name`,
    [ids],
  );
  return new Map(rows.map((r) => [Number(r.id), { days: r.days as number, name: r.name as string }]));
}

/**
 * Shape checks the schema can't express, for edits on one table: rates for set, lines that
 * belong to the table, MCCMNCs from the master (collected into `mccmncIds`).
 */
export async function checkLineEdits(
  db: Db,
  tableId: number,
  edits: { it: RateLineEdit; at: string }[],
  mccmncIds: Map<string, number>,
  nowMs: number,
): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  for (const { it, at } of edits) {
    if (it.action === "set") {
      if (it.rate === undefined) errors.push({ path: `${at}/rate`, message: "required to set a rate" });
      if (it.lineId === undefined && !it.mccmnc) errors.push({ path: at, message: "give lineId or mccmnc" });
      if (it.effectiveFrom && Date.parse(it.effectiveFrom) < nowMs - SKEW_MS)
        errors.push({
          path: `${at}/effectiveFrom`,
          message: "can't be in the past (traffic already sent keeps its rate)",
        });
    } else {
      if (it.lineId === undefined) errors.push({ path: `${at}/lineId`, message: `required to ${it.action} a line` });
      if (it.action === "block" && it.blocked === undefined)
        errors.push({ path: `${at}/blocked`, message: "required" });
      if (it.at && Date.parse(it.at) < nowMs - SKEW_MS)
        errors.push({ path: `${at}/at`, message: "can't be in the past" });
    }
  }
  const lineIds = [...new Set(edits.flatMap(({ it }) => (it.lineId === undefined ? [] : [it.lineId])))];
  if (lineIds.length) {
    const { rows } = await db.query("SELECT id FROM rate_lines WHERE id = ANY($1) AND rate_table_id = $2", [
      lineIds,
      tableId,
    ]);
    const ok = new Set(rows.map((r) => Number(r.id)));
    for (const { it, at } of edits)
      if (it.lineId !== undefined && !ok.has(it.lineId))
        errors.push({ path: `${at}/lineId`, message: `line ${it.lineId} is not in this table` });
  }
  const codes = [
    ...new Set(
      edits.flatMap(({ it }) => (it.lineId === undefined && it.mccmnc && !mccmncIds.has(it.mccmnc) ? [it.mccmnc] : [])),
    ),
  ];
  if (codes.length) {
    const { rows } = await db.query("SELECT id, mccmnc FROM mccmnc WHERE mccmnc = ANY($1) AND deleted_at IS NULL", [
      codes,
    ]);
    for (const r of rows) mccmncIds.set(r.mccmnc, Number(r.id));
  }
  for (const { it, at } of edits)
    if (it.lineId === undefined && it.mccmnc && !mccmncIds.has(it.mccmnc))
      errors.push({ path: `${at}/mccmnc`, message: `${it.mccmnc} is not in the MCCMNC master` });
  return errors;
}

/**
 * Applies checked edits to one table inside a transaction: diff entries go to `diff`, short-notice
 * increases to `breaches`. Answers how many edits changed nothing.
 */
export async function applyLineEdits(
  c: pg.PoolClient,
  table: EditTable,
  items: RateLineEdit[],
  mccmncIds: Map<string, number>,
  userId: number,
  now: Date,
  diff: DiffEntry[],
  breaches: Breach[],
): Promise<number> {
  const id = table.id;
  const nowMs = now.getTime();
  const notice = table.notice;
  let skipped = 0;
  const lineById = async (lineId: number) =>
    (await c.query(`SELECT ${LINE_COLS} FROM rate_lines WHERE id = $1`, [lineId])).rows[0] as
      Record<string, unknown> | undefined;
  for (const it of items) {
    if (it.action === "set") {
      const ref = it.lineId !== undefined ? await lineById(it.lineId) : undefined;
      const mccmncId = ref ? (ref.mccmnc_id as number) : mccmncIds.get(it.mccmnc!)!;
      const senderId = ref ? ((ref.sender_id as string | null) ?? null) : it.senderId?.trim() || null;
      const from = it.effectiveFrom ? new Date(Math.max(Date.parse(it.effectiveFrom), nowMs)) : now;
      const key = [id, mccmncId, senderId];
      const keySql = "rate_table_id = $1 AND mccmnc_id = $2 AND sender_id IS NOT DISTINCT FROM $3";
      const { rows: curRows } = await c.query(
        `SELECT ${LINE_COLS} FROM rate_lines WHERE ${keySql} AND valid_from <= $4 AND (valid_to IS NULL OR valid_to > $4)`,
        [...key, from],
      );
      const cur = curRows[0];
      const rate = Math.round(it.rate! * 1e6) / 1e6;
      const note = it.rateNote === undefined ? null : it.rateNote?.trim() || null;
      if (cur && Number(cur.rate) === rate && (it.rateNote === undefined || note === cur.rate_note)) {
        skipped++;
        continue;
      }
      if (notice && cur && rate > Number(cur.rate)) {
        const earliest = nowMs + notice.days * 86_400_000;
        if (from.getTime() < earliest - SKEW_MS)
          breaches.push({
            mccmnc: String(cur.mccmnc),
            currentRate: Number(cur.rate),
            newRate: rate,
            effectiveFrom: from.toISOString(),
            noticeDays: notice.days,
            earliestAllowed: new Date(earliest).toISOString(),
            enterpriseName: notice.name,
            rateTableId: id,
            table: table.name,
          });
      }
      // Versions starting at or after the new date are replaced by it.
      const { rows: later } = await c.query(
        `SELECT ${LINE_COLS} FROM rate_lines WHERE ${keySql} AND valid_from >= $4`,
        [...key, from],
      );
      for (const l of later) {
        await c.query("DELETE FROM rate_lines WHERE id = $1", [l.id]);
        diff.push({ entity_id: l.id as number, field: "line", before: snap(l), after: null });
      }
      const prev = cur && !later.some((l) => l.id === cur.id) ? cur : null;
      if (prev) {
        const { rows: upd } = await c.query(
          `UPDATE rate_lines SET valid_to = $2, updated_by_id = $3, updated_at = now() WHERE id = $1 RETURNING ${LINE_COLS}`,
          [prev.id, from, userId],
        );
        diff.push({ entity_id: prev.id as number, field: "line", before: snap(prev), after: snap(upd[0]) });
      }
      const base = prev ?? cur;
      const changeType = !base
        ? "new"
        : rate > Number(base.rate)
          ? "increase"
          : rate < Number(base.rate)
            ? "decrease"
            : "same";
      const mccmnc = ref ? (ref.mccmnc as string) : it.mccmnc!;
      const { rows: ins } = await c.query(
        `INSERT INTO rate_lines (rate_table_id, mccmnc_id, mccmnc, dial_code, sender_id, rate, currency, valid_from,
                                is_blocked, change_type, rate_note, created_by_id, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING ${LINE_COLS}`,
        [
          id,
          mccmncId,
          mccmnc,
          base?.dial_code ?? null,
          senderId,
          rate,
          table.currency,
          from,
          base?.is_blocked ?? false,
          changeType,
          note ?? (it.rateNote === undefined ? (base?.rate_note ?? null) : null),
          userId,
        ],
      );
      diff.push({ entity_id: ins[0].id as number, field: "line", before: null, after: snap(ins[0]) });
    } else if (it.action === "close") {
      const l = await lineById(it.lineId!);
      if (!l) continue;
      const at = it.at ? new Date(Math.max(Date.parse(it.at), nowMs)) : now;
      if ((l.valid_from as Date) >= at) {
        // Not started yet: a scheduled rate is withdrawn, and the version before it runs on
        // as long as the withdrawn one would have.
        await c.query("DELETE FROM rate_lines WHERE id = $1", [l.id]);
        diff.push({ entity_id: l.id as number, field: "line", before: snap(l), after: null });
        const { rows: prev } = await c.query(
          `SELECT ${LINE_COLS} FROM rate_lines WHERE rate_table_id = $1 AND mccmnc_id = $2
              AND sender_id IS NOT DISTINCT FROM $3 AND valid_to = $4`,
          [id, l.mccmnc_id, l.sender_id, l.valid_from],
        );
        if (prev[0]) {
          const { rows: upd } = await c.query(
            `UPDATE rate_lines SET valid_to = $2, updated_by_id = $3, updated_at = now() WHERE id = $1 RETURNING ${LINE_COLS}`,
            [prev[0].id, l.valid_to, userId],
          );
          diff.push({ entity_id: prev[0].id as number, field: "line", before: snap(prev[0]), after: snap(upd[0]) });
        }
      } else if (!l.valid_to || (l.valid_to as Date) > at) {
        const { rows: upd } = await c.query(
          `UPDATE rate_lines SET valid_to = $2, updated_by_id = $3, updated_at = now() WHERE id = $1 RETURNING ${LINE_COLS}`,
          [l.id, at, userId],
        );
        diff.push({ entity_id: l.id as number, field: "line", before: snap(l), after: snap(upd[0]) });
      } else skipped++;
    } else {
      const l = await lineById(it.lineId!);
      if (!l || l.is_blocked === it.blocked) {
        skipped++;
        continue;
      }
      const { rows: upd } = await c.query(
        `UPDATE rate_lines SET is_blocked = $2, updated_by_id = $3, updated_at = now() WHERE id = $1 RETURNING ${LINE_COLS}`,
        [l.id, it.blocked, userId],
      );
      diff.push({ entity_id: l.id as number, field: "line", before: snap(l), after: snap(upd[0]) });
    }
  }
  return skipped;
}

/** 409 for increases sooner than a client's notice period (§13.14). */
export function sendNoticeBreach(reply: FastifyReply, breaches: Breach[]) {
  return reply
    .code(409)
    .type("application/problem+json")
    .send({
      type: "about:blank",
      title: "Increases sooner than the client's notice period",
      status: 409,
      detail: `${breaches.length} increase${breaches.length === 1 ? "" : "s"} start before ${breaches[0]!.earliestAllowed.slice(0, 10)} (${breaches[0]!.noticeDays} days' notice for ${breaches[0]!.enterpriseName})`,
      breaches,
    });
}

export function changeRateLines(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const body = request.body as RateLineChanges;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows: tr } = await pool.query(
      `SELECT rt.id, rt.name, rt.kind, rt.currency, rt.deleted_at, vt.deleted_at AS trunk_deleted_at
         FROM rate_tables rt LEFT JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id WHERE rt.id = $1`,
      [id],
    );
    const row = tr[0];
    if (!row) return notFound(reply, id);
    if (row.deleted_at || row.trunk_deleted_at)
      return sendProblem(reply, 400, "This rate table is archived; restore it before editing");
    const now = new Date();
    const mccmncIds = new Map<string, number>();
    const errors = await checkLineEdits(
      pool,
      id,
      body.items.map((it, i) => ({ it, at: `/items/${i}` })),
      mccmncIds,
      now.getTime(),
    );
    if (errors.length) return badInput(reply, errors);
    const table: EditTable = {
      id,
      name: row.name,
      kind: row.kind,
      currency: row.currency,
      notice: row.kind === "customer" ? ((await noticePeriods(pool, [id])).get(id) ?? null) : null,
    };

    const breaches: Breach[] = [];
    let skipped = 0;
    const result = await inTransaction(pool, async (c) => {
      const diff: DiffEntry[] = [];
      skipped = await applyLineEdits(c, table, body.items, mccmncIds, me.id, now, diff, breaches);
      if (breaches.length && !body.acceptNoticeBreach) throw new NoticeBreachError();
      if (diff.length === 0) return { change: null, applied: 0 };
      await c.query("UPDATE rate_tables SET updated_by_id = $2, updated_at = now() WHERE id = $1", [id, me.id]);
      await c.query("SELECT refresh_rate_table_stats($1::bigint[])", [[id]]);
      const change = await recordChange(c, {
        entityType: "rate_table",
        entityIds: [id],
        changeType: body.items.length > 1 ? "bulk" : "edit",
        diff,
        note: body.note?.trim() || (breaches.length ? `Short notice accepted for ${breaches.length} increases` : null),
        userId: me.id,
        ip: request.ip,
      });
      return { change, applied: body.items.length - skipped };
    }).catch((err) => {
      if (err instanceof NoticeBreachError) return null;
      throw err;
    });
    if (result === null)
      return sendNoticeBreach(
        reply,
        breaches.map(({ rateTableId: _r, table: _t, ...b }) => b),
      );
    if (result.change && table.kind === "vendor") scheduleBestBuyRefresh();
    return { change: result.change, applied: result.applied, skipped };
  });
}

export class NoticeBreachError extends Error {}
