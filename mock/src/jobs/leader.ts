// The background jobs run on one server at a time (backend step 11): both servers run this service behind the API,
// and the jobs (invoices, reports, e-mail, scans, alerts) must not run twice. The server that holds a PostgreSQL
// advisory lock on a connection of its own is the leader; when it stops, its connection closes, the lock is freed and
// the other server takes over at its next try (every 15 s). Outside production every process leads.
import pg from "pg";
import { PG_CONFIG } from "../db.js";
import { production } from "../mode.js";

/** The advisory lock key (any constant shared by every server of the platform). */
export const LEADER_LOCK = 774_211_011;
const TRY_EVERY_MS = 15_000;

let leading = !production;
let client: pg.Client | null = null;

export const isLeader = () => leading;

/**
 * Calls `start` once this server leads (at once outside production). `onLost` is called if the lock's connection
 * fails: the process then exits so a supervisor restarts it as a follower, and no job runs twice.
 */
export function whenLeader(start: () => void, onLost: (err: unknown) => void = () => process.exit(1)): () => void {
  if (!production) {
    start();
    return () => {};
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const attempt = async () => {
    if (stopped || leading) return;
    try {
      client ??= await connect(onLost);
      const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LEADER_LOCK]);
      if (rows[0]?.ok) {
        leading = true;
        start();
        return;
      }
    } catch {
      client = null;
    }
    timer = setTimeout(() => void attempt(), TRY_EVERY_MS);
    timer.unref();
  };
  void attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function connect(onLost: (err: unknown) => void): Promise<pg.Client> {
  const c = new pg.Client(PG_CONFIG);
  c.on("error", (err) => {
    if (leading) onLost(err);
    client = null;
  });
  await c.connect();
  return c;
}
