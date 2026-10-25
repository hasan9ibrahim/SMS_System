// Exchange rates against EUR, the base currency (team trial round 2): the source (any rate API: XE, Open
// Exchange Rates, Fixer, ExchangeRate-API, the ECB, a custom JSON URL, or manual entry; round 3), the hourly
// check that only changes rates which moved at least the minimum change, the daily update that takes every
// rate whatever the difference, and currency alerts. Production calls the source's API (api/fxFetch.ts, backend
// step 11); elsewhere each source's quote is simulated (sourceQuote) and the system takes that quote. The API key is admin-only, stored encrypted and never returned (§13.22).
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  FxAlertEvent,
  FxAlertRule,
  FxAlertRuleInput,
  FxProvider,
  FxProviderPreset,
  FxProviderUpdate,
} from "@sms/contract";
import { dailyMoments, PLATFORM_TIMEZONE } from "../platform.js";
import { CURRENCIES } from "../generator/reference.js";
import { decryptSecret, encryptSecret } from "../admin/passwords.js";
import { db, withDb } from "../db.js";
import { sendProblem } from "../problem.js";
import { logEmail } from "./emailLog.js";
import { fetchQuotes, type FxSource } from "./fxFetch.js";
import { production } from "../mode.js";
import type { Change } from "@sms/contract";
import { isAdmin, iso, recordChange } from "./records.js";
import { getCurrentUser } from "./session.js";
import { inTransaction } from "./views.js";

type Db = pg.Pool | pg.PoolClient;
const forbidden = (reply: FastifyReply) =>
  sendProblem(reply, 403, "Only administrators can see or change the exchange-rate provider");

// ---------------------------------------------------------------- sources

/** Known rate APIs and their defaults (team trial round 3: any platform, not only XE). */
export const FX_PRESETS: FxProviderPreset[] = [
  {
    provider: "xe",
    label: "XE Currency Data API (xe.com)",
    apiUrl: "https://xecdapi.xe.com/v1/convert_from.json?from={base}&to=*",
    authType: "basic",
    authParam: null,
    ratesPath: "to",
    baseCurrency: "EUR",
    note: "Paid. Account ID and API key (basic auth). Plan decides freshness: daily, hourly or every minute.",
  },
  {
    provider: "openexchangerates",
    label: "Open Exchange Rates",
    apiUrl: "https://openexchangerates.org/api/latest.json",
    authType: "query",
    authParam: "app_id",
    ratesPath: "rates",
    baseCurrency: "USD",
    note: "Free plan quotes against USD, hourly; paid plans allow EUR and faster updates.",
  },
  {
    provider: "fixer",
    label: "Fixer (fixer.io)",
    apiUrl: "https://data.fixer.io/api/latest",
    authType: "query",
    authParam: "access_key",
    ratesPath: "rates",
    baseCurrency: "EUR",
    note: "Quotes against EUR. Hourly to every minute depending on the plan.",
  },
  {
    provider: "exchangerate_api",
    label: "ExchangeRate-API",
    apiUrl: "https://v6.exchangerate-api.com/v6/{key}/latest/{base}",
    authType: "path",
    authParam: null,
    ratesPath: "conversion_rates",
    baseCurrency: "EUR",
    note: "Key in the URL. Daily on the free plan, hourly or faster on paid plans.",
  },
  {
    provider: "ecb",
    label: "European Central Bank (free)",
    apiUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
    authType: "none",
    authParam: null,
    ratesPath: null,
    baseCurrency: "EUR",
    note: "Free reference rates against EUR, published once a working day around 16:00 CET (XML).",
  },
  {
    provider: "custom",
    label: "Custom JSON API",
    apiUrl: null,
    authType: "query",
    authParam: "access_key",
    ratesPath: "rates",
    baseCurrency: "EUR",
    note: "Any API that returns a JSON object of currency -> rate. Set the URL, how the key is sent and the path.",
  },
  {
    provider: "manual",
    label: "Manual (rates typed in)",
    apiUrl: null,
    authType: "none",
    authParam: null,
    ratesPath: null,
    baseCurrency: "EUR",
    note: "No automatic checks; rates are typed in on Currencies.",
  },
];

