// File names of the files partners receive (team trial round 12, §11): [Key] / {Key} variables, any case, spaces
// ignored, characters a file cannot hold replaced, the extension added once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentDisposition, fillFileName, nowValues, unknownFileNameVariables } from "../src/billing/fileNames.js";

const at = new Date("2026-10-30T16:49:56Z");
const values = {
  ...nowValues("jana.okafor", at),
  company: "Fake Telecom FZ",
  enterpriseName: "Zarisria Mobile Ltd",
  productCategoryName: "Direct",
  currency: "USD",
  trunk: "ZARISRIA_DIR",
};

test("the team's variables fill in, both spellings", () => {
  assert.equal(
    fillFileName(
      "{EnterpriseName}{ProductCategoryName}{Currency}{Username}{Date and Time}{Trunk}{Company}",
      values,
      "x",
      "xls",
    ),
    "Zarisria Mobile LtdDirectUSDjana.okafor2026-10-30_16-49ZARISRIA_DIRFake Telecom FZ.xls",
  );
  assert.equal(
    fillFileName("[EnterpriseName]_[product category name]_[CURRENCY]_[Date]", values, "x", "csv"),
    "Zarisria Mobile Ltd_Direct_USD_2026-10-30.csv",
  );
  // The old lower-case variables keep working.
  assert.equal(
    fillFileName("{company}_{trunk}_rates_{date}", values, "x", "csv"),
    "Fake Telecom FZ_ZARISRIA_DIR_rates_2026-10-30.csv",
  );
});

test("unsafe characters, empty patterns and the extension", () => {
  assert.equal(fillFileName("Rates: [Trunk]/[Date]?", values, "x", "csv"), "Rates_ ZARISRIA_DIR_2026-10-30.csv");
  assert.equal(fillFileName(null, values, "Rates_ZARISRIA_DIR_2026-10-30", "xls"), "Rates_ZARISRIA_DIR_2026-10-30.xls");
  assert.equal(fillFileName("  ", values, "INV-1", "pdf"), "INV-1.pdf");
  assert.equal(fillFileName("[Trunk].pdf", values, "x", "pdf"), "ZARISRIA_DIR.pdf");
  assert.equal(fillFileName("[Username]", { ...nowValues(null, at) }, "x", "pdf"), "system.pdf");
});

test("unknown variables are reported per file kind", () => {
  assert.deepEqual(unknownFileNameVariables("rate", "[EnterpriseName]_{Trunk}_[Date and Time]"), []);
  assert.deepEqual(unknownFileNameVariables("rate", "[InvoiceRefNumber]_[Nope]"), ["[InvoiceRefNumber]", "[Nope]"]);
  assert.deepEqual(unknownFileNameVariables("invoice", "[InvoiceRefNumber]_[PARAM1001]_[VATNumber]"), []);
  assert.deepEqual(
    unknownFileNameVariables("soa", "SOA_[EnterpriseName]_[FromDate]_[ToDate]_[BeneficiaryAddress]"),
    [],
  );
});

test("downloads carry an ASCII name and the exact one", () => {
  assert.equal(
    contentDisposition("فاتورة INV-1.pdf"),
    `attachment; filename="______ INV-1.pdf"; filename*=UTF-8''${encodeURIComponent("فاتورة INV-1.pdf")}`,
  );
});
