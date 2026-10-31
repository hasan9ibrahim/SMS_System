// One export for list pages without their own (§13.22, §13.25): POST /lists/{list}/export answers the rows the page's
// query finds as CSV, through the list engine: filters (column, builder AND/OR, quick search) honoured, AM visibility
// (§13.17) masking as on the page, no credential columns, formula cells escaped (round 12), labels and enum labels,
// times in the asked zone, and the 100,000-row cap with its message (audit_log is over it at seed volume). Runs
// against the seeded database; what the test makes is removed.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import type { FieldDescriptor } from "@sms/contract";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { parseCsv } from "../src/api/masterData.js";
import { cellText, EXPORT_MAX_ROWS, isCredentialField } from "../src/api/listExport.js";
import { clearVisibilityCache, PRESETS } from "../src/visibility/policy.js";

process.env.MOCK_PROXY_SECRET = "test-proxy-secret";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const made = { categories: [] as number[], policies: [] as number[], groups: [] as number[], users: [] as number[] };

after(async () => {
  await app.close();
  if (ready) {
    const q = (sql: string, ids: number[]) => (ids.length ? db().query(sql, [ids]) : null);
    await q("DELETE FROM changes WHERE entity_type = 'product_category' AND entity_ids && $1::bigint[]", made.categories);
    await q("DELETE FROM product_categories WHERE id = ANY($1)", made.categories);
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

function check(res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === "exportList")!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `exportList answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `exportList ${status}: ${JSON.stringify(validate.errors)}`);
}

async function exportCsv(list: string, body: object, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url: `${API_PREFIX}/lists/${list}/export`, payload: body, headers });
  check(res);
  return res;
}

const rowsOf = (res: LightMyRequestResponse) => {
  assert.equal(res.statusCode, 200, res.body.slice(0, 500));
  assert.match(String(res.headers["content-type"]), /text\/csv/);
  return parseCsv(res.body);
};

describe("value formatting (§13.25)", () => {
  const at = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
  test("enum labels, Yes / No, lists, times, plain numbers", () => {
    const f: FieldDescriptor = { field: "status", label: "Status", type: "enum", operators: [], sortable: true, hidden: false };
    assert.equal(cellText({ ...f, enumValues: [{ value: "active", label: "Active" }] }, "active", at), "Active");
    assert.equal(cellText({ ...f, type: "boolean" }, true, at), "Yes");
    assert.equal(cellText({ ...f, type: "boolean" }, false, at), "No");
    assert.equal(cellText({ ...f, type: "text" }, ["a", "b"], at), "a, b");
    assert.equal(cellText({ ...f, type: "datetime" }, "2026-10-31T13:05:09Z", at), "2026-10-31 13:05");
    assert.equal(cellText({ ...f, type: "money" }, -12.5, at), "-12.5");
    assert.equal(cellText({ ...f, type: "text" }, null, at), "");
  });
  test("credential fields: trunk usernames and hosts, anything about passwords; a staff username is business data", () => {
    assert.equal(isCredentialField("customer_trunks", "username"), true);
    assert.equal(isCredentialField("vendor_trunks", "host"), true);
    assert.equal(isCredentialField("users", "passwordState"), true);
    assert.equal(isCredentialField("customer_portal_users", "username"), true);
    assert.equal(isCredentialField("users", "username"), false);
    assert.equal(isCredentialField("enterprises", "name"), false);
  });
});

describe("POST /lists/{list}/export (§13.22)", { skip }, () => {
  let formula = 0;
  before(async () => {
    // A category whose name would run as a formula in a spreadsheet (security audit, round 12).
    const n = Date.now();
    const { rows } = await db().query(
      "INSERT INTO product_categories (name) VALUES ($1), ($2) RETURNING id",
      [`=HYPERLINK("http://x.test","exp${n}")`, `Export test ${n}`],
    );
    made.categories.push(...rows.map((r) => Number(r.id)));
    formula = made.categories[0]!;
  });

  test("filters and quick search are the list's own; columns in the asked order, labels as headers", async () => {
    const res = await exportCsv("product_categories", {
      query: { filter: { logic: "or", conditions: made.categories.map((id) => ({ field: "id", op: "eq", value: id })) } },
      columns: ["name", "id"],
    });
    const csv = rowsOf(res);
    assert.deepEqual(csv.header, ["category_name", "info_id"]);
    assert.equal(csv.rows.length, 2);
    assert.equal(res.headers["x-total-rows"], "2");
    assert.equal(res.headers["x-export-capped"], undefined);
    assert.match(String(res.headers["content-disposition"]), /filename="product_categories_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.csv"/);
    // The formula cell starts with an apostrophe; the other name is as typed.
    const names = csv.rows.map((r) => r.values.category_name!);
    assert.ok(names.some((x) => x.startsWith(`'=HYPERLINK("http://x.test"`)), names.join(" | "));
    assert.ok(names.some((x) => x.startsWith("Export test ")));
    assert.ok(!res.body.includes('\n=HYPERLINK') && !res.body.includes(',=HYPERLINK'));
    // Quick search narrows like the grid's.
    const one = rowsOf(
      await exportCsv("product_categories", {
        query: {
          search: "Export test",
          filter: { logic: "and", conditions: [{ field: "id", op: "in", values: made.categories }] },
        },
        columns: ["id"],
      }),
    );
    assert.equal(one.rows.length, 1);
    assert.notEqual(Number(one.rows[0]!.values.info_id), formula);
  });

  test("the multi-field builder with AND / OR and a regex, as on the page", async () => {
    const page = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/destinations/query`,
      payload: {
        filter: {
          logic: "and",
          conditions: [
            { logic: "or", conditions: [{ field: "mcc", op: "eq", value: "234" }, { field: "mcc", op: "eq", value: "262" }] },
            { field: "network", op: "regex", value: "^(o|v)" },
          ],
        },
        limit: 4000,
      },
    });
    assert.equal(page.statusCode, 200);
    const want = (page.json().rows as { mccmnc: string }[]).map((r) => r.mccmnc).sort();
    const csv = rowsOf(
      await exportCsv("destinations", {
        query: {
          filter: {
            logic: "and",
            conditions: [
              { logic: "or", conditions: [{ field: "mcc", op: "eq", value: "234" }, { field: "mcc", op: "eq", value: "262" }] },
              { field: "network", op: "regex", value: "^(o|v)" },
            ],
          },
        },
        columns: ["mccmnc", "network"],
      }),
    );
    assert.ok(want.length > 0);
    assert.deepEqual(csv.rows.map((r) => r.values.mccmnc).sort(), want);
  });

  test("no credential columns: a trunk's username stays out even when asked for", async () => {
    const csv = rowsOf(
      await exportCsv("customer_trunks", { query: { sort: [{ field: "id", dir: "asc" }] }, columns: ["id", "name", "username"] }),
    );
    assert.deepEqual(csv.header, ["id", "trunk_name"]);
    assert.ok(csv.rows.length > 0);
    const users = rowsOf(await exportCsv("users", { query: {}, columns: ["username", "passwordState", "passwordDaysLeft"] }));
    assert.deepEqual(users.header, ["username"]);
  });

  test("enum labels and times in the asked zone", async () => {
    const res = await exportCsv("enterprises", {
      query: { sort: [{ field: "id", dir: "asc" }] },
      columns: ["id", "type", "updatedAt"],
      timezone: "Asia/Dubai",
    });
    const csv = rowsOf(res);
    assert.deepEqual(csv.header, ["id", "type", "updated_time_(asia/dubai)"]);
    const { rows } = await db().query("SELECT id, type, updated_at FROM enterprises WHERE deleted_at IS NULL ORDER BY id LIMIT 1");
    const first = csv.rows[0]!.values;
    assert.equal(Number(first.id), Number(rows[0].id));
    assert.equal(first.type, { customer: "Customer", vendor: "Vendor", reciprocal: "Bilateral" }[rows[0].type as string]);
    const dubai = new Date((rows[0].updated_at as Date).getTime() + 4 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
    assert.equal(first["updated_time_(asia/dubai)"], dubai);
  });

  test("bad requests: unknown column, unknown zone, a parent's rows, QBR stats without their side", async () => {
    assert.equal((await exportCsv("enterprises", { query: {}, columns: ["nope"] })).statusCode, 400);
    assert.equal((await exportCsv("enterprises", { query: {}, columns: ["id"], timezone: "Mars/Base" })).statusCode, 400);
    assert.equal((await exportCsv("rate_lines", { query: {}, columns: ["id"] })).statusCode, 400);
    assert.equal((await exportCsv("qbr_stats", { query: {}, columns: ["trunk"] })).statusCode, 400);
    const qbr = await exportCsv("qbr_stats", {
      query: { filter: { logic: "and", conditions: [{ field: "side", op: "eq", value: "vendor" }] } },
      columns: ["trunk", "mccmnc", "asr"],
    });
    assert.equal(qbr.statusCode, 200);
  });

  test("the list's page and its Export action are needed (§1, §11)", async () => {
    const n = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
    const g = await db().query("INSERT INTO access_groups (name, permissions) VALUES ($1, $2) RETURNING id", [
      `test export ${n}`,
      { categories: ["view"], countries: ["view", "export"] },
    ]);
    made.groups.push(Number(g.rows[0].id));
    const u = await db().query(
      `INSERT INTO users (username, first_name, last_name, email, password_hash, password_changed_at, access_group_id,
                          department_id, address1)
       VALUES ($1, 'Test', 'Export', $2, 'x', now(), $3, (SELECT min(id) FROM departments), 'Test street 1') RETURNING id`,
      [`test.export.${n}`, `test.export.${n}@example.test`, g.rows[0].id],
    );
    const user = Number(u.rows[0].id);
    made.users.push(user);
    const as = { "x-sms-proxy-secret": "test-proxy-secret", "x-sms-user": String(user) };
    // View alone: no export of the page's list; View and Export: allowed; another page: refused.
    const viewOnly = await exportCsv("product_categories", { query: {}, columns: ["name"] }, as);
    assert.equal(viewOnly.statusCode, 403);
    assert.equal((await exportCsv("countries", { query: {}, columns: ["name"] }, as)).statusCode, 200);
    assert.equal((await exportCsv("enterprises", { query: {}, columns: ["name"] }, as)).statusCode, 403);
    // Change history is open to everyone, scoped to their pages and people: nothing of other pages comes out.
    const changes = rowsOf(await exportCsv("changes", { query: {}, columns: ["entityType"] }, as));
    for (const r of changes.rows) assert.ok(["Country", "Product category"].includes(r.values.record_type!), r.values.record_type);
  });

  test("AM visibility (§13.17): other AMs' enterprises are masked in the file as on the page", async () => {
    const { rows } = await db().query(
      `SELECT u.id FROM users u WHERE u.is_account_manager AND NOT u.is_admin AND u.deleted_at IS NULL
          AND (SELECT count(*) FROM enterprises e WHERE e.account_manager_id = u.id AND e.deleted_at IS NULL) >= 2
        ORDER BY u.id LIMIT 1`,
    );
    const am = Number(rows[0].id);
    // A user-level assignment of a test policy, so the test does not depend on the seeded one.
    const preset = PRESETS.find((p) => p.key === "standard_am")!.fields;
    const p = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/visibility-policies`,
      payload: { ...preset, name: `Test export policy ${Date.now()}` },
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
    const viewAs = { "x-view-as": String(am) };
    const body = { query: { sort: [{ field: "id", dir: "asc" }], limit: 4000 }, columns: ["id", "name"] };
    const page = await app.inject({ method: "POST", url: `${API_PREFIX}/enterprises/query`, payload: body.query, headers: viewAs });
    const shown = new Map((page.json().rows as { id: number; name: string }[]).map((r) => [r.id, r.name]));
    const csv = rowsOf(await exportCsv("enterprises", body, viewAs));
    assert.equal(csv.rows.length, shown.size);
    let maskedCount = 0;
    for (const r of csv.rows) {
      const id = Number(r.values.id);
      assert.equal(r.values.full_legal_name, shown.get(id), `enterprise ${id}`);
      if (/^(Customer|Vendor|Enterprise) #\d+$/.test(r.values.full_legal_name!)) maskedCount++;
    }
    assert.ok(maskedCount > 0, "some enterprises belong to other AMs and are masked");
    const { rows: own } = await db().query("SELECT name FROM enterprises WHERE account_manager_id = $1 AND deleted_at IS NULL", [am]);
    const names = new Set(csv.rows.map((r) => r.values.full_legal_name));
    for (const o of own) assert.ok(names.has(o.name as string), `own enterprise ${o.name} shown by name`);
  });

  test(`at most ${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows, with a line saying so (audit trail at seed volume)`, async () => {
    const res = await exportCsv("audit_log", { query: { sort: [{ field: "id", dir: "desc" }] }, columns: ["id", "action"] });
    assert.equal(res.statusCode, 200);
    const total = Number(res.headers["x-total-rows"]);
    if (total <= EXPORT_MAX_ROWS) return; // a smaller database: nothing to cap
    assert.equal(res.headers["x-export-capped"], String(EXPORT_MAX_ROWS));
    const lines = res.body.trimEnd().split("\r\n");
    // Header, the capped rows, the message.
    assert.equal(lines.length, EXPORT_MAX_ROWS + 2);
    assert.match(lines.at(-1)!, /^"Export stopped at 100,000 of [\d,]+ rows\. Narrow the filters to export the rest\."$/);
    // Rows come in the list's order, none twice.
    const ids = lines.slice(1, -1).map((l) => Number(l.split(",")[0]));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids[0]! > ids.at(-1)!);
  });
});
