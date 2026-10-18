// Live EDRs (§13.3, §13.4, team trial round 1): the traffic simulator's messages are written to the EDR
// store as they are sent, so Live analytics, the reports and EDR search count exactly the traffic the live
// dashboard counts. Each simulated message is a copy of one of the trunk's recent stored EDRs with the
// same outcome (delivered, accepted, refused by the vendor, or not sent to one), with a new ID, message IDs
// and times; the copy is made inside ClickHouse, so every column stays valid. The hourly rollup follows
// through its view.
import { chQuery, chRows } from "../edr.js";
import type { Simulator } from "./simulator.js";

/** How often the sent messages are written. */
export const WRITE_EVERY_MS = 1_000;
/** Templates kept per customer trunk and outcome (its latest first attempts of the last 7 days). */
const PER_OUTCOME = 10;
const TEMPLATES = "edr_live_templates";
/** The outcome of a stored EDR, in the simulator's order (SimTrunk.pending). */
const OUTCOME = "multiIf(msg_status = 'DELIVRD', 0, is_submit_success = 1, 1, v_trunk_id > 0, 2, 3)";

interface WriterState {
  /** Templates per "trunk:outcome", "enterprise:outcome" and outcome. */
  byTrunk: Map<string, number>;
  byEnterprise: Map<string, number>;
  all: number[];
}

let state: WriterState | null = null;
let preparing: Promise<WriterState | null> | null = null;
let writing = false;

async function prepare(): Promise<WriterState | null> {
  try {
    await chQuery(`DROP TABLE IF EXISTS ${TEMPLATES}`);
    await chQuery(`CREATE TABLE ${TEMPLATES} AS edr ENGINE = MergeTree ORDER BY c_trunk_id`);
    await chQuery(
      `INSERT INTO ${TEMPLATES} SELECT * FROM edr
        WHERE submit_time > (SELECT max(submit_time) FROM edr) - INTERVAL 7 DAY AND is_final_attempt = 1 AND attempt_no = 1
        ORDER BY submit_time DESC LIMIT ${PER_OUTCOME} BY c_trunk_id, ${OUTCOME}`,
      120_000,
    );
    type Row = { id: number; o: number; n: string };
    const count = async (col: string) =>
      (await chRows<Row>(
        `SELECT ${col} AS id, ${OUTCOME} AS o, count() AS n FROM ${TEMPLATES} GROUP BY id, o`,
        10_000,
      )) ?? [];
    const [trunks, ents] = await Promise.all([count("c_trunk_id"), count("c_enterprise_id")]);
    const all = [0, 0, 0, 0];
    for (const r of trunks) all[Number(r.o)]! += Number(r.n);
    return {
      byTrunk: new Map(trunks.map((r) => [`${r.id}:${r.o}`, Number(r.n)])),
      byEnterprise: new Map(ents.map((r) => [`${r.id}:${r.o}`, Number(r.n)])),
      all,
    };
  } catch (err) {
    console.warn(`live EDRs off: ${(err as Error).message}`);
    return null;
  }
}

/** `n` copies of templates from `from` (repeated when there are fewer templates than messages). */
function copySql(n: number, have: number, from: string): string {
  const reps = Math.ceil(n / have);
  // One jitter per copy, so the four times move together and keep the stored delays.
  const shift = `dateDiff('millisecond', submit_time, now64(3)) - toInt64(cityHash64(edr_id, rep_, toUnixTimestamp64Milli(now64(3))) % ${WRITE_EVERY_MS})`;
  const id = () => `lower(hex(randomString(8)))`;
  return `SELECT * EXCEPT (rep_) REPLACE (
      generateUUIDv4(rep_) AS edr_id,
      addMilliseconds(start_time, ${shift}) AS start_time,
      addMilliseconds(submit_time, ${shift}) AS submit_time,
      if(isNull(submit_resp_time), NULL, addMilliseconds(assumeNotNull(submit_resp_time), ${shift})) AS submit_resp_time,
      if(isNull(delivery_time), NULL, addMilliseconds(assumeNotNull(delivery_time), ${shift})) AS delivery_time,
      ${id()} AS c_message_id,
      if(v_message_id = '', '', ${id()}) AS v_message_id)
    FROM (${from}) ARRAY JOIN range(${reps}) AS rep_
    ORDER BY rand() LIMIT ${n}`;
}

/**
 * Writes the messages each customer trunk sent since the last call, outcome by outcome. A trunk with no
 * stored EDR of an outcome borrows its enterprise's other trunks, or any trunk, as itself. Called from
 * the live tick; skips a round while the previous write is still running (the messages wait).
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
  const parts: string[] = [];
  const taken: [NonNullable<Simulator["trunks"][number]["pending"]>, number, number][] = [];
  let total = 0;
  for (const t of sim.trunks) {
    const pending = t.pending;
    if (!pending) continue;
    for (let o = 0; o < 4; o++) {
      const n = pending[o]!;
      if (n <= 0) continue;
      pending[o] = 0;
      taken.push([pending, o, n]);
      const as = (where: string) =>
        `SELECT * REPLACE (toUInt32(${t.id}) AS c_trunk_id, toUInt32(${t.enterpriseId}) AS c_enterprise_id)
           FROM (SELECT * FROM ${TEMPLATES} WHERE ${OUTCOME} = ${o}${where})`;
      const own = s.byTrunk.get(`${t.id}:${o}`) ?? 0;
      const ent = s.byEnterprise.get(`${t.enterpriseId}:${o}`) ?? 0;
      const [have, from] = own
        ? [own, `SELECT * FROM ${TEMPLATES} WHERE c_trunk_id = ${t.id} AND ${OUTCOME} = ${o}`]
        : ent
          ? [ent, as(` AND c_enterprise_id = ${t.enterpriseId}`)]
          : [s.all[o]!, as("")];
      if (!have) continue;
      parts.push(copySql(n, have, from));
      total += n;
    }
  }
  if (!parts.length) return 0;
  writing = true;
  try {
    await chQuery(`INSERT INTO edr SELECT * FROM (${parts.map((p) => `(${p})`).join(" UNION ALL ")})`, 30_000);
    if (process.env.SIM_EDR_DEBUG) console.log(`live EDRs written ${total}, simulated today ${sim.today.attempts}`);
    return total;
  } catch (err) {
    console.warn(`live EDRs: ${(err as Error).message}`);
    // Not written: they wait for the next round.
    for (const [p, o, n] of taken) p[o] = (p[o] ?? 0) + n;
    return 0;
  } finally {
    writing = false;
  }
}
