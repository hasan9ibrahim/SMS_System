// Route rule traffic from the EDR store (§13.27): per-window figures cached in
// route_rule_traffic for the grid, and per-rule breakdowns for the hover and the Traffic
// section. Fake EDRs end at the generator's anchor time, so windows end at the latest EDR
// when that is earlier than now.
import type { RouteTraffic, TrafficWindow } from "@sms/contract";
import { db } from "../db.js";
import { sysToPlatformFactor } from "../currency.js";
import { chRows } from "../edr.js";
import { production } from "../mode.js";

export const WINDOWS: Record<TrafficWindow, { sql: string; bucket: string; ms: number }> = {
  "15m": { sql: "INTERVAL 15 MINUTE", bucket: "toStartOfMinute", ms: 15 * 60_000 },
  "1h": { sql: "INTERVAL 1 HOUR", bucket: "toStartOfFiveMinutes", ms: 3_600_000 },
  "24h": { sql: "INTERVAL 24 HOUR", bucket: "toStartOfHour", ms: 86_400_000 },
  "7d": { sql: "INTERVAL 7 DAY", bucket: "toStartOfDay", ms: 7 * 86_400_000 },
  "30d": { sql: "INTERVAL 30 DAY", bucket: "toStartOfDay", ms: 30 * 86_400_000 },
};

/** Margin in the platform currency: each EDR's *_sys amounts are in its company's base currency. */
const marginSql = (factor: string) => `round(sum((revenue_sys - cost_sys) * ${factor}), 2)`;

// Over edr_all (backend step 11b): attempts on attempt rows, deliveries and money on both.
const figuresSql = (factor: string) => `countIf(kind = 'attempt') AS n,
  round(countIf(is_submit_success = 1) / greatest(countIf(kind = 'attempt'), 1) * 100, 1) AS asr,
  round(countIf(msg_status = 'DELIVRD') / greatest(countIf(is_submit_success = 1), 1) * 100, 1) AS dlr,
  ${marginSql(factor)} AS margin`;

/** End of the traffic windows: now, or the latest EDR when the fake data ends earlier (never in production). */
export async function windowEnd(): Promise<string | null> {
  const rows = await chRows<{ t: string }>(
    production ? "SELECT toString(now64(3)) AS t" : "SELECT toString(least(now64(3), max(submit_time))) AS t FROM edr",
  );
  return rows?.[0]?.t ?? null;
}

let running = false;

/** Recomputes route_rule_traffic for every window. Leaves it as it was without ClickHouse. */
export async function refreshRouteTraffic(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const end = await windowEnd();
    if (!end) return;
    const FIGURES = figuresSql(await sysToPlatformFactor());
    const results = await Promise.all(
      (Object.keys(WINDOWS) as TrafficWindow[]).map(async (w) => ({
        w,
        rows: await chRows<{ id: number; n: string; asr: number | null; dlr: number | null; margin: number }>(
          `SELECT route_rule_id AS id, ${FIGURES} FROM edr_all
            WHERE submit_time > toDateTime64('${end}', 3) - ${WINDOWS[w].sql} AND submit_time <= toDateTime64('${end}', 3)
              AND route_rule_id > 0
            GROUP BY id`,
        ),
      })),
    );
    if (results.some((r) => !r.rows)) return;
    const c = await db().connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM route_rule_traffic");
      for (const { w, rows } of results) {
        if (!rows!.length) continue;
        await c.query(
          `INSERT INTO route_rule_traffic (route_rule_id, time_window, messages, asr, dlr, margin)
           SELECT x.id, $1, x.n, x.asr, x.dlr, x.margin
             FROM jsonb_to_recordset($2::jsonb) AS x(id bigint, n int, asr numeric, dlr numeric, margin numeric)
            WHERE EXISTS (SELECT 1 FROM route_rules r WHERE r.id = x.id)`,
          [w, JSON.stringify(rows!.map((r) => ({ ...r, n: Number(r.n) })))],
        );
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  } catch {
    // Next refresh tries again; a missing database is reported by the API calls.
  } finally {
    running = false;
  }
}

export function startRouteTrafficRefresh(everyMs = 60_000): () => void {
  void refreshRouteTraffic();
  const id = setInterval(() => void refreshRouteTraffic(), everyMs);
  id.unref();
  return () => clearInterval(id);
}

const figures = (r: { n: string | number; asr: number | null; dlr: number | null; margin: number | string }) => ({
  messages: Number(r.n),
  asr: r.asr === null ? null : Number(r.asr),
  dlr: r.dlr === null ? null : Number(r.dlr),
  margin: Number(r.margin),
});

