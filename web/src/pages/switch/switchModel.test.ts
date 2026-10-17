import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TranslationRuleDetail } from "@sms/contract";
import { blankRule, impliedDirection, inputFromDetail, ruleSummary, splitValues, toSave } from "./switchModel";

describe("switch model (§6.4, §13.2)", () => {
  test("pasted values split on lines, commas and tabs, trimmed and distinct", () => {
    assert.deepEqual(splitValues(" 4477001\r\n4477002, 4477001\t\n\nABC; "), ["4477001", "4477002", "ABC"]);
  });

  test("direction is the override, else implied by the targets", () => {
    const r = blankRule();
    assert.equal(impliedDirection(r), "Implied by the trunk");
    assert.equal(
      impliedDirection({ ...r, targets: [{ type: "trunk", trunkKind: "vendor", id: 1 }] }),
      "Egress (implied)",
    );
    assert.equal(impliedDirection({ ...r, direction: "ingress" }), "Ingress");
  });

  test("toSave drops values the chosen conversions do not use", () => {
    const v = toSave({
      ...blankRule(),
      name: "  X ",
      senderConversion: "random_number",
      senderConversionValue: "2",
      senderConversionListId: 7,
      receiverConversion: null,
      receiverConversionValue: "00",
      contentRegexIndex: 2,
    });
    assert.equal(v.name, "X");
    assert.equal(v.senderConversionValue, null);
    assert.equal(v.senderConversionListId, 7);
    assert.equal(v.receiverConversionValue, null);
    assert.equal(v.contentRegexIndex, null);
    assert.equal(
      toSave({ ...blankRule(), senderConversion: "prepend", senderConversionListId: 3 }).senderConversionListId,
      null,
    );
  });

  test("a saved rule maps back to the form without labels", () => {
    const d = {
      ...blankRule(),
      id: 5,
      name: "R",
      targets: [{ type: "enterprise", trunkKind: "customer", id: 9, label: "Acme" }],
      usedBy: 3,
      createdBy: null,
      updatedBy: null,
      updatedAt: "2026-10-17T00:00:00Z",
      archivedAt: null,
    } as TranslationRuleDetail;
    const input = inputFromDetail(d);
    assert.deepEqual(input.targets, [{ type: "enterprise", trunkKind: "customer", id: 9 }]);
    assert.ok(!Object.keys(input).includes("usedBy"));
  });

  test("summary says what the rule matches and does", () => {
    assert.equal(
      ruleSummary({
        ...blankRule(),
        receiverPattern: "^00",
        receiverConversion: "left_strip",
        receiverConversionValue: "2",
        continueAfter: false,
      }),
      "When receiver ~ ^00: receiver left strip 2, then stop",
    );
    assert.equal(
      ruleSummary({ ...blankRule(), action: "block", senderPattern: "^TEST", senderPatternNegate: true }),
      "When sender not ~ ^TEST: block",
    );
  });
});
