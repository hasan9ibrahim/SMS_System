// Bulk delete and restore of a list's records (§13.29, §13.10): POST /lists/{list}/bulk-delete and /bulk-restore. A
// mix of deletable and blocked rows deletes the deletable ones as ONE change and lists the others with the reason; a
// dry run changes nothing; one Undo restores them all; an administrator may override with a reason; restore refuses a
// row whose code is live again; access is the list's own Delete; records the visibility policy masks are refused
// (§13.17). Runs against the seeded database on MCCMNC codes the test makes (MCC 999, not a real network); everything
// it makes is removed afterwards.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { BulkRecordsResult } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { clearVisibilityCache, PRESETS } from "../src/visibility/policy.js";
import { BULK_KINDS } from "../src/api/bulkRecords.js";
import { listArchiveOp } from "../src/auth/listAccess.js";
import { listDefs } from "../src/lists/defs.js";

process.env.MOCK_PROXY_SECRET = "test-proxy-secret";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const made = { codes: [] as number[], dialCodes: [] as number[], policies: [] as number[], groups: [] as number[], users: [] as number[] };

after(async () => {
  await app.close();
  if (ready) {
    const q = (sql: string, ids: number[]) => (ids.length ? db().query(sql, [ids]) : null);
    await q("DELETE FROM dial_codes WHERE id = ANY($1)", made.dialCodes);
    await q("DELETE FROM changes WHERE entity_type = 'destination' AND entity_ids && $1::bigint[]", made.codes);
    await q("DELETE FROM mccmnc WHERE id = ANY($1)", made.codes);
    await q("DELETE FROM visibility_assignments WHERE policy_id = ANY($1)", made.policies);
    await q("DELETE FROM changes WHERE entity_type = 'visibility_policy' AND entity_ids && $1::bigint[]", made.policies);
    await q("DELETE FROM visibility_policies WHERE id = ANY($1)", made.policies);
    await q("DELETE FROM audit_log WHERE user_id = ANY($1)", made.users);
    await q("DELETE FROM users WHERE id = ANY($1)", made.users);
    await q("DELETE FROM access_groups WHERE id = ANY($1)", made.groups);
  }
  clearVisibilityCache();
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

async function call(operationId: string, url: string, payload: object, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url: `${API_PREFIX}${url}`, payload, headers });
  check(operationId, res);
  return res;
}
const bulkDelete = (ids: number[], extra: object = {}, headers: Record<string, string> = {}) =>
  call("bulkDeleteRecords", "/lists/destinations/bulk-delete", { ids, ...extra }, headers);
const live = async (ids: number[]) =>
  (await db().query("SELECT id FROM mccmnc WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY id", [ids])).rows.map(
    (r) => Number(r.id),
  );

test("every list whose rows have a Delete has its bulk rules, and only those (§13.29)", () => {
  const deletable = Object.keys(listDefs).filter((l) => listArchiveOp(l));
  assert.deepEqual(Object.keys(BULK_KINDS).sort(), deletable.sort());
});