/** Breakdown of one rule's traffic per customer trunk and vendor trunk, with a time series. */
export async function ruleTraffic(ruleId: number, window: TrafficWindow): Promise<RouteTraffic> {
  const w = WINDOWS[window];
  const end = await windowEnd();
  const empty: RouteTraffic = {
    window,
    available: false,
    from: new Date(Date.now() - w.ms).toISOString(),
    to: new Date().toISOString(),
    total: { messages: 0, asr: null, dlr: null, margin: 0 },
    byCustomer: [],
    byVendor: [],
    series: [],
  };
  if (!end) return empty;
  const factor = await sysToPlatformFactor();
  const FIGURES = figuresSql(factor);
  const where = `route_rule_id = ${Number(ruleId)} AND submit_time > toDateTime64('${end}', 3) - ${w.sql}
    AND submit_time <= toDateTime64('${end}', 3)`;
  const [total, byC, byV, series] = await Promise.all([
    chRows<{ n: string; asr: number | null; dlr: number | null; margin: number }>(
      `SELECT ${FIGURES} FROM edr_all WHERE ${where}`,
    ),
    chRows<{ id: number; n: string; asr: number | null; dlr: number | null; margin: number }>(
      `SELECT c_trunk_id AS id, ${FIGURES} FROM edr_all WHERE ${where} GROUP BY id ORDER BY n DESC LIMIT 50`,
    ),
    chRows<{ id: number; n: string; asr: number | null; dlr: number | null; margin: number }>(
      `SELECT v_trunk_id AS id, ${FIGURES} FROM edr_all WHERE ${where} GROUP BY id ORDER BY n DESC LIMIT 50`,
    ),
    chRows<{ at: string; n: string; margin: number }>(
      `SELECT toString(${w.bucket}(submit_time)) AS at, countIf(kind = 'attempt') AS n, ${marginSql(factor)} AS margin
         FROM edr_all WHERE ${where} GROUP BY at ORDER BY at`,
    ),
  ]);
  if (!total || !byC || !byV || !series) return empty;
  // Which vendor carried the traffic in each bucket (team trial round 1): the window's top 10 vendors,
  // the rest as -1 ("other vendors").
  const top = byV.slice(0, 10).map((r) => Number(r.id));
  const perVendor =
    (await chRows<{ at: string; id: number; n: string }>(
      `SELECT toString(${w.bucket}(submit_time)) AS at,
              if(v_trunk_id IN (${top.length ? top.join(",") : "0"}) OR v_trunk_id = 0, v_trunk_id, -1) AS id,
              count() AS n
         FROM edr WHERE ${where} GROUP BY at, id`,
    )) ?? [];
  const vendorsAt = new Map<string, { vendorTrunkId: number; messages: number }[]>();
  for (const r of perVendor) {
    const list = vendorsAt.get(r.at) ?? [];
    list.push({ vendorTrunkId: Number(r.id), messages: Number(r.n) });
    vendorsAt.set(r.at, list);
  }
  const t = figures(total[0] ?? { n: 0, asr: null, dlr: null, margin: 0 });
  const names = async (table: string, ids: number[]) => {
    if (!ids.length) return new Map<number, { name: string; enterprise: string }>();
    const { rows } = await db().query(
      `SELECT t.id, t.name, e.name AS enterprise FROM ${table} t JOIN enterprises e ON e.id = t.enterprise_id WHERE t.id = ANY($1)`,
      [ids],
    );
    return new Map(rows.map((r) => [Number(r.id), { name: r.name as string, enterprise: r.enterprise as string }]));
  };
  const [cn, vn] = await Promise.all([
    names(
      "customer_trunks",
      byC.map((r) => Number(r.id)),
    ),
    names(
      "vendor_trunks",
      byV.map((r) => Number(r.id)),
    ),
  ]);
  const share = (n: string) => (t.messages ? Math.round((Number(n) / t.messages) * 1000) / 10 : 0);
  const toIso = (s: string) => new Date(`${s.replace(" ", "T")}Z`).toISOString();
  return {
    window,
    available: true,
    from: new Date(Date.parse(toIso(end)) - w.ms).toISOString(),
    to: toIso(end),
    total: t,
    byCustomer: byC.map((r) => ({
      customerTrunkId: Number(r.id),
      name: cn.get(Number(r.id))?.name ?? `Trunk ${r.id}`,
      enterpriseName: cn.get(Number(r.id))?.enterprise ?? "",
      sharePct: share(r.n),
      ...figures(r),
    })),
    byVendor: byV.map((r) => ({
      vendorTrunkId: Number(r.id),
      name: vn.get(Number(r.id))?.name ?? `Trunk ${r.id}`,
      sharePct: share(r.n),
      ...figures(r),
    })),
    series: series.map((r) => ({
      at: toIso(r.at),
      messages: Number(r.n),
      margin: Number(r.margin),
      vendors: (vendorsAt.get(r.at) ?? []).sort((a, b) => b.messages - a.messages),
    })),
  };
}
