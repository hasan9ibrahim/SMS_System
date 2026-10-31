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
import type { MigrationImportEntity } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { TOTP_USED } from "../src/admin/passwords.js";
import { parseCsv, pgArray, toCsv } from "../src/migration/csv.js";
import { PACKAGE_DIR, PackageError, readPackage, writePackage } from "../src/migration/package.js";
import { runningApplies, runningExports } from "../src/api/migration.js";
import { lacking } from "../src/migration/importer.js";
import { withFreshTotp } from "./totp.js";

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
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
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
/** The test admin's (user 1) authenticator code, fresh for each call: a code works once (§13.28). */
const asAdmin = <T>(use: (code: string) => Promise<T>) => withFreshTotp(1, use);

/** What a new user needs besides its name and e-mail (§13.22), as template fields, and seeded values for them. */
const NEED_FIELDS = ["department", "accessGroup", "businessCompany", "address", "country"];
let seededCompany = "";
const userNeeds = () => ["Sales", "Account Manager", seededCompany, "1 Example Street", "AE"];
/**
 * Adds the last `headers.length` of those to a users file, as `[header, ...rows].map(addUserNeeds(headers))`: the
 * header row gets the column names, every other row the values.
 */
const addUserNeeds = (headers: string[]) => (row: string[], i: number) => [
  ...row,
  ...(i === 0 ? headers : userNeeds().slice(-headers.length)),
];

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
    seededCompany = company;
  });

  test("entities, templates and the reference platform's mappings", async () => {
    const entities = await ok("getMigrationEntities", call("GET", "/migration/entities"));
    assert.deepEqual(
      entities.map((e: { entity: string }) => e.entity),
      [
        "departments",
        "product_categories",
        "users",
        "enterprises",
        "customer_trunks",
        "vendor_trunks",
        "rate_tables",
        "rate_lines",
        "number_lists",
        "route_rules",
        "translation_rules",
        "hlr_rules",
        "opening_balances",
      ],
    );
    const trunk = entities.find((e: { entity: string }) => e.entity === "customer_trunks");
    assert.equal(trunk.sensitivity, "credentials");
    assert.ok(trunk.fields.find((f: { field: string }) => f.field === "password").credential);
    const csv = await ok("getMigrationTemplate", call("GET", "/migration/templates/route_rules"));
    assert.match(csv, /^externalId,name,priority,status,customerTrunks,destinations,vendors\n/);
    const maps = await ok("getMigrationMappings", call("GET", "/migration/mappings"));
    assert.equal(maps.filter((m: { builtIn: boolean }) => m.builtIn).length, 13);
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
    const x = await asAdmin(async (code) => {
      const made = await ok(
        "createMigrationExport",
        call("POST", "/migration/exports", { ...body, totpCode: code }),
        201,
      );
      // The code works once (§13.28): the same code makes no second export.
      const reused = await fails(
        "createMigrationExport",
        call("POST", "/migration/exports", { ...body, totpCode: code }),
        400,
      );
      assert.deepEqual(reused.errors, [{ path: "/totpCode", message: TOTP_USED }]);
      return made;
    });
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
    const link = await asAdmin((code) =>
      ok("createMigrationLink", call("POST", `/migration/exports/${x.id}/link`, { totpCode: code })),
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
    const files = (mcc: string, totp?: string, ips = "192.0.2.1;192.0.2.2") => ({
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
            // Everything else Add user needs (§13.22), under the reference platform's names.
          ].map(addUserNeeds(["GUI Access Group", "Business Company", "Address 1", "Country"]))),
        },
        {
          entity: "enterprises",
          fileName: "enterprises.csv",
          mappingId: ref("enterprises"),
          // Everything Add enterprise needs (§13.22): an AM, the country, the address and the four contacts' e-mails.
          content: csv([
            [
              "Enterprise ID",
              "Enterprise Name",
              "Enterprise Type",
              "Business Company",
              "Account Manager",
              "Country",
              "Address 1",
              "Commercial Email",
              "Technical Email",
              "Rates Email",
              "Billing Email",
            ],
            [
              "E1",
              ent,
              "reciprocal",
              company,
              "900",
              "AE",
              "2 Example Road",
              `sales.${run}@example.com`,
              `noc.${run}@example.com`,
              `rates.${run}@example.com`,
              `billing.${run}@example.com`,
            ],
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
            // An SMPP 3.4 password holds 9 characters at most (§13.22: the import takes the trunk form's formats).
            ["C1", "E1", `LEG_C_${run}`, `leg_${run}`, "pw-exampl", ips, "20", "OTP"],
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

    const dry = await asAdmin((code) =>
      ok("createMigrationImport", call("POST", "/migration/imports", files("999", code, "192.0.2.1;192.0.2.300")), 201),
    );
    madeImports.push(dry.id);
    assert.equal(dry.status, "validated");
    assert.ok(dry.includesCredentials);
    assert.equal(dry.report.canApply, false);
    assert.ok(
      dry.report.issues.some((i: { field: string; message: string }) => i.field === "mccmnc" && /999/.test(i.message)),
    );
    // A bad trunk address is a dry-run error (R9: it used to pass and fail Apply in the database).
    assert.ok(
      dry.report.issues.some(
        (i: { field: string; severity: string; message: string }) =>
          i.field === "hostIps" && i.severity === "error" && /192\.0\.2\.300/.test(i.message),
      ),
    );
    await fails("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 409);

    const fixed = await asAdmin((code) =>
      ok(
        "revalidateMigrationImport",
        call("PUT", `/migration/imports/${dry.id}`, files("424", code, "192.0.2.10-192.0.2.13;198.51.100.0/24")),
      ),
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

    // Apply runs in the background (R9): applying at once, then applied.
    const applying = await ok("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 202);
    assert.equal(applying.status, "applying");
    await runningApplies.get(dry.id);
    const applied = await ok("getMigrationImport", call("GET", `/migration/imports/${dry.id}`));
    assert.equal(applied.status, "applied", applied.applyError);
    assert.equal(applied.applyError, null);
    assert.ok(applied.changeId);
    // Rolled back below; if an assertion stops the test first, the import is undone when the tests end, so its live
    // partner, trunks, rule and user do not stay in the shared database (QA 2026-10-31).
    cleanup.push(async () => {
      const { rows: undone } = await db().query("SELECT 1 FROM changes WHERE undo_of_id = $1", [applied.changeId]);
      if (!undone.length) await call("POST", `/changes/${applied.changeId}/undo`, {});
    });
    assert.equal(applied.inactiveTrunks, 2);
    await fails("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 409);
    const { rows: e } = await db().query(
      `SELECT e.id, e.type, u.username, (SELECT count(*) FROM enterprise_billing b WHERE b.enterprise_id = e.id) AS sides
         FROM enterprises e JOIN users u ON u.id = e.account_manager_id WHERE e.name = $1`,
      [ent],
    );
    assert.equal(e[0].username, `legacy.am.${run}`);
    assert.equal(Number(e[0].sides), 2);
    // The AM history holds the imported AM (QA 2026-10-31, §13.30): reports attribute by it, and the record keeps it.
    const { rows: hist } = await db().query(
      `SELECT u.username, h.ends_at FROM enterprise_am_history h JOIN users u ON u.id = h.user_id
        WHERE h.enterprise_id = $1`,
      [e[0].id],
    );
    assert.deepEqual(
      hist.map((h) => [h.username, h.ends_at]),
      [[`legacy.am.${run}`, null]],
    );
    // Checked against the contract: an import row now holds what Add enterprise needs (§13.22).
    const record = await ok("getEnterprise", call("GET", `/enterprises/${e[0].id}`));
    assert.equal(record.accountManagerName, "Legacy Manager", "a load keeps the imported AM");
    const { rows: lines } = await db().query(
      `SELECT l.mccmnc, l.rate, l.valid_to FROM rate_lines l JOIN rate_tables t ON t.id = l.rate_table_id
        WHERE t.name = $1 ORDER BY l.mccmnc, l.valid_from`,
      [`LEG_V_${run} USD`],
    );
    assert.equal(lines.length, 3);
    // The range is stored as the networks that cover it (R9).
    const { rows: ips } = await db().query("SELECT host_ips::text[] AS ips FROM customer_trunks WHERE name = $1", [
      `LEG_C_${run}`,
    ]);
    assert.deepEqual(ips[0].ips, ["192.0.2.10/31", "192.0.2.12/31", "198.51.100.0/24"]);
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

    // Delete (R9): off the list, files gone.
    await ok("deleteMigrationImport", call("DELETE", `/migration/imports/${dry.id}`), 204);
    await fails("getMigrationImport", call("GET", `/migration/imports/${dry.id}`), 404);
    const { rows: del } = await db().query("SELECT deleted_at, files_enc FROM migration_imports WHERE id = $1", [
      dry.id,
    ]);
    assert.ok(del[0].deleted_at);
    assert.equal(del[0].files_enc, null);
  });

  test("an apply whose stored files are gone writes nothing and says why", async () => {
    const dry = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", {
        sourceSystem: `Gone ${run}`,
        trunksInactive: true,
        files: [
          {
            entity: "users",
            fileName: "users.csv",
            content: toCsv([
              ["externalId", "username", "firstName", "lastName", "email"],
              ["G1", `gone.${run}`, "Gone", "User", `gone.${run}@example.com`],
            ].map(addUserNeeds(NEED_FIELDS))),
          },
        ],
      }),
      201,
    );
    madeImports.push(dry.id);
    assert.equal(dry.report.canApply, true, JSON.stringify(dry.report.issues));
    await db().query("UPDATE migration_imports SET files_enc = NULL WHERE id = $1", [dry.id]);
    await ok("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 202);
    await runningApplies.get(dry.id);
    const back = await ok("getMigrationImport", call("GET", `/migration/imports/${dry.id}`));
    assert.equal(back.status, "validated");
    assert.match(back.applyError, /Fix and re-run/);
    assert.equal((await db().query("SELECT 1 FROM users WHERE username = $1", [`gone.${run}`])).rows.length, 0);
  });

  test("headers are matched loosely and choices read as written; Apply then succeeds (team trial round 11)", async () => {
    // "Active" used to pass the dry run and fail Apply on users_status_check; "User name" and "Username" are one
    // column whatever mapping is picked.
    const username = `loose.${run}`;
    const { rows: maps } = await db().query(
      "SELECT id FROM migration_mappings WHERE entity = 'users' AND built_in ORDER BY id LIMIT 1",
    );
    const dry = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", {
        sourceSystem: `Loose ${run}`,
        trunksInactive: true,
        files: [
          {
            entity: "users",
            fileName: "users.csv",
            mappingId: maps[0] ? Number(maps[0].id) : null,
            content: toCsv([
              ["External ID", "Username", "First name", "Last_Name", "E-MAIL", "Account Manager", "Status"],
              ["L1", username, "Loosa", "Fakename", `${username}@example.com`, "Yes", "Active"],
              // What a new user needs besides (§13.22), under names the fields are known by.
            ].map(addUserNeeds(["Dept", "Role", "Company", "Street", "Country code"]))),
          },
        ],
      }),
      201,
    );
    madeImports.push(dry.id);
    assert.equal(dry.report.canApply, true, JSON.stringify(dry.report.issues));
    await ok("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 202);
    await runningApplies.get(dry.id);
    const { rows } = await db().query("SELECT id, status, is_account_manager FROM users WHERE username = $1", [
      username,
    ]);
    assert.equal(rows[0]?.status, "active");
    assert.equal(rows[0]?.is_account_manager, true);
    cleanup.push(async () => {
      await db().query("DELETE FROM migration_refs WHERE entity = 'users' AND record_id = $1", [rows[0].id]);
      await db().query("DELETE FROM users WHERE id = $1", [rows[0].id]);
    });
    // A word the field does not know is reported by the dry run instead of failing Apply.
    const bad = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", {
        sourceSystem: `Loose ${run}`,
        trunksInactive: true,
        files: [
          {
            entity: "users",
            fileName: "users.csv",
            content: toCsv([
              ["username", "firstName", "lastName", "email", "status"],
              [`odd.${run}`, "Odda", "Fakename", `odd.${run}@example.com`, "Sleeping"],
            ]),
          },
        ],
      }),
      201,
    );
    madeImports.push(bad.id);
    assert.equal(bad.report.canApply, false);
    assert.ok(
      bad.report.issues.some((i: { field: string }) => i.field === "status"),
      JSON.stringify(bad.report.issues),
    );
  });

  test("departments, categories, number lists, translation and HLR rules import and roll back (team trial round 12)", async () => {
    const { rows: tr } = await db().query(
      "SELECT name FROM customer_trunks WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    const { rows: hp } = await db().query(
      "SELECT name FROM hlr_providers WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    const trunk = String(tr[0].name);
    const tag = `Imp tags ${run}`;
    const pool = `Imp pool ${run}`;
    const file = (entity: string, rows: string[][]) => ({ entity, fileName: `${entity}.csv`, content: toCsv(rows) });
    const files = [
      file("departments", [
        ["Department", "Description"],
        [`Imp dept ${run}`, "Imported"],
      ]),
      file("product_categories", [["Category"], [`Imp cat ${run}`]]),
      // One row per value, and several values in one row; the type written loosely.
      file("number_lists", [
        ["List name", "Type", "Value"],
        [tag, "Tag", "BANKX"],
        [tag, "tag", "BANKY;BANKZ"],
        [pool, "Random numbers", "447700900001,447700900002"],
      ]),
      file("translation_rules", [
        [
          "Rule",
          "Customer trunk",
          "Sender ID list",
          "Sender ID conversion",
          "Sender ID conversion number list",
          "Destination TON",
        ],
        [`Imp rule ${run}`, trunk, tag, "random_number", pool, "1"],
      ]),
      file("hlr_rules", [
        ["Rule name", "HLR provider", "DNID", "Customer trunk"],
        [`Imp hlr ${run}`, String(hp[0].name), "^234", trunk],
      ]),
    ];
    const dry = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", { sourceSystem: `Lists ${run}`, trunksInactive: true, files }),
      201,
    );
    madeImports.push(dry.id);
    assert.equal(dry.report.canApply, true, JSON.stringify(dry.report.issues));
    const counts = Object.fromEntries(
      dry.report.entities.map((e: { entity: string; create: number }) => [e.entity, e.create]),
    );
    assert.deepEqual(counts, {
      departments: 1,
      product_categories: 1,
      number_lists: 3,
      translation_rules: 1,
      hlr_rules: 1,
    });
    await ok("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 202);
    await runningApplies.get(dry.id);
    const applied = await ok("getMigrationImport", call("GET", `/migration/imports/${dry.id}`));
    assert.equal(applied.status, "applied", applied.applyError);
    cleanup.push(async () => {
      await db().query(
        "DELETE FROM translation_rule_targets WHERE translation_rule_id IN (SELECT id FROM translation_rules WHERE name = $1)",
        [`Imp rule ${run}`],
      );
      await db().query("DELETE FROM translation_rules WHERE name = $1", [`Imp rule ${run}`]);
      await db().query("DELETE FROM hlr_rule_targets WHERE hlr_rule_id IN (SELECT id FROM hlr_rules WHERE name = $1)", [
        `Imp hlr ${run}`,
      ]);
      await db().query("DELETE FROM hlr_rules WHERE name = $1", [`Imp hlr ${run}`]);
      await db().query(
        "DELETE FROM number_list_entries WHERE number_list_id IN (SELECT id FROM number_lists WHERE name = ANY($1))",
        [[tag, pool]],
      );
      await db().query("DELETE FROM number_lists WHERE name = ANY($1)", [[tag, pool]]);
      await db().query("DELETE FROM departments WHERE name = $1", [`Imp dept ${run}`]);
      await db().query("DELETE FROM product_categories WHERE name = $1", [`Imp cat ${run}`]);
    });
    const { rows: lists } = await db().query(
      `SELECT l.name, l.list_type, array_agg(e.value ORDER BY e.value) AS values FROM number_lists l
         JOIN number_list_entries e ON e.number_list_id = l.id WHERE l.name = ANY($1) GROUP BY l.id ORDER BY l.name`,
      [[tag, pool]],
    );
    assert.deepEqual(
      lists.map((l) => [l.name, l.list_type, l.values]),
      [
        [pool, "random", ["447700900001", "447700900002"]],
        [tag, "tag", ["BANKX", "BANKY", "BANKZ"]],
      ],
    );
    const { rows: rule } = await db().query(
      `SELECT r.sender_conversion, r.dest_ton, sl.name AS sender_list, cl.name AS conversion_list,
              (SELECT count(*) FROM translation_rule_targets t WHERE t.translation_rule_id = r.id AND t.target_type = 'trunk'
                  AND t.trunk_kind = 'customer') AS targets
         FROM translation_rules r LEFT JOIN number_lists sl ON sl.id = r.sender_list_id
         LEFT JOIN number_lists cl ON cl.id = r.sender_conversion_list_id WHERE r.name = $1`,
      [`Imp rule ${run}`],
    );
    assert.deepEqual(
      { ...rule[0], targets: Number(rule[0].targets) },
      { sender_conversion: "random_number", dest_ton: 1, sender_list: tag, conversion_list: pool, targets: 1 },
    );
    const { rows: hlr } = await db().query(
      "SELECT dnid_pattern, (SELECT count(*) FROM hlr_rule_targets t WHERE t.hlr_rule_id = h.id) AS n FROM hlr_rules h WHERE name = $1",
      [`Imp hlr ${run}`],
    );
    assert.deepEqual([hlr[0].dnid_pattern, Number(hlr[0].n)], ["^234", 1]);

    // The same lists again with one new value: only that value is added.
    const again = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", {
        sourceSystem: `Lists ${run}`,
        trunksInactive: true,
        files: [
          file("number_lists", [
            ["List name", "Type", "Value"],
            [tag, "tag", "BANKX,BANKW"],
          ]),
        ],
      }),
      201,
    );
    madeImports.push(again.id);
    assert.equal(again.report.entities[0].create, 1);
    // A list type that does not fit the existing list is an error.
    const wrong = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", {
        sourceSystem: `Lists ${run}`,
        trunksInactive: true,
        files: [
          file("number_lists", [
            ["List name", "Type", "Value"],
            [tag, "random", "447700900003"],
          ]),
        ],
      }),
      201,
    );
    madeImports.push(wrong.id);
    assert.equal(wrong.report.canApply, false);

    // Undo rolls the whole import back: every record it made is archived.
    await ok("undoChange", call("POST", `/changes/${applied.changeId}/undo`, {}));
    const { rows: gone } = await db().query(
      `SELECT (SELECT count(*) FROM translation_rules WHERE name = $1 AND deleted_at IS NULL)
            + (SELECT count(*) FROM hlr_rules WHERE name = $2 AND deleted_at IS NULL)
            + (SELECT count(*) FROM number_lists WHERE name = ANY($3) AND deleted_at IS NULL)
            + (SELECT count(*) FROM departments WHERE name = $4 AND deleted_at IS NULL)
            + (SELECT count(*) FROM product_categories WHERE name = $5 AND deleted_at IS NULL) AS live`,
      [`Imp rule ${run}`, `Imp hlr ${run}`, [tag, pool], `Imp dept ${run}`, `Imp cat ${run}`],
    );
    assert.equal(Number(gone[0].live), 0);
  });

  test("a deleted user in the file is restored, not skipped (team trial round 10)", async () => {
    const username = `back.${run}`;
    const users = (source: string, first: string) => ({
      sourceSystem: source,
      trunksInactive: true,
      files: [
        {
          entity: "users",
          fileName: "users.csv",
          content: toCsv([
            ["externalId", "username", "firstName", "lastName", "email"],
            ["B1", username, first, "User", `${username}@example.com`],
          ].map(addUserNeeds(NEED_FIELDS))),
        },
      ],
    });
    const first = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", users(`Back ${run}`, "Back")),
      201,
    );
    madeImports.push(first.id);
    await ok("applyMigrationImport", call("POST", `/migration/imports/${first.id}/apply`), 202);
    await runningApplies.get(first.id);
    const { rows } = await db().query("SELECT id FROM users WHERE username = $1", [username]);
    const id = Number(rows[0].id);
    cleanup.push(async () => {
      await db().query("DELETE FROM migration_refs WHERE entity = 'users' AND record_id = $1", [id]);
      await db().query("DELETE FROM users WHERE id = $1", [id]);
    });
    // Deleted (as a rollback leaves them): the username stays taken, so a second import used to skip the row.
    await db().query("UPDATE users SET deleted_at = now() WHERE id = $1", [id]);
    const again = await ok(
      "createMigrationImport",
      call("POST", "/migration/imports", users(`Back again ${run}`, "Again")),
      201,
    );
    madeImports.push(again.id);
    const counts = again.report.entities.find((e: { entity: string }) => e.entity === "users");
    assert.equal(counts.update, 1, JSON.stringify(counts));
    assert.equal(again.report.canApply, true, JSON.stringify(again.report.issues));
    assert.ok(
      again.report.issues.some((i: { message: string }) => /was deleted: the import restores it/.test(i.message)),
    );
    await ok("applyMigrationImport", call("POST", `/migration/imports/${again.id}/apply`), 202);
    await runningApplies.get(again.id);
    const back = await db().query("SELECT deleted_at, first_name FROM users WHERE id = $1", [id]);
    assert.equal(back.rows[0].deleted_at, null);
    assert.equal(back.rows[0].first_name, "Again");
    // Undo of that import deletes the user again, with its old details.
    const restored = await ok("getMigrationImport", call("GET", `/migration/imports/${again.id}`));
    await ok("undoChange", call("POST", `/changes/${restored.changeId}/undo`, {}));
    const undone = await db().query("SELECT deleted_at, first_name FROM users WHERE id = $1", [id]);
    assert.notEqual(undone.rows[0].deleted_at, null);
    assert.equal(undone.rows[0].first_name, "Back");
  });

  test("the e-mailed credential code is for admins without the authenticator app", async () => {
    // The test admin has the app: its code is the one to use.
    await fails("sendMyCredentialCode", call("POST", "/me/credential-code"), 409);
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

// §13.22 (approved 2026-10-31): a row that adds a record must hold everything the app's own create needs, or the
// row is refused: the dry run names its row and what is missing, and Apply writes nothing until the file is fixed.
describe("rows lacking what the app needs to add a record are refused (§13.22)", () => {
  test("the contract's create schemas decide: complete records lack nothing, a missing value is named", () => {
    const contacts = {
      commercial: ["a@example.com"],
      technical: ["n@example.com"],
      rates: ["r@example.com"],
      finance: ["f@example.com"],
    };
    const complete: [MigrationImportEntity, Record<string, unknown>, Record<string, unknown>?][] = [
      ["departments", { name: "Fake dept", status: "active", description: null }],
      ["product_categories", { name: "Fake category" }],
      ["number_lists", { name: "Fake list", list_type: "tag" }, { entries: [{ value: "FAKETAG", content: null }] }],
      [
        "users",
        {
          username: "fake.user",
          first_name: "Fake",
          last_name: "User",
          email: "fake.user@example.com",
          department_id: 1,
          access_group_id: 2,
          business_company_id: 1,
          address1: "1 Example Street",
          country_iso: "AE",
          is_account_manager: false,
          status: "active",
        },
      ],
      [
        "enterprises",
        {
          name: "Fake Enterprise",
          alias: "FAKE",
          type: "customer",
          tier: "tier3",
          status: "active",
          business_company_id: 1,
          account_manager_id: 5,
          address_line1: "2 Example Road",
          country_id: 3,
          vat_number: null,
        },
        { contacts },
      ],
      [
        "customer_trunks",
        {
          enterprise_id: 1,
          name: "FAKE_C",
          protocol: "smpp",
          product_category_id: null,
          billing_type: "submit",
          tps: 10,
          bind_type: "TR",
          max_connections: 2,
          username: "fake_c",
          password: "pw",
          host_ips: ["192.0.2.1/32"],
          ssl_type: "none",
        },
      ],
      [
        "vendor_trunks",
        {
          enterprise_id: 1,
          name: "FAKE_V",
          protocol: "smpp",
          product_category_id: 2,
          billing_type: "submit",
          tps: 10,
          bind_type: "TR",
          max_connections: 2,
          port: 2775,
          host: "smsc.example.net",
          username: "fake_v",
          password: "pw",
        },
      ],
      [
        "rate_tables",
        { name: "Fake table", kind: "vendor", product_category_id: 1, currency: "USD", vendor_trunk_id: 1 },
      ],
      [
        "route_rules",
        {
          name: "Fake rule",
          priority: 50,
          status: "active",
          customer_trunk_mode: "all",
          customer_trunk_ids: [],
          mccmnc_mode: "all",
          mccmncs: [],
        },
        { vendors: [{ trunk: 1, share: null }], percentage: false },
      ],
      ["hlr_rules", { name: "Fake HLR rule", hlr_provider_id: 1, dnid_pattern: "^44", status: "active" }],
      ["opening_balances", { enterprise_id: 1, side: "customer", amount: -10, currency: "USD", date: "2026-10-01" }],
    ];
    const byEntity = new Map(complete.map(([e, v, x]) => [e, { v, x }]));
    for (const [e, v, x] of complete) assert.deepEqual(lacking(e, v, x), [], e);
    const without = (e: MigrationImportEntity, change: Record<string, unknown>, extra?: Record<string, unknown>) =>
      lacking(e, { ...byEntity.get(e)!.v, ...change }, extra ?? byEntity.get(e)!.x);
    assert.deepEqual(without("departments", { name: "" }), ["name"]);
    assert.deepEqual(without("product_categories", { name: "" }), ["name"]);
    assert.deepEqual(without("number_lists", { name: "" }), ["name"]);
    assert.deepEqual(without("users", { address1: "" }), ["address"]);
    assert.deepEqual(without("users", { department_id: null }), ["department"]);
    assert.deepEqual(without("users", { access_group_id: null, business_company_id: null }).sort(), [
      "accessGroup",
      "businessCompany",
    ]);
    assert.deepEqual(without("enterprises", { address_line1: "" }, { contacts: { ...contacts, technical: [] } }), [
      "address",
      "technicalEmails",
    ]);
    assert.deepEqual(without("enterprises", { country_id: null, account_manager_id: null }).sort(), [
      "accountManager",
      "country",
    ]);
    assert.deepEqual(without("customer_trunks", { host_ips: [] }), ["hostIps"]);
    assert.deepEqual(without("vendor_trunks", { product_category_id: null }), ["category"]);
    assert.deepEqual(without("rate_tables", { currency: "" }), ["currency"]);
    assert.deepEqual(without("route_rules", { name: "" }), ["name"]);
    assert.deepEqual(without("hlr_rules", { dnid_pattern: "" }), ["dnidPattern"]);
    assert.deepEqual(without("opening_balances", { date: null }), ["date"]);
  });

  test(
    "an enterprise without address or contacts is refused in the dry run and not created; a complete one imports",
    { skip },
    async () => {
      const { rows: am } = await db().query(
        "SELECT username FROM users WHERE is_account_manager AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1",
      );
      const okName = `Complete Ent ${run}`;
      const badName = `Lacking Ent ${run}`;
      const header = [
        "externalId",
        "name",
        "type",
        "businessCompany",
        "accountManager",
        "country",
        "address",
        "emails",
        "technicalEmails",
        "ratesEmails",
        "financeEmails",
      ];
      const complete = [
        "CE1",
        okName,
        "customer",
        seededCompany,
        am[0].username,
        "AE",
        "3 Example Avenue",
        `sales.ce.${run}@example.com`,
        `noc.ce.${run}@example.com`,
        `rates.ce.${run}@example.com`,
        `billing.ce.${run}@example.com`,
      ];
      const lackingRow = [
        "LE1",
        badName,
        "customer",
        seededCompany,
        am[0].username,
        "AE",
        "",
        `sales.le.${run}@example.com`,
        "",
        "",
        "",
      ];
      const body = (rows: string[][]) => ({
        sourceSystem: `Needs ${run}`,
        trunksInactive: true,
        files: [{ entity: "enterprises", fileName: "enterprises.csv", content: toCsv([header, ...rows]) }],
      });
      const named = async (name: string) =>
        (await db().query("SELECT id FROM enterprises WHERE name = $1", [name])).rows[0]?.id as number | undefined;

      const dry = await ok(
        "createMigrationImport",
        call("POST", "/migration/imports", body([complete, lackingRow])),
        201,
      );
      madeImports.push(dry.id);
      const refused = dry.report.issues.filter((i: { severity: string }) => i.severity === "error");
      assert.deepEqual(refused, [
        {
          entity: "enterprises",
          row: 3,
          field: null,
          message:
            "Not imported: a new enterprise needs Address, Technical / NOC e-mails, Rates e-mails and Finance / billing e-mails",
          severity: "error",
        },
      ]);
      const counts = dry.report.entities.find((e: { entity: string }) => e.entity === "enterprises");
      assert.equal(counts.create, 1);
      assert.equal(counts.errors, 1);
      assert.equal(dry.report.canApply, false);
      // Apply writes nothing while a row is refused (as for any other row with an error).
      await fails("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 409);
      assert.equal(await named(okName), undefined);
      assert.equal(await named(badName), undefined);

      // Fixed by leaving the row out: the complete enterprise imports and answers the contract's Enterprise.
      const fixed = await ok(
        "revalidateMigrationImport",
        call("PUT", `/migration/imports/${dry.id}`, body([complete])),
      );
      assert.equal(fixed.report.canApply, true, JSON.stringify(fixed.report.issues));
      await ok("applyMigrationImport", call("POST", `/migration/imports/${dry.id}/apply`), 202);
      await runningApplies.get(dry.id);
      const applied = await ok("getMigrationImport", call("GET", `/migration/imports/${dry.id}`));
      assert.equal(applied.status, "applied", applied.applyError);
      const id = await named(okName);
      assert.ok(id);
      cleanup.push(async () => {
        for (const sql of [
          "DELETE FROM enterprise_contacts WHERE enterprise_id = $1",
          "DELETE FROM enterprise_billing WHERE enterprise_id = $1",
          "DELETE FROM enterprise_am_history WHERE enterprise_id = $1",
          "DELETE FROM migration_refs WHERE entity = 'enterprises' AND record_id = $1",
          "DELETE FROM enterprises WHERE id = $1",
        ])
          await db().query(sql, [id]);
      });
      const record = await ok("getEnterprise", call("GET", `/enterprises/${id}`));
      assert.equal(record.address.line1, "3 Example Avenue");
      assert.deepEqual(record.contacts.technical.emails, [`noc.ce.${run}@example.com`]);
      // The account manager the row named, with its history row (§13.30).
      const { rows: history } = await db().query(
        "SELECT count(*)::int AS n FROM enterprise_am_history WHERE enterprise_id = $1 AND ends_at IS NULL",
        [id],
      );
      assert.equal(history[0].n, 1);
      assert.equal(await named(badName), undefined);
      await ok("undoChange", call("POST", `/changes/${applied.changeId}/undo`, {}));
    },
  );

  test(
    "every other entity: a row without a value its create needs is refused with its row number",
    { skip },
    async () => {
      const { rows: ents } = await db().query(
        `SELECT (SELECT name FROM enterprises WHERE type IN ('customer', 'reciprocal') AND deleted_at IS NULL ORDER BY id LIMIT 1) AS customer,
              (SELECT name FROM enterprises WHERE type IN ('vendor', 'reciprocal') AND deleted_at IS NULL ORDER BY id LIMIT 1) AS vendor,
              (SELECT name FROM hlr_providers WHERE deleted_at IS NULL ORDER BY id LIMIT 1) AS provider`,
      );
      const { customer, vendor, provider } = ents[0];
      const cases: [MigrationImportEntity, string[][], string][] = [
        [
          "departments",
          [
            ["name", "description"],
            ["", "No name"],
          ],
          "Name is required",
        ],
        // A lone empty cell would be a blank line, which CSV skips: the rows carry their external ID.
        [
          "product_categories",
          [
            ["externalId", "name"],
            ["PC9", ""],
          ],
          "Name is required",
        ],
        [
          "number_lists",
          [
            ["name", "type", "value"],
            [`Need list ${run}`, "tag", ""],
          ],
          "Value is required",
        ],
        [
          "users",
          [
            ["externalId", "username", "firstName", "lastName", "email", ...NEED_FIELDS],
            ["N1", `need.${run}`, "Need", "User", `need.${run}@example.com`, "Sales", "", "", "", ""],
          ],
          "Not imported: a new user needs GUI access group, Business company, Address and Country",
        ],
        [
          "customer_trunks",
          [
            ["enterprise", "name", "tps"],
            [customer, `NEED_C_${run}`, "10"],
          ],
          "Not imported: a new customer trunk needs Allowed IPs",
        ],
        [
          "vendor_trunks",
          [
            ["enterprise", "name", "tps", "category"],
            [vendor, `NEED_V_${run}`, "10", ""],
          ],
          "Product category is required",
        ],
        [
          "rate_tables",
          [
            ["name", "kind", "currency", "category"],
            [`Need table ${run}`, "customer", "", "OTP"],
          ],
          "Currency is required",
        ],
        [
          "rate_lines",
          [
            ["rateTable", "mccmnc", "rate"],
            [`Need table ${run}`, "424", ""],
          ],
          "Rate is required",
        ],
        [
          "route_rules",
          [
            ["name", "priority", "vendors"],
            [`Need rule ${run}`, "50", ""],
          ],
          "Vendors is required",
        ],
        [
          "translation_rules",
          [
            ["externalId", "name"],
            ["TR9", ""],
          ],
          "Name is required",
        ],
        [
          "hlr_rules",
          [
            ["name", "provider", "dnidPattern"],
            [`Need hlr ${run}`, provider, ""],
          ],
          "Receiver pattern is required",
        ],
        [
          "opening_balances",
          [
            ["enterprise", "side", "amount", "currency", "date"],
            [customer, "customer", "10", "USD", ""],
          ],
          "Date is required",
        ],
      ];
      const dry = await ok(
        "createMigrationImport",
        call("POST", "/migration/imports", {
          sourceSystem: `Needs each ${run}`,
          trunksInactive: true,
          files: cases.map(([entity, rows]) => ({ entity, fileName: `${entity}.csv`, content: toCsv(rows) })),
        }),
        201,
      );
      madeImports.push(dry.id);
      assert.equal(dry.report.canApply, false);
      for (const [entity, , message] of cases) {
        const issue = dry.report.issues.find(
          (i: { entity: string; row: number; severity: string; message: string }) =>
            i.entity === entity && i.row === 2 && i.severity === "error" && i.message === message,
        );
        assert.ok(
          issue,
          `${entity}: ${JSON.stringify(dry.report.issues.filter((i: { entity: string }) => i.entity === entity))}`,
        );
      }
    },
  );
});
