// Exchange rates against EUR, the base currency (team trial round 2): the provider (XE Currency Data API from
// xe.com, or manual entry), the scheduled refresh, and currency alerts when a rate moves by an amount or a %.
// This phase never calls XE: a refresh simulates small market moves, also when an account is set up. The API
// key is admin-only, stored encrypted and never returned (§13.22).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { FxAlertEvent, FxAlertRule, FxAlertRuleInput, FxProvider, FxProviderUpdate } from "@sms/contract";
import { decryptSecret, encryptSecret } from "../admin/passwords.js";
import { db, withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import { logEmail } from "./emailLog.js";
import type { Change } from "@sms/contract";
import { isAdmin, iso, recordChange } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
const forbidden = (reply: FastifyReply) =>
  sendProblem(reply, 403, "Only administrators can see or change the exchange-rate provider");

// ---------------------------------------------------------------- refresh

export interface RateMove {
  id: number;
  iso: string;
  before: number;
  after: number;
}

/**
 * Pulls new rates (simulated: each currency moves up to ±0.6 % against EUR), saves them as one undoable
 * change and checks the currency alerts. Shared by Sync Rates and the scheduled refresh.
 */
export async function refreshRates(
  pool: pg.Pool,
  by: { userId: number | null; ip: string | null; note: string },
): Promise<{ updated: number; change: Change | null }> {
  const { rows } = await pool.query(
    `SELECT c.id, c.iso, cl.rate_per_eur FROM currencies c JOIN currency_latest cl ON cl.iso = c.iso
      WHERE c.deleted_at IS NULL AND c.iso <> 'EUR' ORDER BY c.iso`,
  );
  const moves: RateMove[] = rows.map((r) => {
    const before = Number(r.rate_per_eur);
    const after = Number((before * (1 + (Math.random() - 0.5) * 0.012)).toFixed(8));
    return { id: Number(r.id), iso: String(r.iso).trim(), before, after };
  });
  if (!moves.length) return { updated: 0, change: null };
  const change = await inTransaction(pool, async (c) => {
    for (const m of moves)
      await c.query(
        "INSERT INTO currency_rates (iso, rate_per_eur, valid_from, updated_by_id) VALUES ($1, $2, now(), NULL)",
        [m.iso, m.after],
      );
    const ch = await recordChange(c, {
      entityType: "currency",
      entityIds: moves.map((m) => m.id),
      changeType: "edit",
      diff: moves.map((m) => ({ entity_id: m.id, field: "rate", before: m.before, after: m.after })),
      note: by.note,
      userId: by.userId ?? (await systemUser(c)),
      ip: by.ip,
    });
    await checkFxAlerts(c, moves);
    return ch;
  });
  return { updated: moves.length, change };
}

async function systemUser(c: Db): Promise<number> {
  const { rows } = await c.query("SELECT id FROM users ORDER BY id LIMIT 1");
  return Number(rows[0].id);
}

// ---------------------------------------------------------------- provider

async function loadProvider(c: Db): Promise<FxProvider> {
  const { rows } = await c.query(
    `SELECT p.*, u.username AS updated_by FROM fx_provider p LEFT JOIN users u ON u.id = p.updated_by_id WHERE p.id = 1`,
  );
  const p = rows[0] ?? { provider: "xe", refresh_minutes: 60, enabled: true };
  const keySet = !!p.api_key_enc && !!decryptSecret(String(p.api_key_enc));
  const last = p.last_run_at ? new Date(p.last_run_at).getTime() : null;
  return {
    provider: p.provider,
    accountId: p.account_id ?? null,
    apiKeySet: keySet,
    refreshMinutes: Number(p.refresh_minutes) as FxProvider["refreshMinutes"],
    enabled: !!p.enabled,
    // No call to XE in this phase: always simulated.
    simulated: true,
    lastRunAt: iso(p.last_run_at),
    lastStatus: p.last_status ?? null,
    lastMessage: p.last_message ?? null,
    nextRunAt:
      p.enabled && p.provider === "xe"
        ? new Date((last ?? Date.now()) + Number(p.refresh_minutes) * 60_000).toISOString()
        : null,
    updatedBy: p.updated_by ?? null,
    updatedAt: iso(p.updated_at),
  };
}

export function getFxProvider(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => {
    if (!isAdmin(await getCurrentUser())) return forbidden(reply);
    return loadProvider(pool);
  });
}

