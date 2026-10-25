// Production (backend step 11c, §9.1, §9.2): keeps what the screens show of switch commands current. Capture status
// every 5 seconds, the recording's file list and Repush progress every minute, and expired captures purged hourly from
// both the switch servers and the list. A switch that does not answer is retried on the next tick.
import { db } from "../db.js";
import { CAPTURE_KEEP_DAYS } from "../lists/defs.js";
import { purgeSwitchCaptures, refreshCaptures, refreshPcapFiles, updateRepushProgress } from "../switch/operations.js";

function every(what: string, ms: number, job: () => Promise<unknown>) {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    job()
      .catch((err: Error) => console.warn(`${what}: ${err.message}`))
      .finally(() => (busy = false));
  };
  setTimeout(tick, Math.min(ms, 10_000)).unref();
  setInterval(tick, ms).unref();
}

export function startSwitchJobs() {
  const pool = db();
  every("capture status", 5_000, () => refreshCaptures(pool));
  every("recording files", 60_000, () => refreshPcapFiles(pool));
  every("repush progress", 60_000, () => updateRepushProgress(pool));
  every("capture purge", 3_600_000, () => purgeSwitchCaptures(pool, CAPTURE_KEEP_DAYS));
}
