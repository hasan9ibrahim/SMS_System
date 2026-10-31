// Round 13 security review: the holes it found stay closed. Under a visibility policy (§13.17) another account
// manager's client gives no SMPP password, contacts or sell rates through the notification preview, the sends or the
// rate sheet; the e-mail log never shows a sign-in code (§13.28); an HLR provider's password does not follow its
// address to another host; a regex filter that would make PostgreSQL backtrack is refused (§13.25). Runs against the
// seeded database as an administrator previewing an account manager (X-View-As); the test's rows are removed.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { clearVisibilityCache, PRESETS } from "../src/visibility/policy.js";
import { regexProblem } from "../src/lists/validate.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const run = Date.now().toString(36).slice(-5);
const cleanup: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await f().catch(() => undefined);
  clearVisibilityCache();
  await app.close();
  await closeDb();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, as: number | null = null) =>
  app.inject({
    method,
    url: `${API_PREFIX}${url}`,
    ...(as ? { headers: { "x-view-as": String(as) } } : {}),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

describe("round 13 security review", { skip }, () => {
  let am = 0;
  let mineTrunk = 0;
  let otherTrunk = 0;
  let otherPassword = "";
  before(async () => {
    const { rows } = await db().query(
      `SELECT u.id FROM users u WHERE u.is_account_manager AND NOT u.is_admin AND u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
                       WHERE e.account_manager_id = u.id AND t.deleted_at IS NULL AND e.deleted_at IS NULL)
        ORDER BY u.id LIMIT 1`,
    );
    am = Number(rows[0].id);
    const trunk = async (own: boolean) =>
      (
        await db().query(
          `SELECT t.id, t.password FROM customer_trunks t JOIN enterprises e ON e.id = t.enterprise_id
            WHERE t.deleted_at IS NULL AND e.deleted_at IS NULL AND coalesce(t.password, '') <> ''
              AND EXISTS (SELECT 1 FROM customer_trunk_rate_tables x WHERE x.customer_trunk_id = t.id)
              AND (e.account_manager_id = $1) = $2
            ORDER BY t.id LIMIT 1`,
          [am, own],
        )
      ).rows[0];
    const mine = await trunk(true);
    const other = await trunk(false);
    mineTrunk = Number(mine.id);
    otherTrunk = Number(other.id);
    otherPassword = String(other.password);
    // A user-level test policy hiding others' contacts and sell rates, so the test does not depend on the seed.
    const preset = PRESETS.find((p) => p.key === "standard_am")!.fields;
    assert.equal(preset.items.contacts.others, "hide");
    assert.equal(preset.items.sellRates.others, "hide");
    const p = (await call("POST", "/visibility-policies", { ...preset, name: `Security review ${run}` })).json();
    const a = (
      await call("POST", "/visibility-assignments", { policyId: p.record.id, targetType: "user", targetId: am })
    ).json();
    cleanup.push(() => call("POST", `/visibility-policies/${p.record.id}/archive`, {}));
    cleanup.push(() => call("DELETE", `/visibility-assignments/${a.id}`));
    clearVisibilityCache();
  });

  test("notification preview and sends: no password, contacts or sell rates of another AM's client", async () => {
    for (const kind of ["send_tech_info", "send_rate"]) {
      const r = await call("POST", "/notifications/preview", { trunkId: otherTrunk, kind }, am);
      assert.equal(r.statusCode, 403, `${kind}: ${r.body}`);
      assert.ok(!r.body.includes(otherPassword));
    }
    // Their own client's preview works, without the password: only the e-mail itself carries it.
    const own = await call("POST", "/notifications/preview", { trunkId: mineTrunk, kind: "send_tech_info" }, am);
    assert.equal(own.statusCode, 200, own.body);
    const { rows } = await db().query("SELECT password FROM customer_trunks WHERE id = $1", [mineTrunk]);
    if (String(rows[0].password).length > 2) assert.ok(!own.json().body.includes(String(rows[0].password)));
    // An administrator's preview is not restricted either, and it hides the password the same way.
    const admin = await call("POST", "/notifications/preview", { trunkId: otherTrunk, kind: "send_tech_info" });
    assert.equal(admin.statusCode, 200, admin.body);
    assert.ok(!admin.json().body.includes(otherPassword));
    // Sending (no e-mail leaves: the send is refused before it is written).
    const sent = await call("POST", "/notifications/send-tech-info", { trunkIds: [otherTrunk] }, am);
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().sent, 0);
    assert.match(sent.json().failed[0].reason, /visibility policy/);
    const rates = await call(
      "POST",
      "/notifications/send-rate",
      { trunkIds: [otherTrunk], sendEmail: false, fileType: "csv" },
      am,
    );
    assert.equal(rates.statusCode, 200, rates.body);
    assert.match(rates.json().failed[0].reason, /visibility policy/);
  });

  test("rate sheet: another AM's client's sell rates are not given out", async () => {
    const r = await call("GET", `/customer-trunks/${otherTrunk}/rate-sheet?fileType=csv`, undefined, am);
    assert.equal(r.statusCode, 403, r.body);
    const own = await call("GET", `/customer-trunks/${mineTrunk}/rate-sheet?fileType=csv`, undefined, am);
    assert.equal(own.statusCode, 200, own.body.slice(0, 200));
  });

  test("the e-mail log never shows a sign-in code", async () => {
    const { rows } = await db().query(
      `INSERT INTO email_logs (email_type, status, to_addresses, subject, body)
       VALUES ('otp', 'sent', '{qa@example.test}', 'Your sign-in code', 'Your sign-in code is 424242.') RETURNING id`,
    );
    const id = Number(rows[0].id);
    cleanup.push(() => db().query("DELETE FROM email_logs WHERE id = $1", [id]));
    const r = await call("GET", `/email-logs/${id}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(!r.body.includes("424242"));
    assert.equal(r.json().bodyHtml, null);
  });

  test("an HLR provider's password does not follow its address to another host", async () => {
    const base = {
      name: `QA-provider ${run}`,
      providerType: "hlr",
      url: "https://hlr-one.example.com/lookup?msisdn={DNID}",
      username: "qa",
      extraHeaders: null,
      postData: null,
      currency: "USD",
      defaultRate: 0.002,
      cacheDays: 2,
      timeoutMs: 1500,
      dailyBudget: null,
      status: "inactive",
      responseMapping: {
        mcc: "mcc",
        mnc: "mnc",
        mccmnc: "mccmnc",
        oldMcc: null,
        oldMnc: null,
        oldMccmnc: null,
        ported: "ported",
        errorCode: null,
        errorString: null,
        successCodes: "0",
        numberCheck: null,
        dnidScore: null,
      },
      password: "qa-secret",
    };
    const created = await call("POST", "/hlr-providers", base);
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().record.id as number;
    cleanup.push(() => db().query("DELETE FROM hlr_providers WHERE id = $1", [id]));
    const moved = await call("PUT", `/hlr-providers/${id}`, {
      ...base,
      password: null,
      url: "https://hlr-two.example.net/lookup?msisdn={DNID}",
    });
    assert.equal(moved.statusCode, 400, moved.body);
    assert.ok(moved.json().errors.some((e: { path: string }) => e.path === "/password"));
    // Same host, other path: the password stays.
    const samePlace = await call("PUT", `/hlr-providers/${id}`, {
      ...base,
      password: null,
      url: "https://hlr-one.example.com/v2/lookup?msisdn={DNID}",
    });
    assert.equal(samePlace.statusCode, 200, samePlace.body);
    // Typed again, it may move.
    const retyped = await call("PUT", `/hlr-providers/${id}`, {
      ...base,
      url: "https://hlr-two.example.net/lookup?msisdn={DNID}",
    });
    assert.equal(retyped.statusCode, 200, retyped.body);
  });

  test("regex filters that make PostgreSQL backtrack are refused", async () => {
    assert.equal(regexProblem("^(foo|bar)\\d+$"), null);
    assert.match(regexProblem("(a+)+$")!, /repeated group/);
    assert.match(regexProblem("(.)\\1")!, /back references/);
    assert.match(regexProblem("x".repeat(201))!, /200 characters/);
    const r = await call("POST", "/enterprises/query", {
      limit: 5,
      filter: { logic: "and", conditions: [{ field: "name", op: "regex", value: "(a+)+$" }] },
    });
    assert.equal(r.statusCode, 400, r.body);
  });
});
