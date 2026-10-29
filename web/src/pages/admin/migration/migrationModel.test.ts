import { test } from "node:test";
import assert from "node:assert/strict";
import type { MigrationImport } from "@sms/contract";
import {
  blankExport,
  exportInput,
  exportProblems,
  fmtBytes,
  headerHasCredentials,
  isView,
  nextStep,
  reportLine,
  reportTotals,
} from "./migrationModel";

test("export form: password, confirmation, credentials need 2FA", () => {
  const d = blankExport();
  assert.match(exportProblems(d)[0]!, /12 characters/);
  const ok = { ...d, password: "long-enough-pw", confirm: "long-enough-pw" };
  assert.deepEqual(exportProblems(ok), []);
  assert.match(exportProblems({ ...ok, confirm: "other" })[0]!, /differ/);
  assert.match(exportProblems({ ...ok, withPasswords: true })[0]!, /only with credentials/);
  assert.match(exportProblems({ ...ok, includeCredentials: true })[0]!, /2FA/);
  assert.deepEqual(exportProblems({ ...ok, includeCredentials: true, totpCode: "123456" }), []);
  assert.equal(exportInput({ ...ok, totpCode: "123456" }).totpCode, null);
});

test("credential columns in a file header", () => {
  assert.ok(headerHasCredentials("customer_trunks", "Customer Trunk Name,System ID,TPS\nA,b,1"));
  assert.ok(headerHasCredentials("vendor_trunks", '"name";"password"\n'));
  assert.ok(headerHasCredentials("customer_trunks", "name,SYSTEM_ID,tps\n"));
  assert.ok(!headerHasCredentials("customer_trunks", "name,tps,category\n"));
  // A users file's Username is a login name, not a trunk credential (team trial round 11).
  assert.ok(!headerHasCredentials("users", "username,firstName,lastName,email\n"));
  assert.ok(!headerHasCredentials("users", "User name,Password\n"));
});

test("report totals and the list line", () => {
  const e = [
    { entity: "users", rows: 3, create: 2, update: 0, skip: 1, errors: 0, source: 3, inSystem: 10 },
    { entity: "rate_lines", rows: 1500, create: 1498, update: 0, skip: 0, errors: 2, source: 1500, inSystem: null },
  ];
  assert.deepEqual(reportTotals(e), { rows: 1503, create: 1500, update: 0, skip: 1, errors: 2 });
  assert.equal(reportLine(e), "1,500 new · 1 skipped · 2 with errors");
});

test("views, sizes and the next step", () => {
  assert.ok(isView("exports") && !isView("nope") && !isView(null));
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(21_890_530), "20.9 MB");
  const row = { entity: "users", rows: 1, create: 0, update: 0, skip: 1, errors: 1, source: 1, inSystem: 1 };
  const base = {
    status: "validated",
    inactiveTrunks: 0,
    report: { canApply: false, entities: [row] },
  } as unknown as MigrationImport;
  assert.match(nextStep(base), /Fix the files/);
  // No error and every row skipped (R9): nothing to apply, said plainly.
  const skipped = { ...base, report: { canApply: false, entities: [{ ...row, errors: 0 }] } } as MigrationImport;
  assert.match(nextStep(skipped), /Nothing to apply/);
  assert.match(nextStep({ ...base, status: "applying" }), /background/);
  assert.match(nextStep({ ...base, status: "applied", inactiveTrunks: 4 }), /4 imported trunks/);
});
