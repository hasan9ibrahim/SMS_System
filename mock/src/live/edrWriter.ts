// Live EDRs (§13.3, §13.4, team trial round 1): the traffic simulator's messages are written to the EDR
// store as they are sent, so Live analytics, the reports and EDR search count exactly the traffic the live
// dashboard counts. Each simulated message is a copy of one of the trunk's recent stored EDRs with the
// same outcome (delivered, accepted, refused by the vendor, or not sent to one), with a new ID, message IDs
// and times. Messages sent to a vendor follow today's route rules (live/routing.ts): the copy gets the
// routed vendor, its rule and its cost, billed by the vendor's billing type. The copies are picked here and
// made inside ClickHouse in one insert a second, so every column stays valid; the hourly rollup follows
// through its view. The revenue and cost written are handed back to the simulator, so the dashboard's
// money and vendor figures are the written ones.
import { db } from "../db.js";
import { chQuery, chRows } from "../edr.js";
import { PLATFORM_PER_EUR, sysToPlatformFactor } from "../currency.js";
import { liveRoute } from "./routing.js";
import type { Simulator, SimTrunk } from "./simulator.js";

/** How often the sent messages are written. */
export const WRITE_EVERY_MS = 1_000;
/**
 * Templates kept per customer trunk and outcome (its latest first attempts of the last 7 days). Enough that
 * each vendor and destination keeps its own delivery mix (with 10, a vendor could look 0 % or 100 %).
 */
const PER_OUTCOME = 100;
const TEMPLATES = "edr_live_templates";
/** The outcome of a stored EDR, in the simulator's order (SimTrunk.pending). */
const OUTCOME = "multiIf(msg_status = 'DELIVRD', 0, is_submit_success = 1, 1, v_trunk_id > 0, 2, 3)";

/** What the writer needs to know of a template without reading it back. */
interface Template {
  id: string;
  bc: number;
  mccmnc: string;
  mcc: string;
  msgs: number;
  /** Customer revenue and vendor cost as stored, business-company currency. */
  rev: number;
  cost: number;
  vendorTrunkId: number;
  vendorEnterpriseId: number;
  ok: boolean;
  status: string;
}

interface WriterState {
  byTrunk: Map<string, Template[]>;
  byEnterprise: Map<string, Template[]>;
  all: Template[][];
  /** Business company → platform currency per base-currency unit, and its base currency. */
  factor: Map<number, number>;
  currency: Map<number, string>;
}

let state: WriterState | null = null;
let preparing: Promise<WriterState | null> | null = null;
/** When the templates were last built; a failed or outdated build is retried at most once per REBUILD_MS. */
let preparedAt = 0;
const REBUILD_MS = 60_000;
let writing = false;
let seq = 0;

