// Exchange rates on an EUR base (team trial round 2): the provider settings (admin only, the key never
// returned), a refresh, and currency alerts by % or amount with an e-mail and an event.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { bigEnough, checkProvider, fires, referenceRate, runFxRefresh, sourceQuote } from "../src/api/fx.js";
import { dailyMoments, platformDateTime } from "../src/platform.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
after(async () => {
  await app.close();
  await closeDb();
});
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

test("an alert fires on the % or the amount, up or down", () => {
  assert.equal(fires({ thresholdPct: 1, thresholdAbs: null }, 1.1, 1.112), true);
  assert.equal(fires({ thresholdPct: 1, thresholdAbs: null }, 1.1, 1.105), false);
  assert.equal(fires({ thresholdPct: null, thresholdAbs: 0.5 }, 90, 89.4), true);
  assert.equal(fires({ thresholdPct: 5, thresholdAbs: 0.5 }, 90, 90.2), false);
});

test("EUR is the base: rate 1, not editable; USD has a rate per EUR", { skip }, async () => {
  const page = await call("POST", "/currency-rates/query", { limit: 50 });
  assert.equal(page.statusCode, 200, page.body);
  const rows = page.json().rows as { iso: string; ratePerEur: number }[];
  assert.equal(rows.find((r) => r.iso === "EUR")?.ratePerEur, 1);
  const usd = rows.find((r) => r.iso === "USD")!;
  assert.ok(usd.ratePerEur > 0.8 && usd.ratePerEur < 1.4, `USD ${usd.ratePerEur} per EUR`);
  assert.equal((await call("PUT", "/currency-rates/EUR", { ratePerEur: 1.2 })).statusCode, 400);
});

const settings = (over: Record<string, unknown> = {}) => ({
  provider: "openexchangerates",
  label: null,
  apiUrl: "https://openexchangerates.org/api/latest.json",
  authType: "query",
  authParam: "app_id",
  accountId: null,
  ratesPath: "rates",
  baseCurrency: "USD",
  refreshMinutes: 60,
  minChangeMode: "percent",
  minChange: 0.5,
  dailyUpdateAt: "06:00",
  enabled: true,
  ...over,
});

test("minimum change: by % of the current rate or by amount; 0 = any change (team trial round 3)", () => {
  assert.equal(bigEnough("percent", 0.5, 1.1, 1.1055), true);
  assert.equal(bigEnough("percent", 0.5, 1.1, 1.104), false);
  assert.equal(bigEnough("amount", 0.01, 1.1, 1.0899), true);
  assert.equal(bigEnough("amount", 0.01, 1.1, 1.095), false);
  assert.equal(bigEnough("percent", 0, 1.1, 1.1000001), true);
  assert.equal(bigEnough("percent", 0, 1.1, 1.1), false);
});

test("daily time: last and next moment in the platform time zone", () => {
  const now = Date.parse("2026-10-20T10:00:00Z");
  const { last, next } = dailyMoments("06:00", now);
  assert.ok(last <= now && next > now && next - last >= 23 * 3600_000 && next - last <= 25 * 3600_000);
  assert.equal(platformDateTime(last).slice(11), "06:00");
  assert.equal(platformDateTime(next).slice(11), "06:00");
});

test("source settings are checked: URL, key placement, custom name", () => {
  assert.deepEqual(checkProvider(settings() as never), []);
  assert.equal(checkProvider(settings({ apiUrl: null }) as never)[0]!.path, "/apiUrl");
  assert.equal(checkProvider(settings({ authType: "path" }) as never)[0]!.path, "/apiUrl");
  assert.equal(checkProvider(settings({ authParam: "" }) as never)[0]!.path, "/authParam");
  assert.equal(checkProvider(settings({ provider: "custom" }) as never)[0]!.path, "/label");
  assert.deepEqual(checkProvider(settings({ provider: "ecb", apiUrl: null, authType: "none" }) as never), []);
});

test("provider settings: any source, key stored and never returned", { skip }, async () => {
  const before = (await call("GET", "/exchange-rates/provider")).json();
  assert.ok(before.presets.some((p: { provider: string }) => p.provider === "fixer"));
  const saved = await call("PUT", "/exchange-rates/provider", settings({ apiKey: "not-a-real-key" }));
  assert.equal(saved.statusCode, 200, saved.body);
  const body = saved.json();
  assert.equal(body.apiKeySet, true);
  assert.equal(body.provider, "openexchangerates");
  assert.equal(body.minChange, 0.5);
  assert.ok(body.nextDailyAt, "the next daily update is scheduled");
  assert.ok(!JSON.stringify(body).includes("not-a-real-key"), "the key never comes back");
  const bad = await call("PUT", "/exchange-rates/provider", settings({ apiUrl: "not a url" }));
  assert.equal(bad.statusCode, 400);
  const {
    presets: _p,
    apiKeySet,
    simulated: _s,
    timezone: _t,
    lastRunAt: _a,
    lastStatus: _b,
    lastMessage: _c,
    nextRunAt: _d,
    lastDailyAt: _e,
    nextDailyAt: _f,
    updatedBy: _g,
    updatedAt: _h,
    ...restore
  } = before;
  await call("PUT", "/exchange-rates/provider", { ...restore, apiKey: apiKeySet ? undefined : "" });
});

