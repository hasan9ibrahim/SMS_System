// Product reference data (build step 5, §6.1): categories, countries, MCCMNC codes, Master
// Table profiles and dial codes, MO reference book. Every response is checked against the
// contract; each test undoes its own changes (§13.10). Needs the seeded database.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change, ImportResult } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { parseCsv } from "../src/api/masterData.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
after(async () => {
  await app.close();
  await closeDb();
});

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return /json/.test(String(r.headers["content-type"])) ? r.json() : r.body;
}

const undo = (change: Change | null) =>
  change ? ok("undoChange", call("POST", `/changes/${change.id}/undo`, {})) : Promise.resolve(null);
const run = Date.now().toString(36).slice(-5);

test("parseCsv: quotes, semicolons, CRLF, BOM and blank lines", () => {
  const { header, rows } = parseCsv('﻿MCC;MNC;Network\r\n001;01;"Test; ""One"""\r\n\r\n001;;\r\n');
  assert.deepEqual(header, ["mcc", "mnc", "network"]);
  assert.deepEqual(rows[0], { line: 2, values: { mcc: "001", mnc: "01", network: 'Test; "One"' } });
  assert.equal(rows[1]!.line, 4, "line numbers count blank lines");
});

describe("product categories", { skip }, () => {
  test("add, rename, duplicate name, delete blocked while in use, undo", async () => {
    const name = `TEST${run}`;
    const created = await ok("createProductCategory", call("POST", "/product-categories", { name }), 201);
    assert.equal(created.record.name, name);
    const dup = await call("POST", "/product-categories", { name: name.toLowerCase() });
    assert.equal(dup.statusCode, 409, "names are unique case-insensitively");
    check("createProductCategory", dup);
    const renamed = await ok(
      "updateProductCategory",
      call("PUT", `/product-categories/${created.record.id}`, { name: `${name}X` }),
    );
    assert.equal(renamed.change.diff[0].before, name);
    // A category in use cannot be deleted.
    const page = await ok("queryProductCategories", call("POST", "/product-categories/query", { limit: 50 }));
    const used = page.rows.find((r: { customerTrunks: number }) => r.customerTrunks > 0);
    const blocked = await call("POST", `/product-categories/${used.id}/archive`, {});
    assert.equal(blocked.statusCode, 409);
    check("archiveProductCategory", blocked);
    // An unused one can, and shows under "Delete history".
    const gone = await ok(
      "archiveProductCategory",
      call("POST", `/product-categories/${created.record.id}/archive`, {}),
    );
    assert.ok(gone.record.archivedAt);
    const history = await ok(
      "queryProductCategories",
      call("POST", "/product-categories/query", {
        limit: 50,
        filter: { logic: "and", conditions: [{ field: "archived", op: "eq", value: true }] },
      }),
    );
    assert.ok(history.rows.some((r: { id: number }) => r.id === created.record.id));
    // Undo the delete, the rename, then the add (the add's undo archives it again).
    await undo(gone.change);
    await undo(renamed.change);
    await undo(created.change);
    const { rows } = await db().query("SELECT name, deleted_at FROM product_categories WHERE id = $1", [
      created.record.id,
    ]);
    assert.equal(rows[0].name, name);
    assert.ok(rows[0].deleted_at, "undoing the add archives the category");
  });
});

describe("countries", { skip }, () => {
  test("list with region values, change and undo, export", async () => {
    const fields = await ok("getListFields", call("GET", "/meta/lists/countries/fields"));
    const region = fields.fields.find((f: { field: string }) => f.field === "region");
    assert.ok(region.enumValues.length >= 5, "regions come from the database");
    const page = await ok(
      "queryCountries",
      call("POST", "/countries/query", {
        limit: 5,
        filter: { logic: "and", conditions: [{ field: "iso", op: "eq", value: "de" }] },
      }),
    );
    const de = page.rows[0];
    assert.equal(de.name, "Germany");
    assert.ok(de.networks > 1);
    const saved = await ok(
      "updateCountry",
      call("PUT", `/countries/${de.id}`, { name: de.name, iso: "DE", dialCode: de.dialCode, region: "Test region" }),
    );
    assert.deepEqual(
      saved.change.diff.map((d: { field: string }) => d.field),
      ["region"],
    );
    await undo(saved.change);
    const csv = await ok("exportCountries", call("POST", "/countries/export", { limit: 10, search: "Germany" }));
    assert.match(String(csv), /^name,iso,dial_code,region/);
    assert.match(String(csv), /Germany,DE,49,EU/);
  });
});

