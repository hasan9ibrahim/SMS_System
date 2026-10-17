import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveVisibility } from "@sms/contract";
import { blankPolicy, effectiveLine, hiddenWords, modesFor, policyProblems } from "./visibilityModel";

describe("visibility model (§13.17)", () => {
  test("bands are for margin only", () => {
    assert.ok(modesFor("margin").includes("band"));
    assert.ok(!modesFor("cost").includes("band"));
    const p = blankPolicy();
    p.items.cost.others = "band";
    p.name = "x";
    assert.ok(policyProblems(p).cost);
  });
  test("checks the name and band order", () => {
    const p = blankPolicy();
    p.thresholds.marginLowPct = 30;
    const out = policyProblems(p);
    assert.ok(out.name);
    assert.ok(out.bands);
  });
  test("summarises hidden items and the effective policy", () => {
    const p = blankPolicy();
    p.items.margin.others = "band";
    assert.equal(
      hiddenWords(p.items),
      "others: margin as bands, revenue, cost, sellRates, balances, contacts · own: nothing",
    );
    const v = {
      exempt: false,
      exemptReason: null,
      policy: { name: "Standard AM" },
      sourceName: "All account managers",
      ownEnterprises: 68,
      teamEnterprises: 0,
      grantedEnterprises: 2,
    } as unknown as EffectiveVisibility;
    assert.equal(effectiveLine(v), "Standard AM · from All account managers · 68 own + 2 granted enterprises");
    assert.equal(
      effectiveLine({ ...v, exempt: true, exemptReason: "Administrator" }),
      "Sees everything · Administrator",
    );
  });
});
