// Enterprise and trunk screens (build step 4.1): record CRUD, billing, AM handover, docs,
// trunk rules, safe delete and undo of every save. Every response is checked against the
// contract. Needs the seeded database; without it these tests are skipped.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { deleteTestEnterprises } from "./testEnterprises.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const run = Date.now().toString(36);
after(async () => {
  // Test enterprises and their trunks must not stay active: the live simulator would send
  // traffic for them and they would show on the dashboard and in incidents (§13.3, §13.4).
  if (ready) await deleteTestEnterprises(`Test Enterprise ${run} %`);
  await app.close();
  await closeDb();
});

function check(operationId: string, res: LightMyRequestResponse) {
  const op = operations.find((o) => o.operationId === operationId)!;
  const status = String(res.statusCode);
  assert.ok(status in op.responses, `${operationId} answered ${status}, which the contract does not list: ${res.body}`);
  const validate = op.responses[status];
  // Only JSON bodies are validated (document downloads are binary).
  if (validate && /json/.test(String(res.headers["content-type"])))
    assert.ok(validate(res.json()), `${operationId} ${status}: ${JSON.stringify(validate.errors)}`);
}

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url: `${API_PREFIX}${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function ok(operationId: string, res: Promise<LightMyRequestResponse>, status = 200) {
  const r = await res;
  assert.equal(r.statusCode, status, `${operationId}: ${r.body}`);
  check(operationId, r);
  return r.statusCode === 204 ? null : r.json();
}

const contact = (t: string) => ({ name: `${t} Person`, phone: "+100000000", emails: [`${t}@example.test`] });

async function reference() {
  return ok("getReference", call("GET", "/meta/reference"));
}

async function newEnterprise(type: "customer" | "vendor" | "reciprocal", suffix: string) {
  const ref = await reference();
  return ok(
    "createEnterprise",
    call("POST", "/enterprises", {
      name: `Test Enterprise ${run} ${suffix}`,
      alias: `T${run}${suffix}`.slice(0, 20),
      type,
      tier: "tier2",
      status: "active",
      businessCompanyId: ref.businessCompanies[0].id,
      accountManagerId: ref.accountManagers[0].id,
      address: { line1: "1 Test Street", countryId: ref.countries[0].id },
      creditAlertPercent: { notice: 50, warning: 70, critical: 90 },
      contacts: {
        commercial: contact("commercial"),
        technical: contact("technical"),
        rates: contact("rates"),
        finance: contact("finance"),
      },
    }),
    201,
  );
}

describe("reference data and lists", { skip }, () => {
  test("reference data for forms", async () => {
    const ref = await reference();
    assert.ok(ref.countries.length > 200);
    assert.ok(ref.timezones.includes("Europe/London"));
    assert.ok(ref.accountManagers.length > 0);
  });

  test("trunk lists filter, sort and count the rules that run on each trunk", async () => {
    const page = await ok(
      "queryCustomerTrunks",
      call("POST", "/customer-trunks/query", { sort: [{ field: "rulesCount", dir: "desc" }], limit: 50 }),
    );
    assert.ok(page.total > 10);
    const top = page.rows[0];
    const rules = await ok("getCustomerTrunkRules", call("GET", `/customer-trunks/${top.id}/rules`));
    const running = rules.translation.filter(
      (r: { ruleActive: boolean; enabled: boolean }) => r.ruleActive && r.enabled,
    );
    assert.equal(top.rulesCount, running.length);

    const vendors = await ok(
      "queryVendorTrunks",
      call("POST", "/vendor-trunks/query", {
        filter: { logic: "and", conditions: [{ field: "protocol", op: "in", values: ["http"] }] },
        limit: 5,
      }),
    );
    assert.ok(vendors.rows.every((r: { protocol: string }) => r.protocol === "http"));
  });

  test("Show deleted lists archived rows only when asked (§13.29)", async () => {
    const live = await ok("queryVendorTrunks", call("POST", "/vendor-trunks/query", { limit: 1 }));
    const archived = await ok(
      "queryVendorTrunks",
      call("POST", "/vendor-trunks/query", {
        filter: { logic: "and", conditions: [{ field: "archived", op: "eq", value: true }] },
        limit: 500,
      }),
    );
    const both = await ok(
      "queryVendorTrunks",
      call("POST", "/vendor-trunks/query", {
        filter: { logic: "and", conditions: [{ field: "archived", op: "in", values: [true, false] }] },
        limit: 1,
      }),
    );
    assert.ok(archived.total > 0);
    assert.ok(archived.rows.every((r: { archived: boolean }) => r.archived));
    assert.equal(both.total, live.total + archived.total);
  });

  test("rate tables list with active line counts", async () => {
    const started = Date.now();
    const page = await ok(
      "queryRateTables",
      call("POST", "/rate-tables/query", { sort: [{ field: "activeLines", dir: "desc" }], limit: 20 }),
    );
    assert.ok(page.rows[0].activeLines >= page.rows[1].activeLines);
    assert.ok(Date.now() - started < 3000, "rate table list is fast at full volume");
  });
});

describe("enterprise record (§5.1–5.3)", { skip }, () => {
  test("add, edit with a field-level diff, and undo", async () => {
    const saved = await newEnterprise("customer", "A");
    const id = saved.record.id;
    assert.equal(saved.change.changeType, "create");
    assert.equal(saved.record.contacts.rates.emails[0], "rates@example.test");

    const dup = await call("POST", "/enterprises", {
      ...saved.record,
      accountManagerId: saved.record.accountManagerId,
    });
    assert.equal(dup.statusCode, 400, "body with read-only fields is rejected by the contract");

    const input = {
      name: saved.record.name,
      alias: saved.record.alias,
      type: "reciprocal",
      tier: saved.record.tier,
      status: saved.record.status,
      businessCompanyId: saved.record.businessCompanyId,
      address: { ...saved.record.address, city: "Testville" },
      creditAlertPercent: saved.record.creditAlertPercent,
      contacts: { ...saved.record.contacts, finance: { ...contact("finance"), emails: ["billing@example.test"] } },
    };
    const edited = await ok("updateEnterprise", call("PUT", `/enterprises/${id}`, input));
    const fields = edited.change.diff.map((d: { field: string }) => d.field).sort();
    assert.deepEqual(fields, ["address.city", "contacts.finance.emails", "type"]);
    assert.equal(edited.record.address.city, "Testville");

    const same = await ok("updateEnterprise", call("PUT", `/enterprises/${id}`, input));
    assert.equal(same.change, null, "saving without changes records nothing");

    // Team trial round 6: a Bilateral partner without vendor trunks can go back to customer.
    const back2 = await ok("updateEnterprise", call("PUT", `/enterprises/${id}`, { ...input, type: "customer" }));
    assert.equal(back2.record.type, "customer");
    const toVendor = await call("PUT", `/enterprises/${id}`, { ...input, type: "vendor" });
    assert.equal(toVendor.statusCode, 400, "a customer still can't become a vendor");
    await ok("undoChange", call("POST", `/changes/${back2.change.id}/undo`, {}));

    await ok("undoChange", call("POST", `/changes/${edited.change.id}/undo`, {}));
    const back = await ok("getEnterprise", call("GET", `/enterprises/${id}`));
    assert.equal(back.address.city, null);
    assert.equal(back.type, "customer");
    assert.deepEqual(back.contacts.finance.emails, ["finance@example.test"]);
  });

  test("name is unique, archived names included, and errors point at fields", async () => {
    const { rows } = await db().query("SELECT name FROM enterprises WHERE deleted_at IS NOT NULL LIMIT 1");
    const ref = await reference();
    const res = await call("POST", "/enterprises", {
      name: rows[0].name,
      alias: "X",
      type: "customer",
      tier: "tier1",
      status: "active",
      businessCompanyId: 999999,
      address: { line1: "x" },
      creditAlertPercent: { notice: 90, warning: 70, critical: 50 },
      contacts: { commercial: contact("a"), technical: contact("b"), rates: contact("c"), finance: contact("d") },
      accountManagerId: ref.accountManagers[0].id,
    });
    assert.equal(res.statusCode, 400);
    check("createEnterprise", res);
    const paths = res.json().errors.map((e: { path: string }) => e.path);
    assert.ok(paths.includes("/name"));
    assert.ok(paths.includes("/businessCompanyId"));
    assert.ok(paths.includes("/creditAlertPercent"));
  });

  test("website: an http(s) address, a bare domain gets https:// (QA 2026-10-31, §5.1)", async () => {
    const saved = await newEnterprise("customer", "W");
    const id = saved.record.id as number;
    const { contacts, address, creditAlertPercent } = saved.record;
    const input = (website: string | null) => ({
      ...Object.fromEntries(
        ["name", "alias", "type", "tier", "status", "businessCompanyId"].map((k) => [k, saved.record[k]]),
      ),
      address,
      contacts,
      creditAlertPercent,
      website,
    });
    const edit = (website: string | null) => call("PUT", `/enterprises/${id}`, input(website));
    const stored = async (website: string | null) => (await ok("updateEnterprise", edit(website))).record.website;
    assert.equal(await stored("partner.example"), "https://partner.example");
    assert.equal(await stored(" http://www.partner.example/sms?x=1 "), "http://www.partner.example/sms?x=1");
    assert.equal(await stored("   "), null);
    for (const bad of [
      "javascript:alert(1)",
      "ftp://partner.example",
      "partner",
      "not a website",
      "user:pw@partner.example",
    ]) {
      const r = await edit(bad);
      assert.equal(r.statusCode, 400, `${bad}: ${r.body}`);
      check("updateEnterprise", r);
      assert.ok(
        r.json().errors.some((e: { path: string }) => e.path === "/website"),
        bad,
      );
    }
  });

  test("billing sides, balance and undo", async () => {
    const saved = await newEnterprise("customer", "B");
    const id = saved.record.id;
    const empty = await ok("getEnterpriseBilling", call("GET", `/enterprises/${id}/billing`));
    assert.equal(empty.customer, null);
    const wrongSide = await call("PUT", `/enterprises/${id}/billing`, {
      vendor: { currency: "USD", billingCycleId: 1, timezone: "UTC", openingBalance: 0 },
    });
    assert.equal(wrongSide.statusCode, 400);
    check("updateEnterpriseBilling", wrongSide);

    const created = await ok(
      "updateEnterpriseBilling",
      call("PUT", `/enterprises/${id}/billing`, {
        customer: {
          currency: "EUR",
          billingCycleId: 3,
          timezone: "Europe/Paris",
          billingType: "postpaid",
          creditLimit: 5000,
          openingBalance: 120.5,
        },
        beneficiary: { bank: "Test Bank" },
      }),
    );
    assert.equal(created.record.customer.balance, 120.5);
    // A non-zero credit limit ticks the credit alert, in the same change (team trial round 2).
    assert.equal((await ok("getEnterprise", call("GET", `/enterprises/${id}`))).creditAlert, true);
    // Unticked by hand while the limit is set, it stays off when the limit changes (team trial round 2).
    await db().query("UPDATE enterprises SET credit_alert = false WHERE id = $1", [id]);
    assert.equal(created.record.beneficiary.bank, "Test Bank");
    const edited = await ok(
      "updateEnterpriseBilling",
      call("PUT", `/enterprises/${id}/billing`, {
        customer: {
          ...created.record.customer,
          creditLimit: 9000,
          balance: undefined,
          billingCycleName: undefined,
          updatedBy: undefined,
          updatedAt: undefined,
        },
      }),
    );
    assert.deepEqual(
      edited.change.diff.map((d: { field: string }) => d.field),
      ["billing.customer.creditLimit"],
    );
    assert.equal((await ok("getEnterprise", call("GET", `/enterprises/${id}`))).creditAlert, false);
    await ok("undoChange", call("POST", `/changes/${edited.change.id}/undo`, {}));
    const back = await ok("getEnterpriseBilling", call("GET", `/enterprises/${id}/billing`));
    assert.equal(back.customer.creditLimit, 5000);
  });

  test("a bilateral partner bills both sides in one currency (team trial round 12)", async () => {
    const id = (await newEnterprise("reciprocal", "BC")).record.id;
    const side = (currency: string) => ({ currency, billingCycleId: 3, timezone: "UTC", openingBalance: 0 });
    const split = await call("PUT", `/enterprises/${id}/billing`, { customer: side("EUR"), vendor: side("USD") });
    assert.equal(split.statusCode, 400);
    check("updateEnterpriseBilling", split);
    assert.ok(split.json().errors.some((e: { path: string }) => e.path === "/vendor/currency"));
    const one = await ok(
      "updateEnterpriseBilling",
      call("PUT", `/enterprises/${id}/billing`, {
        customer: side("EUR"),
        vendor: { ...side("EUR"), billingCycleId: 1 },
        beneficiary: { currency: "USDT" },
      }),
    );
    assert.equal(one.record.vendor.currency, "EUR");
    assert.equal(one.record.vendor.billingCycleId, 1, "the cycle stays the vendor side's own");
    assert.equal(one.record.beneficiary.currency, "USDT", "the account currency may be any text");
  });

  test("handover now, scheduled handover replaces a pending one, undo restores history (§13.30)", async () => {
    const saved = await newEnterprise("vendor", "C");
    const id = saved.record.id;
    const ref = await reference();
    const [, am2, am3] = ref.accountManagers;
    const now = await ok("handOverEnterprise", call("POST", `/enterprises/${id}/handover`, { userId: am2.id }));
    assert.equal(now.periods[0].userId, am2.id);
    // The client is told by e-mail from the new AM (team trial round 2).
    assert.equal(now.emailed, 1);
    const { rows: mails } = await db().query(
      "SELECT sender, cc_addresses, subject FROM email_logs WHERE enterprise_id = $1 AND email_type = 'am_handover'",
      [id],
    );
    assert.equal(mails.length, 1);
    assert.ok(mails[0].cc_addresses.length >= 1);
    assert.equal(now.periods[0].endsAt, null);
    assert.equal((await ok("getEnterprise", call("GET", `/enterprises/${id}`))).accountManagerId, am2.id);

    const later = new Date(Date.now() + 7 * 86400_000).toISOString();
    const quiet = await ok(
      "handOverEnterprise",
      call("POST", `/enterprises/${id}/handover`, { userId: am3.id, effectiveAt: later, notify: false }),
    );
    assert.equal(quiet.emailed, 0);
    const replaced = await ok(
      "handOverEnterprise",
      call("POST", `/enterprises/${id}/handover`, {
        userId: ref.accountManagers[0].id,
        effectiveAt: later,
        note: "Moved",
      }),
    );
    assert.equal(replaced.periods.length, 3, "the first scheduled handover was replaced, not stacked");
    assert.equal((await ok("getEnterprise", call("GET", `/enterprises/${id}`))).accountManagerId, am2.id);

    const past = await call("POST", `/enterprises/${id}/handover`, {
      userId: am3.id,
      effectiveAt: "2020-01-01T00:00:00Z",
    });
    assert.equal(past.statusCode, 400);
    check("handOverEnterprise", past);

    await ok("undoChange", call("POST", `/changes/${replaced.change.id}/undo`, {}));
    const history = await ok("getAccountManagerHistory", call("GET", `/enterprises/${id}/account-managers`));
    assert.equal(history[0].userId, am3.id, "the earlier scheduled handover is back");
  });

  test("docs: upload, list, download, delete archives, undo restores (§5.2)", async () => {
    const saved = await newEnterprise("customer", "D");
    const id = saved.record.id;
    const body = Buffer.from("fake contract text");
    const doc = await ok(
      "uploadEnterpriseDoc",
      call("POST", `/enterprises/${id}/docs`, {
        name: "Contract",
        fileName: "contract.txt",
        dataBase64: body.toString("base64"),
      }),
      201,
    );
    assert.equal(doc.contentType, "text/plain");
    assert.equal(doc.size, body.length);
    const file = await call("GET", `/enterprises/${id}/docs/${doc.id}/file`);
    assert.equal(file.statusCode, 200);
    check("downloadEnterpriseDoc", file);
    assert.equal(file.rawPayload.toString(), "fake contract text");
    assert.match(String(file.headers["content-disposition"]), /contract\.txt/);

    await ok("deleteEnterpriseDoc", call("DELETE", `/enterprises/${id}/docs/${doc.id}`), 204);
    assert.equal((await ok("listEnterpriseDocs", call("GET", `/enterprises/${id}/docs`))).length, 0);
    const { rows } = await db().query(
      "SELECT id FROM changes WHERE entity_type = 'enterprise_doc' AND $1 = ANY(entity_ids) AND change_type = 'delete'",
      [doc.id],
    );
    await ok("undoChange", call("POST", `/changes/${rows[0].id}/undo`, {}));
    assert.equal((await ok("listEnterpriseDocs", call("GET", `/enterprises/${id}/docs`))).length, 1);
  });

  test("safe delete: live trunks block even an override; a free enterprise archives and undo brings it back (§13.29)", async () => {
    const { rows } = await db().query(
      `SELECT e.id FROM enterprises e
        WHERE e.deleted_at IS NULL AND EXISTS (SELECT 1 FROM invoices i WHERE i.enterprise_id = e.id AND i.payment_status <> 'paid')
          AND EXISTS (SELECT 1 FROM customer_trunks t WHERE t.enterprise_id = e.id AND t.deleted_at IS NULL)
        ORDER BY e.id DESC LIMIT 1`,
    );
    const id = rows[0].id;
    const deps = await ok("getEnterpriseDependencies", call("GET", `/enterprises/${id}/dependencies`));
    assert.equal(deps.blocked, true);
    const trunks = deps.items.find((i: { key: string }) => i.key === "customer_trunks");
    assert.ok(trunks.blocking && trunks.noOverride && trunks.count > 0);
    const blocked = await call("POST", `/enterprises/${id}/archive`, {});
    assert.equal(blocked.statusCode, 409);
    check("archiveEnterprise", blocked);
    // Team trial round 3: live trunks cannot be overridden, not even by an administrator.
    const override = await call("POST", `/enterprises/${id}/archive`, { override: true, reason: "Test of override" });
    assert.equal(override.statusCode, 409);
    assert.match(override.json().detail, /Customer trunks/);

    const fresh = (await newEnterprise("customer", "del")).record;
    const archived = await ok("archiveEnterprise", call("POST", `/enterprises/${fresh.id}/archive`, {}));
    assert.ok(archived.record.archived);
    const list = await ok(
      "queryEnterprises",
      call("POST", "/enterprises/query", {
        filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: fresh.id }] },
      }),
    );
    assert.equal(list.total, 0, "archived enterprises leave normal lists");
    const edit = await call("PUT", `/enterprises/${fresh.id}`, {});
    assert.equal(edit.statusCode, 400);
    await ok("undoChange", call("POST", `/changes/${archived.change.id}/undo`, {}));
    const back = await ok("getEnterprise", call("GET", `/enterprises/${fresh.id}`));
    assert.equal(back.archived, null);
  });

  test("unknown enterprise answers 404", async () => {
    for (const [op, url] of [
      ["getEnterprise", "/enterprises/99999999"],
      ["getEnterpriseBilling", "/enterprises/99999999/billing"],
      ["listEnterpriseDocs", "/enterprises/99999999/docs"],
      ["getEnterpriseDependencies", "/enterprises/99999999/dependencies"],
    ] as const) {
      const res = await call("GET", url);
      assert.equal(res.statusCode, 404);
      check(op, res);
    }
  });
});

describe("trunks (§5.4, §5.5, §13.2)", { skip }, () => {
  const customerTrunk = (enterpriseId: number, suffix: string) => ({
    enterpriseId,
    name: `T${run}_${suffix}`,
    protocol: "smpp",
    billingType: "submit",
    status: "active",
    bindType: "TR",
    hostIps: ["192.0.2.10", "2001:db8::1"],
    username: `t${run}${suffix}`.slice(0, 16),
    password: "secret1",
    maxConnections: 2,
    tps: 50,
  });

  test("customer trunk: add, username reserved, edit and undo, password never returned", async () => {
    const ent = (await newEnterprise("customer", "E")).record;
    const saved = await ok("createCustomerTrunk", call("POST", "/customer-trunks", customerTrunk(ent.id, "a")), 201);
    const id = saved.record.id;
    assert.equal(saved.record.passwordSet, true);
    assert.ok(!("password" in saved.record));
    assert.deepEqual(saved.record.hostIps, ["192.0.2.10", "2001:db8::1"]);
    // The port follows the connection type and cannot be sent (product owner, 2026-10-24, migration 070).
    assert.equal(saved.record.port, 2775);
    const withPort = await call("POST", "/customer-trunks", { ...customerTrunk(ent.id, "p"), port: 2775 });
    assert.equal(withPort.statusCode, 400);

    const clash = await call("POST", "/customer-trunks", {
      ...customerTrunk(ent.id, "b"),
      username: saved.record.username,
    });
    assert.equal(clash.statusCode, 400);
    check("createCustomerTrunk", clash);
    assert.ok(clash.json().errors.some((e: { path: string }) => e.path === "/username"));
    const noPassword = await call("POST", "/customer-trunks", { ...customerTrunk(ent.id, "c"), password: undefined });
    assert.equal(noPassword.statusCode, 400);

    const { rows: tables } = await db().query(
      "SELECT id FROM rate_tables WHERE kind = 'customer' AND deleted_at IS NULL LIMIT 2",
    );
    const input = {
      ...customerTrunk(ent.id, "a"),
      password: undefined,
      tps: 75,
      rateTableIds: tables.map((t) => t.id),
    };
    const edited = await ok("updateCustomerTrunk", call("PUT", `/customer-trunks/${id}`, input));
    assert.deepEqual(edited.change.diff.map((d: { field: string }) => d.field).sort(), ["rateTableIds", "tps"]);
    await ok("undoChange", call("POST", `/changes/${edited.change.id}/undo`, {}));
    const back = await ok("getCustomerTrunk", call("GET", `/customer-trunks/${id}`));
    assert.equal(back.tps, 50);
    assert.deepEqual(back.rateTableIds, []);

    const pw = await ok(
      "updateCustomerTrunk",
      call("PUT", `/customer-trunks/${id}`, { ...input, password: "newpass" }),
    );
    const entry = pw.change.diff.find((d: { field: string }) => d.field === "password");
    assert.equal(entry.after, "(changed)", "credentials stay out of the change log (§13.22)");
    // Shown on request behind the form's eye button, and the look is in the Audit Trail (team trial round 12).
    const shown = await ok("getCustomerTrunkPassword", call("GET", `/customer-trunks/${id}/password`));
    assert.equal(shown.password, "newpass");
    const { rows: looks } = await db().query(
      "SELECT 1 FROM audit_log WHERE action = 'passwordShown' AND table_name = 'customer_trunks' AND master_id = $1",
      [String(id)],
    );
    assert.equal(looks.length, 1);
    await ok("getCustomerTrunkPassword", call("GET", "/customer-trunks/99999999/password"), 404);

    const tls = await ok("updateCustomerTrunk", call("PUT", `/customer-trunks/${id}`, { ...input, sslType: "tls1.2" }));
    assert.equal(tls.record.port, 2776, "a TLS trunk binds on 2776");
    await ok("undoChange", call("POST", `/changes/${tls.change.id}/undo`, {}));
    assert.equal((await ok("getCustomerTrunk", call("GET", `/customer-trunks/${id}`))).port, 2775);

    // TON / NPI as sent unless set to auto (S-4.7, migration 101).
    assert.equal(back.tonNpiMode, "as_sent");
    const auto = await ok(
      "updateCustomerTrunk",
      call("PUT", `/customer-trunks/${id}`, { ...input, tonNpiMode: "auto" }),
    );
    assert.equal(auto.record.tonNpiMode, "auto");
    assert.ok(auto.change.diff.some((d: { field: string }) => d.field === "tonNpiMode"));
  });

  test("vendor trunk owns a buy rate table; HTTP needs a URL", async () => {
    const ent = (await newEnterprise("vendor", "F")).record;
    const ref = await reference();
    const base = {
      enterpriseId: ent.id,
      name: `V${run}_a`,
      protocol: "smpp",
      categoryId: ref.productCategories[0].id,
      billingType: "delivery",
      status: "active",
      bindType: "TR",
      username: "vendoruser",
      password: "pw12345",
      host: "198.51.100.7",
      port: 2775,
      maxConnections: 1,
      tps: 100,
    };
    const http = await call("POST", "/vendor-trunks", { ...base, protocol: "http" });
    assert.equal(http.statusCode, 400);
    check("createVendorTrunk", http);
    const saved = await ok("createVendorTrunk", call("POST", "/vendor-trunks", base), 201);
    assert.ok(saved.record.ownRateTableId);
    // New vendor trunks allow any data coding, source TON/NPI and length; multipart on (§5.5).
    assert.equal(saved.record.allowedDataCodings, null);
    assert.equal(saved.record.allowedSrcTon, null);
    assert.equal(saved.record.allowedSrcNpi, null);
    assert.equal(saved.record.maxMsgLen, null);
    assert.equal(saved.record.allowedDstTon, null); // any destination TON on new vendor trunks (team trial round 6)
    assert.equal(saved.record.supportMultipart, true);
    const restricted = await ok(
      "updateVendorTrunk",
      call("PUT", `/vendor-trunks/${saved.record.id}`, {
        ...base,
        password: undefined,
        allowedDataCodings: [0, 8],
        maxMsgLen: 160,
      }),
    );
    assert.deepEqual(restricted.record.allowedDataCodings, [0, 8]);
    // TON / NPI: as sent unless the trunk is set to auto (S-4.7); one change, undone like any other (§13.10).
    assert.equal(saved.record.tonNpiMode, "as_sent");
    const auto = await ok(
      "updateVendorTrunk",
      call("PUT", `/vendor-trunks/${saved.record.id}`, { ...base, password: undefined, tonNpiMode: "auto" }),
    );
    assert.equal(auto.record.tonNpiMode, "auto");
    assert.deepEqual(
      auto.change.diff.map((d: { field: string }) => d.field),
      ["tonNpiMode"],
    );
    await ok("undoChange", call("POST", `/changes/${auto.change.id}/undo`, {}));
    assert.equal((await ok("getVendorTrunk", call("GET", `/vendor-trunks/${saved.record.id}`))).tonNpiMode, "as_sent");
    const unknownMode = await call("PUT", `/vendor-trunks/${saved.record.id}`, {
      ...base,
      password: undefined,
      tonNpiMode: "fix",
    });
    assert.equal(unknownMode.statusCode, 400, "only as_sent or auto");
    const anyAgain = await ok(
      "updateVendorTrunk",
      call("PUT", `/vendor-trunks/${saved.record.id}`, { ...base, password: undefined, allowedDataCodings: null }),
    );
    assert.equal(anyAgain.record.allowedDataCodings, null);
    // The Receipt timeout can apply to some destinations only (team trial round 12); none = every destination.
    assert.deepEqual(saved.record.dlrTimeoutMccmncs, []);
    const { rows: codes } = await db().query("SELECT mccmnc FROM mccmnc WHERE deleted_at IS NULL ORDER BY id LIMIT 2");
    const some = codes.map((c) => c.mccmnc as string);
    const scoped = await ok(
      "updateVendorTrunk",
      call("PUT", `/vendor-trunks/${saved.record.id}`, { ...base, password: undefined, dlrTimeoutMccmncs: some }),
    );
    assert.deepEqual(scoped.record.dlrTimeoutMccmncs, some);
    const unknown = await call("PUT", `/vendor-trunks/${saved.record.id}`, {
      ...base,
      password: undefined,
      dlrTimeoutMccmncs: ["999999"],
    });
    assert.equal(unknown.statusCode, 400, "an unknown destination is refused");
    const everywhere = await ok(
      "updateVendorTrunk",
      call("PUT", `/vendor-trunks/${saved.record.id}`, { ...base, password: undefined, dlrTimeoutMccmncs: [] }),
    );
    assert.deepEqual(everywhere.record.dlrTimeoutMccmncs, []);
    // A service trunk (team trial round 12): one outcome, its receipt status after its delay; vendor side only.
    const service = await ok(
      "createVendorTrunk",
      call("POST", "/vendor-trunks", {
        ...base,
        name: `V${run}_svc`,
        protocol: "service",
        dlrTimeoutS: 0,
        dlrTimeoutStat: "UNDELIV",
      }),
      201,
    );
    assert.equal(service.record.protocol, "service");
    assert.equal(service.record.dlrTimeoutStat, "UNDELIV");
    const svcRow = await ok(
      "queryVendorTrunks",
      call("POST", "/vendor-trunks/query", {
        filter: { logic: "and", conditions: [{ field: "id", op: "eq", value: service.record.id }] },
      }),
    );
    assert.equal(svcRow.rows[0].connection, "up", "a service trunk has no bind to wait for");
    const tables = await ok(
      "queryRateTables",
      call("POST", "/rate-tables/query", {
        filter: { logic: "and", conditions: [{ field: "vendorTrunkId", op: "eq", value: saved.record.id }] },
      }),
    );
    assert.equal(tables.rows[0].kind, "vendor");
    const wrongEnterprise = await call("POST", "/customer-trunks", customerTrunk(ent.id, "x"));
    assert.equal(wrongEnterprise.statusCode, 400, "a vendor enterprise can't have customer trunks");
    const client = (await newEnterprise("customer", "SV")).record;
    const serviceClient = await call("POST", "/customer-trunks", { ...customerTrunk(client.id, "sv"), protocol: "service" });
    assert.equal(serviceClient.statusCode, 400, "only a vendor trunk can be a service trunk");
  });

  test("rules tab: reorder, switch off, detach a direct rule, undo (§13.2)", async () => {
    const { rows } = await db().query(
      `SELECT t.id FROM customer_trunks t WHERE t.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM translation_rule_targets g JOIN translation_rules r ON r.id = g.translation_rule_id
                       WHERE r.deleted_at IS NULL AND g.trunk_kind = 'customer' AND g.target_type = 'trunk' AND g.target_id = t.id)
          AND (SELECT count(*) FROM translation_rule_targets g JOIN translation_rules r ON r.id = g.translation_rule_id
                WHERE r.deleted_at IS NULL AND g.trunk_kind = 'customer'
                AND (g.target_type = 'all' OR (g.target_type = 'trunk' AND g.target_id = t.id)
                     OR (g.target_type = 'enterprise' AND g.target_id = t.enterprise_id))) >= 3
        ORDER BY t.id LIMIT 1`,
    );
    const id = rows[0].id;
    const before = await ok("getCustomerTrunkRules", call("GET", `/customer-trunks/${id}/rules`));
    const ids = before.translation.map((r: { ruleId: number }) => r.ruleId);
    const reversed = [...ids].reverse();
    const reordered = await ok(
      "updateCustomerTrunkRules",
      call("PUT", `/customer-trunks/${id}/rules`, {
        translation: reversed.map((ruleId: number) => ({ ruleId, enabled: true })),
      }),
    );
    assert.deepEqual(
      reordered.record.translation.map((r: { ruleId: number }) => r.ruleId),
      reversed,
    );
    const direct = before.translation.find((r: { source: { type: string } }) => r.source.type === "trunk");
    const notDirect = before.translation.find((r: { source: { type: string } }) => r.source.type !== "trunk");
    if (notDirect) {
      const bad = await call("PUT", `/customer-trunks/${id}/rules`, { detachTranslationRuleIds: [notDirect.ruleId] });
      assert.equal(bad.statusCode, 400);
      check("updateCustomerTrunkRules", bad);
    }
    const detached = await ok(
      "updateCustomerTrunkRules",
      call("PUT", `/customer-trunks/${id}/rules`, { detachTranslationRuleIds: [direct.ruleId] }),
    );
    assert.ok(
      !detached.record.translation.some(
        (r: { ruleId: number; source: { type: string } }) => r.ruleId === direct.ruleId && r.source.type === "trunk",
      ),
    );

    await ok("undoChange", call("POST", `/changes/${detached.change.id}/undo`, {}));
    await ok("undoChange", call("POST", `/changes/${reordered.change.id}/undo`, {}));
    const after = await ok("getCustomerTrunkRules", call("GET", `/customer-trunks/${id}/rules`));
    assert.deepEqual(after, before);
  });

  test("archive and restore a trunk (§13.29)", async () => {
    const ent = (await newEnterprise("customer", "G")).record;
    const saved = await ok("createCustomerTrunk", call("POST", "/customer-trunks", customerTrunk(ent.id, "g")), 201);
    const id = saved.record.id;
    const deps = await ok("getCustomerTrunkDependencies", call("GET", `/customer-trunks/${id}/dependencies`));
    assert.equal(deps.blocked, false);
    const archived = await ok(
      "archiveCustomerTrunk",
      call("POST", `/customer-trunks/${id}/archive`, { reason: "Test" }),
    );
    assert.ok(archived.record.archived);
    const reuse = await call("POST", "/customer-trunks", {
      ...customerTrunk(ent.id, "h"),
      username: saved.record.username,
    });
    assert.equal(reuse.statusCode, 400, "an archived trunk's username stays reserved");
    const restored = await ok("restoreCustomerTrunk", call("POST", `/customer-trunks/${id}/restore`));
    assert.equal(restored.record.archived, null);
    const again = await call("POST", `/customer-trunks/${id}/restore`);
    assert.equal(again.statusCode, 400);
    check("restoreCustomerTrunk", again);
  });

  // The switch reloads when its fingerprint changes: count and latest updated_at per table
  // (Sms.Switch.Pipeline.Config.Loader). Archive, restore and undo keep the count, so they must move updated_at
  // (migration 099).
  test("archive, restore and undo change the switch's fingerprint (§13.29, §13.10)", async () => {
    const fingerprint = async () =>
      (await db().query("SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') AS f FROM customer_trunks"))
        .rows[0].f as string;
    const ent = (await newEnterprise("customer", "FP")).record;
    const id = (await ok("createCustomerTrunk", call("POST", "/customer-trunks", customerTrunk(ent.id, "f")), 201)).record
      .id;
    let seen = await fingerprint();
    const moved = async (what: string) => {
      const now = await fingerprint();
      assert.notEqual(now, seen, what);
      seen = now;
    };
    await ok("archiveCustomerTrunk", call("POST", `/customer-trunks/${id}/archive`, { reason: "Test" }));
    await moved("archive");
    await ok("restoreCustomerTrunk", call("POST", `/customer-trunks/${id}/restore`));
    await moved("restore");
    const archived = await ok("archiveCustomerTrunk", call("POST", `/customer-trunks/${id}/archive`, { reason: "Test" }));
    await moved("archive again");
    await ok("undoChange", call("POST", `/changes/${archived.change.id}/undo`, {}));
    await moved("undo of the archive");

    // Every table the fingerprint counts this way, whoever writes deleted_at (rolled back).
    const c = await db().connect();
    try {
      await c.query("BEGIN");
      for (const t of [
        "business_companies",
        "customer_trunks",
        "dial_codes",
        "enterprises",
        "hlr_policies",
        "hlr_provider_rates",
        "hlr_providers",
        "hlr_rules",
        "mccmnc",
        "number_lists",
        "rate_tables",
        "vendor_trunks",
      ]) {
        const { rows } = await c.query(
          `UPDATE ${t} SET deleted_at = CASE WHEN deleted_at IS NULL THEN now() END
            WHERE id = (SELECT min(id) FROM ${t})
           RETURNING updated_at > now() AS moved`,
        );
        if (rows[0]) assert.equal(rows[0].moved, true, t);
      }
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
