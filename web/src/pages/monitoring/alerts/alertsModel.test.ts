import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  activeHoursLabel,
  analyticsFor,
  blankRule,
  channelsLabel,
  conditionText,
  duration,
  fmtAlertValue,
  isMeasured,
  needsBaseline,
  needsValue,
} from "./alertsModel";

describe("alerts model (§13.6)", () => {
  test("pop-up values and conditions in words (team trial round 5)", () => {
    assert.equal(fmtAlertValue("margin", -0.02, "EUR"), "-0.02 EUR");
    assert.equal(fmtAlertValue("dlr", 61, "EUR"), "61.0 %");
    assert.equal(fmtAlertValue("attempts", 1250.4, "EUR"), "1,250");
    assert.equal(fmtAlertValue("tps", null, "EUR"), "—");
    assert.equal(conditionText("margin", { type: "below", value: 0, baseline: null }, "EUR"), "below 0.00 EUR");
    assert.equal(
      conditionText("dlr", { type: "decrease_pct", value: 20, baseline: "yesterday" }, "EUR"),
      "down 20 % vs yesterday",
    );
    assert.equal(conditionText("bind_status", { type: "bind_down", value: null, baseline: null }, "EUR"), "bind down");
    assert.equal(conditionText("dlr", null, "EUR"), null);
    assert.equal(isMeasured({ type: "stopped", value: null, baseline: null }), false);
    assert.equal(isMeasured({ type: "above", value: 5, baseline: null }), true);
  });
  test("labels and durations", () => {
    assert.equal(channelsLabel({ popup: true, sound: false, email: true }), "Pop-up, E-mail");
    assert.equal(activeHoursLabel({ always: true, days: [], fromHour: 0, toHour: 24 }), "Always");
    assert.equal(
      activeHoursLabel({ always: false, days: [5, 1], fromHour: 8, toHour: 20 }),
      "Mon, Fri, 08:00–20:00 UTC",
    );
    assert.equal(duration(45), "45 s");
    assert.equal(duration(12 * 60), "12 min");
    assert.equal(duration(65 * 60), "1 h 05 min");
    assert.equal(duration(50 * 3600), "2 d 2 h");
    assert.equal(analyticsFor("customer_trunk", "A B"), "/live/analytics?by=customer_trunk&q=A%20B");
    assert.equal(analyticsFor("all", "All traffic"), "/live/analytics?by=customer");
  });
  test("conditions and the blank rule", () => {
    assert.equal(needsValue("started"), false);
    assert.equal(needsValue("below"), true);
    assert.equal(needsBaseline("decrease_pct"), true);
    const r = blankRule();
    assert.equal(r.condition.baseline, "previous_window");
    assert.equal(r.channels.popup, true);
  });
});
