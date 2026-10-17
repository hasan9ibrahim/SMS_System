// Reports (§10, §13.15): the Master Report and its export, the presets (department reports and the
// §10 reports that became saved views), Sales and NOC insights, the Billing report list, scheduled
// reports (CRON, e-mailed) and daily traffic alerts. Figures come from the EDR store (reports/engine.ts).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  BillingReportQuery,
  DailyTrafficAlertInput,
  MasterReportExportInput,
  MasterReportQuery,
  MasterReportSettings,
  NocInsightsInput,
  SalesInsightsInput,
  SalesMover,
  ScheduledReportInput,
} from "@sms/contract";
import { PLATFORM_CURRENCY, sysToPlatformFactor } from "../currency.js";
import { db, withDb } from "../db.js";
import { chQuery } from "../edr.js";
import { simplePdf, spreadsheetXml } from "../billing/files.js";
import {
  billingReportDef,
  DAILY_ALERT_FROM,
  DAILY_ALERT_SELECT,
  mapDailyAlert,
  mapScheduledReport,
  SCHEDULED_REPORT_FROM,
  SCHEDULED_REPORT_SELECT,
} from "../lists/defs.js";
import { lit } from "../lists/chEngine.js";
import { compileQuery, type ListDef } from "../lists/engine.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { cronFor, describeCron, nextRuns, parseCron } from "../reports/cron.js";
import {
  DIM_LABELS,
  METRIC_LABELS,
  reportNow,
  runMasterReport,
  splitFilter,
  windowOf,
  type ReportResult,
} from "../reports/engine.js";
import { previousWindow, resolvePeriod, validZone, type Window } from "../reports/period.js";
import { PRESETS } from "../reports/presets.js";
import { causeName } from "../smpp.js";
import { chProblem } from "./observation.js";
import { logEmail } from "./emailLog.js";
import { csvCell, notFound } from "./masterData.js";
import { recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { archiver, badInput, contactEmails, fill } from "./switchTools.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };
const iso = (d: Date) => d.toISOString();

// ---------------------------------------------------------------- master report

function checkReport(q: MasterReportQuery): FieldError[] {
  const errors: FieldError[] = [];
  if (!validZone(q.timezone)) errors.push({ path: "/timezone", message: "unknown time zone" });
  errors.push(
    ...checkListQuery(
      { ...(q.filter ? { filter: q.filter } : {}), ...(q.sort ? { sort: q.sort } : {}) } as never,
      listFields.master_report,
    ),
  );
  const split = splitFilter(q.filter);
  if (split.error) errors.push({ path: "/filter", message: split.error });
  for (const [i, s] of (q.sort ?? []).entries())
    if (!q.groupBy.includes(s.field as never) && !q.metrics.includes(s.field as never) && s.field !== "tpsPeak")
      errors.push({ path: `/sort/${i}/field`, message: "sort by a group-by field or a chosen metric" });
  return errors;
}

async function prepare(
  reply: FastifyReply,
  q: MasterReportQuery,
): Promise<{ window: Window } | { reply: FastifyReply }> {
  const errors = checkReport(q);
  if (errors.length) return { reply: badInput(reply, errors) };
  const w = windowOf(q, await reportNow());
  if (typeof w === "string")
    return { reply: badInput(reply, [{ path: q.period === "custom" ? "/to" : "/period", message: w }]) };
  return { window: w };
}

const page = (q: MasterReportQuery, r: ReportResult, started: number) => ({
  rows: r.rows,
  totals: r.totals,
  total: r.total,
  totalIsEstimate: false,
  nextCursor: r.nextCursor,
  from: iso(r.window.from),
  to: iso(r.window.to),
  previousFrom: r.previous ? iso(r.previous.from) : null,
  previousTo: r.previous ? iso(r.previous.to) : null,
  timezone: q.timezone,
  currency: PLATFORM_CURRENCY,
  groupBy: q.groupBy,
  metrics: q.metrics,
  tookMs: Date.now() - started,
});

export function runMasterReportHandler(request: FastifyRequest, reply: FastifyReply) {
  const q = request.body as MasterReportQuery;
  const started = Date.now();
  return withDb(reply, async (pool) => {
    try {
      const p = await prepare(reply, q);
      if ("reply" in p) return p.reply;
      return page(q, await runMasterReport(pool, q, p.window), started);
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}

/** Header and rows of a report for files: labels, metric values, previous values when comparing. */
export function reportTable(q: MasterReportSettings, r: ReportResult) {
  const prev = !!r.previous;
  const header = [
    ...q.groupBy.map((d) => DIM_LABELS[d]),
    ...q.metrics.flatMap((m) => (prev ? [METRIC_LABELS[m], `${METRIC_LABELS[m]} (previous)`] : [METRIC_LABELS[m]])),
  ];
  const values = (m: Record<string, number | null>, p: Record<string, number | null> | null) =>
    q.metrics.flatMap((k) => (prev ? [m[k] ?? null, p?.[k] ?? null] : [m[k] ?? null]));
  const rows = r.rows.map((row) => [
    ...q.groupBy.map((d) => row.dims[d]?.label ?? ""),
    ...values(row.metrics, row.previous),
  ]);
  const total = ["Total", ...q.groupBy.slice(1).map(() => ""), ...values(r.totals.metrics, r.totals.previous)];
  return { header, rows, total };
}

export function exportMasterReport(request: FastifyRequest, reply: FastifyReply) {
  const { query: q, fileType } = request.body as MasterReportExportInput;
  return withDb(reply, async (pool) => {
    try {
      const p = await prepare(reply, q);
      if ("reply" in p) return p.reply;
      const r = await runMasterReport(pool, q, p.window, { all: true });
      return sendReportFile(reply, q, r, fileType, "master_report");
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}

export function reportFile(q: MasterReportSettings, r: ReportResult, fileType: "csv" | "excel" | "pdf", title: string) {
  const t = reportTable(q, r);
  const period = `${iso(r.window.from).slice(0, 16).replace("T", " ")} to ${iso(r.window.to).slice(0, 16).replace("T", " ")} UTC · ${q.timezone}`;
  if (fileType === "excel")
    return {
      type: "application/vnd.ms-excel",
      ext: "xls",
      body: spreadsheetXml(title, [
        { cells: [title], bold: true },
        { cells: [period] },
        { cells: t.header, bold: true },
        ...t.rows.map((cells) => ({ cells })),
        { cells: t.total, bold: true },
      ]),
    };
  if (fileType === "pdf") {
    // The PDF fonts are Latin-1 only.
    const latin = (t: string) => t.replace(/[·–—]/g, "-").replace(/[^\x20-\xff]/g, "?");
    const line = (cells: (string | number | null)[]) =>
      latin(cells.map((c) => (c === null ? "-" : String(c))).join("  |  ")).slice(0, 150);
    return {
      type: "application/pdf",
      ext: "pdf",
      body: simplePdf([
        { text: title, size: 15, bold: true },
        { text: latin(period), size: 9 },
        { text: line(t.header), size: 8, bold: true, gap: 18 },
        ...t.rows.slice(0, 2000).map((cells) => ({ text: line(cells), size: 8 })),
        { text: line(t.total), size: 8, bold: true, gap: 14 },
      ]),
    };
  }
  return {
    type: "text/csv; charset=utf-8",
    ext: "csv",
    body: [t.header, ...t.rows, t.total].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n",
  };
}

function sendReportFile(
  reply: FastifyReply,
  q: MasterReportSettings,
  r: ReportResult,
  fileType: "csv" | "excel" | "pdf",
  name: string,
) {
  const f = reportFile(q, r, fileType, "Master Report");
  return reply.type(f.type).header("content-disposition", `attachment; filename="${name}.${f.ext}"`).send(f.body);
}

export const listReportPresets = () => ({ presets: PRESETS });

// ---------------------------------------------------------------- sales insights

export function salesInsights(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as SalesInsightsInput;
  if (!validZone(b.timezone)) return badInput(reply, [{ path: "/timezone", message: "unknown time zone" }]);
  return withDb(reply, async (pool) => {
    try {
      const w = windowOf({ period: b.period, from: b.from, to: b.to, timezone: b.timezone }, await reportNow());
      if (typeof w === "string") return badInput(reply, [{ path: "/period", message: w }]);
      const p = previousWindow(w, "previous_period");
      const factor = await sysToPlatformFactor();
      const t = (d: Date) => `toDateTime64(${lit(iso(d).replace("T", " ").replace("Z", ""))}, 3, 'UTC')`;
      const cur = `start_time >= ${t(w.from)}`;
      const where = [
        `start_time >= ${t(p.from)} AND start_time < ${t(w.to)}`,
        b.accountManagerId ? `c_am_user_id = ${Number(b.accountManagerId)}` : "1",
        b.country ? `c_country_iso = ${lit(b.country)}` : "1",
        b.productCategoryId ? `product_category_id = ${Number(b.productCategoryId)}` : "1",
      ].join(" AND ");
      const rows = await chQuery<Record<string, string>>(
        `SELECT c_enterprise_id AS id, countIf(${cur}) AS a, countIf(NOT ${cur}) AS pa,
                toFloat64(sumIf(revenue_sys * ${factor}, ${cur})) AS r, toFloat64(sumIf(revenue_sys * ${factor}, NOT ${cur})) AS pr,
                toFloat64(sumIf((revenue_sys - cost_sys) * ${factor}, ${cur})) AS m, argMax(c_am_user_id, start_time) AS am
           FROM edr WHERE ${where} GROUP BY id`,
      );
      const ids = rows.map((r) => Number(r.id));
      const ams = rows.map((r) => Number(r.am)).filter(Boolean);
      const [ents, users] = await Promise.all([
        pool.query("SELECT id, name FROM enterprises WHERE id = ANY($1)", [ids]),
        pool.query("SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id = ANY($1)", [ams]),
      ]);
      const ent = new Map(ents.rows.map((r) => [Number(r.id), String(r.name)]));
      const user = new Map(users.rows.map((r) => [Number(r.id), String(r.name)]));
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const movers: SalesMover[] = rows.map((r) => {
        const revenue = Number(r.r);
        const prev = Number(r.pr);
        return {
          enterpriseId: Number(r.id),
          enterprise: ent.get(Number(r.id)) ?? `#${r.id}`,
          accountManager: user.get(Number(r.am)) ?? null,
          attempts: Number(r.a),
          previousAttempts: Number(r.pa),
          revenue: r2(revenue),
          previousRevenue: r2(prev),
          margin: r2(Number(r.m)),
          changePct: prev > 0 ? Math.round(((revenue - prev) / prev) * 1000) / 10 : null,
        };
      });
      const threshold = b.thresholdPct ?? 20;
      const both = movers.filter((m) => m.attempts > 0 && m.previousAttempts > 0 && m.changePct !== null);
      return {
        from: iso(w.from),
        to: iso(w.to),
        previousFrom: iso(p.from),
        previousTo: iso(p.to),
        currency: PLATFORM_CURRENCY,
        growing: both
          .filter((m) => m.changePct! >= threshold)
          .sort((a, z) => z.revenue - z.previousRevenue - (a.revenue - a.previousRevenue))
          .slice(0, 25),
        declining: both
          .filter((m) => m.changePct! <= -threshold)
          .sort((a, z) => a.revenue - a.previousRevenue - (z.revenue - z.previousRevenue))
          .slice(0, 25),
        newClients: movers
          .filter((m) => m.attempts > 0 && m.previousAttempts === 0)
          .sort((a, z) => z.revenue - a.revenue)
          .slice(0, 25),
        stopped: movers
          .filter((m) => m.attempts === 0 && m.previousAttempts > 0)
          .sort((a, z) => z.previousRevenue - a.previousRevenue)
          .slice(0, 25),
      };
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}

// ---------------------------------------------------------------- billing report

export function queryBillingReport(request: FastifyRequest, reply: FastifyReply) {
  const { params, query } = request.body as BillingReportQuery;
  const errors = checkListQuery(query, listFields.billing_report);
  if (errors.length)
    return sendProblem(reply, 400, "Invalid list query", {
      errors: errors.map((e) => ({ ...e, path: `/query${e.path}` })),
    });
  return withDb(reply, async (pool) => {
    try {
      const w = windowOf(
        { period: params.period, from: params.from, to: params.to, timezone: "UTC" },
        await reportNow(),
      );
      if (typeof w === "string") return badInput(reply, [{ path: "/params/period", message: w }]);
      const factor = await sysToPlatformFactor();
      const t = (d: Date) => `toDateTime64(${lit(iso(d).replace("T", " ").replace("Z", ""))}, 3, 'UTC')`;
      const inWindow = `start_time >= ${t(w.from)} AND start_time < ${t(w.to)}`;
      const [cust, vend] = await Promise.all([
        chQuery<Record<string, string>>(
          `SELECT c_enterprise_id AS id, countIf(is_customer_billable = 1) AS billable,
                  toFloat64(sumIf(revenue_sys * c_ex_rate, is_customer_billable = 1)) AS amount,
                  countIf(is_customer_billable = 1 AND revenue_sys < cost_sys) AS neg,
                  toFloat64(sumIf((cost_sys - revenue_sys) * ${factor}, is_customer_billable = 1 AND revenue_sys < cost_sys)) AS neg_amount
             FROM edr WHERE ${inWindow} GROUP BY id`,
        ),
        chQuery<Record<string, string>>(
          `SELECT v_enterprise_id AS id, countIf(is_vendor_billable = 1) AS billable, toFloat64(sumIf(cost, is_vendor_billable = 1)) AS amount
             FROM edr WHERE ${inWindow} AND v_enterprise_id > 0 GROUP BY id`,
        ),
      ]);
      const traffic = new Map<number, number[]>();
      for (const r of cust)
        traffic.set(Number(r.id), [Number(r.billable), Number(r.amount), 0, 0, Number(r.neg), Number(r.neg_amount)]);
      for (const r of vend) {
        const x = traffic.get(Number(r.id)) ?? [0, 0, 0, 0, 0, 0];
        x[2] = Number(r.billable);
        x[3] = Number(r.amount);
        traffic.set(Number(r.id), x);
      }
      const def = billingReportDef(w.from, w.to) as ListDef<unknown>;
      return await inTransaction(pool, async (c) => {
        await c.query(
          `CREATE TEMP TABLE br_traffic (enterprise_id bigint PRIMARY KEY, c_billable bigint, c_amount numeric, v_billable bigint,
             v_amount numeric, neg_msgs bigint, neg_amount numeric) ON COMMIT DROP`,
        );
        const ids = [...traffic.keys()];
        const col = (i: number) => ids.map((id) => traffic.get(id)![i]);
        await c.query(
          `INSERT INTO br_traffic SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::numeric[], $4::bigint[], $5::numeric[], $6::bigint[], $7::numeric[])`,
          [ids, col(0), col(1), col(2), col(3), col(4), col(5)],
        );
        const cq = compileQuery(def, query);
        const [pageRes, count] = await Promise.all([
          c.query(cq.sql, cq.values),
          query.withTotal === false ? null : c.query(cq.countSql, cq.countValues),
        ]);
        const more = pageRes.rows.length > cq.limit;
        const rows = pageRes.rows.slice(0, cq.limit).map((r) => def.mapRow(r));
        return {
          rows,
          total: count ? Number(count.rows[0].n) : cq.offset + rows.length + (more ? 1 : 0),
          totalIsEstimate: count === null,
          nextCursor: more ? Buffer.from(JSON.stringify({ o: cq.offset + cq.limit })).toString("base64url") : null,
        };
      });
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}

// ---------------------------------------------------------------- NOC insights

export function nocInsights(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as NocInsightsInput;
  if (!validZone(b.timezone)) return badInput(reply, [{ path: "/timezone", message: "unknown time zone" }]);
  return withDb(reply, async (pool) => {
    try {
      const w = windowOf({ period: b.period, from: b.from, to: b.to, timezone: b.timezone }, await reportNow());
      if (typeof w === "string") return badInput(reply, [{ path: "/period", message: w }]);
      const t = (d: Date) => `toDateTime64(${lit(iso(d).replace("T", " ").replace("Z", ""))}, 3, 'UTC')`;
      const inWindow = `start_time >= ${t(w.from)} AND start_time < ${t(w.to)}`;
      const [binds, errors, vendors] = await Promise.all([
        pool.query(
          `SELECT b.side, b.trunk_id, coalesce(ct.name, vt.name) AS trunk, e.name AS enterprise, b.status, b.since
             FROM trunk_binds b
             LEFT JOIN customer_trunks ct ON b.side = 'customer' AND ct.id = b.trunk_id
             LEFT JOIN vendor_trunks vt ON b.side = 'vendor' AND vt.id = b.trunk_id
             JOIN enterprises e ON e.id = coalesce(ct.enterprise_id, vt.enterprise_id)
            WHERE b.status <> 'online' AND coalesce(ct.status, vt.status) = 'active' AND coalesce(ct.deleted_at, vt.deleted_at) IS NULL
            ORDER BY b.side DESC, b.since LIMIT 50`,
        ),
        chQuery<{ code: string; n: string; total: string }>(
          `SELECT command_status AS code, count() AS n, (SELECT count() FROM edr WHERE ${inWindow}) AS total
             FROM edr WHERE ${inWindow} AND command_status != 0 GROUP BY code ORDER BY n DESC LIMIT 8`,
        ),
        chQuery<Record<string, string>>(
          `SELECT v_trunk_id AS id, count() AS a, if(count() = 0, NULL, round(countIf(is_submit_success = 1) / count() * 100, 1)) AS asr,
                  if(countIf(is_submit_success = 1) = 0, NULL, round(countIf(msg_status = 'DELIVRD') / countIf(is_submit_success = 1) * 100, 1)) AS dlr,
                  if(countIf(msg_status = 'DELIVRD') = 0, NULL, round(sumIf(delivery_delay_ms, msg_status = 'DELIVRD') / countIf(msg_status = 'DELIVRD') / 1000, 1)) AS delay
             FROM edr WHERE ${inWindow} AND v_trunk_id > 0 GROUP BY id HAVING a >= 100`,
        ),
      ]);
      const { rows: vt } = await pool.query("SELECT id, name FROM vendor_trunks WHERE id = ANY($1)", [
        vendors.map((v) => Number(v.id)),
      ]);
      const vname = new Map(vt.map((r) => [Number(r.id), String(r.name)]));
      const now = Date.now();
      const worst = vendors
        .map((v) => {
          const asr = v.asr === null ? null : Number(v.asr);
          const dlr = v.dlr === null ? null : Number(v.dlr);
          const delay = v.delay === null ? null : Number(v.delay);
          const problem =
            asr !== null && asr < 75
              ? "Low ASR"
              : dlr !== null && dlr < 70
                ? "Low DLR"
                : delay !== null && delay > 20
                  ? "Slow delivery"
                  : "";
          const score = (asr ?? 100) / 100 + (dlr ?? 100) / 100 - (delay ?? 0) / 100;
          return {
            vendorTrunkId: Number(v.id),
            vendorTrunk: vname.get(Number(v.id)) ?? `#${v.id}`,
            attempts: Number(v.a),
            asr,
            dlr,
            deliveryDelayS: delay,
            problem,
            score,
          };
        })
        .filter((v) => v.problem)
        .sort((a, z) => a.score - z.score)
        .slice(0, 12)
        .map(({ score: _score, ...v }) => v);
      return {
        from: iso(w.from),
        to: iso(w.to),
        bindsDown: binds.rows.map((r) => ({
          side: r.side,
          trunkId: Number(r.trunk_id),
          trunk: r.trunk,
          enterprise: r.enterprise,
          status: r.status,
          since: (r.since as Date).toISOString(),
          downMinutes: Math.max(0, Math.round((now - (r.since as Date).getTime()) / 60_000)),
        })),
        topErrors: errors.map((e) => ({
          causeCode: Number(e.code),
          causeText: causeName(Number(e.code)),
          count: Number(e.n),
          sharePct: Number(e.total) ? Math.round((Number(e.n) / Number(e.total)) * 1000) / 10 : 0,
        })),
        worstVendors: worst,
      };
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}

// ---------------------------------------------------------------- scheduled reports

const loadScheduled = async (c: Db, id: number) => {
  const { rows } = await c.query(`SELECT ${SCHEDULED_REPORT_SELECT} FROM ${SCHEDULED_REPORT_FROM} WHERE s.id = $1`, [
    id,
  ]);
  return rows[0] ? mapScheduledReport(rows[0]) : null;
};
export const getScheduledReport = (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadScheduled(pool, id)) ?? notFound(reply, "Scheduled report", id));
};

const SR_FIELDS: [keyof ScheduledReportInput, string][] = [
  ["name", "name"],
  ["description", "description"],
  ["templateKind", "template_kind"],
  ["presetKey", "preset_key"],
  ["viewId", "view_id"],
  ["status", "status"],
  ["businessCompanyId", "business_company_id"],
  ["notificationEmails", "notification_emails"],
  ["cronInterval", "cron_interval"],
  ["cronFrequency", "cron_frequency"],
  ["cronExpression", "cron_expression"],
  ["fileType", "file_type"],
  ["emailBody", "email_body"],
];

async function checkScheduled(c: Db, b: ScheduledReportInput, id: number | null): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  try {
    parseCron(b.cronExpression);
  } catch (e) {
    errors.push({ path: "/cronExpression", message: (e as Error).message });
  }
  if (b.templateKind === "preset" && !PRESETS.some((p) => p.key === b.presetKey))
    errors.push({ path: "/presetKey", message: "choose a report" });
  if (b.templateKind === "view") {
    const { rows } = await c.query("SELECT 1 FROM saved_views WHERE id = $1 AND list = 'master_report'", [b.viewId]);
    if (!rows[0]) errors.push({ path: "/viewId", message: "choose a saved Master Report view" });
  }
  const { rows: bc } = await c.query("SELECT 1 FROM business_companies WHERE id = $1", [b.businessCompanyId]);
  if (!bc[0]) errors.push({ path: "/businessCompanyId", message: "unknown business company" });
  const { rows: dup } = await c.query(
    "SELECT 1 FROM scheduled_reports WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> coalesce($2, 0)",
    [b.name.trim(), id],
  );
  if (dup[0]) errors.push({ path: "/name", message: "another scheduled report has this name" });
  return errors;
}
const nextRunOf = (b: Pick<ScheduledReportInput, "status" | "cronExpression">) =>
  b.status === "active" ? (nextRuns(b.cronExpression, new Date())[0] ?? null) : null;
const srValues = (b: ScheduledReportInput) => ({
  ...b,
  name: b.name.trim(),
  presetKey: b.templateKind === "preset" ? b.presetKey : null,
  viewId: b.templateKind === "view" ? b.viewId : null,
});

export function createScheduledReport(request: FastifyRequest, reply: FastifyReply) {
  const b = srValues(request.body as ScheduledReportInput);
  return withDb(reply, async (pool) => {
    const errors = await checkScheduled(pool, b, null);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO scheduled_reports (${SR_FIELDS.map(([, col]) => col).join(", ")}, next_run_at, updated_by_id)
         VALUES (${SR_FIELDS.map((_, i) => `$${i + 1}`).join(", ")}, $${SR_FIELDS.length + 1}, $${SR_FIELDS.length + 2}) RETURNING id`,
        [...SR_FIELDS.map(([k]) => b[k]), nextRunOf(b), me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "scheduled_report",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: b.name } }],
        note: `Added scheduled report ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadScheduled(pool, id), change });
  });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function updateScheduledReport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = srValues(request.body as ScheduledReportInput);
  return withDb(reply, async (pool) => {
    const before = await loadScheduled(pool, id);
    if (!before) return notFound(reply, "Scheduled report", id);
    const errors = await checkScheduled(pool, b, id);
    if (errors.length) return badInput(reply, errors);
    const diff: DiffEntry[] = SR_FIELDS.filter(([k]) => !same(before[k], b[k])).map(([k]) => ({
      entity_id: id,
      field: k,
      before: before[k] ?? null,
      after: b[k] ?? null,
    }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE scheduled_reports SET ${SR_FIELDS.map(([, col], i) => `${col} = $${i + 2}`).join(", ")},
                next_run_at = $${SR_FIELDS.length + 2}, updated_by_id = $${SR_FIELDS.length + 3}, updated_at = now() WHERE id = $1`,
        [id, ...SR_FIELDS.map(([k]) => b[k]), nextRunOf(b), me.id],
      );
      return recordChange(c, {
        entityType: "scheduled_report",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed scheduled report ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadScheduled(pool, id), change };
  });
}

const srArchiver = archiver("scheduled_reports", "scheduled_report", "Scheduled report", loadScheduled);
export const archiveScheduledReport = srArchiver.archive;
export const restoreScheduledReport = srArchiver.restore;

/** The settings a scheduled report runs: its preset, or its saved view's report (with defaults). */
async function settingsOf(
  c: Db,
  r: { templateKind: string; presetKey: string | null; viewId: number | null },
): Promise<MasterReportSettings | null> {
  if (r.templateKind === "preset") return PRESETS.find((p) => p.key === r.presetKey)?.settings ?? null;
  const { rows } = await c.query("SELECT state FROM saved_views WHERE id = $1", [r.viewId]);
  const report = (rows[0]?.state as { report?: MasterReportSettings } | undefined)?.report;
  return report ?? null;
}

/** Runs one scheduled report: builds the file and e-mails it (Email Logs), then sets the next run. */
export async function runScheduled(pool: pg.Pool, id: number, userId: number | null) {
  const r = await loadScheduled(pool, id);
  if (!r) return null;
  let status: "sent" | "failed" = "failed";
  let error: string | null = null;
  try {
    const settings = await settingsOf(pool, r);
    if (!settings) throw new Error("The report template no longer exists");
    const w = windowOf(settings, await reportNow());
    if (typeof w === "string") throw new Error(w);
    const result = await runMasterReport(pool, { ...settings, limit: 4000 }, w, { all: true });
    const f = reportFile(settings, result, r.fileType, r.template);
    const { rows: bc } = await pool.query("SELECT name, website FROM business_companies WHERE id = $1", [
      r.businessCompanyId,
    ]);
    const host = String(bc[0]?.website ?? "").replace(/^https?:\/\/(www\.)?/, "");
    const vars = {
      report: r.template,
      from: iso(w.from).slice(0, 16).replace("T", " "),
      to: iso(w.to).slice(0, 16).replace("T", " "),
      rows: String(result.total),
      company: bc[0]?.name ?? "",
    };
    status = await logEmail(pool, {
      type: "schedule_report_alert",
      to: r.notificationEmails,
      sender: host ? `reports@${host}` : null,
      subject: `${r.name}: ${vars.from} to ${vars.to} UTC`,
      body: fill(r.emailBody.replace(/<[^>]+>/g, ""), vars),
      file: `${r.name.replace(/[^\w-]+/g, "_")}_${iso(w.from).slice(0, 10)}.${f.ext}`,
      userId,
    });
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 300);
  }
  await pool.query(
    `UPDATE scheduled_reports SET last_run_at = now(), last_status = $2, last_error = $3,
            next_run_at = CASE WHEN status = 'active' THEN $4::timestamptz END WHERE id = $1`,
    [id, status, error, nextRuns(r.cronExpression, new Date())[0] ?? null],
  );
  return loadScheduled(pool, id);
}

export function runScheduledReport(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    return (await runScheduled(pool, id, me.id)) ?? notFound(reply, "Scheduled report", id);
  });
}

export function previewCron(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as { expression: string; count?: number };
  try {
    return { runs: nextRuns(b.expression, new Date(), b.count ?? 5).map(iso), description: describeCron(b.expression) };
  } catch (e) {
    return badInput(reply, [{ path: "/expression", message: (e as Error).message }]);
  }
}
export { cronFor };

// ---------------------------------------------------------------- daily traffic alerts

const loadDaily = async (c: Db, id: number) => {
  const { rows } = await c.query(`SELECT ${DAILY_ALERT_SELECT} FROM ${DAILY_ALERT_FROM} WHERE d.id = $1`, [id]);
  return rows[0] ? mapDailyAlert(rows[0]) : null;
};
export const getDailyTrafficAlert = (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadDaily(pool, id)) ?? notFound(reply, "Daily traffic alert", id));
};
const DA_FIELDS: [keyof DailyTrafficAlertInput, string][] = [
  ["name", "name"],
  ["status", "status"],
  ["businessCompanyId", "business_company_id"],
  ["contactType", "contact_type"],
  ["enterpriseId", "enterprise_id"],
  ["sendHour", "send_hour"],
  ["emailBody", "email_body"],
];
async function checkDaily(c: Db, b: DailyTrafficAlertInput, id: number | null): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const { rows: e } = await c.query("SELECT 1 FROM enterprises WHERE id = $1 AND deleted_at IS NULL", [b.enterpriseId]);
  if (!e[0]) errors.push({ path: "/enterpriseId", message: "unknown enterprise" });
  const { rows: dup } = await c.query(
    "SELECT 1 FROM daily_traffic_alerts WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> coalesce($2, 0)",
    [b.name.trim(), id],
  );
  if (dup[0]) errors.push({ path: "/name", message: "another daily traffic alert has this name" });
  return errors;
}

export function createDailyTrafficAlert(request: FastifyRequest, reply: FastifyReply) {
  const b = { ...(request.body as DailyTrafficAlertInput) };
  b.name = b.name.trim();
  return withDb(reply, async (pool) => {
    const errors = await checkDaily(pool, b, null);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO daily_traffic_alerts (${DA_FIELDS.map(([, col]) => col).join(", ")}, updated_by_id)
         VALUES (${DA_FIELDS.map((_, i) => `$${i + 1}`).join(", ")}, $${DA_FIELDS.length + 1}) RETURNING id`,
        [...DA_FIELDS.map(([k]) => b[k]), me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "daily_traffic_alert",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: b.name } }],
        note: `Added daily traffic alert ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadDaily(pool, id), change });
  });
}

export function updateDailyTrafficAlert(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = { ...(request.body as DailyTrafficAlertInput) };
  b.name = b.name.trim();
  return withDb(reply, async (pool) => {
    const before = await loadDaily(pool, id);
    if (!before) return notFound(reply, "Daily traffic alert", id);
    const errors = await checkDaily(pool, b, id);
    if (errors.length) return badInput(reply, errors);
    const diff: DiffEntry[] = DA_FIELDS.filter(([k]) => !same(before[k], b[k])).map(([k]) => ({
      entity_id: id,
      field: k,
      before: before[k] ?? null,
      after: b[k] ?? null,
    }));
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        `UPDATE daily_traffic_alerts SET ${DA_FIELDS.map(([, col], i) => `${col} = $${i + 2}`).join(", ")},
                updated_by_id = $${DA_FIELDS.length + 2}, updated_at = now() WHERE id = $1`,
        [id, ...DA_FIELDS.map(([k]) => b[k]), me.id],
      );
      return recordChange(c, {
        entityType: "daily_traffic_alert",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed daily traffic alert ${b.name}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadDaily(pool, id), change };
  });
}

const daArchiver = archiver("daily_traffic_alerts", "daily_traffic_alert", "Daily traffic alert", loadDaily);
export const archiveDailyTrafficAlert = daArchiver.archive;
export const restoreDailyTrafficAlert = daArchiver.restore;

/** Yesterday (the last full UTC day of traffic) for an enterprise, per trunk, as a text table. */
async function dailySummary(pool: pg.Pool, enterpriseId: number) {
  const now = await reportNow();
  const w = resolvePeriod("yesterday", "UTC", now);
  const factor = await sysToPlatformFactor();
  const t = (d: Date) => `toDateTime64(${lit(iso(d).replace("T", " ").replace("Z", ""))}, 3, 'UTC')`;
  const rows = await chQuery<Record<string, string>>(
    `SELECT if(c_enterprise_id = ${enterpriseId}, 'customer', 'vendor') AS side, if(c_enterprise_id = ${enterpriseId}, c_trunk_id, v_trunk_id) AS trunk,
            count() AS a, countIf(msg_status = 'DELIVRD') AS d, countIf(is_submit_success = 1) AS s,
            toFloat64(sumIf(revenue_sys * ${factor}, c_enterprise_id = ${enterpriseId})) AS r,
            toFloat64(sumIf(cost_sys * ${factor}, v_enterprise_id = ${enterpriseId})) AS c
       FROM edr WHERE start_time >= ${t(w.from)} AND start_time < ${t(w.to)}
        AND (c_enterprise_id = ${enterpriseId} OR v_enterprise_id = ${enterpriseId}) GROUP BY side, trunk ORDER BY side, a DESC`,
  );
  const ids = (side: string) => rows.filter((r) => r.side === side).map((r) => Number(r.trunk));
  const [ct, vt] = await Promise.all([
    pool.query("SELECT id, name FROM customer_trunks WHERE id = ANY($1)", [ids("customer")]),
    pool.query("SELECT id, name FROM vendor_trunks WHERE id = ANY($1)", [ids("vendor")]),
  ]);
  const name = new Map<string, string>([
    ...ct.rows.map((r): [string, string] => [`customer${r.id}`, r.name]),
    ...vt.rows.map((r): [string, string] => [`vendor${r.id}`, r.name]),
  ]);
  const head = ["Trunk", "Messages", "Delivered", "DLR %", `Amount (${PLATFORM_CURRENCY})`];
  const body = rows.map((r) => [
    `${name.get(`${r.side}${r.trunk}`) ?? `#${r.trunk}`} (${r.side})`,
    Number(r.a).toLocaleString("en-US"),
    Number(r.d).toLocaleString("en-US"),
    Number(r.s) ? ((Number(r.d) / Number(r.s)) * 100).toFixed(1) : "—",
    (r.side === "customer" ? Number(r.r) : Number(r.c)).toFixed(2),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ");
  const table = body.length ? [line(head), ...body.map(line)].join("\n") : "No traffic on this day.";
  return { day: iso(w.from).slice(0, 10), table };
}

export async function sendDaily(pool: pg.Pool, id: number, userId: number | null) {
  const a = await loadDaily(pool, id);
  if (!a) return null;
  const { day, table } = await dailySummary(pool, a.enterpriseId);
  const { rows: bc } = await pool.query(
    `SELECT bc.name, bc.website FROM enterprises e JOIN business_companies bc ON bc.id = coalesce($2, e.business_company_id) WHERE e.id = $1`,
    [a.enterpriseId, a.businessCompanyId],
  );
  const host = String(bc[0]?.website ?? "").replace(/^https?:\/\/(www\.)?/, "");
  const recipients = await contactEmails(pool, a.enterpriseId, [a.contactType]);
  const vars = { enterprise: a.enterprise, date: day, summary: table, company: bc[0]?.name ?? "" };
  const mail = {
    recipients,
    subject: `Daily traffic summary ${day} – ${a.enterprise}`,
    body: fill(a.emailBody.replace(/<[^>]+>/g, ""), vars),
  };
  await logEmail(pool, {
    type: "daily_report",
    enterpriseId: a.enterpriseId,
    to: recipients,
    sender: host ? `noc@${host}` : null,
    subject: mail.subject,
    body: mail.body,
    userId,
  });
  await pool.query("UPDATE daily_traffic_alerts SET last_sent_at = now() WHERE id = $1", [id]);
  return mail;
}

export function sendDailyTrafficAlert(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => {
    try {
      const me = await getCurrentUser();
      return (await sendDaily(pool, id, me.id)) ?? notFound(reply, "Daily traffic alert", id);
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}

// ---------------------------------------------------------------- jobs

/** Every minute: due scheduled reports run, and daily alerts go out in their send hour (once a day). */
export function startReportJobs() {
  const tick = async () => {
    const pool = db();
    const { rows: due } = await pool.query(
      "SELECT id FROM scheduled_reports WHERE deleted_at IS NULL AND status = 'active' AND next_run_at <= now() ORDER BY next_run_at LIMIT 5",
    );
    for (const r of due) await runScheduled(pool, Number(r.id), null).catch(() => undefined);
    const { rows: daily } = await pool.query(
      `SELECT id FROM daily_traffic_alerts WHERE deleted_at IS NULL AND status = 'active'
          AND send_hour = extract(hour FROM now() AT TIME ZONE 'UTC')
          AND (last_sent_at IS NULL OR last_sent_at < date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') LIMIT 20`,
    );
    for (const r of daily) await sendDaily(pool, Number(r.id), null).catch(() => undefined);
  };
  setInterval(() => void tick().catch(() => undefined), 60_000).unref();
}
