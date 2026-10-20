// Bulk rating workspace (§13.11, rating part): one job over several rate tables (clients) and
// destinations. Preview works out every affected line (current and new rate, cost and margin,
// below-cost and notice-period flags, last 7 days' traffic impact); apply writes the reviewed
// rows to all their tables in one transaction, saved as ONE undoable change (§13.10).
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  RateBulkApply,
  RateBulkItem,
  RateBulkPreview,
  RateBulkRow,
  RateBulkScope,
  RateBulkSummary,
  RateLineEdit,
} from "@sms/contract";
import { PLATFORM_CURRENCY, sysToPlatformFactor } from "../currency.js";
import { withDb } from "../db.js";
import { chRows } from "../edr.js";
import { sendProblem } from "../problem.js";
import { scheduleBestBuyRefresh } from "./bestbuy.js";
import {
  isOverlap,
  OVERLAP,
  overlapProblem,
  applyLineEdits,
  checkLineEdits,
  noticePeriods,
  NoticeBreachError,
  sendNoticeBreach,
  type Breach,
  type EditTable,
} from "./rates.js";
import { recordChange, type DiffEntry, type FieldError } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";
import { sendRateNotices } from "./rateNotices.js";

const MAX_ROWS = 20_000;
/** Start times may be up to a minute in the past (clock skew); never earlier (§13.32). */
const SKEW_MS = 60_000;
const DAY_MS = 86_400_000;
const badInput = (reply: FastifyReply, errors: FieldError[]) =>
  sendProblem(reply, 400, "Check the highlighted fields", { errors });
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);

interface TableInfo extends EditTable {
  categoryId: number | null;
  clients: string;
  trunkIds: number[];
  archived: boolean;
}

/** The scope's tables with their clients, customer trunks and notice periods. */
async function loadTables(db: import("pg").Pool, ids: number[]): Promise<Map<number, TableInfo>> {
  const { rows } = await db.query(
    `SELECT rt.id, rt.name, rt.kind, rt.currency, rt.product_category_id,
            (rt.deleted_at IS NOT NULL OR vt.deleted_at IS NOT NULL) AS archived,
            COALESCE((SELECT string_agg(DISTINCT e.name, ', ') FROM customer_trunk_rate_tables x
                        JOIN customer_trunks t ON t.id = x.customer_trunk_id AND t.deleted_at IS NULL
                        JOIN enterprises e ON e.id = t.enterprise_id WHERE x.rate_table_id = rt.id),
                     ve.name, '') AS clients,
            COALESCE((SELECT array_agg(x.customer_trunk_id) FROM customer_trunk_rate_tables x
                       WHERE x.rate_table_id = rt.id), '{}') AS trunk_ids
       FROM rate_tables rt
       LEFT JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id
       LEFT JOIN enterprises ve ON ve.id = vt.enterprise_id
      WHERE rt.id = ANY($1)`,
    [ids],
  );
  const notices = await noticePeriods(db, ids);
  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        id: Number(r.id),
        name: r.name,
        kind: r.kind,
        currency: r.currency,
        categoryId: r.product_category_id === null ? null : Number(r.product_category_id),
        clients: r.clients,
        trunkIds: (r.trunk_ids as string[]).map(Number),
        archived: r.archived,
        notice: r.kind === "customer" ? (notices.get(Number(r.id)) ?? null) : null,
      },
    ]),
  );
}

/** Errors in the tables of a job: unknown or archived. */
function tableErrors(ids: number[], tables: Map<number, TableInfo>, path: (i: number) => string): FieldError[] {
  return ids.flatMap((id, i) => {
    const t = tables.get(id);
    if (!t) return [{ path: path(i), message: `rate table ${id} not found` }];
    if (t.archived) return [{ path: path(i), message: `${t.name} is archived; restore it before editing` }];
    return [];
  });
}

