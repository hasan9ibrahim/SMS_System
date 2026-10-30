// AM visibility (build step 5.17, §13.17): policies and presets, assignment precedence, shares and
// temporary access, and server-side masking and hiding seen through X-View-As: lists (filter, search,
// withheld values), record details, saves to masked records, jump-to search, exports and the JSON
// backstop for names. Every response is checked against the contract. Needs the seeded database.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { clearVisibilityCache } from "../src/visibility/policy.js";
import { modeSql, valueSql, hide, maskName, byEnterprise, lit } from "../src/visibility/sql.js";
import type { Viewer } from "../src/visibility/policy.js";
import { PRESETS } from "../src/visibility/policy.js";
import { chRows } from "../src/edr.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
  clearVisibilityCache();
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
let AM = 0;
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, as: number | null = null) =>
  app.inject({
    method,
    url: `${API_PREFIX}${url}`,
    ...(as ? { headers: { "x-view-as": String(as) } } : {}),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return status === 204 ? null : r.json();
}
const list = (path: string, op: string, body: object, as: number | null = AM) =>
  ok(op, call("POST", `/${path}/query`, { limit: 100, ...body }, as));

describe("rule SQL (§13.17)", () => {
  const items = PRESETS[1]!.fields.items;
  const v = {
    exempt: false,
    policy: {
      maskOthers: true,
      items: { ...items, margin: { others: "band", own: "show" } },
      thresholds: { marginLowPct: 5, marginHighPct: 20, revenueHideAbove: null, costTrafficDays: null },
    },
    own: [1, 2],
    costOwn: [1, 2, 9],
  } as unknown as Viewer;
  test("names: the value for own rows, a neutral ID for others", () => {
    const sql = valueSql(maskName("e.name", "e.id", byEnterprise("e.id"), lit("Customer")), v);
    assert.match(sql, /e\.id\) = ANY\('\{1,2\}'::bigint\[\]\)/);
    assert.match(sql, /'Customer' \|\| ' #'/);
    assert.equal(valueSql(maskName("e.name", "e.id", byEnterprise("e.id"), lit("Customer")), null), "e.name");
  });
  test("hiding: bands for others' margin, cost own includes traffic vendors, nothing when all shown", () => {
    const m = modeSql(hide("margin", "x", byEnterprise("e.id")), v)!;
    assert.match(m, /'Low'/);
    assert.match(m, /'Normal'/);
    assert.match(modeSql(hide("cost", "x", byEnterprise("e.id")), v)!, /\{1,2,9\}/);
    assert.equal(modeSql(hide("traffic", "x", byEnterprise("e.id")), v), null);
  });
});

