import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LcrTable } from "@sms/contract";
import { blankProfile, lcrCsv, nextMonday, profileProblems } from "./lcrModel";

describe("LCR model (§13.23)", () => {
  test("next Monday", () => {
    assert.equal(nextMonday(new Date("2026-10-17T12:00:00Z")).toISOString(), "2026-10-19T00:00:00.000Z");
    assert.equal(nextMonday(new Date("2026-10-19T08:00:00Z")).toISOString(), "2026-10-26T00:00:00.000Z");
  });
  test("profile checks", () => {
    assert.deepEqual(Object.keys(profileProblems(blankProfile())), ["name"]);
    const p = { ...blankProfile(), name: "x", split: "percentage" as const, vendorCount: 2, shares: [60, 30] };
    assert.equal(profileProblems(p).shares, "shares add up to 90 %, not 100 %");
    assert.deepEqual(profileProblems({ ...p, shares: [60, 40] }), {});
  });
  test("CSV export", () => {
    const t = {
      currency: "EUR",
      rows: [
        {
          rank: 1,
          vendorTrunk: 'A "x"',
          vendor: "V",
          tier: "tier1",
          cost: 0.01,
          rate: 0.011,
          currency: "USD",
          effectiveFrom: "2026-10-01T00:00:00Z",
          nextRate: null,
          nextFrom: null,
          asr: 90,
          dlr: 80,
          delayS: 4,
          tpsNow: null,
          tpsLimit: 100,
          routedNow: 2,
          score: null,
          pick: true,
          share: null,
          excluded: null,
        },
      ],
    } as unknown as LcrTable;
    const csv = lcrCsv(t).split("\n");
    assert.equal(csv.length, 2);
    assert.ok(csv[1]!.startsWith('1,"A ""x""",V,tier1,0.01'));
  });
});