export function previewRateBulk(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as RateBulkScope;
  return withDb(reply, async (pool) => {
    const now = Date.now();
    const a = body.action;
    const onlyExisting = body.onlyExisting ?? true;
    const errors: FieldError[] = [];
    const needsValue = !["close", "block", "unblock", "none"].includes(a.type);
    if (needsValue && (a.value === null || a.value === undefined))
      errors.push({ path: "/action/value", message: "required for this action" });
    if (a.type === "set" && (a.value ?? 0) < 0) errors.push({ path: "/action/value", message: "can't be negative" });
    const costPlus = a.type === "cost_plus_pct" || a.type === "cost_plus_amount";
    if (costPlus && a.costSource === "vendor_trunk" && !a.vendorTrunkId)
      errors.push({ path: "/action/vendorTrunkId", message: "choose the vendor trunk whose cost to use" });
    const hasDest = (body.mccmncs?.length ?? 0) + (body.countryIsos?.length ?? 0) > 0;
    if (!onlyExisting && !hasDest)
      errors.push({ path: "/onlyExisting", message: "adding new rates needs a list of destinations" });
    if (!onlyExisting && a.type !== "set" && !costPlus)
      errors.push({ path: "/onlyExisting", message: "only a fixed rate or cost + margin can add new rates" });
    if (body.effectiveFrom && Date.parse(body.effectiveFrom) < now - SKEW_MS)
      errors.push({ path: "/effectiveFrom", message: "can't be in the past (traffic already sent keeps its rate)" });
    const tables = await loadTables(pool, body.rateTableIds);
    errors.push(...tableErrors(body.rateTableIds, tables, (i) => `/rateTableIds/${i}`));
    if (costPlus && [...tables.values()].some((t) => t.kind !== "customer"))
      errors.push({ path: "/action/type", message: "cost + margin prices customer (sell) tables only" });

    // Destinations by MCCMNC and by country.
    let destIds: number[] | null = null;
    if (hasDest) {
      const { rows } = await pool.query(
        `SELECT m.id, m.mccmnc FROM mccmnc m JOIN countries co ON co.id = m.country_id
          WHERE m.deleted_at IS NULL AND (m.mccmnc = ANY($1) OR co.iso = ANY($2))`,
        [body.mccmncs ?? [], body.countryIsos ?? []],
      );
      const known = new Set(rows.map((r) => r.mccmnc as string));
      (body.mccmncs ?? []).forEach((m, i) => {
        if (!known.has(m)) errors.push({ path: `/mccmncs/${i}`, message: `${m} is not in the MCCMNC master` });
      });
      destIds = rows.map((r) => Number(r.id));
      if (destIds.length === 0 && errors.length === 0)
        errors.push({ path: "/countryIsos", message: "no destinations in these countries" });
    }
    if (errors.length) return badInput(reply, errors);

    // Lines valid now in the scope.
    const { rows: lines } = await pool.query(
      `SELECT l.id, l.rate_table_id, l.mccmnc_id, l.sender_id, l.rate, l.is_blocked
         FROM rate_lines l
        WHERE l.rate_table_id = ANY($1) AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
          ${destIds ? "AND l.mccmnc_id = ANY($2)" : ""}
        ORDER BY l.rate_table_id, l.mccmnc, l.sender_id NULLS FIRST
        LIMIT ${MAX_ROWS + 1}`,
      destIds ? [body.rateTableIds, destIds] : [body.rateTableIds],
    );
    interface Base {
      tableId: number;
      mccmncId: number;
      senderId: string | null;
      lineId: number | null;
      rate: number | null;
      blocked: boolean;
    }
    const bases: Base[] = lines.map((l) => ({
      tableId: Number(l.rate_table_id),
      mccmncId: Number(l.mccmnc_id),
      senderId: l.sender_id,
      lineId: Number(l.id),
      rate: Number(l.rate),
      blocked: l.is_blocked,
    }));
    if (!onlyExisting && destIds) {
      const has = new Set(bases.filter((b) => b.senderId === null).map((b) => `${b.tableId}:${b.mccmncId}`));
      for (const t of body.rateTableIds)
        for (const m of destIds)
          if (!has.has(`${t}:${m}`))
            bases.push({ tableId: t, mccmncId: m, senderId: null, lineId: null, rate: null, blocked: false });
    }
    if (bases.length > MAX_ROWS)
      return badInput(reply, [
        { path: "/rateTableIds", message: `more than ${MAX_ROWS.toLocaleString("en")} lines; narrow the scope` },
      ]);

    // Destination names, exchange rates and costs.
    const mIds = [...new Set(bases.map((b) => b.mccmncId))];
    const { rows: dest } = await pool.query(
      `SELECT m.id, m.mccmnc, m.network, co.name AS country, co.iso FROM mccmnc m
         JOIN countries co ON co.id = m.country_id WHERE m.id = ANY($1)`,
      [mIds],
    );
    const destById = new Map(dest.map((d) => [Number(d.id), d]));
    const { rows: fx } = await pool.query("SELECT iso, rate_per_usd FROM currency_latest");
    const perUsd = new Map(fx.map((r) => [String(r.iso), Number(r.rate_per_usd)]));
    const platformPerUsd = perUsd.get(PLATFORM_CURRENCY) ?? 1;
    const toTable = (usd: number, t: TableInfo) => usd * (perUsd.get(t.currency) ?? 1);
    const tableToPlatform = (v: number, t: TableInfo) => (v / (perUsd.get(t.currency) ?? 1)) * platformPerUsd;

    const cost = new Map<string, { usd: number; vendor: string | null }>();
    if (costPlus && a.costSource === "vendor_trunk") {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (l.mccmnc_id) l.mccmnc_id, l.rate / cl.rate_per_usd AS usd, vt.name
           FROM rate_lines l
           JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
           JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id
           JOIN currency_latest cl ON cl.iso = l.currency
          WHERE rt.vendor_trunk_id = $1 AND l.mccmnc_id = ANY($2) AND l.sender_id IS NULL AND NOT l.is_blocked
            AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
          ORDER BY l.mccmnc_id, l.rate / cl.rate_per_usd`,
        [a.vendorTrunkId, mIds],
      );
      for (const r of rows) cost.set(`*:${r.mccmnc_id}`, { usd: Number(r.usd), vendor: r.name });
    }
    // Best buy for margins (and for cost + margin by default).
    const { rows: bb } = await pool.query(
      `SELECT bb.mccmnc_id, bb.product_category_id, bb.rate_usd, vt.name FROM best_buy_rates bb
         LEFT JOIN vendor_trunks vt ON vt.id = bb.vendor_trunk_id WHERE bb.mccmnc_id = ANY($1)`,
      [mIds],
    );
    for (const r of bb)
      cost.set(`${r.product_category_id}:${r.mccmnc_id}`, { usd: Number(r.rate_usd), vendor: r.name ?? null });

    // Last 7 days' traffic per table and destination (generic lines only; EDRs carry no sender-ID line).
    const traffic = await trafficLast7Days([...tables.values()], [...new Set(dest.map((d) => d.mccmnc as string))]);

    const round = a.round ?? 6;
    const fromBase = body.effectiveFrom ? Math.max(Date.parse(body.effectiveFrom), now) : now;
    // Suggested rates per table and destination (Market moves "Update rates", §13.14).
    const overrides = new Map((body.overrides ?? []).map((o) => [`${o.rateTableId}:${o.mccmnc}`, o] as const));
    const summary: RateBulkSummary = {
      tables: tables.size,
      destinations: mIds.length,
      lines: bases.length,
      up: 0,
      down: 0,
      new: 0,
      same: 0,
      closed: 0,
      blocked: 0,
      unblocked: 0,
      skipped: 0,
      belowCost: 0,
      noticeBreach: 0,
      noticeAdjusted: 0,
      currency: PLATFORM_CURRENCY,
      traffic: traffic !== null,
      messages7d: 0,
      revenue7d: 0,
      margin7d: 0,
      revenueChange7d: 0,
      marginChange7d: 0,
    };

    const rows: RateBulkRow[] = bases.map((b) => {
      const t = tables.get(b.tableId)!;
      const d = destById.get(b.mccmncId)!;
      const mccmnc = d.mccmnc as string;
      const best = t.kind === "customer" ? cost.get(`${t.categoryId}:${b.mccmncId}`) : undefined;
      const chosen = costPlus && a.costSource === "vendor_trunk" ? cost.get(`*:${b.mccmncId}`) : best;
      const costT = chosen ? r6(toTable(chosen.usd, t)) : null;
      const tr = b.senderId === null ? traffic?.get(`${t.id}:${mccmnc}`) : undefined;
      let newRate: number | null = null;
      let note: string | null = null;
      const cur = b.rate;
      switch (a.type) {
        case "set":
          newRate = a.value!;
          break;
        case "change_pct":
          newRate = cur === null ? null : cur * (1 + a.value! / 100);
          break;
        case "change_amount":
          newRate = cur === null ? null : cur + a.value!;
          break;
        case "cost_plus_pct":
        case "cost_plus_amount":
          if (costT === null) note = a.costSource === "vendor_trunk" ? "the vendor trunk has no rate here" : "no cost";
          else newRate = a.type === "cost_plus_pct" ? costT * (1 + a.value! / 100) : costT + a.value!;
          break;
      }
      if (newRate !== null) newRate = Math.max(0, Math.round(newRate * 10 ** round) / 10 ** round);
      const override = b.senderId === null ? overrides.get(`${t.id}:${mccmnc}`) : undefined;
      if (override && !["close", "block", "unblock"].includes(a.type)) {
        newRate = Math.round(override.rate * 1e6) / 1e6;
        note = null;
      }

      let edit: RateBulkRow["edit"] = "none";
      let change: RateBulkRow["change"] = "skip";
      let newBlocked: boolean | null = null;
      if (a.type === "close") {
        if (b.lineId !== null) [edit, change] = ["close", "close"];
      } else if (a.type === "block" || a.type === "unblock") {
        const want = a.type === "block";
        if (b.lineId !== null && b.blocked !== want) [edit, change, newBlocked] = ["block", a.type, want];
        else note = want ? "already blocked" : "not blocked";
      } else if (newRate !== null) {
        if (cur === null) [edit, change] = ["set", "new"];
        else if (newRate === cur) change = "same";
        else [edit, change] = ["set", newRate > cur ? "increase" : "decrease"];
      }

      let from = override?.effectiveFrom ? Math.max(Date.parse(override.effectiveFrom), now) : fromBase;
      let noticeBreach = false;
      let noticeAdjusted = false;
      const period =
        change === "increase" || change === "decrease" || change === "new" ? t.notice?.[change] : undefined;
      if (period) {
        const earliest = now + period.days * DAY_MS;
        if (from < earliest - SKEW_MS) {
          if (body.respectNotice) [from, noticeAdjusted] = [earliest, true];
          else noticeBreach = true;
        }
      }
      const effective = edit === "set" ? newRate! : cur;
      const belowCost = edit === "set" && costT !== null && newRate! < costT;
      if (belowCost) note ??= "sells below cost";
      if (noticeBreach) note ??= `${change} sooner than ${period!.days} days' notice (${period!.name})`;

      const messages = tr?.messages ?? 0;
      const toPlatform = platformPerUsd / (perUsd.get(t.currency) ?? 1);
      const revenueT = tr ? r2(tr.revenuePlatform / toPlatform) : 0;
      const marginT = tr ? r2((tr.revenuePlatform - tr.costPlatform) / toPlatform) : 0;
      let revenueChangeT = 0;
      if (edit === "close") revenueChangeT = -revenueT;
      else if (edit === "set" && cur !== null) revenueChangeT = r2(messages * (newRate! - cur));

      summary.up += +(change === "increase");
      summary.down += +(change === "decrease");
      summary.new += +(change === "new");
      summary.same += +(change === "same");
      summary.closed += +(change === "close");
      summary.blocked += +(change === "block");
      summary.unblocked += +(change === "unblock");
      summary.skipped += +(change === "skip");
      summary.belowCost += +belowCost;
      summary.noticeBreach += +noticeBreach;
      summary.noticeAdjusted += +noticeAdjusted;
      if (tr) {
        summary.messages7d += messages;
        summary.revenue7d += tr.revenuePlatform;
        summary.margin7d += tr.revenuePlatform - tr.costPlatform;
        const changeP = edit === "close" ? -tr.revenuePlatform : tableToPlatform(revenueChangeT, t);
        summary.revenueChange7d += changeP;
        summary.marginChange7d += edit === "close" ? -(tr.revenuePlatform - tr.costPlatform) : changeP;
      }

      return {
        key: `${t.id}:${mccmnc}:${b.senderId ?? ""}`,
        rateTableId: t.id,
        table: t.name,
        kind: t.kind as RateBulkRow["kind"],
        currency: t.currency,
        clients: t.clients,
        noticeDays: t.notice?.increase?.days ?? null,
        mccmnc,
        country: d.country ?? null,
        countryIso: d.iso ?? null,
        network: d.network ?? null,
        senderId: b.senderId,
        lineId: b.lineId,
        currentRate: cur,
        blocked: b.blocked,
        edit,
        newRate: edit === "set" || change === "same" ? newRate : null,
        newBlocked,
        effectiveFrom: new Date(from).toISOString(),
        change,
        cost: costT,
        costVendor: chosen?.vendor ?? null,
        currentMarginPct: cur !== null && costT !== null ? marginPct(cur, costT) : null,
        newMarginPct: effective !== null && costT !== null && edit !== "close" ? marginPct(effective, costT) : null,
        changePct: edit === "set" && cur !== null && cur > 0 ? pct(newRate!, cur) : null,
        belowCost,
        noticeBreach,
        noticeAdjusted,
        messages7d: messages,
        revenue7d: revenueT,
        margin7d: marginT,
        revenueChange7d: revenueChangeT,
        toPlatform: Math.round(toPlatform * 1e8) / 1e8,
        note,
      };
    });
    for (const k of ["revenue7d", "margin7d", "revenueChange7d", "marginChange7d"] as const)
      summary[k] = r2(summary[k]);
    return { rows, summary } satisfies RateBulkPreview;
  });
}

