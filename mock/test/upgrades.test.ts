// Database upgrades on start (team trial round 2): the scripts run once per content, under a lock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, db, dbReady } from "../src/db.js";
import { applyUpgrades, upgradeScripts } from "../src/upgrades.js";

const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
after(() => closeDb());

test("the repo's upgrade scripts are found and marked by content", () => {
  const scripts = upgradeScripts();
  assert.ok(scripts.some((s) => s.name === "2026-10-18_trial_round_1.sql"));
  assert.ok(scripts.every((s) => /^script:.+\.sql:[0-9a-f]{16}$/.test(s.mark)));
});

test("a script runs once; a changed script runs again; a failing one rolls back", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "upgrades-"));
  const t = `upgrade_test_${Date.now().toString(36)}`;
  writeFileSync(join(dir, "a.sql"), `CREATE TABLE IF NOT EXISTS ${t} (n int); INSERT INTO ${t} VALUES (1);`);
  try {
    assert.deepEqual((await applyUpgrades(db(), dir)).applied, ["a.sql"]);
    assert.deepEqual(await applyUpgrades(db(), dir), { applied: [], upToDate: ["a.sql"] });
    const count = async () => Number((await db().query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    assert.equal(await count(), 1, "not run twice");
    writeFileSync(join(dir, "a.sql"), `INSERT INTO ${t} VALUES (2);`);
    assert.deepEqual((await applyUpgrades(db(), dir)).applied, ["a.sql"]);
    assert.equal(await count(), 2);
    writeFileSync(join(dir, "b.sql"), `INSERT INTO ${t} VALUES (3); SELECT no_such_column FROM ${t};`);
    await assert.rejects(applyUpgrades(db(), dir), /upgrade b.sql failed/);
    assert.equal(await count(), 2, "the failed script left nothing behind");
  } finally {
    await db().query(`DROP TABLE IF EXISTS ${t}`);
    await db().query("DELETE FROM upgrade_marks WHERE name LIKE 'script:a.sql:%' OR name LIKE 'script:b.sql:%'");
  }
});

test("the real upgrade script applies to the seeded database and is then up to date", { skip }, async () => {
  const started = Date.now();
  await applyUpgrades();
  const again = await applyUpgrades();
  assert.deepEqual(again.applied, []);
  assert.ok(again.upToDate.includes("2026-10-18_trial_round_1.sql"));
  assert.ok(Date.now() - started < 60_000);
});
