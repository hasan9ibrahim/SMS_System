// Bulk delete dialogs (§13.29): the first names the count and the first records, the second asks plainly again; the
// count follows the dry run and the administrator's override.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BulkRecordsResult } from "@sms/contract";
import { goingNames, secondConfirmText, selectionSentence, stillRefused, willChange } from "./bulkModel";

const codes = ["23410", "23415", "23420", "23430", "23433", "23450", "23455"];

test("the first dialog names the count and the first five records", () => {
  assert.equal(
    selectionSentence("Delete", codes, "MCCMNC code", "MCCMNC codes"),
    "Delete 7 MCCMNC codes: 23410, 23415, 23420, 23430, 23433, …",
  );
  assert.equal(selectionSentence("Delete", codes.slice(0, 2), "MCCMNC code", "MCCMNC codes"), "Delete 2 MCCMNC codes: 23410, 23415");
  assert.equal(selectionSentence("Restore", ["Acme"], "enterprise", "enterprises"), "Restore 1 enterprise: Acme");
  assert.equal(selectionSentence("Delete", [], "category", "categories"), "Delete 0 categories");
});

test("the second dialog asks plainly", () => {
  assert.equal(secondConfirmText(12, "MCCMNC code", "MCCMNC codes"), "Are you sure? 12 MCCMNC codes will be deleted.");
  assert.equal(secondConfirmText(1, "rate table", "rate tables"), "Are you sure? 1 rate table will be deleted.");
  assert.equal(secondConfirmText(1200, "IP", "IPs", "restore"), "Are you sure? 1,200 IPs will be restored.");
});

test("the count: rows the dry run accepts; with an override the overridable refused ones too", () => {
  const r: Pick<BulkRecordsResult, "done" | "refused"> = {
    done: [
      { id: 1, name: "23410", warnings: [] },
      { id: 2, name: "23415", warnings: ["Messages in the last 30 days: 12"] },
    ],
    refused: [
      { id: 3, name: "23420", reason: "Settle these first: Dial codes 1", overridable: true },
      { id: 4, name: "Customer #12", reason: "Another account manager's record", overridable: false },
    ],
  };
  assert.equal(willChange(r, false), 2);
  assert.equal(willChange(r, true), 3);
  assert.deepEqual(goingNames(r, false), ["23410", "23415"]);
  assert.deepEqual(goingNames(r, true), ["23410", "23415", "23420"]);
  assert.deepEqual(stillRefused(r, false).map((x) => x.id), [3, 4]);
  assert.deepEqual(stillRefused(r, true).map((x) => x.id), [4]);
});