/** Margin % of a sell rate over its cost. */
const marginPct = (rate: number, cost: number) => (rate > 0 ? Math.round(((rate - cost) / rate) * 1000) / 10 : null);

/** Last 7 days' billable messages, revenue and cost (platform currency) per customer table and MCCMNC. */
async function trafficLast7Days(tables: TableInfo[], mccmncs: string[]) {
  const sell = tables.filter((t) => t.kind === "customer" && t.trunkIds.length);
  if (!sell.length) return new Map<string, { messages: number; revenuePlatform: number; costPlatform: number }>();
  const factor = await sysToPlatformFactor();
  const list = (xs: (string | number)[]) => xs.map((x) => (typeof x === "number" ? x : `'${x.replace(/'/g, "")}'`));
  const rows = await chRows<{ t: number; m: string; n: string; rev: string; cost: string }>(
    `SELECT c_rate_table_id AS t, c_mccmnc AS m, sum(is_customer_billable * msg_count) AS n,
            sum(revenue_sys * ${factor}) AS rev, sum(cost_sys * ${factor}) AS cost
       FROM edr
      WHERE start_time >= now() - INTERVAL 7 DAY
        AND c_trunk_id IN (${list([...new Set(sell.flatMap((t) => t.trunkIds))]).join(",")})
        AND c_rate_table_id IN (${list(sell.map((t) => t.id)).join(",")})
        ${mccmncs.length && mccmncs.length <= 5000 ? `AND c_mccmnc IN (${list(mccmncs).join(",")})` : ""}
      GROUP BY t, m`,
    10_000,
  );
  if (!rows) return null;
  return new Map(
    rows.map((r) => [
      `${r.t}:${r.m}`,
      { messages: Number(r.n), revenuePlatform: Number(r.rev), costPlatform: Number(r.cost) },
    ]),
  );
}