/** Whether a checked rate differs enough from the one in the system to replace it. */
export function bigEnough(mode: "percent" | "amount", min: number, current: number, checked: number): boolean {
  if (!(min > 0)) return checked !== current;
  const diff = Math.abs(checked - current);
  if (mode === "amount") return diff >= min - 1e-12;
  return current > 0 && (diff / current) * 100 >= min - 1e-9;
}

// ---------------------------------------------------------------- refresh

export interface RateMove {
  id: number;
  iso: string;
  before: number;
  after: number;
}

export interface RefreshResult {
  checked: number;
  updated: number;
  change: Change | null;
}

/**
 * Checks the source (simulated: each currency moves up to ±0.6 % against EUR) and saves the rates that moved
 * at least the minimum change, or all of them when `force` (daily update, Sync Rates), as one undoable change,
 * then checks the currency alerts. Shared by Sync Rates, the hourly check and the daily update.
 */
/** A stable 0..1 number for a text (FNV-1a). */
function unit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/**
 * The rate per EUR a source's quotes stay around: the fake data's reference value (the seed's latest day, from
 * the generator's currency list), or for a currency added later its first stored rate.
 */
export function referenceRate(iso: string, fallback: number): number {
  const eur = CURRENCIES.find((c) => c.iso === "EUR")!.perUsd;
  const c = CURRENCIES.find((x) => x.iso === iso);
  return c ? Number((c.perUsd / eur).toFixed(8)) : fallback;
}

/**
 * What a rate source quotes for one EUR in `iso` at `now` (this phase never calls a rate API). The same
 * source gives the same quote all hour; the quote moves slowly within ±0.6 % of the currency's reference rate
 * (the reference rate), and each source differs from the others by at most 0.1 %, as real sources do.
 */
export function sourceQuote(provider: string, iso: string, anchor: number, now = Date.now()): number {
  if (!(anchor > 0)) return anchor;
  const hour = Math.floor(now / 3_600_000);
  const wave = Math.sin((2 * Math.PI * hour) / (90 + Math.floor(unit(iso) * 60)) + unit(iso) * 6.283);
  const bias = (unit(`${provider}:${iso}`) - 0.5) * 0.002;
  return Number((anchor * (1 + 0.006 * wave + bias)).toFixed(8));
}

export async function refreshRates(
  pool: pg.Pool,
  by: { userId: number | null; ip: string | null; note: string },
  opts: { force: boolean; mode?: "percent" | "amount"; min?: number } = { force: true },
): Promise<RefreshResult> {
  // The rate each currency gets is what the selected source quotes now (simulated, see sourceQuote), not a
  // random step from the current rate, so rates follow the source and do not drift (team trial round 2).
  const { rows } = await pool.query(
    `SELECT c.id, c.iso, cl.rate_per_eur,
            (SELECT r.rate_per_eur FROM currency_rates r WHERE r.iso = c.iso ORDER BY r.valid_from LIMIT 1) AS anchor,
            COALESCE((SELECT p.provider FROM fx_provider p WHERE p.id = 1), 'xe') AS provider
       FROM currencies c JOIN currency_latest cl ON cl.iso = c.iso
      WHERE c.deleted_at IS NULL AND c.iso <> 'EUR' ORDER BY c.iso`,
  );
  const now = Date.now();
  // Production (backend step 11): the source's real quotes; a currency it does not quote keeps its rate.
  const provider = String(rows[0]?.provider ?? "manual");
  const real = production && provider !== "manual" ? await fetchQuotes(await sourceOf(pool)) : null;
  const checked: RateMove[] = rows.map((r) => {
    const before = Number(r.rate_per_eur);
    const code = String(r.iso).trim();
    // Manual entry: nothing to fetch, the rates stay as typed.
    const after =
      r.provider === "manual"
        ? before
        : real
          ? (real.get(code) ?? before)
          : sourceQuote(String(r.provider), code, referenceRate(code, Number(r.anchor ?? before)), now);
    return { id: Number(r.id), iso: code, before, after };
  });
  const moves = checked.filter(
    (m) => m.after !== m.before && (opts.force || bigEnough(opts.mode ?? "percent", opts.min ?? 0, m.before, m.after)),
  );
  if (!moves.length) return { checked: checked.length, updated: 0, change: null };
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
      note: by.note.replace("{n}", String(moves.length)),
      userId: by.userId ?? (await systemUser(c)),
      ip: by.ip,
    });
    await checkFxAlerts(c, moves);
    return ch;
  });
  return { checked: checked.length, updated: moves.length, change };
}