test("scheduler: hourly check changes only big moves, the daily update takes every rate", { skip }, async () => {
  const pool = db();
  const { rows: saved } = await pool.query("SELECT * FROM fx_provider WHERE id = 1");
  const latest = async () =>
    Object.fromEntries(
      (await pool.query("SELECT iso, rate_per_eur FROM currency_latest WHERE iso <> 'EUR'")).rows.map((r) => [
        String(r.iso).trim(),
        Number(r.rate_per_eur),
      ]),
    );
  try {
    const now = Date.now();
    const lastDaily = new Date(dailyMoments("06:00", now).last + 60_000);
    // A threshold no simulated move reaches (they stay within ±0.6 %): the check changes nothing.
    await pool.query(
      `UPDATE fx_provider SET provider = 'fixer', enabled = true, refresh_minutes = 60, min_change_mode = 'percent',
              min_change = 50, daily_update_at = '06:00', last_run_at = NULL, last_daily_at = $1 WHERE id = 1`,
      [lastDaily],
    );
    const a = await latest();
    assert.equal(await runFxRefresh(pool, now), "check");
    assert.deepEqual(await latest(), a, "nothing moved 50 %");
    assert.equal(await runFxRefresh(pool, now + 60_000), null, "not due again within the hour");
    // The daily time passed since the last daily update: every rate is taken.
    await pool.query("UPDATE fx_provider SET last_daily_at = $1 WHERE id = 1", [
      new Date(lastDaily.getTime() - 86_400_000),
    ]);
    // One rate set away from the source's quote: the daily update takes the quote again.
    const iso = Object.keys(a)[0]!;
    await pool.query("INSERT INTO currency_rates (iso, rate_per_eur, valid_from) VALUES ($1, $2, now())", [
      iso,
      a[iso]! * 1.03,
    ]);
    const before = Date.now();
    assert.equal(await runFxRefresh(pool, now + 120_000), "daily");
    const b = await latest();
    const { rows: first } = await pool.query(
      "SELECT rate_per_eur FROM currency_rates WHERE iso = $1 ORDER BY valid_from LIMIT 1",
      [iso],
    );
    // The quote is the same all hour; either side of an hour turning over during the update counts.
    const quotes = [before, Date.now()].map((t) =>
      sourceQuote("fixer", iso, referenceRate(iso, Number(first[0].rate_per_eur)), t),
    );
    assert.ok(
      quotes.some((q) => Math.abs(b[iso]! - q) < 1e-6),
      `the daily update took the source's quote: ${b[iso]} vs ${quotes.join(" / ")}`,
    );
    const { rows } = await pool.query("SELECT last_message FROM fx_provider WHERE id = 1");
    assert.match(String(rows[0].last_message), /Daily update/);
  } finally {
    const p = saved[0];
    await pool.query(
      `UPDATE fx_provider SET provider = $1, enabled = $2, refresh_minutes = $3, min_change_mode = $4, min_change = $5,
              daily_update_at = $6, last_run_at = $7, last_daily_at = $8 WHERE id = 1`,
      [
        p.provider,
        p.enabled,
        p.refresh_minutes,
        p.min_change_mode,
        p.min_change,
        p.daily_update_at,
        p.last_run_at,
        p.last_daily_at,
      ],
    );
  }
});

test("a sync checks the alerts: a tiny threshold fires and e-mails", { skip }, async () => {
  const rule = await call("POST", "/exchange-rates/alerts", {
    iso: "GBP",
    thresholdPct: null,
    thresholdAbs: 0.00000001,
    window: "update",
    recipients: ["fx-test@demo.example"],
    enabled: true,
  });
  assert.equal(rule.statusCode, 201, rule.body);
  const id = rule.json().id;
  const bad = await call("POST", "/exchange-rates/alerts", {
    iso: "EUR",
    thresholdPct: null,
    thresholdAbs: null,
    window: "update",
    recipients: [],
    enabled: true,
  });
  assert.equal(bad.statusCode, 400);
  const sync = await call("POST", "/currency-rates/sync");
  assert.equal(sync.statusCode, 200, sync.body);
  const events = (await call("GET", "/exchange-rates/alerts/events?limit=5")).json();
  const ev = events.find((e: { ruleId: number }) => e.ruleId === id);
  assert.ok(ev, "the GBP alert fired");
  assert.equal(ev.emailed, 1);
  const { rows } = await db().query(
    "SELECT subject FROM email_logs WHERE email_type = 'currency_alert' ORDER BY id DESC LIMIT 1",
  );
  assert.match(String(rows[0].subject), /GBP/);
  assert.equal((await call("DELETE", `/exchange-rates/alerts/${id}`)).statusCode, 204);
  if (sync.json().change) await call("POST", `/changes/${sync.json().change.id}/undo`, {});
});

test("a source quotes the same rate all hour, near the anchor; sources differ slightly (team trial round 2)", () => {
  const h = Date.UTC(2026, 9, 21, 9, 0, 0);
  const q = sourceQuote("xe", "USD", 1.09, h + 60_000);
  assert.equal(sourceQuote("xe", "USD", 1.09, h + 59 * 60_000), q, "same quote within the hour");
  for (let i = 0; i < 24 * 60; i++) {
    const v = sourceQuote("xe", "USD", 1.09, h + i * 3_600_000);
    assert.ok(Math.abs(v / 1.09 - 1) <= 0.0071, `stays near the anchor: ${v}`);
  }
  const ecb = sourceQuote("ecb", "USD", 1.09, h);
  assert.ok(Math.abs(ecb / sourceQuote("xe", "USD", 1.09, h) - 1) <= 0.002, "sources within 0.2 % of each other");
});
