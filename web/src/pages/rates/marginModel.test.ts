import { test } from "node:test";
import assert from "node:assert/strict";
import { blankDeal, dealCsv, dealSummary, lineFigures } from "./marginModel";

test("margin calculator: per day, per period and netting (team trial round 3)", () => {
  const line = { destination: "Ethiopia", mccmnc: null, cost: 0.018, rate: 0.019, messages: 1_000_000 };
  const f = lineFigures(line, 30);
  assert.equal(f.marginPerSms, 0.001);
  assert.equal(f.totalCost, 18_000);
  assert.equal(f.totalMargin, 1_000);
  assert.equal(f.smsPerDay, 33_333.333333);
  const d = {
    ...blankDeal(),
    carrierName: "Fake Carrier",
    outbound: [line],
    inbound: [{ destination: "Sudan Zain", mccmnc: null, cost: 0.01185, rate: 0.0125, messages: 1_400_000 }],
  };
  const s = dealSummary(d);
  assert.equal(s.totalMargin, 1_910);
  assert.equal(s.netting, 500, "outbound cost 18,000 − inbound revenue 17,500: we pay the carrier");
  assert.match(dealCsv(d), /We pay Fake Carrier,500/);
});