describe("MCCMNC codes", { skip }, () => {
  const countryId = async () => (await db().query("SELECT id FROM countries WHERE iso = 'DE'")).rows[0].id as number;

  test("add, change, delete, restore and undo; MCC/MNC of a used code cannot change", async () => {
    const cid = await countryId();
    const created = await ok(
      "createDestination",
      call("POST", "/destinations", {
        mcc: "001",
        mnc: "97",
        originalMnc: null,
        countryId: cid,
        network: `Test ${run}`,
      }),
      201,
    );
    assert.equal(created.record.mccmnc, "00197");
    const dup = await call("POST", "/destinations", { mcc: "001", mnc: "97", countryId: cid, network: "Again" });
    assert.equal(dup.statusCode, 409);
    const changed = await ok(
      "updateDestination",
      call("PUT", `/destinations/${created.record.id}`, {
        mcc: "001",
        mnc: "98",
        originalMnc: "098",
        countryId: cid,
        network: `Test ${run}`,
      }),
    );
    assert.equal(changed.record.mccmnc, "00198");
    assert.equal(changed.record.originalMnc, "098");
    const deps = await ok("getDestinationDependencies", call("GET", `/destinations/${created.record.id}/dependencies`));
    assert.equal(deps.blocked, false);
    const gone = await ok("archiveDestination", call("POST", `/destinations/${created.record.id}/archive`, {}));
    assert.ok(gone.record.archivedAt);
    const restored = await ok("restoreDestination", call("POST", `/destinations/${created.record.id}/restore`));
    assert.equal(restored.record.archivedAt, null);
    for (const c of [restored.change, gone.change, changed.change, created.change]) await undo(c);
    const { rows } = await db().query("SELECT mccmnc, deleted_at FROM mccmnc WHERE id = $1", [created.record.id]);
    assert.equal(rows[0].mccmnc, "00197", "undo restores the code");
    assert.ok(rows[0].deleted_at);

    // A code with rate lines keeps its MCC and MNC.
    const { rows: used } = await db().query(
      `SELECT m.id, m.mcc, m.mnc, m.country_id, m.network FROM mccmnc m
        WHERE NOT m.is_all_networks AND m.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM rate_lines l WHERE l.mccmnc_id = m.id AND l.valid_to IS NULL) LIMIT 1`,
    );
    const u = used[0];
    const refused = await call("PUT", `/destinations/${u.id}`, {
      mcc: u.mcc,
      mnc: u.mnc === "01" ? "02" : "01",
      originalMnc: null,
      countryId: u.country_id,
      network: u.network,
    });
    assert.equal(refused.statusCode, 409);
    check("updateDestination", refused);
  });

  test("import: dry run, errors stop it, apply is one change, replace keeps codes in use", async () => {
    const csv = [
      "mcc,mnc,original_mnc,country,network",
      `001,91,,Germany,Import A ${run}`,
      `001,92,092,Germany,Import B ${run}`,
      `262,01,,Germany,Telekom Deutschland`,
    ].join("\n");
    const dry: ImportResult = await ok(
      "importDestinations",
      call("POST", "/destinations/import", { csv, dryRun: true }),
    );
    assert.equal(dry.applied, false);
    assert.equal(dry.added, 2);
    assert.equal(dry.updated + dry.unchanged, 1);
    assert.ok(
      dry.warnings.some((w) => /not in the file/.test(w.message)),
      "merge mode reports missing codes",
    );
    const { rows: before } = await db().query("SELECT count(*)::int AS n FROM mccmnc WHERE mcc = '001'");

    const bad: ImportResult = await ok(
      "importDestinations",
      call("POST", "/destinations/import", { csv: `${csv}\n001,9x,,Germany,Bad\n001,93,,Atlantis,Bad`, dryRun: false }),
    );
    assert.equal(bad.applied, false, "any error stops the whole import");
    assert.deepEqual(
      bad.errors.map((e) => e.line),
      [5, 6],
    );
    assert.equal((await db().query("SELECT count(*)::int AS n FROM mccmnc WHERE mcc = '001'")).rows[0].n, before[0].n);

    const done: ImportResult = await ok(
      "importDestinations",
      call("POST", "/destinations/import", { csv, dryRun: false }),
    );
    assert.equal(done.applied, true);
    assert.equal(done.change?.changeType, "import");
    const { rows: added } = await db().query(
      "SELECT mccmnc, original_mnc FROM mccmnc WHERE mcc = '001' AND deleted_at IS NULL AND network LIKE $1 ORDER BY 1",
      [`Import _ ${run}`],
    );
    assert.deepEqual(
      added.map((r) => [r.mccmnc, r.original_mnc]),
      [
        ["00191", null],
        ["00192", "092"],
      ],
    );
    // Replace mode (dry run): codes left out are archived unless still in use.
    const replace: ImportResult = await ok(
      "importDestinations",
      call("POST", "/destinations/import", { csv, dryRun: true, mode: "replace" }),
    );
    assert.ok(replace.kept.length > 100, "codes with rate lines or rules are kept");
    assert.ok(replace.archived >= 0);
    await undo(done.change);
    const { rows: after } = await db().query(
      "SELECT count(*)::int AS n FROM mccmnc WHERE mcc = '001' AND deleted_at IS NULL AND network LIKE $1",
      [`Import _ ${run}`],
    );
    assert.equal(after[0].n, 0, "undoing the import archives what it added");
  });
});

