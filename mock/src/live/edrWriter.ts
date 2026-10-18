// Live EDRs (§13.3, §13.4, team trial round 1): the traffic simulator's messages are written to the EDR
// store as they are sent, so Live analytics, the reports and EDR search count exactly the traffic the live
// dashboard counts. Each simulated message is a copy of one of the trunk's recent stored EDRs with the
// same outcome (delivered, accepted, refused by the vendor, or not sent to one), with a new ID, message IDs
// and times. The copies are picked here and made inside ClickHouse in one insert a second, so every column
// stays valid; the hourly rollup follows through its view.
import { chQuery, chRows } from "../edr.js";
import type { Simulator, SimTrunk } from "./simulator.js";

/** How often the sent messages are written. */
export const WRITE_EVERY_MS = 1_000;
/** Templates kept per customer trunk and outcome (its latest first attempts of the last 7 days). */
const PER_OUTCOME = 10;
const TEMPLATES = "edr_live_templates";
/** The outcome of a stored EDR, in the simulator's order (SimTrunk.pending). */
const OUTCOME = "multiIf(msg_status = 'DELIVRD', 0, is_submit_success = 1, 1, v_trunk_id > 0, 2, 3)";

interface WriterState {
  /** Template EDR IDs per "trunk:outcome", per "enterprise:outcome" and per outcome. */
  byTrunk: Map<string, string[]>;
  byEnterprise: Map<string, string[]>;
  all: string[][];
}

let state: WriterState | null = null;
let preparing: Promise<WriterState | null> | null = null;
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
      (await chRows<{ id: string; t: number; e: number; o: number }>(
        `SELECT toString(edr_id) AS id, c_trunk_id AS t, c_enterprise_id AS e, ${OUTCOME} AS o FROM ${TEMPLATES}`,
        30_000,
      )) ?? [];
    const s: WriterState = { byTrunk: new Map(), byEnterprise: new Map(), all: [[], [], [], []] };
    const add = (m: Map<string, string[]>, k: string, id: string) => m.set(k, [...(m.get(k) ?? []), id]);
    for (const r of rows) {
      add(s.byTrunk, `${r.t}:${r.o}`, r.id);
      add(s.byEnterprise, `${r.e}:${r.o}`, r.id);
      s.all[Number(r.o)]!.push(r.id);
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

/**
 * Writes the messages each customer trunk sent since the last call, outcome by outcome. Called from the
 * live tick; skips a round while the previous write is still running (the messages wait).
 */
export async function writeLiveEdrs(sim: Simulator): Promise<number> {
  // Off with SIM_WRITE_EDRS=0, and under the test runner so tests see a fixed EDR store.
  if (process.env.SIM_WRITE_EDRS === "0" || process.env.NODE_TEST_CONTEXT) return 0;
  if (!state) {
    preparing ??= prepare().then((s) => (state = s));
    await preparing;
    if (!state) return 0;
  }
  if (writing) return 0;
  const s = state;
  // (template ID, trunk, enterprise, copy number) per message.
  const copies: string[] = [];
  const taken: [NonNullable<SimTrunk["pending"]>, number, number][] = [];
  for (const t of sim.trunks) {
    const pending = t.pending;
    if (!pending) continue;
    for (let o = 0; o < 4; o++) {
      const n = pending[o]!;
      if (n <= 0) continue;
      const ids = pool(s, t, o);
      if (!ids.length) continue;
      pending[o] = 0;
      taken.push([pending, o, n]);
      for (let k = 0; k < n; k++)
        copies.push(`('${ids[Math.floor(Math.random() * ids.length)]}',${t.id},${t.enterpriseId},${seq++})`);
    }
  }
  if (!copies.length) return 0;
  writing = true;
  // One jitter per copy, so the four times move together and keep the stored delays.
  const shift = `dateDiff('millisecond', submit_time, now64(3)) - toInt64(cityHash64(m_seq, toUnixTimestamp64Milli(now64(3))) % ${WRITE_EVERY_MS})`;
  const id = () => `lower(hex(randomString(8)))`;
  const t0 = Date.now();
  try {
    await chQuery(
      `INSERT INTO edr SELECT * EXCEPT (m_id, m_trunk, m_ent, m_seq) REPLACE (
          generateUUIDv4(m_seq) AS edr_id,
          toUInt32(m_trunk) AS c_trunk_id,
          toUInt32(m_ent) AS c_enterprise_id,
          addMilliseconds(start_time, ${shift}) AS start_time,
          addMilliseconds(submit_time, ${shift}) AS submit_time,
          if(isNull(submit_resp_time), NULL, addMilliseconds(assumeNotNull(submit_resp_time), ${shift})) AS submit_resp_time,
          if(isNull(delivery_time), NULL, addMilliseconds(assumeNotNull(delivery_time), ${shift})) AS delivery_time,
          ${id()} AS c_message_id,
          if(v_message_id = '', '', ${id()}) AS v_message_id)
        FROM ${TEMPLATES} AS t
        INNER JOIN (
          SELECT toUUID(x.1) AS m_id, x.2 AS m_trunk, x.3 AS m_ent, x.4 AS m_seq
            FROM (SELECT arrayJoin([${copies.join(",")}]) AS x)
        ) AS m ON t.edr_id = m.m_id`,
      30_000,
    );
    if (process.env.SIM_EDR_DEBUG) console.log(`live EDRs written ${copies.length} in ${Date.now() - t0} ms`);
    return copies.length;
  } catch (err) {
    console.warn(`live EDRs: ${(err as Error).message}`);
    // Not written: they wait for the next round.
    for (const [p, o, n] of taken) p[o] = (p[o] ?? 0) + n;
    return 0;
  } finally {
    writing = false;
  }
}
