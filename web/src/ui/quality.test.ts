import assert from "node:assert/strict";
import { test } from "node:test";
import { qualityClass, qualityTone } from "./quality";

test("ASR / DLR tone by value (team trial round 1)", () => {
  assert.equal(qualityTone(95), "good");
  assert.equal(qualityTone(80), "good");
  assert.equal(qualityTone(79.9), "warning");
  assert.equal(qualityTone(60), "warning");
  assert.equal(qualityTone(59), "error");
  assert.equal(qualityTone(null), "");
  assert.equal(qualityClass(70), "tone-warning");
  assert.equal(qualityClass(95), "", "good values are plain text (team trial round 5)");
  assert.equal(qualityClass(undefined), "");
});
