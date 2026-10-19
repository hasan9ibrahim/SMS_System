import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decodeState } from "../../../grid/filterModel";
import { cleanupUrl, resultText } from "./cleanupModel";

describe("cleanup model (§13.19)", () => {
  test("a badge opens open findings of its kinds", () => {
    const url = cleanupUrl({ area: "rules", kinds: ["route_rule_unused"] });
    const s = decodeState(new URLSearchParams(url.split("?")[1]).get("g")!);
    assert.deepEqual(s.columns.kind, { field: "kind", op: "in", values: ["route_rule_unused"] });
    assert.deepEqual(s.columns.state, { field: "state", op: "in", values: ["open"] });
  });
  test("result text", () => {
    assert.equal(
      resultText({
        applied: 2,
        awaitingApproval: 0,
        skipped: [{ id: 1, reason: "already applied" }],
        change: { id: 9 } as never,
      }),
      "Applied 2 findings as change #9 (undo in History) · 1 skipped: already applied",
    );
    assert.equal(resultText({ applied: 0, awaitingApproval: 0, skipped: [], change: null }), "Nothing to apply");
  });
});
