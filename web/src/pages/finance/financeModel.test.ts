import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  balanceEffect,
  balanceWords,
  blankTransaction,
  netWords,
  modeLabel,
  money,
  periodDays,
  typeLabel,
} from "./financeModel";

describe("finance model (§7, §13.33)", () => {
  test("a new payment follows the side", () => {
    const c = blankTransaction("customer", new Date("2026-10-17T10:00:00Z"));
    assert.deepEqual([c.paymentType, c.transactionType, c.paymentDate], ["credit", "receipt", "2026-10-17"]);
    const v = blankTransaction("vendor");
    assert.deepEqual([v.paymentType, v.transactionType], ["debit", "bill_payment"]);
    assert.equal(c.includeInSoa, true, "In SOA is ticked by default (§13.33)");
  });

  test("balance effect (positive = credit): payments raise the balance, the opposite lowers it", () => {
    assert.equal(balanceEffect({ side: "customer", paymentType: "credit", amount: 100 }), 100);
    assert.equal(balanceEffect({ side: "customer", paymentType: "debit", amount: 100 }), -100);
    assert.equal(balanceEffect({ side: "vendor", paymentType: "debit", amount: 50 }), 50);
  });

  test("balance in words", () => {
    assert.deepEqual(balanceWords(-400, "customer"), { text: "owes us", tone: "tone-error" });
    assert.deepEqual(balanceWords(500, "customer"), { text: "in credit", tone: "tone-good" });
    assert.deepEqual(balanceWords(-300, "vendor"), { text: "we owe", tone: "tone-error" });
    assert.equal(balanceWords(0.001, "customer").text, "settled");
    assert.equal(netWords(-100), "partner owes us (net)");
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
