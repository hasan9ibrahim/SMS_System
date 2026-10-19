// Migration Center (build step 5.20, §13.22): entities, templates and mappings; the encrypted package
// (password, credential levels, manifest); single-use links; credential safeguards (admin + 2FA);
// CSV import through the reference mapping with dry run, fix and re-run, apply as one change, go-live
// per partner and rollback by undo; a package from this system dry-runs to skips. Every response is
// checked against the contract. Needs the seeded database.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { decryptSecret, totpCode } from "../src/admin/passwords.js";
import { parseCsv, pgArray, toCsv } from "../src/migration/csv.js";
import { PACKAGE_DIR, PackageError, readPackage, writePackage } from "../src/migration/package.js";
import { runningExports } from "../src/api/migration.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const run = Date.now().toString(36);
const cleanup: (() => Promise<unknown>)[] = [];
/** Export packages and imports this run makes: rows and files go when the tests end. */
const madeExports: number[] = [];
const madeImports: number[] = [];
cleanup.push(async () => {
  const { rows } = await db().query("SELECT file_path FROM migration_exports WHERE id = ANY($1)", [madeExports]);
  for (const r of rows) if (r.file_path) await rm(r.file_path, { force: true });
  await db().query("DELETE FROM migration_links WHERE export_id = ANY($1)", [madeExports]);
  await db().query("DELETE FROM migration_exports WHERE id = ANY($1)", [madeExports]);
  const { rows: imp } = await db().query("SELECT input->>'blob' AS blob FROM migration_imports WHERE id = ANY($1)", [
    madeImports,
  ]);
  for (const r of imp) if (r.blob) await rm(r.blob, { force: true });
  await db().query("DELETE FROM migration_refs WHERE import_id = ANY($1)", [madeImports]);
  await db().query("DELETE FROM migration_imports WHERE id = ANY($1)", [madeImports]);
});
after(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
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
async function fails(operationId: string, res: Promise<LightMyRequestResponse>, status: number) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: expected ${status}, got ${r.statusCode} ${r.body}`);
  check(operationId, r);
  return r.json();
}
async function myTotp() {
  const { rows } = await db().query("SELECT totp_secret FROM users WHERE id = 1");
  const stored = String(rows[0].totp_secret);
  return totpCode(stored.startsWith("enc:") ? decryptSecret(stored)! : stored);
}

describe("csv", () => {
  test("parses quotes, separators and line breaks; writes them back", () => {
    const rows = [
      ["a", 'say "hi"', "x,y"],
      ["multi\nline", "", "3"],
    ];
    assert.deepEqual(parseCsv(toCsv(rows)), rows);
    assert.deepEqual(parseCsv("a;b\n1;2\n\n"), [
      ["a", "b"],
      ["1", "2"],
    ]);
    assert.deepEqual(pgArray('{1,2,"a b"}'), ["1", "2", "a b"]);
  });
});

describe("migration center", { skip }, () => {
  let company = "";
  before(async () => {
    const { rows } = await db().query("SELECT name FROM business_companies ORDER BY id LIMIT 1");
    company = rows[0].name;
  });

  test("entities, templates and the reference platform's mappings", async () => {
    const entities = await ok("getMigrationEntities", call("GET", "/migration/entities"));
    assert.deepEqual(
      entities.map((e: { entity: string }) => e.entity),
      [
        "users",
        "enterprises",
        "customer_trunks",
        "vendor_trunks",
        "rate_tables",
        "rate_lines",
        "route_rules",
        "opening_balances",
      ],
    );
    const trunk = entities.find((e: { entity: string }) => e.entity === "customer_trunks");
    assert.equal(trunk.sensitivity, "credentials");
    assert.ok(trunk.fields.find((f: { field: string }) => f.field === "password").credential);
    const csv = await ok("getMigrationTemplate", call("GET", "/migration/templates/route_rules"));
    assert.match(csv, /^externalId,name,priority,status,customerTrunks,destinations,vendors\n/);
    const maps = await ok("getMigrationMappings", call("GET", "/migration/mappings"));
    assert.equal(maps.filter((m: { builtIn: boolean }) => m.builtIn).length, 8);
    const ref = maps.find((m: { builtIn: boolean; entity: string }) => m.builtIn && m.entity === "users");
    await fails(
      "saveMigrationMapping",
      call("POST", "/migration/mappings", {
        sourceSystem: ref.sourceSystem,
        entity: "users",
        name: ref.name,
        columns: ref.columns,
      }),
      400,
    );
    const mine = await ok(
      "saveMigrationMapping",
      call("POST", "/migration/mappings", {
        sourceSystem: `Legacy ${run}`,
        entity: "users",
        name: "Default",
        columns: { ...ref.columns, email: "Mail" },
      }),
    );
    cleanup.push(() => db().query("DELETE FROM migration_mappings WHERE id = $1", [mine.id]));
    assert.equal(mine.columns.email, "Mail");
    await fails(
      "saveMigrationMapping",
      call("POST", "/migration/mappings", {
        sourceSystem: `Legacy ${run}`,
        entity: "users",
        name: "Bad",
        columns: { username: "U" },
      }),
      400,
    );
  });

  test("the package opens only with its password and carries credentials only when asked", async () => {
    const path = join(PACKAGE_DIR, `test-${run}.smspkg`);
    cleanup.push(() => rm(path, { force: true }));
    const opts = { includeCredentials: false, withPasswords: false, rateLines: "none" as const };
    const { manifest, sizeBytes } = await writePackage(db(), opts, "correct horse battery", path, "test");
    assert.ok(sizeBytes > 1000);
    assert.ok(!manifest.entities.some((e) => e.entity === "rate_lines"));
    await assert.rejects(readPackage(path, "wrong password!!"), PackageError);
    const frames = await readPackage(path, "correct horse battery");
    assert.equal(JSON.parse(frames.get("manifest.json")!).entities.length, manifest.entities.length);
    const trunkHeader = parseCsv(frames.get("customer_trunks.csv")!)[0]!;
    assert.ok(trunkHeader.includes("name") && !trunkHeader.includes("username") && !trunkHeader.includes("password"));
    const userHeader = parseCsv(frames.get("users.csv")!)[0]!;
    assert.ok(
      userHeader.includes("username") && !userHeader.includes("password_hash") && !userHeader.includes("totp_secret"),
    );
    const enterprises = manifest.entities.find((e) => e.entity === "enterprises")!;
    assert.equal(parseCsv(frames.get("enterprises.csv")!).length - 1, enterprises.rows);
    assert.ok(manifest.links.some((l) => l.from === "customer_trunks" && l.to === "enterprises" && l.count > 0));

    await writePackage(
      db(),
      { ...opts, includeCredentials: true, withPasswords: true },
      "correct horse battery",
      path,
      "test",
    );
    const full = parseCsv((await readPackage(path, "correct horse battery")).get("vendor_trunks.csv")!)[0]!;
    assert.ok(full.includes("host") && full.includes("password"));
  });

  test("export, single-use link, credentials need 2FA", async () => {
    await fails(
      "createMigrationExport",
      call("POST", "/migration/exports", {
        includeCredentials: false,
        withPasswords: false,
        rateLines: "none",
        password: "short",
      }),
      400,
    );
    const body = {
      includeCredentials: true,
      withPasswords: false,
      rateLines: "none",
      password: "long-enough-password",
    };
    const exportsNow = async () => Number((await db().query("SELECT count(*) AS n FROM migration_exports")).rows[0].n);
    const countBefore = await exportsNow();
    const no2fa = await fails("createMigrationExport", call("POST", "/migration/exports", body), 400);
    assert.equal(no2fa.errors[0].path, "/totpCode");
    assert.equal(await exportsNow(), countBefore, "a refused export writes nothing");
    const before = Number(
      (await db().query("SELECT count(*) AS n FROM email_logs WHERE email_type = 'credential_transfer'")).rows[0].n,
    );
    const x = await ok(
      "createMigrationExport",
      call("POST", "/migration/exports", { ...body, totpCode: await myTotp() }),
      201,
    );
    madeExports.push(x.id);
    assert.equal(x.status, "running");
    assert.ok(x.includesCredentials);
    await runningExports.get(x.id);
    const done = await ok("getMigrationExport", call("GET", `/migration/exports/${x.id}`));
    assert.equal(done.status, "done", done.error);
    assert.ok(done.manifest.entities.length >= 20);
    const after = Number(
      (await db().query("SELECT count(*) AS n FROM email_logs WHERE email_type = 'credential_transfer'")).rows[0].n,
    );
    assert.ok(after > before);
    const list = await ok("getMigrationExports", call("GET", "/migration/exports"));
    assert.equal(list[0].id, x.id);

    await fails("createMigrationLink", call("POST", `/migration/exports/${x.id}/link`, {}), 400);
    const link = await ok(
      "createMigrationLink",
      call("POST", `/migration/exports/${x.id}/link`, { totpCode: await myTotp() }),
    );
    assert.match(link.url, /\/migration\/downloads\/[\w-]{20,}$/);
    const token = link.url.split("/").pop();
    const first = await app.inject({ method: "GET", url: `${API_PREFIX}/migration/downloads/${token}` });
    assert.equal(first.statusCode, 200);
    assert.equal(first.rawPayload.subarray(0, 8).toString(), "SMSPKG1\n");
    await fails("downloadMigrationPackage", call("GET", `/migration/downloads/${token}`), 410);
    await fails("downloadMigrationPackage", call("GET", "/migration/downloads/not-a-real-token-at-all"), 404);
    // The audit row is written after the answer is sent.
    let audit = { rows: [] as unknown[] };
    for (let i = 0; i < 20 && !audit.rows.length; i++) {
      audit = await db().query(
        "SELECT 1 FROM audit_log WHERE action = 'createMigrationExport' AND at > now() - interval '5 minutes'",
      );
      if (!audit.rows.length) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(audit.rows.length > 0);
  });

  test("CSV import: dry run, fix, apply as one change, go-live per partner, rollback by undo", async () => {
    const maps = await ok("getMigrationMappings", call("GET", "/migration/mappings"));
    const ref = (entity: string) =>
      maps.find((m: { builtIn: boolean; entity: string }) => m.builtIn && m.entity === entity).id;
    const ent = `Legacy Ent ${run}`;
    const csv = (rows: string[][]) => toCsv(rows);
    const files = (mcc: string, totp?: string) => ({
      sourceSystem: `Legacy ${run}`,
      trunksInactive: true,
      conflicts: {},
      ...(totp ? { totpCode: totp } : {}),
      files: [
        {
          entity: "users",
          fileName: "users.csv",
          mappingId: ref("users"),
          content: csv([
            ["User ID", "User Name", "First Name", "Last Name", "Email", "Department", "Account Manager", "Status"],
            ["900", `legacy.am.${run}`, "Legacy", "Manager", `legacy.${run}@example.com`, "Sales", "yes", "active"],
          ]),
        },
        {
          entity: "enterprises",
          fileName: "enterprises.csv",
          mappingId: ref("enterprises"),
          content: csv([
            [
              "Enterprise ID",
              "Enterprise Name",
              "Enterprise Type",
              "Business Company",
              "Account Manager",
              "Country",
              "Commercial Email",
            ],
            ["E1", ent, "reciprocal", company, "900", "AE", `rates.${run}@example.com`],
          ]),
        },
        {
          entity: "customer_trunks",
          fileName: "ct.csv",
          mappingId: ref("customer_trunks"),
          content: csv([
            [
              "Customer Trunk ID",
              "Enterprise Name",
              "Customer Trunk Name",
              "System ID",
              "Password",
              "Host IP",
              "TPS",
              "Product Category",
            ],
            ["C1", "E1", `LEG_C_${run}`, `leg_${run}`, "pw-example", "192.0.2.1;192.0.2.2", "20", "OTP"],
          ]),
        },
        {
          entity: "vendor_trunks",
          fileName: "vt.csv",
          mappingId: ref("vendor_trunks"),
          content: csv([
            ["Vendor Trunk ID", "Enterprise Name", "Vendor Trunk Name", "Host", "TPS", "Product Category"],
            ["V1", ent, `LEG_V_${run}`, "smsc.example.net", "50", "DIRECT"],
          ]),
        },
        {
          entity: "rate_tables",
          fileName: "rt.csv",
          mappingId: ref("rate_tables"),
          content: csv([
            ["Rate Table ID", "Rate Table Name", "Type", "Currency", "Product Category", "Vendor Trunk"],
            ["R1", `LEG_V_${run} USD`, "vendor", "USD", "DIRECT", "V1"],
          ]),
        },
        {
          entity: "rate_lines",
          fileName: "lines.csv",
          content: csv([
            ["rateTable", "mccmnc", "rate", "validFrom"],
            ["R1", mcc, "0.0100", "2026-01-01"],
            ["R1", mcc, "0.0120", "2026-06-01"],
            ["R1", "42402", "0.0110", ""],
          ]),
        },
        {
          entity: "route_rules",
          fileName: "rules.csv",
          mappingId: ref("route_rules"),
          content: csv([
            ["Rule ID", "Rule Name", "Priority", "Customer Trunks", "MCCMNC", "Vendor Trunks"],
            ["RR1", `Legacy rule ${run}`, "50", "C1", "424", `LEG_V_${run}:100`],
          ]),
        },
        {
          entity: "opening_balances",
          fileName: "bal.csv",
          mappingId: ref("opening_balances"),
          content: csv([
            ["Enterprise Name", "Account Type", "Balance", "Currency", "Balance Date"],
            [ent, "customer", "-250.50", "USD", "2026-10-01"],
          ]),
        },
      ],
    });

    // Trunk credentials in the files: admin + 2FA.
    const importsNow = async () => Number((await db().query("SELECT count(*) AS n FROM migration_imports")).rows[0].n);
    const countBefore = await importsNow();
    const refused = await fails("createMigrationImport", call("POST", "/migration/imports", files("999")), 400);
    assert.equal(refused.errors[0].path, "/totpCode");
    assert.equal(await importsNow(), countBefore, "a refused import writes nothing");

    const dry = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", files("999", await myTotp())),
      201,
    );
    madeImports.push(dry.id);
    assert.equal(dry.status, "validated");
    assert.ok(dry.includesCredentials);
    assert.equal(dry.report.canApply, false);
    assert.ok(
      dry.report.issues.some((i: { field: string; message: string }) => i.field === "mccmnc" && /999/.test(i.message)),
    );
    await fails("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 409);

    const fixed = await ok(
      "revalidateMigrationImport",
      call("PUT", `/migration/imports/${dry.id}`, files("424", await myTotp())),
    );
    assert.equal(fixed.report.canApply, true, JSON.stringify(fixed.report.issues));
    const by = (e: string) => fixed.report.entities.find((x: { entity: string }) => x.entity === e);
    for (const e of [
      "users",
      "enterprises",
      "customer_trunks",
      "vendor_trunks",
      "rate_tables",
      "route_rules",
      "opening_balances",
    ])
      assert.equal(by(e).create, 1, e);
    assert.equal(by("rate_lines").create, 3);
    assert.equal(fixed.files.find((f: { entity: string }) => f.entity === "users").mapping, "Reference platform");
    // The dry run wrote nothing.
    assert.equal((await db().query("SELECT 1 FROM enterprises WHERE name = $1", [ent])).rows.length, 0);

    const applied = await ok("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`));
    assert.equal(applied.status, "applied");
    assert.ok(applied.changeId);
    assert.equal(applied.inactiveTrunks, 2);
    await fails("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 409);
    const { rows: e } = await db().query(
      `SELECT e.id, e.type, u.username, (SELECT count(*) FROM enterprise_billing b WHERE b.enterprise_id = e.id) AS sides
         FROM enterprises e JOIN users u ON u.id = e.account_manager_id WHERE e.name = $1`,
      [ent],
    );
    assert.equal(e[0].username, `legacy.am.${run}`);
    assert.equal(Number(e[0].sides), 2);
    const { rows: lines } = await db().query(
      `SELECT l.mccmnc, l.rate, l.valid_to FROM rate_lines l JOIN rate_tables t ON t.id = l.rate_table_id
        WHERE t.name = $1 ORDER BY l.mccmnc, l.valid_from`,
      [`LEG_V_${run} USD`],
    );
    assert.equal(lines.length, 3);
    assert.equal(new Date(lines[0].valid_to).toISOString(), "2026-06-01T00:00:00.000Z");
    const { rows: refs } = await db().query("SELECT entity, external_id FROM migration_refs WHERE import_id = $1", [
      dry.id,
    ]);
    assert.ok(refs.some((r) => r.entity === "customer_trunks" && r.external_id === "C1"));
    const { rows: tx } = await db().query(
      "SELECT payment_type, amount FROM transactions WHERE enterprise_id = $1 AND deleted_at IS NULL",
      [e[0].id],
    );
    assert.deepEqual(
      tx.map((t) => [t.payment_type, Number(t.amount)]),
      [["debit", 250.5]],
    );

    const go = await ok(
      "activateMigrationTrunks",
      call("POST", `/migration/imports/${dry.id}/activate`, { enterpriseIds: [e[0].id] }),
    );
    assert.equal(go.activated, 2);
    assert.equal(go.change.changeType, "enable");
    const again = await ok(
      "activateMigrationTrunks",
      call("POST", `/migration/imports/${dry.id}/activate`, { enterpriseIds: null }),
    );
    assert.equal(again.activated, 0);

    // Undo = rollback of the whole import.
    await ok("undoChange", call("POST", `/changes/${applied.changeId}/undo`, {}));
    const rolled = await ok("getMigrationImport", call("GET", `/migration/imports/${dry.id}`));
    assert.equal(rolled.status, "rolled_back");
    const { rows: gone } = await db().query(
      `SELECT (SELECT deleted_at FROM enterprises WHERE id = $1) AS e,
              (SELECT deleted_at FROM customer_trunks WHERE name = $2) AS t,
              (SELECT deleted_at FROM users WHERE username = $3) AS u,
              (SELECT count(*) FROM transactions WHERE enterprise_id = $1 AND deleted_at IS NULL) AS tx`,
      [e[0].id, `LEG_C_${run}`, `legacy.am.${run}`],
    );
    assert.ok(gone[0].e && gone[0].t && gone[0].u);
    assert.equal(Number(gone[0].tx), 0);
    await fails(
      "activateMigrationTrunks",
      call("POST", `/migration/imports/${dry.id}/activate`, { enterpriseIds: null }),
      409,
    );
    const list = await ok("getMigrationImports", call("GET", "/migration/imports"));
    assert.ok(list.some((i: { id: number }) => i.id === dry.id));
  });

  test("a package from this system dry-runs to skips: nothing is duplicated", async () => {
    const x = await ok(
      "createMigrationExport",
      call("POST", "/migration/exports", {
        includeCredentials: false,
        withPasswords: false,
        rateLines: "none",
        password: "long-enough-password",
      }),
      201,
    );
    madeExports.push(x.id);
    await runningExports.get(x.id);
    const wrong = await fails(
      "createMigrationImport",
      call("POST", "/migration/imports", {
        sourceSystem: `Twin ${run}`,
        files: [],
        packageExportId: x.id,
        packagePassword: "not the password",
        trunksInactive: true,
      }),
      400,
    );
    assert.equal(wrong.errors[0].path, "/packagePassword");
    const dry = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", {
        sourceSystem: `Twin ${run}`,
        files: [],
        packageExportId: x.id,
        packagePassword: "long-enough-password",
        trunksInactive: true,
      }),
      201,
    );
    madeImports.push(dry.id);
    for (const e of dry.report.entities) assert.equal(e.create + e.update, 0, `${e.entity}: ${JSON.stringify(e)}`);
    assert.equal(dry.report.canApply, false);
    assert.ok(dry.report.issues.some((i: { entity: string }) => i.entity === "package"));
  });
});