export function updateFxProvider(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as FxProviderUpdate;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!isAdmin(me)) return forbidden(reply);
    const key = b.apiKey === undefined || b.apiKey === null ? undefined : b.apiKey.trim();
    await pool.query(
      `UPDATE fx_provider SET provider = $1, account_id = $2, refresh_minutes = $3, enabled = $4,
              api_key_enc = CASE WHEN $5::boolean THEN $6 ELSE api_key_enc END, updated_by_id = $7, updated_at = now()
        WHERE id = 1`,
      [
        b.provider,
        b.accountId?.trim() || null,
        b.refreshMinutes,
        b.enabled,
        key !== undefined,
        key ? encryptSecret(key) : null,
        me.id,
      ],
    );
    return loadProvider(pool);
  });
}

/** One scheduled refresh when it is due (checked every minute). */
export async function runFxRefresh(pool: pg.Pool, now = Date.now()): Promise<boolean> {
  const p = await loadProvider(pool);
  if (!p.enabled || p.provider !== "xe") return false;
  if (p.lastRunAt && now - Date.parse(p.lastRunAt) < p.refreshMinutes * 60_000 - 5_000) return false;
  try {
    const r = await refreshRates(pool, {
      userId: null,
      ip: null,
      note: `Scheduled refresh of ${"{n}"} exchange rates (simulated XE feed)`,
    });
    await pool.query(
      "UPDATE fx_provider SET last_run_at = now(), last_status = 'simulated', last_message = $1 WHERE id = 1",
      [`${r.updated} rates updated (simulated: no call to XE in this phase)`],
    );
    if (r.change)
      await pool.query("UPDATE changes SET note = replace(note, '{n}', $2) WHERE id = $1", [
        r.change.id,
        String(r.updated),
      ]);
  } catch (e) {
    await pool.query(
      "UPDATE fx_provider SET last_run_at = now(), last_status = 'error', last_message = $1 WHERE id = 1",
      [String((e as Error).message).slice(0, 300)],
    );
  }
  return true;
}

export function startFxRefresh() {
  const tick = () => void runFxRefresh(db()).catch(() => undefined);
  setTimeout(tick, 90_000).unref();
  setInterval(tick, 60_000).unref();
}

// ---------------------------------------------------------------- alerts

const RULE_SQL = `SELECT r.*, u.username AS updated_by FROM fx_alert_rules r LEFT JOIN users u ON u.id = r.updated_by_id`;

function mapRule(r: Record<string, unknown>): FxAlertRule {
  return {
    id: Number(r.id),
    iso: r.iso ? String(r.iso).trim() : null,
    thresholdPct: r.threshold_pct === null ? null : Number(r.threshold_pct),
    thresholdAbs: r.threshold_abs === null ? null : Number(r.threshold_abs),
    window: r.window as FxAlertRule["window"],
    recipients: (r.recipients as string[]) ?? [],
    enabled: !!r.enabled,
    lastTriggeredAt: iso(r.last_triggered_at as Date | null),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: iso(r.updated_at as Date)!,
  };
}

function checkRule(b: FxAlertRuleInput): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  if (b.thresholdPct === null && b.thresholdAbs === null)
    errors.push({ path: "/thresholdPct", message: "give a % or an amount (or both)" });
  if (b.iso === "EUR")
    errors.push({ path: "/iso", message: "EUR is the base currency; it never moves against itself" });
  return errors;
}

export function listFxAlertRules(_request: FastifyRequest, reply: FastifyReply) {
  return withDb(reply, async (pool) => (await pool.query(`${RULE_SQL} ORDER BY r.id`)).rows.map(mapRule));
}