async function prepare(): Promise<WriterState | null> {
  try {
    await chQuery(`DROP TABLE IF EXISTS ${TEMPLATES}`);
    await chQuery(`CREATE TABLE ${TEMPLATES} AS edr ENGINE = MergeTree ORDER BY edr_id`);
    await chQuery(
      `INSERT INTO ${TEMPLATES} SELECT * FROM edr
        WHERE submit_time > (SELECT max(submit_time) FROM edr) - INTERVAL 7 DAY AND is_final_attempt = 1 AND attempt_no = 1
        ORDER BY submit_time DESC LIMIT ${PER_OUTCOME} BY c_trunk_id, ${OUTCOME}`,
      120_000,
    );
    const rows =
      (await chRows<{
        id: string;
        t: number;
        e: number;
        o: number;
        bc: number;
        mccmnc: string;
        mcc: string;
        n: number;
        rev: number;
        cost: number;
        vt: number;
        ve: number;
        ok: number;
        st: string;
      }>(
        `SELECT toString(edr_id) AS id, c_trunk_id AS t, c_enterprise_id AS e, ${OUTCOME} AS o, business_company_id AS bc,
                toString(c_mccmnc) AS mccmnc, toString(c_mcc) AS mcc, msg_count AS n, toFloat64(revenue_sys) AS rev,
                toFloat64(cost_sys) AS cost, v_trunk_id AS vt, v_enterprise_id AS ve, is_submit_success AS ok,
                toString(msg_status) AS st
           FROM ${TEMPLATES}`,
        60_000,
      )) ?? [];
    const { rows: bcs } = await db().query(
      `SELECT bc.id, bc.base_currency, ${PLATFORM_PER_EUR} / cl.rate_per_eur AS f
         FROM business_companies bc JOIN currency_latest cl ON cl.iso = bc.base_currency`,
    );
    const s: WriterState = {
      byTrunk: new Map(),
      byEnterprise: new Map(),
      all: [[], [], [], []],
      factor: new Map(bcs.map((r) => [Number(r.id), Number(r.f)])),
      currency: new Map(bcs.map((r) => [Number(r.id), String(r.base_currency)])),
    };
    const add = (m: Map<string, Template[]>, k: string, t: Template) => m.set(k, [...(m.get(k) ?? []), t]);
    for (const r of rows) {
      const tpl: Template = {
        id: r.id,
        bc: Number(r.bc),
        mccmnc: r.mccmnc,
        mcc: r.mcc,
        msgs: Number(r.n) || 1,
        rev: Number(r.rev),
        cost: Number(r.cost),
        vendorTrunkId: Number(r.vt),
        vendorEnterpriseId: Number(r.ve),
        ok: Number(r.ok) === 1,
        status: r.st,
      };
      add(s.byTrunk, `${r.t}:${r.o}`, tpl);
      add(s.byEnterprise, `${r.e}:${r.o}`, tpl);
      s.all[Number(r.o)]!.push(tpl);
    }
    return s;
  } catch (err) {
    console.warn(`live EDRs off: ${(err as Error).message}`);
    return null;
  }
}

/** The templates a trunk's messages of one outcome copy: its own, its enterprise's, or any trunk's. */
const pool = (s: WriterState, t: SimTrunk, o: number) =>
  s.byTrunk.get(`${t.id}:${o}`) ?? s.byEnterprise.get(`${t.enterpriseId}:${o}`) ?? s.all[o]!;

/** Whether a vendor bills this message, by its billing type (§5): attempt, submit, reported or delivery. */
function vendorBills(billingType: string, tpl: Template): boolean {
  if (billingType === "attempt") return true;
  if (billingType === "submit") return tpl.ok;
  if (billingType === "reported") return tpl.ok && tpl.status !== "" && tpl.status !== "ENROUTE";
  return tpl.status === "DELIVRD";
}

/** One message to write: the template, the trunk it is sent as, and where it was routed (if routed). */
interface Copy {
  tpl: Template;
  trunk: SimTrunk;
  outcome: number;
  route: ReturnType<typeof liveRoute>;
  bills: boolean;
  /** Platform currency. */
  revenue: number;
  cost: number;
}

/**
 * Writes the messages each customer trunk sent since the last call, outcome by outcome. Called from the
 * live tick; skips a round while the previous write is still running (the messages wait).
 */
