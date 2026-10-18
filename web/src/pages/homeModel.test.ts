// Home daily screens: pinned first, most used by views, recent by last opened (team trial round 1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DAILY, ago, homeEntries } from "./homeModel";

const at = (h: number) => new Date(Date.UTC(2026, 9, 18, h)).toISOString();

test("dashboard and live analytics come first, whatever the history", () => {
  const { pinned } = homeEntries([]);
  assert.deepEqual(
    pinned.map((p) => p.page.key),
    ["dashboard", "live-analytics"],
  );
});

test("most used sums views per page, records count for their list, pinned and home left out", () => {
  const { mostUsed, fromHistory } = homeEntries([
    { path: "/enterprises/12", title: "Acme Mobile", views: 4, lastAt: at(9) },
    { path: "/enterprises", title: null, views: 3, lastAt: at(8) },
    { path: "/rates/manager", title: null, views: 5, lastAt: at(7) },
    { path: "/dashboard", title: null, views: 50, lastAt: at(10) },
    { path: "/", title: null, views: 20, lastAt: at(6) },
  ]);
  assert.ok(fromHistory);
  assert.deepEqual(
    mostUsed.map((m) => [m.page.key, m.views]),
    [
      ["enterprises", 7],
      ["rate-manager", 5],
    ],
  );
});

test("without a history most used falls back to the usual daily screens", () => {
  const { mostUsed, fromHistory } = homeEntries([]);
  assert.equal(fromHistory, false);
  assert.deepEqual(
    mostUsed.map((m) => m.page.key),
    DEFAULT_DAILY,
  );
});

test("recent keeps the order, names records and skips home", () => {
  const { recent } = homeEntries([
    { path: "/enterprises/customer-trunks/7", title: "ACME_OTP", views: 1, lastAt: at(11) },
    { path: "/", title: null, views: 9, lastAt: at(10) },
    { path: "/enterprises/9", title: null, views: 1, lastAt: at(9) },
    { path: "/routing/rules", title: null, views: 2, lastAt: at(8) },
  ]);
  assert.deepEqual(
    recent.map((r) => r.label),
    ["ACME_OTP", "Enterprise #9", "Route rules"],
  );
});

test("ago reads naturally", () => {
  const now = Date.UTC(2026, 9, 18, 12);
  assert.equal(ago(new Date(now - 20_000).toISOString(), now), "just now");
  assert.equal(ago(new Date(now - 5 * 60_000).toISOString(), now), "5 min ago");
  assert.equal(ago(new Date(now - 3 * 3600_000).toISOString(), now), "3 h ago");
  assert.equal(ago(new Date(now - 30 * 3600_000).toISOString(), now), "yesterday");
});