export function createFxAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as FxAlertRuleInput;
  return withDb(reply, async (pool) => {
    const errors = checkRule(b);
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    const me = await getCurrentUser();
    const { rows } = await pool.query(
      `INSERT INTO fx_alert_rules (iso, threshold_pct, threshold_abs, "window", recipients, enabled, updated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [b.iso, b.thresholdPct, b.thresholdAbs, b.window, b.recipients, b.enabled, me.id],
    );
    const r = await pool.query(`${RULE_SQL} WHERE r.id = $1`, [rows[0].id]);
    return reply.code(201).send(mapRule(r.rows[0]));
  });
}

export function updateFxAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  const b = request.body as FxAlertRuleInput;
  return withDb(reply, async (pool) => {
    const errors = checkRule(b);
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    const me = await getCurrentUser();
    const { rowCount } = await pool.query(
      `UPDATE fx_alert_rules SET iso = $2, threshold_pct = $3, threshold_abs = $4, "window" = $5, recipients = $6,
              enabled = $7, updated_by_id = $8, updated_at = now() WHERE id = $1`,
      [id, b.iso, b.thresholdPct, b.thresholdAbs, b.window, b.recipients, b.enabled, me.id],
    );
    if (!rowCount) return sendProblem(reply, 404, `Currency alert ${id} not found`);
    return mapRule((await pool.query(`${RULE_SQL} WHERE r.id = $1`, [id])).rows[0]);
  });
}

export function deleteFxAlertRule(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: number };
  return withDb(reply, async (pool) => {
    const { rowCount } = await pool.query("DELETE FROM fx_alert_rules WHERE id = $1", [id]);
    if (!rowCount) return sendProblem(reply, 404, `Currency alert ${id} not found`);
    return reply.code(204).send();
  });
}

export function listFxAlertEvents(request: FastifyRequest, reply: FastifyReply) {
  const { limit = 100 } = request.query as { limit?: number };
  return withDb(reply, async (pool): Promise<FxAlertEvent[]> => {
    const { rows } = await pool.query("SELECT * FROM fx_alert_events ORDER BY at DESC, id DESC LIMIT $1", [limit]);
    return rows.map((r) => ({
      id: Number(r.id),
      ruleId: Number(r.rule_id),
      iso: String(r.iso).trim(),
      fromRate: Number(r.from_rate),
      toRate: Number(r.to_rate),
      changePct: Number(r.change_pct),
      window: r.window,
      at: iso(r.at)!,
      emailed: Number(r.emailed),
    }));
  });
}

/** Whether a move fires a rule: at least the % or the amount, up or down. */
export function fires(rule: Pick<FxAlertRule, "thresholdPct" | "thresholdAbs">, from: number, to: number): boolean {
  if (!(from > 0)) return false;
  const pct = Math.abs((to - from) / from) * 100;
  const abs = Math.abs(to - from);
  return (
    (rule.thresholdPct !== null && pct >= rule.thresholdPct - 1e-9) ||
    (rule.thresholdAbs !== null && abs >= rule.thresholdAbs - 1e-12)
  );
}

/** Checks every enabled rule against the moves just saved; fired rules are logged and e-mailed. */
export async function checkFxAlerts(c: Db, moves: RateMove[]): Promise<number> {
  const { rows } = await c.query(`${RULE_SQL} WHERE r.enabled`);
  let fired = 0;
  for (const rule of rows.map(mapRule)) {
    for (const m of moves) {
      if (rule.iso && rule.iso !== m.iso) continue;
      let from = m.before;
      if (rule.window === "day") {
        const { rows: d } = await c.query(
          `SELECT r.rate_per_eur FROM currency_rates r WHERE r.iso = $1 AND r.valid_from <= now() - interval '24 hours'
            ORDER BY r.valid_from DESC LIMIT 1`,
          [m.iso],
        );
        if (!d[0]) continue;
        from = Number(d[0].rate_per_eur);
      }
      if (!fires(rule, from, m.after)) continue;
      const pct = Math.round(((m.after - from) / from) * 1e6) / 1e4;
      const subject = `Currency alert: ${m.iso} moved ${pct > 0 ? "+" : ""}${pct.toFixed(2)} % against EUR`;
      const body = [
        `${m.iso} is now ${m.after} per 1 EUR (was ${from}${rule.window === "day" ? " 24 hours ago" : " at the previous update"}).`,
        `Change: ${pct > 0 ? "+" : ""}${pct.toFixed(2)} % (${(m.after - from).toFixed(6)} ${m.iso}).`,
        "",
        `Alert: ${rule.iso ?? "any currency"} · ${[
          rule.thresholdPct !== null ? `≥ ${rule.thresholdPct} %` : null,
          rule.thresholdAbs !== null ? `≥ ${rule.thresholdAbs} ${rule.iso ?? "units"}` : null,
        ]
          .filter(Boolean)
          .join(" or ")}.`,
        "Rates in other currencies are converted with the new rate from now on; amounts already billed keep theirs.",
      ].join("\n");
      let emailed = 0;
      if (rule.recipients.length) {
        await logEmail(c, { type: "currency_alert", to: rule.recipients, subject, body, sender: null });
        emailed = rule.recipients.length;
      }
      await c.query(
        `INSERT INTO fx_alert_events (rule_id, iso, from_rate, to_rate, change_pct, "window", emailed)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rule.id, m.iso, from, m.after, pct, rule.window, emailed],
      );
      await c.query("UPDATE fx_alert_rules SET last_triggered_at = now() WHERE id = $1", [rule.id]);
      fired++;
    }
  }
  return fired;
}
