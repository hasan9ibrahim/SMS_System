// Which rate line prices a message (decided 2026-10-30, §5.4, §6.2): blocked means blocked (a blocked line that applies
// is no rate: no fallback to the country line or a later table), and a vendor's Sender ID lines match the sender it
// receives after its egress translation, a customer's the one it sent. As the switch (`Config.sell_price/4`,
// `vendor_price/4`). Fake rate tables are added to a seeded trunk and removed after.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { buildServer, API_PREFIX } from "../src/server.js";
import { closeDb, db, dbReady } from "../src/db.js";
import { customerPrice, vendorPrice } from "../src/api/linePrice.js";
import { vendorOptions } from "../src/api/routeRules.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
const run = Date.now().toString(36).slice(-5);
const tables: number[] = [];
const lines: number[] = [];
let net = "";
let other = "";
let ct = 0;
let vt = 0;

before(async () => {
  if (!ready) return;
  // A network whose country has an All networks code, and another network of that country.
  const { rows: n } = await db().query(
    `SELECT m.mccmnc, m.id, c.id AS country_line, (SELECT o.mccmnc FROM mccmnc o WHERE o.mcc = m.mcc
              AND NOT o.is_all_networks AND o.mccmnc <> m.mccmnc ORDER BY o.mccmnc LIMIT 1) AS other
       FROM mccmnc m JOIN mccmnc c ON c.mccmnc = left(m.mccmnc, 3) AND c.is_all_networks
      WHERE NOT m.is_all_networks AND length(m.mccmnc) > 3
        AND EXISTS (SELECT 1 FROM mccmnc o WHERE o.mcc = m.mcc AND NOT o.is_all_networks AND o.mccmnc <> m.mccmnc)
      ORDER BY m.mccmnc LIMIT 1`,
  );
  net = n[0].mccmnc;
  other = n[0].other;
  const netId = Number(n[0].id);
  const { rows: o } = await db().query("SELECT id FROM mccmnc WHERE mccmnc = $1", [n[0].other]);
  const otherId = Number(o[0].id);
  const countryId = Number(n[0].country_line);
  const mcc = net.slice(0, 3);
  const { rows: c } = await db().query(
    "SELECT id, product_category_id FROM customer_trunks WHERE deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1",
  );
  ct = Number(c[0].id);
  // A routable vendor trunk with no line of its own for the country, so only the test's lines count.
  const { rows: v } = await db().query(
    `SELECT vt.id, vt.product_category_id FROM vendor_trunks vt
      WHERE vt.deleted_at IS NULL AND vt.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM rate_tables rt JOIN rate_lines l ON l.rate_table_id = rt.id
                         WHERE rt.vendor_trunk_id = vt.id AND left(l.mccmnc, 3) = $1)
      ORDER BY vt.id LIMIT 1`,
    [mcc],
  );
  vt = Number(v[0].id);
  const table = async (kind: string, category: number, vendor: number | null) => {
    const { rows } = await db().query(
      `INSERT INTO rate_tables (kind, name, product_category_id, currency, vendor_trunk_id)
       VALUES ($1, $2, $3, 'EUR', $4) RETURNING id`,
      [kind, `PICK_${kind}_${run}_${tables.length}`, category, vendor],
    );
    tables.push(Number(rows[0].id));
    return Number(rows[0].id);
  };
  const line = async (t: number, id: number, code: string, rate: string, blocked = false, sender: string | null = null) => {
    const { rows } = await db().query(
      `INSERT INTO rate_lines (rate_table_id, mccmnc_id, mccmnc, sender_id, rate, currency, valid_from, is_blocked, change_type)
       VALUES ($1, $2, $3, $4, $5, 'EUR', now() - interval '1 hour', $6, 'new') RETURNING id`,
      [t, id, code, sender, rate, blocked],
    );
    lines.push(Number(rows[0].id));
  };
  // Customer: table 1 blocks the network, sells the country; table 2 sells the network; the sender's own line first.
  const t1 = await table("customer", Number(c[0].product_category_id), null);
  const t2 = await table("customer", Number(c[0].product_category_id), null);
  await line(t1, netId, net, "0", true);
  await line(t1, countryId, mcc, "0.04");
  await line(t1, netId, net, "0.07", false, `FakeBank${run}`);
  await line(t2, netId, net, "0.06");
  const { rows: pos } = await db().query(
    "SELECT COALESCE(min(position), 0) AS p FROM customer_trunk_rate_tables WHERE customer_trunk_id = $1",
    [ct],
  );
  await db().query(
    "INSERT INTO customer_trunk_rate_tables (customer_trunk_id, rate_table_id, position) VALUES ($1, $2, $3), ($1, $4, $5)",
    [ct, t1, Number(pos[0].p) - 2, t2, Number(pos[0].p) - 1],
  );
  // Vendor (one rate table per trunk): the network blocked, the country priced; a Sender ID line for the sender it
  // would receive.
  const { rows: own } = await db().query("SELECT id FROM rate_tables WHERE vendor_trunk_id = $1", [vt]);
  const v1 = own[0] ? Number(own[0].id) : await table("vendor", Number(v[0].product_category_id), vt);
  await line(v1, netId, net, "0", true);
  await line(v1, countryId, mcc, "0.01");
  await line(v1, netId, net, "0.03", false, `FakeBank${run}`);
  // Another network: the country line prices it, except for one sender whose own line is blocked.
  await line(v1, otherId, other, "0", true, `Blocked${run}`);
});

