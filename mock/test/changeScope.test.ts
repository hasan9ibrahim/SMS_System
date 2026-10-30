// Who sees and undoes whose changes (§13.10, team trial round 12): everyone sees and undoes their own; administrators
// and directors (the Management department) everyone's; a department's manager the changes of that department's
// people. There is no "undo others" permission any more. Calls are made as forwarded by the Elixir API (X-Sms-User).
// Runs against the seeded database; the test's rows are removed.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { Change, ChangePage } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";

process.env.MOCK_PROXY_SECRET = "test-proxy-secret";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available";
const run = Date.now().toString(36).slice(-5);
const made: { users: number[]; departments: number[]; group: number | null } = {
  users: [],
  departments: [],
  group: null,
};

after(async () => {
  // Close first: closing waits for the audit rows still being written after the last replies.
  await app.close();
  if (ready) {
    await db().query("DELETE FROM audit_log WHERE user_id = ANY($1)", [made.users]);
    await db().query("UPDATE changes SET undo_of_id = NULL WHERE user_id = ANY($1)", [made.users]);
    await db().query("DELETE FROM changes WHERE user_id = ANY($1)", [made.users]);
    // Departments name their manager and last editor (the undo stamps it), users their department: unlink first.
    await db().query("UPDATE departments SET manager_id = NULL, updated_by_id = NULL WHERE id = ANY($1)", [
      made.departments,
    ]);
    await db().query("DELETE FROM users WHERE id = ANY($1)", [made.users]);
    await db().query("DELETE FROM departments WHERE id = ANY($1)", [made.departments]);
    if (made.group) await db().query("DELETE FROM access_groups WHERE id = $1", [made.group]);
  }
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

async function as(who: number, operationId: string, url: string, payload: object) {
  const res = await app.inject({
    method: "POST",
    url: `${API_PREFIX}${url}`,
    headers: {
      "x-sms-proxy-secret": "test-proxy-secret",
      "x-sms-user": String(who),
    },
    payload,
  });
  check(operationId, res);
  return res;
}

async function department(name: string): Promise<number> {
  const { rows } = await db().query("INSERT INTO departments (name) VALUES ($1) RETURNING id", [name]);
  made.departments.push(Number(rows[0].id));
  return Number(rows[0].id);
}

async function user(tag: string, departmentId: number): Promise<number> {
  const { rows } = await db().query(
    `INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, access_group_id,
                        department_id, address1)
     VALUES ($1, 'Test', 'Scope', $2, 'x', now(), $3, $4, 'Test street 1') RETURNING id`,
    [`test.${tag}.${run}`, `test.${tag}.${run}@example.test`, made.group, departmentId],
  );
  made.users.push(Number(rows[0].id));
  return Number(rows[0].id);
}

/** A change on a test department's description, as if `who` had saved it. */
async function change(who: number, departmentId: number, after: string): Promise<number> {
  await db().query("UPDATE departments SET description = $2 WHERE id = $1", [departmentId, after]);
  const { rows } = await db().query(
    `INSERT INTO changes (entity_type, entity_ids, change_type, diff, user_id)
     VALUES ('department', ARRAY[$1::bigint], 'edit', $2, $3) RETURNING id`,
    [departmentId, JSON.stringify([{ entity_id: departmentId, field: "description", before: null, after }]), who],
  );
  return Number(rows[0].id);
}

const seen = async (who: number, ids: number[]) => {
  const res = await as(who, "queryChanges", "/changes/query", {
    filter: {
      logic: "and",
      conditions: [{ field: "id", op: "in", values: ids }],
    },
    limit: 50,
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as ChangePage).rows;
};

describe("change history by person (§13.10, team trial round 12)", { skip }, () => {
  test("own changes for everyone, the team's for its manager, everyone's for directors", async () => {
    const g = await db().query("INSERT INTO access_groups (name, permissions) VALUES ($1, $2) RETURNING id", [
      `Scope test ${run}`,
      { departments: ["view", "edit"], "change-history": ["view"] },
    ]);
    made.group = Number(g.rows[0].id);
    const team = await department(`Scope team ${run}`);
    const other = await department(`Scope other ${run}`);
    const management = (
      await db().query("SELECT id FROM departments WHERE lower(name) = 'management' AND deleted_at IS NULL")
    ).rows[0]?.id as number | undefined;
    assert.ok(management, "the seed has a Management department");

    const manager = await user("manager", other);
    await db().query("UPDATE departments SET manager_id = $2 WHERE id = $1", [team, manager]);
    const member = await user("member", team);
    const outsider = await user("outsider", other);
    const director = await user("director", Number(management));

    const byMember = await change(member, team, "member's note");
    const byOutsider = await change(outsider, other, "outsider's note");
    const ids = [byMember, byOutsider];

    const ofMember = await seen(member, ids);
    assert.deepEqual(
      ofMember.map((c) => c.id),
      [byMember],
      "a member sees only their own change",
    );
    assert.equal(ofMember[0]!.canUndo, true);

    const ofManager = await seen(manager, ids);
    assert.deepEqual(
      ofManager.map((c) => c.id),
      [byMember],
      "the manager sees the team's changes, not other departments'",
    );
    assert.equal(ofManager[0]!.canUndo, true);

    const ofDirector = await seen(director, ids);
    assert.deepEqual(ofDirector.map((c) => c.id).sort(), [...ids].sort(), "a director sees everyone's");
    assert.ok(ofDirector.every((c) => c.canUndo));

    // Undo: the outsider may not undo the member's change; the manager may.
    const refused = await as(outsider, "undoChange", `/changes/${byMember}/undo`, {});
    assert.equal(refused.statusCode, 403, refused.body);
    const undone = await as(manager, "undoChange", `/changes/${byMember}/undo`, {});
    assert.equal(undone.statusCode, 200, undone.body);
    const after = await db().query("SELECT description FROM departments WHERE id = $1", [team]);
    assert.equal(after.rows[0].description, null);

    // The undone change can no longer be undone, and an undo is never offered.
    const again = (await seen(manager, [byMember, (undone.json() as Change).id])).sort((a, b) => a.id - b.id);
    assert.deepEqual(
      again.map((c) => c.canUndo),
      [false, false],
    );

    // A director undoes anyone's.
    const byDirector = await as(director, "undoChange", `/changes/${byOutsider}/undo`, {});
    assert.equal(byDirector.statusCode, 200, byDirector.body);
  });
});