describe("Master Table", { skip }, () => {
  test("profiles: add as a copy, rename, the default stays; dial codes: add, change, delete, import", async () => {
    const list = await ok("queryDialCodeProfiles", call("POST", "/dial-code-profiles/query", { limit: 20 }));
    const all = list.rows.find((p: { isDefault: boolean }) => p.isDefault);
    assert.equal(all.name, "All");
    assert.ok(all.prefixes > 1000);
    const allArchive = await call("POST", `/dial-code-profiles/${all.id}/archive`, {});
    assert.equal(allArchive.statusCode, 400);
    const small = list.rows.find((p: { name: string }) => p.name === "Short ranges");
    const created = await ok(
      "createDialCodeProfile",
      call("POST", "/dial-code-profiles", { name: `Test ${run}`, copyFromId: small.id }),
      201,
    );
    assert.equal(created.record.prefixes, small.prefixes, "copied from the source profile");
    const pid = created.record.id;

    const noProfile = await call("POST", "/dial-codes/query", { limit: 5 });
    assert.equal(noProfile.statusCode, 400, "the dial-code list needs a profile");
    const page = await ok(
      "queryDialCodes",
      call("POST", "/dial-codes/query", {
        limit: 500,
        filter: { logic: "and", conditions: [{ field: "profileId", op: "eq", value: pid }] },
      }),
    );
    assert.equal(page.total, small.prefixes);

    const dest = (await db().query("SELECT id, mccmnc FROM mccmnc WHERE mccmnc = '26201'")).rows[0];
    const added = await ok(
      "createDialCode",
      call("POST", "/dial-codes", { profileId: pid, prefix: "4999901", destinationId: dest.id }),
      201,
    );
    assert.equal(added.record.mccmnc, "26201");
    const dup = await call("POST", "/dial-codes", { profileId: pid, prefix: "4999901", destinationId: dest.id });
    assert.equal(dup.statusCode, 409);
    const moved = await ok(
      "updateDialCode",
      call("PUT", `/dial-codes/${added.record.id}`, { prefix: "4999902", destinationId: dest.id }),
    );
    assert.equal(moved.record.prefix, "4999902");
    const deleted = await ok("deleteDialCodes", call("POST", "/dial-codes/delete", { ids: [added.record.id] }));
    assert.equal(deleted.change.changeType, "delete");

    const csv = "prefix,mccmnc\n4999903,26201\n4999904,26202\n";
    const dry: ImportResult = await ok(
      "importDialCodes",
      call("POST", `/dial-code-profiles/${pid}/import`, { csv, dryRun: true, mode: "replace" }),
    );
    assert.equal(dry.added, 2);
    assert.equal(dry.archived, small.prefixes, "replace archives the prefixes left out");
    const done: ImportResult = await ok(
      "importDialCodes",
      call("POST", `/dial-code-profiles/${pid}/import`, { csv, dryRun: false, mode: "replace" }),
    );
    assert.equal(done.applied, true);
    const exported = await ok("exportDialCodes", call("GET", `/dial-code-profiles/${pid}/export`));
    assert.equal(String(exported).trim().split("\r\n").length, 3, "header and the two imported prefixes");

    const renamed = await ok(
      "updateDialCodeProfile",
      call("PUT", `/dial-code-profiles/${pid}`, { name: `Test ${run}b` }),
    );
    const gone = await ok("archiveDialCodeProfile", call("POST", `/dial-code-profiles/${pid}/archive`, {}));
    for (const c of [
      gone.change,
      renamed.change,
      done.change,
      deleted.change,
      moved.change,
      added.change,
      created.change,
    ])
      await undo(c);
    const { rows } = await db().query("SELECT deleted_at FROM dial_code_profiles WHERE id = $1", [pid]);
    assert.ok(rows[0].deleted_at, "undoing the add archives the profile");
  });
});

