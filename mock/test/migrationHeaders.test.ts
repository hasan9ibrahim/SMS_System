// Migration import headers and choices (§13.22, team trial round 11): any name a field is known by works as its
// column ("User name", "Username", "USER_NAME"), with or without a column mapping, and choices are read the way people
// write them ("Active", "Tier 1", "Bilateral"). A template downloaded from the system imports back unchanged. No
// database: mapRows is pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MigrationImportEntity } from "@sms/contract";
import { BUILT_IN_MAPPINGS, IMPORT_ENTITIES } from "../src/migration/entities.js";
import { choiceOf, looseKey, mapRows } from "../src/migration/importer.js";
import { toCsv } from "../src/migration/csv.js";
import { packageFiles } from "../src/migration/fromPackage.js";

const file = (entity: MigrationImportEntity, rows: string[][]) => ({
  entity,
  fileName: `${entity}.csv`,
  content: toCsv(rows),
  mappingId: null,
});
const refMapping = (entity: MigrationImportEntity) => BUILT_IN_MAPPINGS.find((m) => m.entity === entity)!.columns;

test("headers match loosely: case, spaces, dashes and underscores do not matter", () => {
  assert.equal(looseKey("User name"), looseKey("username"));
  assert.equal(looseKey("USER_NAME"), looseKey("User-Name"));
  assert.equal(looseKey("E-mail"), looseKey("email"));
  for (const header of ["username", "Username", "User name", "USER_NAME", "user-name", "Login"]) {
    const { rows, missing } = mapRows(
      file("users", [
        [header, "First name", "Last name", "E-mail"],
        ["test.one", "Testa", "Fakeperson", "testa@example.test"],
      ]),
      null,
    );
    assert.deepEqual(missing, [], header);
    assert.equal(rows[0]!.username, "test.one", header);
    assert.equal(rows[0]!.email, "testa@example.test", header);
  }
});

test("a column mapping no longer shuts out the template's own headers", () => {
  // The reference platform's mapping expects "User Name"; a file with the template's "username" still works.
  const mapping = refMapping("users");
  assert.equal(mapping.username, "User Name");
  const { rows, missing } = mapRows(
    file("users", [
      ["username", "firstName", "lastName", "email"],
      ["test.two", "Testo", "Fakename", "testo@example.test"],
    ]),
    mapping,
  );
  assert.deepEqual(missing, []);
  assert.equal(rows[0]!.username, "test.two");
  // And the mapping's own name keeps working.
  const mapped = mapRows(
    file("users", [
      ["User Name", "First Name", "Last Name", "Email"],
      ["test.three", "Testi", "Fakename", "testi@example.test"],
    ]),
    mapping,
  );
  assert.deepEqual(mapped.missing, []);
  assert.equal(mapped.rows[0]!.username, "test.three");
});

test("a column serves one field: an alias never takes a column named after another field", () => {
  // Trunk files: "Enterprise" is the enterprise field even though it is also a name others use for a partner.
  const { rows, missing } = mapRows(
    file("customer_trunks", [
      ["Enterprise", "Trunk name", "TPS"],
      ["Testco Fake Ltd", "TESTCO_OTP", "50"],
    ]),
    null,
  );
  assert.deepEqual(missing, []);
  assert.equal(rows[0]!.enterprise, "Testco Fake Ltd");
  assert.equal(rows[0]!.name, "TESTCO_OTP");
});

test("choices are read the way people write them", () => {
  assert.equal(choiceOf(["active", "inactive"], "Active"), "active");
  assert.equal(choiceOf(["active", "inactive"], "DISABLED"), "inactive");
  assert.equal(choiceOf(["tier1", "tier2", "tier3"], "Tier 1"), "tier1");
  assert.equal(choiceOf(["tier1", "tier2", "tier3"], "2"), "tier2");
  assert.equal(choiceOf(["customer", "vendor", "reciprocal"], "Bilateral"), "reciprocal");
  assert.equal(choiceOf(["none", "tls1.0", "tls1.2", "tls1.3"], "TLS 1.2"), "tls1.2");
  assert.equal(choiceOf(["yes", "no"], "Yes"), "yes");
  // Unknown words stay as written, so the dry run reports them instead of Apply failing.
  assert.equal(choiceOf(["active", "inactive"], "Maybe"), "Maybe");
  const { rows } = mapRows(
    file("users", [
      ["username", "firstName", "lastName", "email", "status", "isAccountManager"],
      ["test.four", "Testy", "Fakename", "testy@example.test", "Active", "Yes"],
    ]),
    null,
  );
  assert.equal(rows[0]!.status, "active");
  assert.equal(rows[0]!.isAccountManager, "yes");
});

test("every template downloaded from the system imports back unchanged, with or without a mapping", () => {
  for (const info of IMPORT_ENTITIES) {
    const entity = info.entity as MigrationImportEntity;
    const keys = info.fields.map((f) => f.field);
    const labels = info.fields.map((f) => f.label);
    for (const header of [keys, labels])
      for (const mapping of [null, refMapping(entity)]) {
        const { missing, rows } = mapRows(file(entity, [header, header.map((h) => `v-${h}`)]), mapping);
        assert.deepEqual(missing, [], `${entity} ${header === keys ? "keys" : "labels"} ${mapping ? "mapped" : ""}`);
        // Every column landed in its own field.
        for (const [i, f] of info.fields.entries())
          if (!f.allowed.length) assert.equal(rows[0]![f.field], `v-${header[i]}`, `${entity}.${f.field}`);
      }
  }
});

test("a trunk file or package that still has Part Wise Routing imports with the column ignored (S-3.8)", () => {
  // Part Wise Routing was removed (product owner 2026-10-31); old exports still carry the column.
  const { rows, missing } = mapRows(
    file("customer_trunks", [
      ["Enterprise", "Trunk name", "TPS", "Part Wise Routing", "Billing type"],
      ["Test Enterprise", "TEST_TRUNK", "50", "Yes", "Submit"],
    ]),
    null,
  );
  assert.deepEqual(missing, []);
  assert.deepEqual(Object.keys(rows[0]!).sort(), IMPORT_ENTITIES.find((e) => e.entity === "customer_trunks")!.fields
    .map((f) => f.field)
    .sort());
  assert.equal(rows[0]!.name, "TEST_TRUNK");
  assert.equal(rows[0]!.billingType, "submit");
  assert.ok(!Object.values(rows[0]!).includes("Yes"));

  const pkg = packageFiles(
    new Map([
      ["enterprises.csv", toCsv([["id", "name", "type"], ["7", "Test Enterprise", "customer"]])],
      [
        "customer_trunks.csv",
        toCsv([
          ["id", "enterprise_id", "name", "tps", "billing_type", "part_wise_routing"],
          ["70", "7", "TEST_TRUNK", "50", "submit", "t"],
        ]),
      ],
    ]),
  );
  const trunks = pkg.files.find((f) => f.entity === "customer_trunks")!;
  assert.ok(trunks.content.includes("TEST_TRUNK"));
  assert.ok(!/part.?wise/i.test(trunks.content));
});