after(async () => {
  if (ready) {
    await db().query("DELETE FROM rate_lines WHERE id = ANY($1)", [lines]);
    await db().query("DELETE FROM customer_trunk_rate_tables WHERE rate_table_id = ANY($1)", [tables]);
    await db().query("DELETE FROM rate_tables WHERE id = ANY($1)", [tables]);
  }
  await app.close();
  await closeDb();
});

describe("blocked means blocked; Sender ID lines by the right sender (decided 2026-10-30)", { skip }, () => {
  test("a blocked customer line is no rate: no country line, no later table; the sender's own line still prices", async () => {
    assert.equal(await customerPrice(db(), ct, net, null), "blocked");
    const bySender = await customerPrice(db(), ct, net, `FakeBank${run}`);
    assert.ok(bySender && bySender !== "blocked");
    assert.equal(bySender.rate, 0.07);
    // Another network of the country keeps the country line of the first table.
    const country = await customerPrice(db(), ct, other, null);
    assert.ok(country && country !== "blocked");
    assert.equal(country.rate, 0.04);
  });

  test("a blocked vendor line keeps the vendor off the destination; its Sender ID line prices that sender", async () => {
    assert.equal(await vendorPrice(db(), vt, net, null), "blocked");
    const bySender = await vendorPrice(db(), vt, net, `FakeBank${run}`);
    assert.ok(bySender && bySender !== "blocked");
    assert.equal(bySender.rate, 0.03);
    const options = await vendorOptions(db(), net, [vt]);
    assert.equal(options.get(vt)?.blocked, true);
    assert.equal(options.get(vt)?.cost, null);
    const elsewhere = await vendorOptions(db(), other, [vt]);
    assert.equal(elsewhere.get(vt)?.blocked, false);
    assert.equal(elsewhere.get(vt)?.cost, 0.01);
    // A blocked Sender ID line blocks only that sender.
    assert.equal(await vendorPrice(db(), vt, other, `Blocked${run}`), "blocked");
    const generic = await vendorPrice(db(), vt, other, "OtherShop");
    assert.ok(generic && generic !== "blocked");
    assert.equal(generic.rate, 0.01);
  });

  test("the Route simulator refuses a blocked customer rate, and prices the sender the customer sent", async () => {
    const sim = (senderId: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: `${API_PREFIX}/route-simulator`,
        payload: {
          customerTrunkId: ct,
          senderId,
          mccmnc: net,
          text: "Your code is 1234",
          dataCoding: 0,
          sourceTon: 5,
          sourceNpi: 0,
          destTon: 1,
          destNpi: 1,
          testSms: false,
          ...extra,
        },
      });
    const blocked = (await sim("INFO")).json();
    assert.equal(blocked.customerRate, null);
    assert.match(blocked.blocked, /customer's rate for the destination is blocked/);
    const own = (await sim(`FakeBank${run}`)).json();
    assert.equal(own.customerRate.rate, 0.07);
    // Straight to the vendor: priced, or refused as blocked, by the sender it receives after its egress translation
    // (the seeded vendor rules may change it).
    for (const [code, sender] of [
      [net, `FakeBank${run}`],
      [other, `Blocked${run}`],
    ] as const) {
      const r = (await sim(sender, { vendorTrunkId: vt, mccmnc: code })).json();
      if (r.translation.blocked || r.vendorTranslation?.result.blocked) continue;
      const received = r.vendorTranslation?.result.after.sender ?? r.sender;
      const expected = await vendorPrice(db(), vt, code, received);
      if (expected === "blocked") assert.match(r.blocked, /rate for the destination is blocked/);
      else assert.equal(r.forcedVendor.rate, expected?.rate ?? null);
    }
  });
});
