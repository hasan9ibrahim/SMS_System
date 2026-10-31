// Observation Deck (§9): EDR Search and Failed EDR Search on the EDR store, EDR templates (saved column
// sets), Trouble Ticket e-mails and EDR Repush. Template saves are undoable (§13.10); delete archives
// (§13.29). Downloads, network status, captures, the route simulator and diagnosis live in their own
// modules (edrDownloads.ts, network.ts, routeSimulator.ts).
import { fillBody, fillText } from "../email/html.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  EdrRow,
  EdrTemplateInput,
  ListFields,
  ListQuery,
  RepushInput,
  TroubleTicketInput,
  TroubleTicketPreviewInput,
} from "@sms/contract";
import { withDb } from "../db.js";
import { chQuery, ChError, ChTimeout, ChUnavailable } from "../edr.js";
import { chSelect, lit, nameMaps, runChList, withOutcomes, type ChListDef } from "../lists/chEngine.js";
import {
  EDR_TEMPLATE_FROM,
  EDR_TEMPLATE_SELECT,
  mapEdrTemplate,
  mapRepush,
  REPUSH_FROM,
  REPUSH_SELECT,
} from "../lists/defs.js";
import { edrList, failedEdrList } from "../lists/edrDefs.js";
import { listFields } from "../lists/fields.js";
import { checkListQuery } from "../lists/validate.js";
import { sendProblem } from "../problem.js";
import { companyMailbox, logEmail } from "./emailLog.js";
import { csvCell, notFound } from "./masterData.js";
import { recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { archiver, badInput, contactEmails } from "./switchTools.js";
import { inTransaction } from "./views.js";
import { production } from "../mode.js";
import { switchProblem } from "../switch/commands.js";
import { switchRepush } from "../switch/operations.js";
import { PastDetailError } from "../reports/source.js";

type Db = pg.Pool | pg.PoolClient;
type Params = { id: number };

/** EDR store errors: unreachable or too slow = 503; a query ClickHouse rejects (e.g. a bad regex) = 400. */
export function chProblem(reply: FastifyReply, err: unknown) {
  if (err instanceof ChTimeout)
    return sendProblem(reply, 503, "The EDR store did not finish in time; choose a shorter period or narrower filters");
  if (err instanceof ChUnavailable) return sendProblem(reply, 503, "The EDR store is not answering; try again shortly");
  // Detail asked for a period older than the detailed EDRs (docs/BACKEND_PLAN.md §3.7).
  if (err instanceof PastDetailError)
    return sendProblem(reply, 400, err.message, { errors: [{ path: "/query", message: err.message }] });
  if (err instanceof ChError)
    return sendProblem(reply, 400, "The EDR store rejected the query", {
      errors: [{ path: "/filter", message: err.message.split("\n")[0]!.slice(0, 300) }],
    });
  throw err;
}

/**
 * A Start Time period at the filter's top level (QA 2026-10-31, §9.1, §9.2): `between`, or a lower and an upper bound.
 * Without one a list read every EDR kept (a year) and sorted them.
 */
export function hasPeriod(query: ListQuery): boolean {
  const f = query.filter;
  if (!f || (f.logic === "or" && f.conditions.length > 1)) return false;
  const ops = f.conditions.flatMap((c) => ("field" in c && c.field === "startTime" ? [c.op] : []));
  return ops.includes("between") || (ops.some((o) => o === "gt" || o === "gte") && ops.some((o) => o === "lt" || o === "lte"));
}

function queryCh<Row>(fields: ListFields, def: ChListDef<Row>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.body as ListQuery;
    const errors = checkListQuery(query, fields);
    if (errors.length) return sendProblem(reply, 400, "Invalid list query", { errors });
    if (!hasPeriod(query)) {
      const message = "Choose a period: a Start Time from and to";
      return sendProblem(reply, 400, message, { errors: [{ path: "/filter", message }] });
    }
    try {
      return await withDb(reply, (pool) => runChList(pool, def, query));
    } catch (err) {
      return chProblem(reply, err);
    }
  };
}
export const queryEdrs = queryCh(listFields.edrs, edrList);
export const queryFailedEdrs = queryCh(listFields.failed_edrs, failedEdrList);