/** The configured rate source with its API key (production calls it). */
async function sourceOf(c: Db): Promise<FxSource> {
  const { rows } = await c.query("SELECT * FROM fx_provider WHERE id = 1");
  const p = rows[0] ?? {};
  const preset = FX_PRESETS.find((x) => x.provider === p.provider);
  return {
    provider: String(p.provider ?? "manual"),
    apiUrl: (p.api_url as string | null) ?? preset?.apiUrl ?? null,
    authType: String(p.auth_type ?? preset?.authType ?? "none"),
    authParam: (p.auth_param as string | null) ?? preset?.authParam ?? null,
    accountId: (p.account_id as string | null) ?? null,
    ratesPath: (p.rates_path as string | null) ?? preset?.ratesPath ?? null,
    baseCurrency: String(p.base_currency ?? preset?.baseCurrency ?? "EUR").trim(),
    apiKey: p.api_key_enc ? decryptSecret(String(p.api_key_enc)) : null,
  };
}

async function systemUser(c: Db): Promise<number> {
  const { rows } = await c.query("SELECT id FROM users ORDER BY id LIMIT 1");
  return Number(rows[0].id);
}

// ---------------------------------------------------------------- provider

const sourceLabel = (p: { provider: string; label: string | null }) =>
  p.provider === "custom" && p.label
    ? p.label
    : (FX_PRESETS.find((x) => x.provider === p.provider)?.label ?? p.provider);

