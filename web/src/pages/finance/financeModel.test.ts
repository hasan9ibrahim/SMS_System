import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { balanceEffect, blankTransaction, modeLabel, money, periodDays, typeLabel } from "./financeModel";

describe("finance model (§7, §13.33)", () => {
  test("a new payment follows the side", () => {
    const c = blankTransaction("customer", new Date("2026-10-17T10:00:00Z"));
    assert.deepEqual([c.paymentType, c.transactionType, c.paymentDate], ["credit", "receipt", "2026-10-17"]);
    const v = blankTransaction("vendor");
    assert.deepEqual([v.paymentType, v.transactionType], ["debit", "bill_payment"]);
    assert.equal(c.includeInSoa, true, "In SOA is ticked by default (§13.33)");
  });

  test("balance effect: payments lower what is owed, the opposite raises it", () => {
    assert.equal(balanceEffect({ side: "customer", paymentType: "credit", amount: 100 }), -100);
    assert.equal(balanceEffect({ side: "customer", paymentType: "debit", amount: 100 }), 100);
    assert.equal(balanceEffect({ side: "vendor", paymentType: "debit", amount: 50 }), -50);
  });

  test("labels and formatting", () => {
    assert.equal(modeLabel("bank_transfer"), "Bank Transfer");
    assert.equal(modeLabel(null), "—");
    assert.equal(typeLabel("credit_note"), "Credit Note");
    assert.equal(money(1234.5, "EUR"), "1,234.50 EUR");
    assert.equal(money(null), "—");
    assert.equal(periodDays("2026-10-01", "2026-10-31"), 31);
  });
});
