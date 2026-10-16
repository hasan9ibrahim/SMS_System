// The best-buy view (migration 004): cheapest current vendor rate per destination and
// product category (§13.12), and the per-table counts built on it (rate_table_stats). Both
// are refreshed in the background after vendor rate changes and every few minutes, so lists
// read them without recomputing 1.4 M rate lines.
import { db } from "../db.js";

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;

async function refresh() {
  try {
    await db().query("REFRESH MATERIALIZED VIEW CONCURRENTLY best_buy_rates");
    // Negative-margin counts of every sell table follow the new best buy.
    await db().query("SELECT refresh_rate_table_stats()");
  } catch {
    // The view is rebuilt by the next refresh; a missing database is reported elsewhere.
  }
}

/** Refresh soon; several calls in a row lead to one refresh. */
export function scheduleBestBuyRefresh(delayMs = 1000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    running = (running ?? Promise.resolve()).then(refresh).finally(() => (running = null));
  }, delayMs);
  timer.unref();
}

/** Waits for a pending refresh (tests). */
export async function bestBuySettled(): Promise<void> {
  while (timer || running) await (running ?? new Promise((r) => setTimeout(r, 50)));
}

/** Periodic refresh, so "valid now" in the view follows the clock (scheduled rates start). */
export function startBestBuyRefresh(everyMs = 5 * 60_000): () => void {
  const id = setInterval(() => scheduleBestBuyRefresh(0), everyMs);
  id.unref();
  return () => clearInterval(id);
}
