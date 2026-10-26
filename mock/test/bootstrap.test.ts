// Backend step 14: the go-live bootstrap on a new, empty database (the schema from the migrations, nothing else). It
// runs in a database of its own, made for the test and dropped after, so the seeded one is not touched.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PG_CONFIG } from "../src/db.js";
import { passwordRules, verifyPassword } from "../src/admin/passwords.js";
import { bootstrap, temporaryPassword } from "../src/bootstrap.js";

const NAME = `sms_bootstrap_${process.pid}`;
const DB_DIR = fileURLToPath(new URL("../../db/postgres/", import.meta.url));

async function makeDb(): Promise<boolean> {
  const admin = new pg.Client(PG_CONFIG);
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${NAME}`);
    return true;
  } catch {
    return false;
  } finally {
    await admin.end().catch(() => {});
  }
}

const ready = await makeDb();
const skip = ready ? false : "PostgreSQL not available (or no right to create a database)";
let c: pg.Client;

before(async () => {
  if (!ready) return;
  c = new pg.Client({ ...PG_CONFIG, database: NAME });
  await c.connect();
  for (const dir of ["init", "migrations"])
    for (const f of readdirSync(join(DB_DIR, dir))
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await c.query(readFileSync(join(DB_DIR, dir, f), "utf8"));
});

after(async () => {
  if (!ready) return;
  await c.end();
  const admin = new pg.Client(PG_CONFIG);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  await admin.end();
});

const count = async (sql: string) => Number((await c.query(sql)).rows[0].n);
const admin = { username: "first.admin", email: "admin@example.org", firstName: "First", lastName: "Admin" };

describe("go-live bootstrap (step 14)", { skip }, () => {
  test("a database without the schema is refused", async () => {
    const probe = new pg.Client({ ...PG_CONFIG, database: "postgres" });
    await probe.connect();
    await assert.rejects(bootstrap(probe), /schema sms not found/);
    await probe.end();
  });

  test("fills the reference data and creates the system user and the first administrator", async () => {
    const r = await bootstrap(c, { admin });
    for (const t of ["currencies", "currency_rates", "billing_cycles", "product_categories", "countries"])
      assert.ok(r.filled.includes(t), t);
    assert.ok(r.filled.includes("administrator") && r.filled.includes("system user"));
    assert.ok(r.adminPassword);

    assert.ok((await count("SELECT count(*) AS n FROM countries")) > 200, "every country of the MCC/MNC list");
    assert.ok((await count("SELECT count(*) AS n FROM mccmnc WHERE NOT is_all_networks")) > 1500);
    assert.equal(await count("SELECT count(*) AS n FROM mccmnc WHERE dlr_target_pct IS NOT NULL"), 0, "no fake targets");
    // Every country's dial code resolves to an All networks code of that country.
    const { rows: dial } = await c.query(
      `SELECT d.prefix, m.is_all_networks, m.country_id = co.id AS same FROM dial_codes d
         JOIN mccmnc m ON m.id = d.mccmnc_id JOIN countries co ON co.dial_code = d.prefix AND co.id = m.country_id
        WHERE d.prefix = '44'`,
    );
    assert.equal(dial.length, 1);
    assert.ok(dial[0].is_all_networks && dial[0].same);
    assert.equal(await count("SELECT count(*) AS n FROM currency_rates WHERE iso = 'EUR'"), 0, "EUR is the base");

    const { rows: u } = await c.query(
      "SELECT username, is_admin, must_change_password, otp_method, password_hash, temp_password_expires_at > now() AS t, access_group_id IS NOT NULL AS g FROM users ORDER BY id",
    );
    assert.equal(u.length, 2);
    assert.equal(u[0].username, "system");
    assert.equal(u[0].is_admin, false);
    assert.equal(verifyPassword("", u[0].password_hash), false, "the system user cannot sign in");
    assert.deepEqual(
      { ...u[1], password_hash: undefined },
      {
        username: "first.admin",
        is_admin: true,
        must_change_password: true,
        otp_method: "email",
        password_hash: undefined,
        t: true,
        g: true,
      },
    );
    assert.ok(verifyPassword(r.adminPassword, u[1].password_hash));
    assert.deepEqual((await c.query("SELECT summary_emails FROM cleanup_settings")).rows[0].summary_emails, []);
  });

  test("running it again changes nothing", async () => {
    const before = await count("SELECT count(*) AS n FROM mccmnc");
    const r = await bootstrap(c, { admin: { ...admin, username: "second.admin" } });
    assert.deepEqual(r.filled, []);
    assert.equal(r.adminPassword, null);
    assert.equal(await count("SELECT count(*) AS n FROM mccmnc"), before);
    assert.equal(await count("SELECT count(*) AS n FROM users"), 2);
  });

  test("the summary addresses can be set", async () => {
    const r = await bootstrap(c, { summaryEmails: ["noc@example.org"] });
    assert.deepEqual(r.filled, ["cleanup summary e-mails"]);
    assert.deepEqual((await c.query("SELECT summary_emails FROM sms.cleanup_settings")).rows[0].summary_emails, [
      "noc@example.org",
    ]);
  });

  test("without platform e-mail the administrator can be made without the sign-in code", async () => {
    await c.query("DELETE FROM password_history; DELETE FROM users WHERE username = 'first.admin'");
    const r = await bootstrap(c, { admin: { ...admin, withoutCode: true } });
    assert.deepEqual(r.filled, ["administrator"]);
    const { rows } = await c.query("SELECT otp_method FROM users WHERE username = 'first.admin'");
    assert.equal(rows[0].otp_method, "off");
  });

  test("the temporary password meets the password rules", () => {
    for (let i = 0; i < 20; i++) {
      const p = temporaryPassword();
      assert.deepEqual(
        passwordRules(p, { username: "first.admin" }, []).filter((x) => !x.met),
        [],
        p,
      );
    }
  });
});