describe("visibility policies (§13.17)", { skip }, () => {
  let other = 0; // an enterprise of another AM
  let mine = 0; // one of AM's
  before(async () => {
    const { rows } = await db().query(
      `SELECT u.id FROM users u WHERE u.is_account_manager AND NOT u.is_admin AND u.deleted_at IS NULL
          AND (SELECT count(*) FROM enterprises e WHERE e.account_manager_id = u.id AND e.deleted_at IS NULL) >= 3
        ORDER BY u.id LIMIT 1`,
    );
    AM = Number(rows[0].id);
    const { rows: e } = await db().query(
      `SELECT (SELECT id FROM enterprises WHERE account_manager_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1) AS mine,
              (SELECT id FROM enterprises WHERE account_manager_id <> $1 AND deleted_at IS NULL AND type <> 'vendor'
                 AND EXISTS (SELECT 1 FROM customer_trunks t WHERE t.enterprise_id = enterprises.id AND t.deleted_at IS NULL)
                 AND EXISTS (SELECT 1 FROM enterprise_billing b WHERE b.enterprise_id = enterprises.id)
               ORDER BY id LIMIT 1) AS other`,
      [AM],
    );
    mine = Number(e[0].mine);
    other = Number(e[0].other);
    // A user-level assignment of a test policy, so the test does not depend on the seeded one.
    const preset = PRESETS.find((p) => p.key === "standard_am")!.fields;
    const p = await ok(
      "createVisibilityPolicy",
      call("POST", "/visibility-policies", { ...preset, name: `Test AM policy ${Date.now()}` }),
      201,
    );
    const a = await ok(
      "assignVisibilityPolicy",
      call("POST", "/visibility-assignments", { policyId: p.record.id, targetType: "user", targetId: AM }),
      201,
    );
    cleanup.push(() => call("POST", `/visibility-policies/${p.record.id}/archive`, {}));
    cleanup.push(() => call("DELETE", `/visibility-assignments/${a.id}`));
    policyId = p.record.id;
    assignmentId = a.id;
  });
  let policyId = 0;
  let assignmentId = 0;

  test("presets, list, effective policy from the user's assignment", async () => {
    const presets = await ok("getVisibilityPresets", call("GET", "/visibility-policies/presets"));
    assert.deepEqual(
      presets.map((p: { key: string }) => p.key),
      ["strict_am", "standard_am", "team_lead"],
    );
    const page = await list("visibility-policies", "queryVisibilityPolicies", {}, null);
    assert.ok(page.rows.some((r: { name: string }) => r.name === "Standard AM"));
    const eff = await ok("getUserVisibility", call("GET", `/users/${AM}/visibility`));
    assert.equal(eff.source, "user");
    assert.equal(eff.policy.id, policyId);
    assert.ok(eff.ownEnterprises >= 3);
    const me = await ok("getMyVisibility", call("GET", "/me/visibility", undefined, AM));
    assert.equal(me.viewAs, true);
    assert.equal(me.userId, AM);
    const admin = await ok("getMyVisibility", call("GET", "/me/visibility"));
    assert.equal(admin.exempt, true);
    assert.equal(admin.exemptReason, "Administrator");
    const assigned = await list(
      "visibility-assignments",
      "queryVisibilityAssignments",
      { filter: { logic: "and", conditions: [{ field: "targetId", op: "eq", value: AM }] } },
      null,
    );
    assert.equal(assigned.rows[0].users, 1);
    // An assigned policy cannot be deleted; bands are for margin only.
    assert.equal((await call("POST", `/visibility-policies/${policyId}/archive`, {})).statusCode, 409);
    const bad = await call("PUT", `/visibility-policies/${policyId}`, {
      ...PRESETS[1]!.fields,
      name: "x",
      items: { ...PRESETS[1]!.fields.items, revenue: { others: "band", own: "show" } },
    });
    assert.equal(bad.statusCode, 400);
  });

  test("lists: others masked and not searchable, own shown, money withheld with a reason", async () => {
    const e = await list("enterprises", "queryEnterprises", {
      filter: { logic: "and", conditions: [{ field: "id", op: "in", values: [mine, other] }] },
    });
    const byId = new Map(e.rows.map((r: { id: number; name: string }) => [r.id, r.name]));
    assert.match(String(byId.get(other)), new RegExp(`^(Customer|Enterprise) #${other}$`));
    assert.doesNotMatch(String(byId.get(mine)), /#/);
    const { rows: n } = await db().query("SELECT name FROM enterprises WHERE id = $1", [other]);
    const hidden = await list("enterprises", "queryEnterprises", { search: n[0].name });
    assert.ok(!hidden.rows.some((r: { id: number }) => r.id === other), "a masked name cannot be found");
    const asAdmin = await list("enterprises", "queryEnterprises", { search: n[0].name }, null);
    assert.ok(asAdmin.rows.some((r: { id: number }) => r.id === other));
    const found = await list("enterprises", "queryEnterprises", { search: `#${other}` });
    assert.ok(
      found.rows.some((r: { id: number }) => r.id === other),
      "the neutral ID can be searched",
    );

    const bal = await list("enterprise-balances", "queryEnterpriseBalances", {
      filter: { logic: "and", conditions: [{ field: "id", op: "in", values: [mine, other] }] },
    });
    const ob = bal.rows.find((r: { id: number }) => r.id === other);
    if (ob) {
      assert.equal(ob.netBalance, null);
      assert.ok(
        bal.masked.some(
          (m: { id: number; field: string; text: string }) =>
            m.id === other && m.field === "netBalance" && m.text === "Hidden",
        ),
      );
    }
    const trunks = await list("customer-trunks", "queryCustomerTrunks", {
      filter: { logic: "and", conditions: [{ field: "enterpriseId", op: "eq", value: other }] },
    });
    assert.ok(trunks.rows.length);
    for (const t of trunks.rows) {
      assert.equal(t.name, `Customer trunk #${t.id}`);
      assert.equal(t.username, null);
    }
    // Filtering on a withheld value finds nothing of others (it is NULL for this viewer).
    const inv = await list("invoices", "queryInvoices", {
      filter: {
        logic: "and",
        conditions: [
          { field: "enterpriseId", op: "eq", value: other },
          { field: "dueAmount", op: "gte", value: -1e12 },
        ],
      },
    });
    assert.equal(inv.total, 0);
  });

  test("rate lines: others' sell rates hidden, margin as bands with a band policy, export withheld", async () => {
    // A table of the other AM's client that none of this AM's clients shares (tables can serve several trunks).
    const { rows } = await db().query(
      `SELECT x.rate_table_id AS id FROM customer_trunk_rate_tables x JOIN customer_trunks t ON t.id = x.customer_trunk_id
        WHERE t.enterprise_id = $1 AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM customer_trunk_rate_tables y JOIN customer_trunks u ON u.id = y.customer_trunk_id
                           JOIN enterprises e ON e.id = u.enterprise_id
                          WHERE y.rate_table_id = x.rate_table_id AND e.account_manager_id = $2)
        ORDER BY x.rate_table_id LIMIT 1`,
      [other, AM],
    );
    const tableId = Number(rows[0].id);
    const q = {
      filter: {
        logic: "and",
        conditions: [
          { field: "rateTableId", op: "eq", value: tableId },
          { field: "view", op: "eq", value: "current" },
        ],
      },
      limit: 20,
    };
    const own =
      (
        await db().query(
          `SELECT 1 FROM customer_trunk_rate_tables x JOIN customer_trunks t ON t.id = x.customer_trunk_id
        WHERE x.rate_table_id = $1 AND t.enterprise_id IN (SELECT id FROM enterprises WHERE account_manager_id = $2)`,
          [tableId, AM],
        )
      ).rows.length > 0;
    const lines = await list("rate-lines", "queryRateLines", q);
    assert.ok(!own && lines.rows.length, "a table of another AM's client with current lines");
    {
      assert.equal(lines.rows[0].rate, null);
      assert.ok(lines.masked.some((m: { field: string; text: string }) => m.field === "rate" && m.text === "Hidden"));
      const csv = await call("GET", `/rate-tables/${tableId}/export?view=current`, undefined, AM);
      assert.equal(csv.statusCode, 200);
      const first = csv.body.split("\r\n")[1]!.split(",");
      assert.equal(first[5], "", "the rate is empty in the export");
      // Team-lead style band policy: margin of others as Low / Normal / High.
      const band = {
        ...PRESETS[1]!.fields,
        name: `Test band ${Date.now()}`,
        items: { ...PRESETS[1]!.fields.items, margin: { others: "band", own: "show" } },
      };
      await ok("updateVisibilityPolicy", call("PUT", `/visibility-policies/${policyId}`, band));
      const banded = await list("rate-lines", "queryRateLines", q);
      const texts = banded.masked
        .filter((m: { field: string }) => m.field === "marginPct")
        .map((m: { text: string }) => m.text);
      assert.ok(texts.length && texts.every((t: string) => ["Low", "Normal", "High", "Hidden"].includes(t)));
    }
  });

  test("record details, refused saves, jump-to search, the JSON backstop", async () => {
    const d = await ok("getEnterprise", call("GET", `/enterprises/${other}`, undefined, AM));
    assert.match(d.name, new RegExp(`#${other}$`));
    assert.equal(d.alias, d.name);
    assert.deepEqual(d.contacts.commercial.emails, ["hidden@masked.invalid"]);
    const full = await ok("getEnterprise", call("GET", `/enterprises/${other}`));
    const keys = [
      "name",
      "alias",
      "type",
      "tier",
      "status",
      "businessCompanyId",
      "accountManagerId",
      "bindAlert",
      "creditAlert",
      "creditAlertPercent",
      "address",
      "website",
      "fax",
      "registrationNumber",
      "vatNumber",
      "billingTimezone",
      "rateNoticeDays",
      "contacts",
    ];
    const body = Object.fromEntries(keys.filter((k) => k in full).map((k) => [k, full[k]]));
    const vatBefore = (await db().query("SELECT vat_number FROM enterprises WHERE id = $1", [other])).rows[0]
      .vat_number;
    const put = await call("PUT", `/enterprises/${other}`, { ...body, vatNumber: "REFUSED-EDIT" }, AM);
    assert.equal(put.statusCode, 403);
    check("updateEnterprise", put);
    // The refusal writes nothing.
    const vatAfter = (await db().query("SELECT vat_number FROM enterprises WHERE id = $1", [other])).rows[0].vat_number;
    assert.equal(vatAfter, vatBefore);
    const { rows: t } = await db().query(
      "SELECT id FROM customer_trunks WHERE enterprise_id = $1 AND deleted_at IS NULL LIMIT 1",
      [other],
    );
    const trunk = await ok("getCustomerTrunk", call("GET", `/customer-trunks/${t[0].id}`, undefined, AM));
    assert.equal(trunk.name, `Customer trunk #${t[0].id}`);
    assert.equal(trunk.username, "hidden");
    assert.match(trunk.enterpriseName, new RegExp(`#${other}$`));

    const { rows: n } = await db().query("SELECT name FROM enterprises WHERE id = $1", [other]);
    const hits = await ok("search", call("GET", `/search?q=${encodeURIComponent(n[0].name)}`, undefined, AM));
    assert.ok(!hits.hits.some((h: { kind: string; id: number }) => h.kind === "enterprise" && h.id === other));
  });

  test("shares and temporary access make an enterprise own until revoked or expired", async () => {
    const g = await ok(
      "createVisibilityGrant",
      call("POST", "/visibility-grants", {
        userId: AM,
        enterpriseId: other,
        expiresAt: null,
        reason: "Covering a holiday",
      }),
      201,
    );
    assert.equal(g.kind, "share");
    const seen = await ok("getEnterprise", call("GET", `/enterprises/${other}`, undefined, AM));
    assert.doesNotMatch(seen.name, /#/);
    const eff = await ok("getUserVisibility", call("GET", `/users/${AM}/visibility`));
    assert.equal(eff.grantedEnterprises, 1);
    const r = await ok("revokeVisibilityGrant", call("POST", `/visibility-grants/${g.id}/revoke`));
    assert.equal(r.state, "revoked");
    assert.equal((await call("POST", `/visibility-grants/${g.id}/revoke`)).statusCode, 409);
    const masked = await ok("getEnterprise", call("GET", `/enterprises/${other}`, undefined, AM));
    assert.match(masked.name, /#/);
    // Temporary access stops counting when it expires.
    const tmp = await ok(
      "createVisibilityGrant",
      call("POST", "/visibility-grants", {
        userId: AM,
        enterpriseId: other,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        reason: "Cover",
      }),
      201,
    );
    assert.equal(tmp.kind, "temporary");
    await db().query("UPDATE visibility_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [tmp.id]);
    clearVisibilityCache();
    const after = await ok("getEnterprise", call("GET", `/enterprises/${other}`, undefined, AM));
    assert.match(after.name, /#/);
    const grants = await list(
      "visibility-grants",
      "queryVisibilityGrants",
      { filter: { logic: "and", conditions: [{ field: "userId", op: "eq", value: AM }] } },
      null,
    );
    assert.ok(grants.rows.some((x: { id: number; state: string }) => x.id === tmp.id && x.state === "expired"));
    // Every grant and policy change is in the Audit Trail.
    await new Promise((res) => setTimeout(res, 100));
    const { rows: au } = await db().query(
      "SELECT count(*)::int AS n FROM audit_log WHERE table_name IN ('visibility_grants', 'visibility_policies', 'visibility_assignments') AND at > now() - interval '5 minutes'",
    );
    assert.ok(au[0].n >= 3);
  });

  test("an enterprise handed to the account manager shows under its name at once (team trial round 12)", async () => {
    // The viewer is cached: a first look as the AM primes it.
    const masked = await ok("getEnterprise", call("GET", `/enterprises/${other}`, undefined, AM));
    assert.match(masked.name, /#\d+$/);
    const { rows } = await db().query("SELECT name, account_manager_id FROM enterprises WHERE id = $1", [other]);
    // The handover writes the AM history, which loading the enterprise applies again: both are put back.
    const { rows: history } = await db().query("SELECT id, ends_at FROM enterprise_am_history WHERE enterprise_id = $1", [
      other,
    ]);
    try {
      await ok(
        "handOverEnterprise",
        call("POST", `/enterprises/${other}/handover`, { userId: AM, note: "visibility test", notify: false }),
      );
      // No waiting for the cache to expire.
      const seen = await ok("getEnterprise", call("GET", `/enterprises/${other}`, undefined, AM));
      assert.equal(seen.name, rows[0].name);
    } finally {
      await db().query("DELETE FROM enterprise_am_history WHERE enterprise_id = $1 AND NOT (id = ANY($2))", [
        other,
        history.map((h) => h.id),
      ]);
      for (const h of history)
        await db().query("UPDATE enterprise_am_history SET ends_at = $2 WHERE id = $1", [h.id, h.ends_at]);
      await db().query("UPDATE enterprises SET account_manager_id = $2 WHERE id = $1", [other, rows[0].account_manager_id]);
      clearVisibilityCache();
    }
  });

  test("EDRs: others masked and not found by name, their money and IPs withheld; downloads only the AM's own", async (t) => {
    // Security audit (team trial round 12): EDR Search, Failed EDR Search and EDR downloads follow the policy.
    const latest = await chRows<{ t: string }>("SELECT toString(max(start_time)) AS t FROM edr");
    if (!latest?.[0]?.t || latest[0].t.startsWith("1970")) return t.skip("EDR store not available");
    const to = new Date(`${latest[0].t.replace(" ", "T")}Z`);
    const from = new Date(to.getTime() - 6 * 3_600_000);
    const period = { field: "startTime", op: "between", values: [from.toISOString(), to.toISOString()] };
    const query = (extra: object[] = []) => ({ filter: { logic: "and", conditions: [period, ...extra] }, limit: 300 });
    const { rows: o } = await db().query(
      "SELECT id FROM enterprises WHERE account_manager_id = $1 AND deleted_at IS NULL",
      [AM],
    );
    const own = new Set(o.map((r) => Number(r.id)));

    const seen = await list("edrs", "queryEdrs", query());
    const all = await list("edrs", "queryEdrs", query(), null);
    assert.ok(seen.rows.length > 0 && all.rows.length > 0);
    type E = Record<string, unknown> & { customerEnterpriseId: number; vendorEnterpriseId: number };
    for (const r of seen.rows as E[]) {
      if (own.has(r.customerEnterpriseId)) assert.equal(typeof r.customerRate, "number");
      else {
        assert.equal(r.customerRate, null);
        assert.equal(r.revenue, null);
        assert.equal(r.customerIp, null);
        assert.match(String(r.customerEnterprise), /#\d+$/);
      }
      if (r.vendorEnterpriseId && !own.has(r.vendorEnterpriseId)) assert.equal(r.vendorIp, null);
    }
    // A withheld value matches no filter: only own clients' messages have a sell rate to compare.
    const rated = await list("edrs", "queryEdrs", query([{ field: "customerRate", op: "gte", value: 0 }]));
    assert.ok((rated.rows as E[]).every((r) => own.has(r.customerEnterpriseId)));
    // Another AM's client cannot be found by its name, though it is in the period.
    const theirs = (all.rows as E[]).find((r) => r.customerEnterpriseId && !own.has(r.customerEnterpriseId));
    if (theirs) {
      const named = [{ field: "customerEnterprise", op: "like", value: String(theirs.customerEnterprise) }];
      const found = await list("edrs", "queryEdrs", query(named));
      assert.ok(!(found.rows as E[]).some((r) => r.customerEnterpriseId === theirs.customerEnterpriseId));
      const searched = await list("edrs", "queryEdrs", { ...query(), search: String(theirs.customerEnterprise) });
      assert.ok(!(searched.rows as E[]).some((r) => r.customerEnterpriseId === theirs.customerEnterpriseId));
      assert.ok((await list("edrs", "queryEdrs", query(named), null)).rows.length > 0);
    }

    // Someone else's download: not listed for the AM, not opened, not cancelled.
    const d = await ok(
      "requestEdrDownload",
      call("POST", "/edr-downloads", {
        kind: "edr",
        query: { filter: { logic: "and", conditions: [period] } },
        fileType: "csv",
        templateId: null,
        columns: ["startTime", "customerEnterprise", "customerRate"],
      }),
      201,
    );
    cleanup.push(() => call("POST", `/edr-downloads/${d.id}/cancel`, {}));
    const mineOnly = await list("edr-downloads", "queryEdrDownloads", {});
    assert.ok(!mineOnly.rows.some((x: { id: number }) => x.id === d.id));
    assert.ok((await list("edr-downloads", "queryEdrDownloads", {}, null)).rows.some((x: { id: number }) => x.id === d.id));
    await ok("downloadEdrFile", call("GET", `/edr-downloads/${d.id}/file`, undefined, AM), 403);
    await ok("cancelEdrDownload", call("POST", `/edr-downloads/${d.id}/cancel`, {}, AM), 403);
  });

  test("removing the user's assignment falls back to the next one", async () => {
    await ok("removeVisibilityAssignment", call("DELETE", `/visibility-assignments/${assignmentId}`), 204);
    const eff = await ok("getUserVisibility", call("GET", `/users/${AM}/visibility`));
    assert.notEqual(eff.source, "user");
  });
});