/** Selected EDRs by UUID with the given columns (plus the IDs a ticket or repush needs). */
export async function edrsByIds(pool: pg.Pool, ids: string[], columns: string[]): Promise<EdrRow[]> {
  const def = edrList as ChListDef<unknown>;
  const want = [
    ...new Set([...columns, "id", "customerEnterpriseId", "customerTrunkId", "vendorTrunkId", "startTime"]),
  ];
  const [rows, names] = await Promise.all([
    chQuery<Record<string, unknown>>(
      `SELECT ${chSelect(def, want)} FROM edr WHERE edr_id IN (${ids.map((id) => lit(id)).join(",")})
        ORDER BY start_time`,
    ),
    nameMaps(pool, def),
  ]);
  if (rows.length) {
    const times = rows.map((r) => String(r.startTime)).sort();
    await withOutcomes(def, rows, times[0]!, times[times.length - 1]!, want);
  }
  return rows.map((r) => edrList.mapRow({ ...r }, names));
}

const fieldLabel = new Map(listFields.edrs.fields.map((f) => [f.field, f.label]));
const unknownColumns = (columns: string[], path = "/columns"): FieldError[] =>
  columns.filter((c) => !fieldLabel.has(c)).map((c) => ({ path, message: `unknown EDR column "${c}"` }));

// ---------------------------------------------------------------- templates

const loadTemplate = async (c: Db, id: number) => {
  const { rows } = await c.query(`SELECT ${EDR_TEMPLATE_SELECT} FROM ${EDR_TEMPLATE_FROM} WHERE t.id = $1`, [id]);
  return rows[0] ? mapEdrTemplate(rows[0]) : null;
};
export const getEdrTemplate = (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as Params;
  return withDb(reply, async (pool) => (await loadTemplate(pool, id)) ?? notFound(reply, "EDR template", id));
};

async function checkTemplate(c: Db, b: EdrTemplateInput, id: number | null): Promise<FieldError[]> {
  const errors = unknownColumns(b.columns);
  if (new Set(b.columns).size !== b.columns.length)
    errors.push({ path: "/columns", message: "a column is listed twice" });
  const { rows } = await c.query(
    "SELECT id FROM edr_templates WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> coalesce($2, 0)",
    [b.name.trim(), id],
  );
  if (rows[0]) errors.push({ path: "/name", message: "another template has this name" });
  return errors;
}

export function createEdrTemplate(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as EdrTemplateInput;
  return withDb(reply, async (pool) => {
    const errors = await checkTemplate(pool, b, null);
    if (errors.length) return badInput(reply, errors);
    const me = await getCurrentUser();
    const { id, change } = await inTransaction(pool, async (c) => {
      const { rows } = await c.query(
        "INSERT INTO edr_templates (name, columns, updated_by_id) VALUES ($1, $2, $3) RETURNING id",
        [b.name.trim(), b.columns, me.id],
      );
      const id = Number(rows[0].id);
      const change = await recordChange(c, {
        entityType: "edr_template",
        entityIds: [id],
        changeType: "create",
        diff: [{ entity_id: id, field: "*", before: null, after: { name: b.name.trim() } }],
        note: `Added EDR template ${b.name.trim()}`,
        userId: me.id,
        ip: request.ip,
      });
      return { id, change };
    });
    return reply.code(201).send({ record: await loadTemplate(pool, id), change });
  });
}

export function updateEdrTemplate(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as Params;
  const b = request.body as EdrTemplateInput;
  return withDb(reply, async (pool) => {
    const before = await loadTemplate(pool, id);
    if (!before) return notFound(reply, "EDR template", id);
    const errors = await checkTemplate(pool, b, id);
    if (errors.length) return badInput(reply, errors);
    const diff: DiffEntry[] = [];
    if (before.name !== b.name.trim())
      diff.push({ entity_id: id, field: "name", before: before.name, after: b.name.trim() });
    if (before.columns.join("|") !== b.columns.join("|"))
      diff.push({ entity_id: id, field: "columns", before: before.columns, after: b.columns });
    if (!diff.length) return { record: before, change: null };
    const me = await getCurrentUser();
    const change = await inTransaction(pool, async (c) => {
      await c.query(
        "UPDATE edr_templates SET name = $2, columns = $3, updated_by_id = $4, updated_at = now() WHERE id = $1",
        [id, b.name.trim(), b.columns, me.id],
      );
      return recordChange(c, {
        entityType: "edr_template",
        entityIds: [id],
        changeType: "edit",
        diff,
        note: `Changed EDR template ${b.name.trim()}`,
        userId: me.id,
        ip: request.ip,
      });
    });
    return { record: await loadTemplate(pool, id), change };
  });
}