describe("POST /lists/{list}/bulk-delete and /bulk-restore (§13.29, §13.10)", { skip }, () => {
  let blocked = 0;
  before(async () => {
    const { rows: c } = await db().query("SELECT id FROM countries ORDER BY id LIMIT 1");
    const suffix = String(Date.now() % 900 + 100); // three digits, so each run makes new codes
    for (const mnc of ["1", "2", "3", "4"]) {
      const res = await call("createDestination", "/destinations", {
        mcc: "999",
        mnc: `${mnc}${suffix.slice(0, 2)}`,
        originalMnc: null,
        countryId: Number(c[0].id),
        network: `Bulk test ${mnc}`,
      });
      assert.equal(res.statusCode, 201, res.body);
      made.codes.push(Number(res.json().record.id));
    }
    // The third code is in use by a dial code: blocked (§13.29), an administrator may override with a reason.
    blocked = made.codes[2]!;
    const d = await db().query("INSERT INTO dial_codes (profile, prefix, mccmnc_id) VALUES ('All', $1, $2) RETURNING id", [
      `999${suffix}77`,
      blocked,
    ]);
    made.dialCodes.push(Number(d.rows[0].id));
  });

  test("a dry run names what would be deleted and refused, and changes nothing", async () => {
    const res = await bulkDelete(made.codes.slice(0, 3), { dryRun: true });
    assert.equal(res.statusCode, 200, res.body);
    const r = res.json() as BulkRecordsResult;
    assert.equal(r.dryRun, true);
    assert.equal(r.change, null);
    assert.deepEqual(r.done.map((x) => x.id), made.codes.slice(0, 2));
    assert.match(r.done[0]!.name, /^999\d+$/);
    assert.deepEqual(r.refused.map((x) => x.id), [blocked]);
    assert.match(r.refused[0]!.reason, /Dial codes 1/);
    assert.equal(r.refused[0]!.overridable, true);
    assert.deepEqual(await live(made.codes), made.codes);
  });

  test("deletable rows go as ONE change, blocked ones are listed; one Undo restores them all", async () => {
    const before = Number((await db().query("SELECT max(id) AS n FROM changes")).rows[0].n);
    const res = await bulkDelete(made.codes.slice(0, 3));
    const r = res.json() as BulkRecordsResult;
    assert.equal(r.dryRun, false);
    assert.deepEqual(r.done.map((x) => x.id), made.codes.slice(0, 2));
    assert.deepEqual(r.refused.map((x) => x.id), [blocked]);
    assert.ok(r.change);
    assert.equal(r.change.changeType, "delete");
    assert.deepEqual([...r.change.entityIds].map(Number).sort(), made.codes.slice(0, 2));
    assert.match(r.change.note ?? "", /^Deleted 2 MCCMNC codes/);
    // One change for the whole selection.
    const { rows } = await db().query(
      "SELECT id FROM changes WHERE id > $1 AND entity_type = 'destination' AND entity_ids && $2::bigint[]",
      [before, made.codes],
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(await live(made.codes), [blocked, made.codes[3]!]);
    // Already deleted rows are refused on a second try.
    const again = (await bulkDelete(made.codes.slice(0, 2))).json() as BulkRecordsResult;
    assert.equal(again.done.length, 0);
    assert.deepEqual(again.refused.map((x) => x.reason), ["Already deleted", "Already deleted"]);
    // Undo brings both back in one go.
    const undo = await call("undoChange", `/changes/${r.change.id}/undo`, {});
    assert.equal(undo.statusCode, 200, undo.body);
    assert.deepEqual(await live(made.codes), made.codes);
  });

  test("an administrator overrides the blockers with a written reason", async () => {
    const noReason = await bulkDelete([blocked], { override: true });
    assert.equal(noReason.statusCode, 400);
    const res = await bulkDelete([blocked], { override: true, reason: "test cleanup" });
    const r = res.json() as BulkRecordsResult;
    assert.deepEqual(r.done.map((x) => x.id), [blocked]);
    assert.match(r.change?.note ?? "", /Override: test cleanup/);
    assert.deepEqual(await live([blocked]), []);
    // Back, for the other tests: restore by the bulk restore.
    const back = (await call("bulkRestoreRecords", "/lists/destinations/bulk-restore", { ids: [blocked] })).json();
    assert.deepEqual((back as BulkRecordsResult).done.map((x) => x.id), [blocked]);
  });

  test("restore as one change; a row whose code is live again is refused", async () => {
    const [a, b] = made.codes;
    const del = (await bulkDelete([a!, b!])).json() as BulkRecordsResult;
    assert.equal(del.done.length, 2);
    // Another live code takes a's MCCMNC meanwhile.
    const { rows } = await db().query("SELECT mcc, mnc, mccmnc, country_id FROM mccmnc WHERE id = $1", [a]);
    const twin = await call("createDestination", "/destinations", {
      mcc: rows[0].mcc,
      mnc: rows[0].mnc,
      originalMnc: null,
      countryId: Number(rows[0].country_id),
      network: "Bulk test twin",
    });
    assert.equal(twin.statusCode, 201, twin.body);
    made.codes.push(Number(twin.json().record.id));
    const res = await call("bulkRestoreRecords", "/lists/destinations/bulk-restore", { ids: [a!, b!] });
    const r = res.json() as BulkRecordsResult;
    assert.deepEqual(r.done.map((x) => x.id), [b]);
    assert.deepEqual(r.refused.map((x) => [x.id, x.reason]), [[a, "Another live record has this code"]]);
    assert.equal(r.change?.changeType, "edit");
    assert.match(r.change?.note ?? "", /^Restored 1 MCCMNC code/);
  });

  test("access is the list's own Delete; Restore is for administrators (§1, §11)", async () => {
    const n = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
    const user = async (permissions: Record<string, string[]>) => {
      const g = await db().query("INSERT INTO access_groups (name, permissions) VALUES ($1, $2) RETURNING id", [
        `test bulk ${n} ${made.groups.length}`,
        permissions,
      ]);
      made.groups.push(Number(g.rows[0].id));
      const u = await db().query(
        `INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, access_group_id,
                            department_id, address1)
         VALUES ($1, 'Test', 'Bulk', $2, 'x', now(), $3, (SELECT min(id) FROM departments), 'Test street 1') RETURNING id`,
        [`test.bulk.${n}.${made.users.length}`, `test.bulk.${n}.${made.users.length}@example.test`, g.rows[0].id],
      );
      made.users.push(Number(u.rows[0].id));
      return { "x-sms-proxy-secret": "test-proxy-secret", "x-sms-user": String(u.rows[0].id) };
    };
    const viewer = await user({ mccmnc: ["view"] });
    const refused = await bulkDelete([made.codes[3]!], { dryRun: true }, viewer);
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().code, "not_allowed");
    const deleter = await user({ mccmnc: ["view", "edit", "delete"] });
    assert.equal((await bulkDelete([made.codes[3]!], { dryRun: true }, deleter)).statusCode, 200);
    // Not an administrator: no override, no restore.
    assert.equal((await bulkDelete([made.codes[3]!], { override: true, reason: "x" }, deleter)).statusCode, 403);
    const restore = await call("bulkRestoreRecords", "/lists/destinations/bulk-restore", { ids: [made.codes[0]!] }, deleter);
    assert.equal(restore.statusCode, 403);
    // A list whose rows have no Delete.
    assert.equal((await call("bulkDeleteRecords", "/lists/countries/bulk-delete", { ids: [1] })).statusCode, 400);
  });

  test("AM visibility (§13.17): another AM's masked enterprise is refused, never deleted (dry run)", async () => {
    const { rows } = await db().query(
      `SELECT u.id FROM users u WHERE u.is_account_manager AND NOT u.is_admin AND u.deleted_at IS NULL
          AND (SELECT count(*) FROM enterprises e WHERE e.account_manager_id = u.id AND e.deleted_at IS NULL) >= 2
        ORDER BY u.id LIMIT 1`,
    );
    const am = Number(rows[0].id);
    const { rows: e } = await db().query(
      `SELECT (SELECT id FROM enterprises WHERE account_manager_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1) AS mine,
              (SELECT id FROM enterprises WHERE account_manager_id <> $1 AND deleted_at IS NULL ORDER BY id LIMIT 1) AS other`,
      [am],
    );
    const preset = PRESETS.find((p) => p.key === "standard_am")!.fields;
    const p = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/visibility-policies`,
      payload: { ...preset, name: `Test bulk policy ${Date.now()}` },
    });
    assert.equal(p.statusCode, 201, p.body);
    made.policies.push(Number(p.json().record.id));
    const a = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/visibility-assignments`,
      payload: { policyId: p.json().record.id, targetType: "user", targetId: am },
    });
    assert.equal(a.statusCode, 201, a.body);
    clearVisibilityCache();
    const res = await call(
      "bulkDeleteRecords",
      "/lists/enterprises/bulk-delete",
      { ids: [Number(e[0].mine), Number(e[0].other)], dryRun: true },
      { "x-view-as": String(am) },
    );
    assert.equal(res.statusCode, 200, res.body);
    const r = res.json() as BulkRecordsResult;
    const other = r.refused.find((x) => x.id === Number(e[0].other));
    assert.ok(other, JSON.stringify(r));
    assert.match(other.name, /^(Customer|Vendor|Enterprise) #\d+$/);
    assert.match(other.reason, /masked by your visibility policy/);
    // The AM's own enterprise is judged by its dependencies, by name.
    const mine = [...r.done, ...r.refused].find((x) => x.id === Number(e[0].mine))!;
    assert.doesNotMatch(mine.name, /#\d+$/);
    assert.equal(r.change, null);
  });
});
