// Live EDRs (§13.3, §13.4, team trial round 1): the traffic simulator's messages are written to the EDR
// store as they are "sent", so Live analytics, the reports and EDR search grow with the same traffic the
// live dashboard counts. Each simulated message is a copy of one of the trunk's recent stored EDRs
// (destination, vendor, rates, status and delay as stored) with a new ID, message IDs and times; the copy
// is made inside ClickHouse, so every column stays valid. The hourly rollup follows through its view.
import { chQuery, chRows } from "../edr.js";
import type { Simulator } from "./simulator.js";

/** How often the pending messages are written. */
export const WRITE_EVERY_MS = 5_000;
/** Templates kept per customer trunk (its latest final attempts of the last 7 days). */
const PER_TRUNK = 40;
const TEMPLATES = "edr_live_templates";

interface WriterState {
  /** Templates per customer trunk ID. */
  templates: Map<number, number>;
  /** Today's attempts per trunk when last written, and the fraction not yet written. */
  seen: Map<number, number>;
  carry: Map<number, number>;
  day: string;
}

let state: WriterState | null = null;
let preparing: Promise<WriterState | null> | null = null;
let writing = false;

async function prepare(): Promise<WriterState | null> {
  try {
    await chQuery(`CREATE TABLE IF NOT EXISTS ${TEMPLATES} AS edr ENGINE = MergeTree ORDER BY c_trunk_id`);
    await chQuery(`TRUNCATE TABLE ${TEMPLATES}`);
    await chQuery(
      `INSERT INTO ${TEMPLATES} SELECT * FROM edr
        WHERE submit_time > (SELECT max(submit_time) FROM edr) - INTERVAL 7 DAY AND is_final_attempt = 1 AND attempt_no = 1
        ORDER BY submit_time DESC LIMIT ${PER_TRUNK} BY c_trunk_id`,
      120_000,
    );
    const rows =
      (await chRows<{ id: number; n: string }>(
        `SELECT c_trunk_id AS id, count() AS n FROM ${TEMPLATES} GROUP BY id`,
        10_000,
      )) ?? [];
    return {
      templates: new Map(rows.map((r) => [Number(r.id), Number(r.n)])),
      seen: new Map(),
      carry: new Map(),
      day: "",
    };
  } catch (err) {
    console.warn(`live EDRs off: ${(err as Error).message}`);
    return null;
  }
}

/** One customer trunk's new messages, copied from its templates (repeated when it sends more than it has). */
function copySql(trunkId: number, n: number, have: number): string {
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
    FROM (SELECT * FROM ${TEMPLATES} WHERE c_trunk_id = ${trunkId}) ARRAY JOIN range(${reps}) AS rep_
    ORDER BY rand() LIMIT ${n}`;
}

/**
 * Writes the messages each customer trunk sent since the last call. Called from the live tick; skips a
 * round while the previous write is still running (the messages wait for the next one).
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
  // A new day starts every trunk's count again.
  if (s.day !== sim.today.day) {
    s.day = sim.today.day;
    for (const t of sim.trunks) s.seen.set(t.id, t.day.attempts);
  }
  const parts: string[] = [];
  let total = 0;
  for (const t of sim.trunks) {
    const before = s.seen.get(t.id) ?? t.day.attempts;
    s.seen.set(t.id, t.day.attempts);
    const due = Math.max(0, t.day.attempts - before) + (s.carry.get(t.id) ?? 0);
    const n = Math.floor(due);
    s.carry.set(t.id, due - n);
    const have = s.templates.get(t.id) ?? 0;
    if (n > 0 && have > 0) {
      parts.push(copySql(t.id, n, have));
      total += n;
    }
  }
  if (!parts.length) return 0;
  writing = true;
  try {
    await chQuery(`INSERT INTO edr SELECT * FROM (${parts.map((p) => `(${p})`).join(" UNION ALL ")})`, 30_000);
    return total;
  } catch (err) {
    console.warn(`live EDRs: ${(err as Error).message}`);
    return 0;
  } finally {
    writing = false;
  }
}
