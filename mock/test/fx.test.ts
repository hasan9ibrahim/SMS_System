// Exchange rates on an EUR base (team trial round 2): the provider settings (admin only, the key never
// returned), a refresh, and currency alerts by % or amount with an e-mail and an event.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { fires } from "../src/api/fx.js";

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

test("provider settings: key stored, never returned", { skip }, async () => {
  const before = (await call("GET", "/exchange-rates/provider")).json();
  assert.equal(before.refreshMinutes > 0, true);
  const saved = await call("PUT", "/exchange-rates/provider", {
    provider: "xe",
    accountId: "demo-account",
    apiKey: "not-a-real-key",
    refreshMinutes: 60,
    enabled: true,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const body = saved.json();
  assert.equal(body.apiKeySet, true);
  assert.ok(!JSON.stringify(body).includes("not-a-real-key"), "the key never comes back");
  await call("PUT", "/exchange-rates/provider", {
    provider: before.provider,
    accountId: before.accountId,
    apiKey: before.apiKeySet ? undefined : "",
    refreshMinutes: before.refreshMinutes,
    enabled: before.enabled,
  });
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
