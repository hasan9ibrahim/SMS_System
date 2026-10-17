import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RateBulkRow } from "@sms/contract";
import { applyItems, evalCell, impact, noEdits, parseCodes, parseScope, review, scopeUrl, visible } from "./bulkModel";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const row = (key: string, over: Partial<RateBulkRow> = {}): RateBulkRow => ({
  key,
  rateTableId: 1,
  table: "ALPHA_OTP_EUR",
  kind: "customer",
  currency: "EUR",
  clients: "Alpha Ltd",
  noticeDays: null,
  mccmnc: "26201",
  country: "Germany",
  countryIso: "DE",
  network: "Telekom",
  senderId: null,
  lineId: 10,
  currentRate: 0.05,
  blocked: false,
  edit: "set",
  newRate: 0.055,
  newBlocked: null,
  effectiveFrom: new Date(NOW).toISOString(),
  change: "increase",
  cost: 0.04,
  costVendor: "Vega",
  currentMarginPct: 20,
  newMarginPct: 27.3,
  changePct: 10,
  belowCost: false,
  noticeBreach: false,
  noticeAdjusted: false,
  messages7d: 1000,
  revenue7d: 50,
  margin7d: 10,
  revenueChange7d: 5,
  toPlatform: 1,
  note: null,
  ...over,
});

describe("bulk rating model (§13.11)", () => {
  test("scope in the URL", () => {
    const s = parseScope("?tables=3,1,x,3&mccmnc=26201,abc&country=de,FRA");
    assert.deepEqual(s, { tables: [3, 1], mccmncs: ["26201"], countries: ["DE"] });
    assert.equal(scopeUrl({ tables: [1, 2], countries: ["DE"] }), "/rates/bulk?tables=1,2&country=DE");
    assert.equal(scopeUrl({}), "/rates/bulk");
  });
  test("pasted destination lists", () => {
    assert.deepEqual(parseCodes("26201\n26202, de ; 26201\tGermany"), {
      mccmncs: ["26201", "26202"],
      countries: ["DE"],
      invalid: ["Germany"],
    });
  });
  test("cell formulas", () => {
    const v = { cost: 0.04, rate: 0.05 };
    assert.equal(evalCell("0.061", v), 0.061);
    assert.equal(evalCell("0,061", v), 0.061);
    assert.equal(evalCell("=cost*1.15", v), 0.046);
    assert.equal(evalCell("=rate + 0.002", v), 0.052);
    assert.equal(evalCell("=(cost+0.01)*2", v), 0.1);
    assert.equal(evalCell("=cost*", v), null);
    assert.equal(evalCell("=cost*1.1", { cost: null, rate: 0.05 }), null);
    assert.equal(evalCell("=rate-1", v), null, "never below zero");
    assert.equal(evalCell("abc", v), null);
  });
  test("typed rates and exclusions recompute the flags and the impact", () => {
    const rows = [
      row("a"),
      row("b", { noticeDays: 30, lineId: 11 }),
      row("c", { edit: "close", change: "close", newRate: null, lineId: 12 }),
      row("d", { lineId: null, currentRate: null, change: "new", revenueChange7d: 0, messages7d: 0, revenue7d: 0 }),
    ];
    const edits = noEdits();
    edits.rates.set("a", 0.03);
    edits.rates.set("b", 0.06);
    edits.excluded.add("d");
    const r = review(rows, edits, NOW);
    assert.equal(r[0]!.change, "decrease");
    assert.equal(r[0]!.belowCost, true);
    assert.equal(r[0]!.revenueChange7d, -20);
    assert.equal(r[1]!.noticeBreach, true, "an increase sooner than 30 days' notice");
    const t = impact(r);
    assert.equal(t.applying, 3);
    assert.equal(t.excluded, 1);
    assert.deepEqual([t.up, t.down, t.closed, t.new], [1, 1, 1, 0]);
    assert.equal(t.belowCost, 1);
    assert.equal(t.revenueChange7d, -20 + 10 - 50);
    assert.equal(t.marginChange7d, -20 + 10 - 10);
    assert.equal(visible(r, "flagged", "").length, 2);
    assert.equal(visible(r, "excluded", "").length, 1);
    assert.equal(visible(r, "all", "telekom").length, 4);
  });
  test("apply items: new lines by MCCMNC, past start times mean now", () => {
    const rows = review(
      [
        row("a", { effectiveFrom: new Date(NOW - 600_000).toISOString() }),
        row("b", { lineId: null, currentRate: null, change: "new", effectiveFrom: new Date(NOW + DAY).toISOString() }),
        row("c", { edit: "block", change: "block", newBlocked: true, lineId: 12 }),
        row("d", { edit: "none", change: "same" }),
      ],
      noEdits(),
      NOW,
    );
    assert.deepEqual(applyItems(rows, NOW), [
      { rateTableId: 1, action: "set", lineId: 10, rate: 0.055 },
      {
        rateTableId: 1,
        action: "set",
        mccmnc: "26201",
        senderId: null,
        rate: 0.055,
        effectiveFrom: rows[1]!.effectiveFrom,
      },
      { rateTableId: 1, action: "block", lineId: 12, blocked: true },
    ]);
  });
});

const DAY = 86_400_000;
