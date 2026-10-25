// Auto Invoicing (§12.3, §7; backend step 11): at the end of each billing cycle, in the enterprise's billing time zone,
// every customer with Auto Invoicing enabled gets its invoice for the cycle that just ended (an Invoice Request of type
// Auto, as the old platform ran shortly after midnight), and the invoice is e-mailed with its business company's
// Invoice template and the PDF attached. A cycle already invoiced (by hand or an earlier run) is skipped.
//
// Cycles (Billing Cycle page): daily = yesterday; weekly = the 7 days before its week day (default Monday);
// fortnightly = the 14 days before its week day, every other week (even ISO weeks); monthly = last calendar month;
// custom = blocks of Usage Days counted from 2026-01-01. Due date = invoice date + Due Days (runInvoiceRequest).
import type pg from "pg";
import { db } from "../db.js";
import { emailInvoice, runInvoiceRequest } from "../api/invoices.js";

const WEEK_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const CUSTOM_ANCHOR = Date.UTC(2026, 0, 1);

/** Today's date (YYYY-MM-DD) in a time zone. */
export function localDay(tz: string, now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => new Date(dayMs(d) + n * 86_400_000).toISOString().slice(0, 10);
function isoWeek(d: string): number {
  const t = new Date(dayMs(d));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

export interface Cycle {
  billingType: "custom" | "daily" | "weekly" | "fortnightly" | "monthly";
  weekDay: string | null;
  usageDays: number;
}

/** The cycle that ended yesterday when `today` is a cycle's first day; null on other days (exported for tests). */
export function endedCycle(c: Cycle, today: string): { from: string; to: string } | null {
  const yesterday = addDays(today, -1);
  const weekDay = WEEK_DAYS[new Date(dayMs(today)).getUTCDay()]!;
  const startDay = c.weekDay ?? "MON";
  switch (c.billingType) {
    case "daily":
      return { from: yesterday, to: yesterday };
    case "weekly":
      return weekDay === startDay ? { from: addDays(today, -7), to: yesterday } : null;
    case "fortnightly":
      return weekDay === startDay && isoWeek(today) % 2 === 0 ? { from: addDays(today, -14), to: yesterday } : null;
    case "monthly": {
      if (!today.endsWith("-01")) return null;
      return { from: `${yesterday.slice(0, 7)}-01`, to: yesterday };
    }
    case "custom": {
      const n = Math.max(1, c.usageDays);
      const days = Math.round((dayMs(today) - CUSTOM_ANCHOR) / 86_400_000);
      return days > 0 && days % n === 0 ? { from: addDays(today, -n), to: yesterday } : null;
    }
  }
}

/** One run: creates and runs the due Auto invoice requests, then e-mails each invoice. Returns the requests made. */
export async function runAutoInvoicing(pool: pg.Pool = db(), now = Date.now()): Promise<number> {
  const { rows } = await pool.query(
    `SELECT b.enterprise_id, b.timezone, cy.billing_type, cy.week_day, cy.usage_days
       FROM enterprise_billing b JOIN enterprises e ON e.id = b.enterprise_id AND e.deleted_at IS NULL
       JOIN billing_cycles cy ON cy.id = b.billing_cycle_id
      WHERE b.side = 'customer' AND b.auto_invoicing AND e.status = 'active'`,
  );
  let made = 0;
  for (const r of rows) {
    const tz = String(r.timezone || "UTC");
    const today = localDay(tz, now);
    const cycle = endedCycle(
      { billingType: r.billing_type, weekDay: r.week_day ?? null, usageDays: Number(r.usage_days) },
      today,
    );
    if (!cycle) continue;
    // Already invoiced or requested for this cycle (by hand, or an earlier run): nothing to do.
    const { rows: done } = await pool.query(
      `SELECT 1 FROM invoice_requests WHERE enterprise_id = $1 AND kind = 'traffic' AND NOT regenerate
          AND usage_start = $2 AND usage_end = $3 AND status <> 'failed'
       UNION ALL
       SELECT 1 FROM invoices WHERE enterprise_id = $1 AND kind = 'traffic' AND deleted_at IS NULL
          AND usage_start <= $3 AND usage_end >= $2
       LIMIT 1`,
      [r.enterprise_id, cycle.from, cycle.to],
    );
    if (done[0]) continue;
    const { rows: req } = await pool.query(
      `INSERT INTO invoice_requests (kind, invoice_type, enterprise_id, timezone, usage_start, usage_end, due_date_type,
                                     invoice_date, status)
       VALUES ('traffic', 'auto', $1, $2, $3, $4, 'auto', $5, 'pending') RETURNING id`,
      [r.enterprise_id, tz, cycle.from, cycle.to, today],
    );
    made++;
    const id = Number(req[0].id);
    await runInvoiceRequest(id);
    const { rows: out } = await pool.query("SELECT status, invoice_id FROM invoice_requests WHERE id = $1", [id]);
    if (out[0]?.status === "completed" && out[0].invoice_id) await emailInvoice(pool, Number(out[0].invoice_id));
  }
  return made;
}

/** Every 15 minutes on the server that runs the jobs. */
export function startAutoInvoicing() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runAutoInvoicing();
    } catch (err) {
      console.warn(`auto invoicing: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), 15 * 60_000).unref();
}