export async function writeLiveEdrs(sim: Simulator): Promise<number> {
  // Off with SIM_WRITE_EDRS=0, and under the test runner so tests see a fixed EDR store.
  if (process.env.SIM_WRITE_EDRS === "0" || process.env.NODE_TEST_CONTEXT) return 0;
  if (!state) {
    // Retried after a failed build (e.g. the EDR store was not up yet when the server started).
    if (preparing && Date.now() - preparedAt >= REBUILD_MS) preparing = null;
    preparing ??= ((preparedAt = Date.now()), prepare().then((s) => (state = s)));
    await preparing;
    // No EDR store: the simulator counts money from its own averages again.
    if (!state) {
      sim.moneyFromWriter = false;
      return 0;
    }
  }
  if (writing) return 0;
  const s = state;
  const copies: Copy[] = [];
  const taken: [NonNullable<SimTrunk["pending"]>, number, number][] = [];
  for (const t of sim.trunks) {
    const pending = t.pending;
    if (!pending) continue;
    for (let o = 0; o < 4; o++) {
      const n = pending[o]!;
      if (n <= 0) continue;
      const tpls = pool(s, t, o);
      if (!tpls.length) continue;
      pending[o] = 0;
      taken.push([pending, o, n]);
      for (let k = 0; k < n; k++) {
        const tpl = tpls[Math.floor(Math.random() * tpls.length)]!;
        const f = s.factor.get(tpl.bc) ?? 1;
        // Not sent to a vendor (outcome 3): nothing to route.
        const route = o < 3 ? liveRoute(t.id, tpl.mccmnc, tpl.mcc) : undefined;
        const bills = route ? vendorBills(route.vendorBillingType, tpl) : tpl.cost > 0;
        copies.push({
          tpl,
          trunk: t,
          outcome: o,
          route,
          bills,
          revenue: tpl.rev * f,
          cost: route ? (bills ? route.cost * tpl.msgs : 0) : tpl.cost * f,
        });
      }
    }
  }
  if (!copies.length) return 0;
  writing = true;
  const fx = await sysToPlatformFactor();
  const cur = [...s.currency];
  const currencyOf = `transform(business_company_id, [${cur.map(([id]) => id).join(",")}], [${cur.map(([, c]) => `'${c}'`).join(",")}], v_currency)`;
  // (template, trunk, enterprise, copy number, vendor trunk, vendor enterprise, platform cost per message,
  //  vendor bills it, vendor billing type, rule, route type, decided by); vendor trunk 0 = keep the stored one.
  const tuples = copies.map((c) => {
    const r = c.route;
    return `('${c.tpl.id}',${c.trunk.id},${c.trunk.enterpriseId},${seq++},${r?.vendorTrunkId ?? 0},${r?.vendorEnterpriseId ?? 0},${(r?.cost ?? 0).toFixed(6)},${c.bills ? 1 : 0},'${r?.vendorBillingType ?? ""}',${r?.ruleId ?? 0},'${r?.routeType ?? ""}','${r?.decidedBy ?? ""}')`;
  });
  // One jitter per copy, so the four times move together and keep the stored delays.
  const shift = `dateDiff('millisecond', submit_time, now64(3)) - toInt64(cityHash64(m_seq, toUnixTimestamp64Milli(now64(3))) % ${WRITE_EVERY_MS})`;
  const id = () => `lower(hex(randomString(8)))`;
  const routed = (expr: string, keep: string) => `if(m_vt > 0, ${expr}, ${keep})`;
  const sysRate = `m_cost / (${fx})`;
  try {
    await chQuery(
      `INSERT INTO edr SELECT * EXCEPT (m_id, m_trunk, m_ent, m_seq, m_vt, m_ve, m_cost, m_bills, m_vbt, m_rule, m_rtype, m_by) REPLACE (
          generateUUIDv4(m_seq) AS edr_id,
          toUInt32(m_trunk) AS c_trunk_id,
          toUInt32(m_ent) AS c_enterprise_id,
          addMilliseconds(start_time, ${shift}) AS start_time,
          addMilliseconds(submit_time, ${shift}) AS submit_time,
          if(isNull(submit_resp_time), NULL, addMilliseconds(assumeNotNull(submit_resp_time), ${shift})) AS submit_resp_time,
          if(isNull(delivery_time), NULL, addMilliseconds(assumeNotNull(delivery_time), ${shift})) AS delivery_time,
          ${id()} AS c_message_id,
          if(v_message_id = '', '', arrayStringConcat(arrayMap(i -> ${id()}, range(greatest(toUInt32(msg_count), 1))), ',')) AS v_message_id,
          ${routed("toUInt32(m_vt)", "v_trunk_id")} AS v_trunk_id,
          ${routed("toUInt32(m_ve)", "v_enterprise_id")} AS v_enterprise_id,
          ${routed("toString(m_vbt)", "toString(v_billing_type)")} AS v_billing_type,
          CAST(${routed(sysRate, "toFloat64(v_rate)")} AS Decimal(12, 6)) AS v_rate,
          ${routed(currencyOf, "toString(v_currency)")} AS v_currency,
          CAST(${routed("1", "toFloat64(v_ex_rate)")} AS Decimal(18, 8)) AS v_ex_rate,
          CAST(${routed(sysRate, "toFloat64(v_sys_rate)")} AS Decimal(12, 6)) AS v_sys_rate,
          ${routed("toUInt8(m_bills)", "is_vendor_billable")} AS is_vendor_billable,
          CAST(${routed(`if(m_bills = 1, ${sysRate} * msg_count, 0)`, "toFloat64(cost)")} AS Decimal(14, 6)) AS cost,
          CAST(${routed(`if(m_bills = 1, ${sysRate} * msg_count, 0)`, "toFloat64(cost_sys)")} AS Decimal(14, 6)) AS cost_sys,
          ${routed("toUInt32(m_rule)", "route_rule_id")} AS route_rule_id,
          ${routed("toString(m_rtype)", "toString(route_type)")} AS route_type,
          ${routed("toUInt8(1)", "route_level")} AS route_level,
          ${routed("toString(m_by)", "toString(route_decided_by)")} AS route_decided_by)
        FROM ${TEMPLATES} AS t
        INNER JOIN (
          SELECT toUUID(x.1) AS m_id, x.2 AS m_trunk, x.3 AS m_ent, x.4 AS m_seq, x.5 AS m_vt, x.6 AS m_ve,
                 toFloat64(x.7) AS m_cost, x.8 AS m_bills, x.9 AS m_vbt, x.10 AS m_rule, x.11 AS m_rtype, x.12 AS m_by
            FROM (SELECT arrayJoin([${tuples.join(",")}]) AS x)
        ) AS m ON t.edr_id = m.m_id`,
      30_000,
    );
    handBack(sim, copies);
    if (process.env.SIM_EDR_DEBUG)
      console.log(`live EDRs written ${copies.length}, routed ${copies.filter((c) => c.route).length}`);
    return copies.length;
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`live EDRs: ${msg}`);
    // Not written: they wait for the next round.
    for (const [p, o, n] of taken) p[o] = (p[o] ?? 0) + n;
    // The EDR store got new columns after the templates were copied (an upgrade applied after start, e.g.
    // migration 002): rebuild the templates from the current table on the next round.
    if (
      /NUMBER_OF_COLUMNS_DOESNT_MATCH|UNKNOWN_IDENTIFIER|NO_SUCH_COLUMN/.test(msg) &&
      Date.now() - preparedAt >= REBUILD_MS
    ) {
      console.warn("live EDRs: the EDR store changed; rebuilding the live templates");
      state = null;
      preparing = null;
    }
    return 0;
  } finally {
    writing = false;
  }
}

