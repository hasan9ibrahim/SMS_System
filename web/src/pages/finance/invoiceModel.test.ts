import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  blankRequest,
  comparisonInfo,
  diffTone,
  lastMonths,
  linesText,
  parseLines,
  requestInput,
  toleranceWords,
  utcTime,
  zonedTime,
} from "./invoiceModel";

describe("invoice model (§7, §12.3, §13.31)", () => {
  test("Generate Request defaults to last month and cleans proforma fields", () => {
    const r = blankRequest(new Date("2026-10-17T10:00:00Z"));
    assert.deepEqual([r.usageStart, r.usageEnd, r.invoiceDate], ["2026-09-01", "2026-09-30", "2026-10-17"]);
    const traffic = requestInput({
      ...r,
      amount: 5,
      volume: 10,
      currency: "EUR",
      dueDate: "2026-11-01",
      enterpriseIds: [1, 2],
      invoiceNumber: "X",
    });
    assert.deepEqual(
      [traffic.amount, traffic.volume, traffic.currency, traffic.dueDate, traffic.invoiceNumber],
      [null, null, null, null, null],
    );
    const pro = requestInput({
      ...r,
      kind: "proforma",
      amount: 5,
      dueDateType: "manual",
      dueDate: "2026-11-01",
      enterpriseIds: [1],
      invoiceNumber: " P-1 ",
    });
    assert.deepEqual([pro.amount, pro.dueDate, pro.invoiceNumber], [5, "2026-11-01", "P-1"]);
  });

  test("destination lines from text", () => {
    const ok = parseLines("mccmnc,volume,amount\n23410,1000,12.5\n\n26201;;3\n");
    assert.equal(ok.error, null);
    assert.deepEqual(ok.lines, [
      { mccmnc: "23410", volume: 1000, amount: 12.5 },
      { mccmnc: "26201", volume: null, amount: 3 },
    ]);
    assert.equal(linesText(ok.lines), "23410,1000,12.5\n26201,,3");
    assert.match(parseLines("2341,1,1").error!, /not an MCCMNC/);
    assert.match(parseLines("23410,1,1\n23410,2,2").error!, /listed twice/);
    assert.match(parseLines("23410,1.5,1").error!, /whole number/);
    assert.match(parseLines("23410,1,").error!, /amount is missing/);
  });

  test("labels, tolerance words, tones and month ranges", () => {
    assert.equal(comparisonInfo(null).label, "Not checked");
    assert.equal(comparisonInfo("no_data").label, "No EDR data");
    assert.equal(toleranceWords(1, 50, "stricter", "USD"), "1 % and 50 USD");
    assert.equal(toleranceWords(null, 1000, "looser", "messages"), "1,000 messages");
    assert.equal(toleranceWords(null, null, "looser", "USD"), "no check");
    assert.deepEqual(
      [diffTone(0.5), diffTone(-3), diffTone(8), diffTone(null)],
      ["", "tone-warning", "tone-error", ""],
    );
    assert.deepEqual(lastMonths(12, new Date("2026-10-17T00:00:00Z")), { from: "2025-11", to: "2026-10" });
    assert.equal(zonedTime("2026-09-20T20:00:00.000Z", "Asia/Dubai"), "2026-09-21 00:00");
    assert.equal(utcTime("2026-09-20T20:00:00.000Z"), "2026-09-20 20:00");
  });
});