const templateArchiver = archiver("edr_templates", "edr_template", "EDR template", loadTemplate);
export const archiveEdrTemplate = templateArchiver.archive;
export const restoreEdrTemplate = templateArchiver.restore;

// ---------------------------------------------------------------- trouble ticket

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Times as "2026-10-16 21:29:59" (UTC), booleans as Yes / No. */
const cellText = (v: unknown) =>
  v === null || v === undefined
    ? ""
    : Array.isArray(v)
      ? v.join(" ")
      : typeof v === "boolean"
        ? v
          ? "Yes"
          : "No"
        : typeof v === "string" && ISO.test(v)
          ? v.slice(0, 19).replace("T", " ")
          : String(v);

/** The EDRs as an aligned plain-text table for the e-mail body. */
export function edrTable(rows: EdrRow[], columns: string[]): string {
  const head = columns.map((c) => fieldLabel.get(c) ?? c);
  const body = rows.map((r) => columns.map((c) => cellText((r as unknown as Record<string, unknown>)[c])));
  const widths = head.map((h, i) => Math.min(40, Math.max(h.length, ...body.map((b) => b[i]!.length))));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.slice(0, 40).padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

export const edrCsv = (rows: EdrRow[], columns: string[]) =>
  [
    columns.map((c) => csvCell(fieldLabel.get(c) ?? c)).join(","),
    ...rows.map((r) => columns.map((c) => csvCell(cellText((r as unknown as Record<string, unknown>)[c]))).join(",")),
  ].join("\r\n") + "\r\n";

interface Ticket {
  enterpriseId: number;
  enterprise: string;
  trunkName: string;
  customerTrunkId: number | null;
  vendorTrunkId: number | null;
  recipients: string[];
  sender: string | null;
  subject: string;
  body: string;
  rows: EdrRow[];
}

async function buildTicket(pool: pg.Pool, b: TroubleTicketPreviewInput): Promise<Ticket | FieldError[]> {
  const errors = unknownColumns(b.columns);
  if (b.sendTo === "vendor" && !b.vendorTrunkId)
    errors.push({ path: "/vendorTrunkId", message: "choose the vendor trunk" });
  const { rows: tpl } = await pool.query(
    "SELECT subject, body FROM email_templates WHERE id = $1 AND email_type = 'trouble_ticket' AND deleted_at IS NULL",
    [b.templateId],
  );
  if (!tpl[0]) errors.push({ path: "/templateId", message: "choose a trouble ticket template" });
  if (errors.length) return errors;
  const rows = await edrsByIds(pool, b.edrIds, b.columns);
  if (!rows.length) return [{ path: "/edrIds", message: "none of the selected EDRs were found" }];
  let enterpriseId: number;
  let trunkName: string;
  let customerTrunkId: number | null = null;
  let vendorTrunkId: number | null = null;
  if (b.sendTo === "vendor") {
    const { rows: vt } = await pool.query(
      "SELECT t.id, t.name, t.enterprise_id FROM vendor_trunks t WHERE t.id = $1 AND t.deleted_at IS NULL",
      [b.vendorTrunkId],
    );
    if (!vt[0]) return [{ path: "/vendorTrunkId", message: "unknown vendor trunk" }];
    enterpriseId = Number(vt[0].enterprise_id);
    trunkName = vt[0].name;
    vendorTrunkId = Number(vt[0].id);
  } else {
    const customers = [...new Set(rows.map((r) => r.customerEnterpriseId))];
    if (customers.length > 1)
      return [
        { path: "/edrIds", message: `the EDRs belong to ${customers.length} customers; select one customer's EDRs` },
      ];
    enterpriseId = customers[0]!;
    const trunks = [...new Set(rows.map((r) => r.customerTrunk ?? ""))];
    trunkName = trunks.length === 1 ? trunks[0]! : `${trunks.length} trunks`;
    customerTrunkId = trunks.length === 1 ? rows[0]!.customerTrunkId : null;
  }
  const { rows: ent } = await pool.query(
    "SELECT e.name, bc.name AS company FROM enterprises e JOIN business_companies bc ON bc.id = e.business_company_id WHERE e.id = $1",
    [enterpriseId],
  );
  const vars = {
    enterprise: ent[0]?.name ?? "",
    trunk: trunkName,
    rows: String(rows.length),
    company: ent[0]?.company ?? "",
    edrs: edrTable(rows, b.columns),
  };
  return {
    enterpriseId,
    enterprise: vars.enterprise,
    trunkName,
    customerTrunkId,
    vendorTrunkId,
    recipients: await contactEmails(pool, enterpriseId, ["technical", "commercial"]).then((all) => all.slice(0, 4)),
    sender: await companyMailbox(pool, enterpriseId, "troubleTicket"),
    subject: b.subject.trim() || fillText(tpl[0].subject, vars),
    body: fillBody(tpl[0].body, vars),
    rows,
  };
}

export function previewTroubleTicket(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as TroubleTicketPreviewInput;
  return withDb(reply, async (pool) => {
    try {
      const t = await buildTicket(pool, b);
      if (Array.isArray(t)) return badInput(reply, t);
      return { recipients: t.recipients, subject: t.subject, body: t.body };
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}

export function sendTroubleTicket(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as TroubleTicketInput;
  return withDb(reply, async (pool) => {
    if (b.attachment && Buffer.from(b.attachment.contentBase64, "base64").length > 5 * 1024 * 1024)
      return badInput(reply, [{ path: "/attachment", message: "the attachment is larger than 5 MB" }]);
    try {
      const t = await buildTicket(pool, b);
      if (Array.isArray(t)) return badInput(reply, t);
      const me = await getCurrentUser();
      // The EDRs also go as a CSV attachment (edrCsv), with the user's own file.
      const csvName = `trouble_ticket_${t.trunkName.replace(/[^\w-]+/g, "_")}.csv`;
      await logEmail(pool, {
        type: "trouble_ticket",
        enterpriseId: t.enterpriseId,
        customerTrunkId: t.customerTrunkId,
        vendorTrunkId: t.vendorTrunkId,
        to: t.recipients,
        sender: t.sender,
        subject: t.subject,
        body: t.body,
        file: [csvName, b.attachment?.name].filter(Boolean).join(", "),
        attachments: [
          { fileName: csvName, contentType: "text/csv", content: edrCsv(t.rows, b.columns) },
          ...(b.attachment
            ? [{ fileName: b.attachment.name, content: Buffer.from(b.attachment.contentBase64, "base64") }]
            : []),
        ],
        userId: me.id,
      });
      const { rows: last } = await pool.query(
        "SELECT id FROM email_logs WHERE email_type = 'trouble_ticket' AND user_id = $1 ORDER BY id DESC LIMIT 1",
        [me.id],
      );
      return {
        emailLogId: Number(last[0].id),
        enterprise: t.enterprise,
        recipients: t.recipients,
        rows: t.rows.length,
      };
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}

// ---------------------------------------------------------------- repush

let edrColumnNames: string[] | null = null;
async function edrColumnList(): Promise<string[]> {
  edrColumnNames ??= (
    await chQuery<{ name: string }>(
      "SELECT name FROM system.columns WHERE database = currentDatabase() AND table = 'edr' ORDER BY position",
    )
  ).map((r) => r.name);
  return edrColumnNames;
}

/**
 * Re-sends undelivered final attempts on another vendor trunk: each becomes a new attempt (attempt
 * number + 1, the new vendor, the request ID) and the old one stops being the final attempt. The
 * mock decides the outcome (about 80 % delivered), dates the new attempt two minutes after the old
 * one, and copies cost and rate from it.
 */
export function repushEdrs(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as RepushInput;
  return withDb(reply, async (pool) => {
    const { rows: vt } = await pool.query(
      "SELECT id, name, enterprise_id, port FROM vendor_trunks WHERE id = $1 AND deleted_at IS NULL AND status = 'active'",
      [b.vendorTrunkId],
    );
    if (!vt[0]) return badInput(reply, [{ path: "/vendorTrunkId", message: "choose an active vendor trunk" }]);
    try {
      const ids = [...new Set(b.edrIds)];
      const inList = ids.map((id) => lit(id)).join(",");
      const eligible = await chQuery<{ id: string }>(
        // Delivered per the attempt row or the switch's outcome row (backend step 11b).
        `SELECT toString(edr_id) AS id FROM edr WHERE edr_id IN (${inList}) AND is_final_attempt = 1 AND msg_status != 'DELIVRD'
           AND edr_id NOT IN (SELECT edr_id FROM edr_receipt WHERE kind = 'outcome' AND edr_id IN (${inList}) AND msg_status = 'DELIVRD')`,
      );
      const me = await getCurrentUser();
      // Production (backend step 11c): a switch server sends each message again as a new attempt with the request id;
      // the outcome is counted from its EDRs (jobs/switchJobs.ts).
      if (production) {
        try {
          const id = await switchRepush(pool, b.vendorTrunkId, eligible.map((r) => r.id), ids.length - eligible.length, me.id);
          const { rows: out } = await pool.query(`SELECT ${REPUSH_SELECT} FROM ${REPUSH_FROM} WHERE r.id = $1`, [id]);
          return reply.code(201).send(mapRepush(out[0]));
        } catch (err) {
          return switchProblem(reply, err);
        }
      }
      const { rows } = await pool.query(
        `INSERT INTO repush_requests (vendor_trunk_id, edr_count, skipped, created_by_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [b.vendorTrunkId, eligible.length, ids.length - eligible.length, me.id],
      );
      const requestId = Number(rows[0].id);
      let delivered = 0;
      if (eligible.length) {
        const cols = await edrColumnList();
        const override: Record<string, string> = {
          edr_id: "generateUUIDv4()",
          // Two minutes after the old attempt, so the generated EDR period (which the reports and
          // traffic alerts read up to its last EDR) stays as it is; the switch uses the send time.
          start_time: "src.start_time + toIntervalSecond(120)",
          submit_time: "src.start_time + toIntervalMillisecond(120020)",
          submit_resp_time: "src.start_time + toIntervalMillisecond(120180)",
          delivery_time: "if(rand() % 100 < 80, src.start_time + toIntervalMillisecond(122500 + rand() % 6000), NULL)",
          v_enterprise_id: String(Number(vt[0].enterprise_id)),
          v_trunk_id: String(Number(vt[0].id)),
          v_port: String(Number(vt[0].port)),
          v_message_id: "lower(hex(rand64()))",
          repush_request_id: String(requestId),
          attempt_no: "src.attempt_no + 1",
          is_final_attempt: "1",
          is_submit_success: "1",
          command_status: "0",
          msg_status: "if(isNull(delivery_time), 'UNDELIV', 'DELIVRD')",
          c_msg_status: "if(isNull(delivery_time), 'UNDELIV', 'DELIVRD')",
          delivery_error: "if(isNull(delivery_time), '001', '000')",
          delivery_delay_ms:
            "if(isNull(delivery_time), 0, toUInt32(dateDiff('millisecond', submit_time, delivery_time)))",
        };
        // Aliases are visible in the whole SELECT (msg_status reads the new delivery_time), so the
        // source row's own values are read through `src.`.
        const select = cols.map((c) => (override[c] ? `${override[c]} AS ${c}` : `src.${c} AS ${c}`)).join(", ");
        await chQuery(
          `INSERT INTO edr (${cols.join(", ")}) SELECT ${select} FROM edr AS src
            WHERE src.edr_id IN (${eligible.map((r) => lit(r.id)).join(",")})`,
        );
        await chQuery(
          `ALTER TABLE edr UPDATE is_final_attempt = 0 WHERE edr_id IN (${eligible.map((r) => lit(r.id)).join(",")})`,
        );
        const counts = await chQuery<{ d: string }>(
          `SELECT countIf(msg_status = 'DELIVRD') AS d FROM edr WHERE repush_request_id = ${requestId}`,
        );
        delivered = Number(counts[0]?.d ?? 0);
      }
      await pool.query("UPDATE repush_requests SET status = 'done', delivered = $2, failed = $3 WHERE id = $1", [
        requestId,
        delivered,
        eligible.length - delivered,
      ]);
      const { rows: out } = await pool.query(`SELECT ${REPUSH_SELECT} FROM ${REPUSH_FROM} WHERE r.id = $1`, [
        requestId,
      ]);
      return reply.code(201).send(mapRepush(out[0]));
    } catch (err) {
      return chProblem(reply, err);
    }
  });
}