/** A reviewed row as a rate line edit on its table. */
function toEdit(it: RateBulkItem): RateLineEdit {
  if (it.action === "set")
    return {
      action: "set",
      ...(it.lineId !== undefined ? { lineId: it.lineId } : { mccmnc: it.mccmnc, senderId: it.senderId ?? null }),
      ...(it.rate !== undefined ? { rate: it.rate } : {}),
      ...(it.effectiveFrom ? { effectiveFrom: it.effectiveFrom } : {}),
    };
  if (it.action === "close")
    return {
      action: "close",
      lineId: it.lineId,
      ...(it.effectiveFrom ? { at: it.effectiveFrom } : {}),
    } as RateLineEdit;
  return { action: "block", lineId: it.lineId, blocked: it.blocked } as RateLineEdit;
}

export function applyRateBulk(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as RateBulkApply;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    const now = new Date();
    const ids = [...new Set(body.items.map((it) => it.rateTableId))];
    const tables = await loadTables(pool, ids);
    const errors: FieldError[] = [];
    body.items.forEach((it, i) => {
      const t = tables.get(it.rateTableId);
      if (!t) errors.push({ path: `/items/${i}/rateTableId`, message: `rate table ${it.rateTableId} not found` });
      else if (t.archived) errors.push({ path: `/items/${i}/rateTableId`, message: `${t.name} is archived` });
    });
    if (errors.length) return badInput(reply, errors);
    const byTable = new Map<number, { it: RateLineEdit; at: string }[]>();
    body.items.forEach((it, i) =>
      byTable.set(it.rateTableId, [...(byTable.get(it.rateTableId) ?? []), { it: toEdit(it), at: `/items/${i}` }]),
    );
    const mccmncIds = new Map<string, number>();
    for (const [id, edits] of byTable)
      errors.push(...(await checkLineEdits(pool, id, edits, mccmncIds, now.getTime())));
    if (errors.length) return badInput(reply, errors);

    const breaches: Breach[] = [];
    let skipped = 0;
    const diff: DiffEntry[] = [];
    const result = await inTransaction(pool, async (c) => {
      diff.length = 0;
      const changed: number[] = [];
      for (const [id, edits] of byTable) {
        const before = diff.length;
        skipped += await applyLineEdits(
          c,
          tables.get(id)!,
          edits.map((e) => e.it),
          mccmncIds,
          me.id,
          now,
          diff,
          breaches,
        );
        if (diff.length > before) changed.push(id);
      }
      if (breaches.length && !body.acceptNoticeBreach) throw new NoticeBreachError();
      if (diff.length === 0) return { change: null, applied: 0, tables: 0 };
      await c.query("UPDATE rate_tables SET updated_by_id = $2, updated_at = now() WHERE id = ANY($1)", [
        changed,
        me.id,
      ]);
      await c.query("SELECT refresh_rate_table_stats($1::bigint[])", [changed]);
      const applied = body.items.length - skipped;
      const change = await recordChange(c, {
        entityType: "rate_table",
        entityIds: changed,
        changeType: "bulk",
        diff,
        note:
          body.note?.trim() ||
          `Bulk rating: ${applied} line${applied === 1 ? "" : "s"} on ${changed.length} table${changed.length === 1 ? "" : "s"}` +
            (breaches.length ? `; short notice accepted for ${breaches.length} increases` : ""),
        userId: me.id,
        ip: request.ip,
      });
      return { change, applied, tables: changed.length };
    }).catch((err) => {
      if (err instanceof NoticeBreachError) return null;
      if (isOverlap(err)) return OVERLAP;
      throw err;
    });
    if (result === OVERLAP) return overlapProblem(reply);
    if (result === null) return sendNoticeBreach(reply, breaches);
    if (result.change && [...tables.values()].some((t) => t.kind === "vendor")) scheduleBestBuyRefresh();
    // Rate notifications to the customers using the changed tables (team trial round 1).
    const notificationsSent =
      result.change && body.sendNotification ? await sendRateNotices(pool, diff, me.id, body.notificationNote) : 0;
    return { ...result, skipped, notificationsSent };
  });
}