describe("MO reference book", { skip }, () => {
  test("add, duplicate number + keyword, change, import with errors, delete and undo", async () => {
    // A trunk with a rate table: its currency is the table's (decided 2026-10-17).
    const trunk = (
      await db().query(
        `SELECT t.id, t.name, rt.currency FROM customer_trunks t
           JOIN customer_trunk_rate_tables x ON x.customer_trunk_id = t.id AND x.position = (
             SELECT min(position) FROM customer_trunk_rate_tables WHERE customer_trunk_id = t.id)
           JOIN rate_tables rt ON rt.id = x.rate_table_id AND rt.deleted_at IS NULL
          WHERE t.deleted_at IS NULL ORDER BY t.id LIMIT 1`,
      )
    ).rows[0];
    const other = trunk.currency === "EUR" ? "USD" : "EUR";
    const input = {
      customerTrunkId: trunk.id,
      number: `4420${run.replace(/\D/g, "7").padEnd(7, "7")}`.slice(0, 13),
      keyword: "TEST",
      rate: 0.02,
      vendorRate: 0.01,
      destinationId: null,
      setupCharge: 50,
      fixCharge: 10,
    };
    const created = await ok("createMoNumber", call("POST", "/mo-numbers", input), 201);
    assert.equal(created.record.customerTrunk, trunk.name);
    assert.equal(created.record.currency, trunk.currency, "the trunk's currency");
    const dup = await call("POST", "/mo-numbers", { ...input, keyword: "test" });
    assert.equal(dup.statusCode, 409, "number + keyword is unique, keyword case-insensitive");
    const noTrunk = await call("POST", "/mo-numbers", { ...input, customerTrunkId: 999_999_999, keyword: "OTHER" });
    assert.equal(noTrunk.statusCode, 400);
    check("createMoNumber", noTrunk);
    const changed = await ok(
      "updateMoNumber",
      call("PUT", `/mo-numbers/${created.record.id}`, { ...input, rate: 0.03 }),
    );
    assert.deepEqual(
      changed.change.diff.map((d: { field: string }) => d.field),
      ["rate"],
    );

    const csv = [
      "customer_trunk,number,keyword,rate,vendor_rate,currency,mccmnc,setup_charge,fix_charge",
      `${trunk.name},${input.number},TEST,0.04,,${trunk.currency},,0,0`,
      `${trunk.name},${input.number}1,,0.01,0.005,,26201,0,5`,
      `No such trunk,123456,,0.01,,,,0,0`,
      `${trunk.name},${input.number}2,,0.01,,${other},,0,0`,
    ].join("\n");
    const bad: ImportResult = await ok("importMoNumbers", call("POST", "/mo-numbers/import", { csv, dryRun: true }));
    assert.equal(bad.errors.length, 2);
    assert.match(bad.errors[1]!.message, new RegExp(`bills in ${trunk.currency}`), "a currency column must match");
    assert.equal(bad.updated, 1);
    assert.equal(bad.added, 1);
    const good: ImportResult = await ok(
      "importMoNumbers",
      call("POST", "/mo-numbers/import", { csv: csv.split("\n").slice(0, 3).join("\n"), dryRun: false }),
    );
    assert.equal(good.applied, true);
    const listed = await ok("queryMoNumbers", call("POST", "/mo-numbers/query", { limit: 10, search: input.number }));
    assert.equal(listed.total, 2);
    assert.ok(
      listed.rows.every((r: { currency: string }) => r.currency === trunk.currency),
      "entries without a currency column take the trunk's",
    );
    const gone = await ok("archiveMoNumber", call("POST", `/mo-numbers/${created.record.id}/archive`, {}));
    for (const c of [gone.change, good.change, changed.change, created.change]) await undo(c);
    const { rows } = await db().query(
      "SELECT count(*)::int AS n FROM mo_numbers WHERE number LIKE $1 AND deleted_at IS NULL",
      [`${input.number}%`],
    );
    assert.equal(rows[0].n, 0);
  });
});
