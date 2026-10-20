// Readable change log of a rate table (team trial round 2): each saved change of the table with its rates in
// plain words (destination, old → new rate, what changed and from when) instead of field snapshots.
// Built from the same change records as History and undo (§13.10).
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateChangeLogEntry, RateChangeLogItem, RateChangeLogPage } from "@sms/contract";
import { withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import { iso, type DiffEntry } from "./records.js";

interface Snap {
  tableId: number;
  mccmnc: string;
  senderId: string | null;
  rate: number;
  from: string;
  to: string | null;
  blocked: boolean;
  note?: string | null;
}

type Item = Omit<RateChangeLogItem, "country" | "network">;
const MAX_ITEMS = 200;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The rates of one change for one table, paired per destination and sender ID. */
export function readableItems(diff: DiffEntry[], tableId: number): Item[] {
  const groups = new Map<string, { a: Snap | null; b: Snap | null }[]>();
  for (const d of diff) {
    if (d.field !== "line") continue;
    const a = d.after as Snap | null;
    const b = d.before as Snap | null;
    const s = a ?? b;
    if (!s || Number(s.tableId) !== tableId) continue;
    const key = `${s.mccmnc}|${s.senderId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), { a, b }]);
  }
  const out: Item[] = [];
  for (const entries of groups.values()) {
    const s = (entries[0]!.a ?? entries[0]!.b)!;
    const base = { mccmnc: s.mccmnc, senderId: s.senderId ?? null };
    // A new version, or an old one reopened by an undo (it runs on from where it would have ended).
    const start =
      entries.find((e) => e.a && !e.b) ?? entries.find((e) => e.a && e.b && e.a.to === null && e.b.to !== null);
    const end = entries.find((e) => e.a && e.b && e.b.to === null && e.a.to !== null);
    const removed = entries.find((e) => !e.a && e.b);
    if (start) {
      const isReopen = !!start.b;
      const old = end?.b ?? removed?.b ?? null;
      const oldRate = old ? Number(old.rate) : null;
      const newRate = Number(start.a!.rate);
      const kind: Item["kind"] =
        oldRate === null ? "new" : newRate > oldRate ? "increase" : newRate < oldRate ? "decrease" : "same";
      out.push({
        ...base,
        kind,
        oldRate,
        newRate,
        changePct: oldRate ? r6(((newRate - oldRate) / oldRate) * 100) : null,
        effectiveFrom: isReopen ? start.b!.to : start.a!.from,
        until: start.a!.to,
      });
    } else if (end)
      out.push({
        ...base,
        kind: "closed",
        oldRate: Number(end.b!.rate),
        newRate: null,
        changePct: null,
        effectiveFrom: end.a!.to,
        until: null,
      });
    else if (removed)
      out.push({
        ...base,
        kind: "withdrawn",
        oldRate: Number(removed.b!.rate),
        newRate: null,
        changePct: null,
        effectiveFrom: removed.b!.from,
        until: removed.b!.to,
      });
    for (const e of entries) {
      if (!e.a || !e.b) continue;
      if (e.a.blocked !== e.b.blocked)
        out.push({
          ...base,
          kind: e.a.blocked ? "blocked" : "unblocked",
          oldRate: Number(e.a.rate),
          newRate: Number(e.a.rate),
          changePct: null,
          effectiveFrom: null,
          until: null,
        });
      else if ((e.a.note ?? null) !== (e.b.note ?? null) && e.a.to === e.b.to && !start && !end)
        out.push({
          ...base,
          kind: "note",
          oldRate: Number(e.a.rate),
          newRate: Number(e.a.rate),
          changePct: null,
          effectiveFrom: null,
          until: null,
        });
    }
  }
  return out.sort((x, y) => x.mccmnc.localeCompare(y.mccmnc) || (x.senderId ?? "").localeCompare(y.senderId ?? ""));
}

export function getRateChangeLog(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const q = request.query as { cursor?: string; limit?: number };
  const limit = q.limit ?? 25;
  const before = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : null;
  return withDb(reply, async (pool) => {
    const { rows: t } = await pool.query("SELECT currency FROM rate_tables WHERE id = $1", [id]);
    if (!t[0]) return sendProblem(reply, 404, `Rate table ${id} not found`);
    const { rows } = await pool.query(
      `SELECT c.id, c.change_type, c.note, c.undo_of_id, c.inserted_at, c.diff, u.username
         FROM changes c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.entity_type = 'rate_table' AND $1 = ANY(c.entity_ids) AND ($2::bigint IS NULL OR c.id < $2)
        ORDER BY c.id DESC LIMIT $3`,
      [id, before, limit + 1],
    );
    const page = rows.slice(0, limit).map((r) => ({ r, items: readableItems((r.diff ?? []) as DiffEntry[], id) }));
    const codes = [...new Set(page.flatMap((p) => p.items.slice(0, MAX_ITEMS).map((i) => i.mccmnc)))];
    const { rows: names } = codes.length
      ? await pool.query(
          `SELECT m.mccmnc, c.name AS country, m.network FROM mccmnc m LEFT JOIN countries c ON c.id = m.country_id
            WHERE m.mccmnc = ANY($1) AND m.deleted_at IS NULL`,
          [codes],
        )
      : { rows: [] };
    const byCode = new Map(names.map((n) => [String(n.mccmnc), n]));
    const out: RateChangeLogEntry[] = page.map(({ r, items }) => {
      const counts: Record<string, number> = {};
      for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
      return {
        changeId: Number(r.id),
        at: iso(r.inserted_at)!,
        user: r.username ?? null,
        changeType: r.change_type,
        note: r.note ?? null,
        undoOfId: r.undo_of_id === null ? null : Number(r.undo_of_id),
        currency: String(t[0].currency).trim(),
        counts,
        items: items.slice(0, MAX_ITEMS).map((i) => ({
          ...i,
          country: byCode.get(i.mccmnc)?.country ?? null,
          network: byCode.get(i.mccmnc)?.network ?? null,
        })),
        itemCount: items.length,
      };
    });
    const result: RateChangeLogPage = {
      rows: out,
      nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null,
    };
    return result;
  });
}
