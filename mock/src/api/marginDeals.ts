// Margin calculator (team trial round 3): saved swap deals, the SMS version of the team's sheet. A deal has two legs:
// outbound (we send to the carrier; it is our vendor) and inbound (the carrier sends to us; it is our customer). The
// totals are worked out here on save, to 6 decimals, the same way the page shows them.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { MarginDeal, MarginDealInput, MarginDealLine, MarginDealRow, MarginDealTotals } from "@sms/contract";
import { withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import { iso } from "./records.js";
import { getCurrentUser } from "./session.js";
import { searchPattern } from "../lists/engine.js";
import { badInput } from "./switchTools.js";

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** One leg's messages, cost, revenue and margin over the period. */
function legTotals(lines: MarginDealLine[]) {
  let messages = 0;
  let cost = 0;
  let revenue = 0;
  for (const l of lines) {
    messages += l.messages;
    cost += l.messages * l.cost;
    revenue += l.messages * l.rate;
  }
  return { messages, cost: r6(cost), revenue: r6(revenue), margin: r6(revenue - cost) };
}

/** Total margin of both legs; netting = what we owe the carrier (outbound cost) less what it owes us. */
export function dealTotals(d: Pick<MarginDealInput, "outbound" | "inbound">): MarginDealTotals {
  const outbound = legTotals(d.outbound);
  const inbound = legTotals(d.inbound);
  return {
    outbound,
    inbound,
    totalMargin: r6(outbound.margin + inbound.margin),
    netting: r6(outbound.cost - inbound.revenue),
  };
}

const SELECT = `SELECT d.*, cb.username AS created_by, ub.username AS updated_by FROM margin_deals d
  JOIN users cb ON cb.id = d.created_by_id JOIN users ub ON ub.id = d.updated_by_id`;

function toDeal(r: Record<string, unknown>): MarginDeal {
  const outbound = r.outbound as MarginDealLine[];
  const inbound = r.inbound as MarginDealLine[];
  return {
    id: Number(r.id),
    name: String(r.name),
    carrierEnterpriseId: r.carrier_enterprise_id === null ? null : Number(r.carrier_enterprise_id),
    carrierName: String(r.carrier_name),
    currency: String(r.currency).trim(),
    periodDays: Number(r.period_days),
    notes: (r.notes as string | null) ?? null,
    outbound,
    inbound,
    totals: dealTotals({ outbound, inbound }),
    createdBy: String(r.created_by),
    updatedAt: iso(r.updated_at)!,
    updatedBy: String(r.updated_by),
  };
}

function check(b: MarginDealInput) {
  const errors: { path: string; message: string }[] = [];
  if (!b.name.trim()) errors.push({ path: "/name", message: "required" });
  if (!b.carrierName.trim()) errors.push({ path: "/carrierName", message: "required" });
  for (const leg of ["outbound", "inbound"] as const)
    b[leg].forEach((l, i) => {
      if (!l.destination.trim()) errors.push({ path: `/${leg}/${i}/destination`, message: "required" });
    });
  return errors;
}

export function listMarginDeals(request: FastifyRequest, reply: FastifyReply) {
  const q = request.query as { search?: string; limit?: number };
  return withDb(reply, async (pool): Promise<MarginDealRow[]> => {
    const search = q.search?.trim();
    const { rows } = await pool.query(
      `SELECT d.id, d.name, d.carrier_name, d.currency, d.period_days, d.total_margin, d.netting, d.updated_at,
              ub.username AS updated_by
         FROM margin_deals d JOIN users ub ON ub.id = d.updated_by_id
        ${search ? "WHERE d.name ILIKE $2 OR d.carrier_name ILIKE $2" : ""}
        ORDER BY d.updated_at DESC, d.id DESC LIMIT $1`,
      search ? [q.limit ?? 50, searchPattern(search, true)] : [q.limit ?? 50],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      carrierName: r.carrier_name,
      currency: String(r.currency).trim(),
      periodDays: Number(r.period_days),
      totalMargin: Number(r.total_margin),
      netting: Number(r.netting),
      updatedAt: iso(r.updated_at)!,
      updatedBy: r.updated_by,
    }));
  });
}

export function getMarginDeal(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rows } = await pool.query(`${SELECT} WHERE d.id = $1`, [id]);
    if (!rows[0]) return sendProblem(reply, 404, `Deal ${id} not found`);
    return toDeal(rows[0]);
  });
}

function values(b: MarginDealInput) {
  const t = dealTotals(b);
  return [
    b.name.trim(),
    b.carrierEnterpriseId ?? null,
    b.carrierName.trim(),
    b.currency,
    b.periodDays,
    b.notes ?? null,
    JSON.stringify(b.outbound),
    JSON.stringify(b.inbound),
    t.totalMargin,
    t.netting,
  ];
}

export function createMarginDeal(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as MarginDealInput;
  const errors = check(b);
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `INSERT INTO margin_deals (name, carrier_enterprise_id, carrier_name, currency, period_days, notes, outbound,
              inbound, total_margin, netting, created_by_id, updated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
      [...values(b), me.id],
    );
    const { rows: saved } = await pool.query(`${SELECT} WHERE d.id = $1`, [rows[0].id]);
    return reply.code(201).send(toDeal(saved[0]));
  });
}

export function updateMarginDeal(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const b = request.body as MarginDealInput;
  const errors = check(b);
  if (errors.length) return badInput(reply, errors);
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const { rowCount } = await pool.query(
      `UPDATE margin_deals SET name = $1, carrier_enterprise_id = $2, carrier_name = $3, currency = $4, period_days = $5,
              notes = $6, outbound = $7, inbound = $8, total_margin = $9, netting = $10, updated_by_id = $11,
              updated_at = now() WHERE id = $12`,
      [...values(b), me.id, id],
    );
    if (!rowCount) return sendProblem(reply, 404, `Deal ${id} not found`);
    const { rows } = await pool.query(`${SELECT} WHERE d.id = $1`, [id]);
    return toDeal(rows[0]);
  });
}

export function deleteMarginDeal(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rowCount } = await pool.query("DELETE FROM margin_deals WHERE id = $1", [id]);
    if (!rowCount) return sendProblem(reply, 404, `Deal ${id} not found`);
    return reply.code(204).send();
  });
}