async function loadProvider(c: Db, now = Date.now()): Promise<FxProvider> {
  const { rows } = await c.query(
    `SELECT p.*, u.username AS updated_by FROM fx_provider p LEFT JOIN users u ON u.id = p.updated_by_id WHERE p.id = 1`,
  );
  const p = rows[0] ?? { provider: "xe", refresh_minutes: 60, enabled: true, auth_type: "basic", base_currency: "EUR" };
  const keySet = !!p.api_key_enc && !!decryptSecret(String(p.api_key_enc));
  const last = p.last_run_at ? new Date(p.last_run_at).getTime() : null;
  const auto = !!p.enabled && p.provider !== "manual";
  const daily = (p.daily_update_at as string | null) ?? null;
  return {
    provider: p.provider,
    label: p.label ?? null,
    apiUrl: p.api_url ?? null,
    authType: p.auth_type ?? "none",
    authParam: p.auth_param ?? null,
    accountId: p.account_id ?? null,
    ratesPath: p.rates_path ?? null,
    baseCurrency: String(p.base_currency ?? "EUR").trim(),
    apiKeySet: keySet,
    refreshMinutes: Number(p.refresh_minutes) as FxProvider["refreshMinutes"],
    minChangeMode: p.min_change_mode ?? "percent",
    minChange: Number(p.min_change ?? 0),
    dailyUpdateAt: daily,
    enabled: !!p.enabled,
    // Production calls the rate API (backend step 11); elsewhere the quotes are simulated.
    simulated: !production,
    timezone: PLATFORM_TIMEZONE,
    lastRunAt: iso(p.last_run_at),
    lastStatus: p.last_status ?? null,
    lastMessage: p.last_message ?? null,
    nextRunAt: auto ? new Date((last ?? now) + Number(p.refresh_minutes) * 60_000).toISOString() : null,
    lastDailyAt: iso(p.last_daily_at),
    nextDailyAt: auto && daily ? new Date(dailyMoments(daily, now).next).toISOString() : null,
    presets: FX_PRESETS,
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

export function checkProvider(b: FxProviderUpdate): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  if (b.provider !== "manual" && b.provider !== "ecb" && !b.apiUrl?.trim())
    errors.push({ path: "/apiUrl", message: "required: the URL that returns the latest rates" });
  if (b.apiUrl?.trim() && !/^https?:\/\/\S+$/.test(b.apiUrl.trim()))
    errors.push({ path: "/apiUrl", message: "an http(s) URL" });
  if (b.authType === "path" && b.apiUrl && !b.apiUrl.includes("{key}"))
    errors.push({ path: "/apiUrl", message: "put {key} where the API key goes" });
  if ((b.authType === "query" || b.authType === "header") && !b.authParam?.trim())
    errors.push({ path: "/authParam", message: `the ${b.authType === "query" ? "parameter" : "header"} name` });
  if (b.provider === "custom" && !b.label?.trim()) errors.push({ path: "/label", message: "name the source" });
  if (b.minChangeMode === "percent" && b.minChange > 100) errors.push({ path: "/minChange", message: "at most 100 %" });
  return errors;
}

export function updateFxProvider(request: FastifyRequest, reply: FastifyReply) {
  const b = request.body as FxProviderUpdate;
  return withDb(reply, async (pool) => {
    const me = await getCurrentUser();
    if (!isAdmin(me)) return forbidden(reply);
    const errors = checkProvider(b);
    if (errors.length) return sendProblem(reply, 400, "Check the highlighted fields", { errors });
    const key = b.apiKey === undefined || b.apiKey === null ? undefined : b.apiKey.trim();
    await pool.query(
      `UPDATE fx_provider SET provider = $1, account_id = $2, refresh_minutes = $3, enabled = $4,
              api_key_enc = CASE WHEN $5::boolean THEN $6 ELSE api_key_enc END, updated_by_id = $7, updated_at = now(),
              label = $8, api_url = $9, auth_type = $10, auth_param = $11, rates_path = $12, base_currency = $13,
              min_change_mode = $14, min_change = $15, daily_update_at = $16
        WHERE id = 1`,
      [
        b.provider,
        b.accountId?.trim() || null,
        b.refreshMinutes,
        b.enabled,
        key !== undefined,
        key ? encryptSecret(key) : null,
        me.id,
        b.label?.trim() || null,
        b.apiUrl?.trim() || null,
        b.authType,
        b.authParam?.trim() || null,
        b.ratesPath?.trim() || null,
        b.baseCurrency,
        b.minChangeMode,
        b.minChange,
        b.dailyUpdateAt,
      ],
    );
    return loadProvider(pool);
  });
}

/**
 * The scheduler (checked every minute): the daily update when its time has passed today and it has not run
 * since, otherwise a check when one is due. A check only changes rates that moved at least the minimum change.
 */
export async function runFxRefresh(pool: pg.Pool, now = Date.now()): Promise<"daily" | "check" | null> {
  const p = await loadProvider(pool, now);
  if (!p.enabled || p.provider === "manual") return null;
  const source = sourceLabel(p);
  const dailyDue =
    p.dailyUpdateAt !== null &&
    (() => {
      const { last } = dailyMoments(p.dailyUpdateAt!, now);
      return !p.lastDailyAt || Date.parse(p.lastDailyAt) < last;
    })();
  const checkDue = !p.lastRunAt || now - Date.parse(p.lastRunAt) >= p.refreshMinutes * 60_000 - 5_000;
  if (!dailyDue && !checkDue) return null;
  const threshold = p.minChangeMode === "percent" ? `${p.minChange} %` : `${p.minChange} per EUR`;
  const sim = production ? "" : "simulated ";
  try {
    const r = await refreshRates(
      pool,
      {
        userId: null,
        ip: null,
        note: dailyDue
          ? `Daily update of {n} exchange rates (${sim}${source} feed)`
          : `{n} exchange rates moved ≥ ${threshold} (${sim}${source} feed)`,
      },
      { force: dailyDue, mode: p.minChangeMode, min: p.minChange },
    );
    const message = dailyDue
      ? `Daily update: ${r.updated} of ${r.checked} rates updated${production ? ` from ${source}` : ` (simulated: no call to ${source})`}`
      : `${r.checked} checked, ${r.updated} updated, ${r.checked - r.updated} below ${threshold}${production ? "" : " (simulated)"}`;
    await pool.query(
      `UPDATE fx_provider SET last_run_at = to_timestamp($2 / 1000.0), last_status = '${production ? "ok" : "simulated"}', last_message = $1,
              last_daily_at = CASE WHEN $3::boolean THEN to_timestamp($2 / 1000.0) ELSE last_daily_at END WHERE id = 1`,
      [message, now, dailyDue],
    );
  } catch (e) {
    await pool.query(
      "UPDATE fx_provider SET last_run_at = to_timestamp($2 / 1000.0), last_status = 'error', last_message = $1 WHERE id = 1",
      [String((e as Error).message).slice(0, 300), now],
    );
  }
  return dailyDue ? "daily" : "check";
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
