import { test } from "node:test";
import assert from "node:assert/strict";
import { matchOptions } from "./comboMatch";

const opts = ["Germany (DE)", "Nigeria (NG)", "UTC-04:00 · America/New_York", "UTC+01:00 · Europe/Berlin"].map(
  (label, value) => ({ value, label }),
);

test("an option matches when its label contains every word typed, in any case (team trial round 12)", () => {
  assert.deepEqual(
    matchOptions(opts, "ger").map((o) => o.label),
    ["Germany (DE)", "Nigeria (NG)"],
  );
  assert.deepEqual(
    matchOptions(opts, "YORK").map((o) => o.label),
    ["UTC-04:00 · America/New_York"],
  );
  assert.deepEqual(
    matchOptions(opts, "europe ber").map((o) => o.label),
    ["UTC+01:00 · Europe/Berlin"],
  );
  assert.equal(matchOptions(opts, "").length, 4);
  assert.equal(matchOptions(opts, "", 2).length, 2);
});