/** The written revenue and cost into today's figures, and each message's vendor into the vendor figures. */
function handBack(sim: Simulator, copies: Copy[]) {
  const vendors = new Map(sim.vendors.map((v) => [v.id, v]));
  for (const c of copies) {
    const t = c.trunk;
    t.day.revenue += c.revenue;
    t.day.cost += c.cost;
    sim.today.revenue += c.revenue;
    sim.today.cost += c.cost;
    const client = sim.today.clients.get(t.enterpriseId);
    if (client) {
      client.money += c.revenue;
      client.margin += c.revenue - c.cost;
    }
    if (c.outcome === 3) continue;
    const vendorId = c.route?.vendorTrunkId ?? c.tpl.vendorTrunkId;
    const v = vendors.get(vendorId);
    if (!v) continue;
    v.routed = (v.routed ?? 0) + 1;
    v.day.attempts += 1;
    if (c.outcome <= 1) v.day.submitted += 1;
    if (c.outcome === 0) v.day.delivered += 1;
    v.day.cost += c.cost;
    const p = sim.today.vendors.get(v.enterpriseId) ?? {
      name: v.enterpriseName,
      attempts: 0,
      money: 0,
      margin: 0,
      successful: 0,
      delivered: 0,
    };
    p.attempts += 1;
    p.money += c.cost;
    if (c.outcome <= 1) p.successful += 1;
    if (c.outcome === 0) p.delivered += 1;
    sim.today.vendors.set(v.enterpriseId, p);
  }
}
