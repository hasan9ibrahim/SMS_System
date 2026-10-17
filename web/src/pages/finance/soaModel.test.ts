import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SoaLine } from "@sms/contract";
import { defaultPeriod, enterprisesParam, entryEffect, lineAction, signedAmount, soaLink } from "./soaModel";

const line = (over: Partial<SoaLine>): SoaLine => ({
  key: "x",
  date: "2026-09-01",
  kind: "invoice",
  reference: null,
  description: "",
  amount: -1,
  balance: null,
  source: "auto",
  status: null,
  note: null,
  refType: "invoice",
  refId: 1,
  adjustmentId: null,
  ...over,
});

describe("SOA model (§13.31, §13.33)", () => {
  test("manual action per line", () => {
    assert.equal(lineAction(line({})), "remove_invoice");
    assert.equal(lineAction(line({ refType: "vendor_invoice" })), "remove_vendor_invoice");
    assert.equal(lineAction(line({ refType: "transaction" })), null, "payments use Include in SOA (§13.33)");
    assert.equal(lineAction(line({ refType: "entry", adjustmentId: 4, source: "manual" })), "take_back");
  });

  test("period, links and entry sign", () => {
    assert.deepEqual(defaultPeriod(new Date("2026-10-17T00:00:00Z")), { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(enterprisesParam("?enterprises=4,x,9,0"), [4, 9]);
    assert.equal(soaLink([3, 3, 5]), "/finance/soa?enterprises=3,5");
    assert.equal(signedAmount(25, "lowers"), -25);
    assert.equal(signedAmount(-25, "raises"), 25);
    assert.deepEqual([entryEffect("payment"), entryEffect("adjustment")], ["raises", "lowers"]);
  });
});
