import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MarketMoveVendor } from "@sms/contract";
import { moveLabel, updateRatesUrl, vendorChart } from "./marketModel";

const colors = {
  text: "#000",
  secondary: "#777",
  border: "#ddd",
  accent: "#36c",
  good: "#3a3",
  warning: "#c90",
  error: "#c33",
  panel: "#fff",
  series: ["#36c", "#c48", "#73e", "#09a"],
};
const vendor = (name: string, moved: boolean): MarketMoveVendor => ({
  vendorTrunkId: 1,
  vendorTrunk: name,
  vendor: "V",
  tier: "tier1",
  moved,
  oldRate: 0.05,
  newRate: 0.055,
  changePct: 10,
  effectiveFrom: null,
  series: [
    { at: "2026-08-01T00:00:00.000Z", rate: 0.05 },
    { at: "2026-10-20T00:00:00.000Z", rate: 0.055 },
  ],
});

describe("market move model (§13.14)", () => {
  test("labels", () => {
    assert.equal(moveLabel({ direction: "up", avgChangePct: 8.42 }), "↑ +8.4 %");
    assert.equal(moveLabel({ direction: "down", avgChangePct: -5 }), "↓ -5.0 %");
  });
  test("chart: moved vendors solid, others dashed, lines carried to now", () => {
    const o = vendorChart(
      [vendor("A", true), vendor("B", false)],
      colors,
      "EUR",
      Date.parse("2026-11-01T00:00:00Z"),
    ) as {
      series: { lineStyle: { type?: string }; data: number[][]; color: string }[];
    };
    assert.equal(o.series[0]!.lineStyle.type, undefined);
    // §15.3: a vendor line is never painted in the good / warning / problem colours.
    assert.equal(o.series[0]!.color, colors.series[0]);
    assert.equal(o.series[1]!.lineStyle.type, "dashed");
    assert.equal(o.series[0]!.data.length, 3, "extended past the last change");
  });
  test("update rates link", () => {
    assert.equal(updateRatesUrl({ id: 7, mccmnc: "26201" }, [1, 2]), "/rates/bulk?move=7&tables=1,2&mccmnc=26201");
  });
});
