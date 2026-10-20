// Rate Lookup (build step 4.4, §13.16): destination search, the vendor and client panels
// with best and routed margins, point in time, advanced matrix views, highlights, export
// and saved lookups. Every response is checked against the contract. Needs the seeded
// database; traffic figures are null without ClickHouse.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, API_PREFIX } from "../src/server.js";
import { operations } from "../src/contract.js";
import { closeDb, db, dbReady } from "../src/db.js";

const app = await buildServer({ socket: false });
const ready = await dbReady();
const skip = ready ? false : "seeded database not available (npm run db:up && npm run seed:small)";
after(async () => {
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

/** A network sold by at least one client and bought from at least two vendors, with its country. */
async function busyNetwork() {
  const { rows } = await db().query(
    `SELECT l.mccmnc, m.mcc, co.name AS country, co.dial_code, co.id AS country_id
       FROM rate_lines l JOIN rate_tables rt ON rt.id = l.rate_table_id
       JOIN mccmnc m ON m.mccmnc = l.mccmnc JOIN countries co ON co.id = m.country_id
      WHERE NOT m.is_all_networks AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
      GROUP BY l.mccmnc, m.mcc, co.name, co.dial_code, co.id
     HAVING count(*) FILTER (WHERE rt.kind = 'vendor') >= 2
        AND count(*) FILTER (WHERE rt.kind = 'customer' AND EXISTS
              (SELECT 1 FROM customer_trunk_rate_tables x WHERE x.rate_table_id = rt.id)) >= 1
      ORDER BY count(*) DESC LIMIT 1`,
  );
  const r = rows[0];
  return {
    mccmnc: r.mccmnc as string,
    mcc: String(r.mcc).trim(),
    country: r.country as string,
    dialCode: r.dial_code as string,
    countryId: Number(r.country_id),
  };
}

describe("destination search (§13.16 easy mode)", { skip }, () => {
  test("country name, MCCMNC, dial code and phone number", async () => {
    const n = await busyNetwork();
    const byName = await ok(
      "resolveLookupDestinations",
      call("GET", `/rate-lookup/destinations?q=${encodeURIComponent(n.country.slice(0, 5))}`),
    );
    assert.equal(byName.kind, "text");
    assert.ok(
      byName.destinations.some((d: { mccmnc: string; allNetworks: boolean }) => d.mccmnc === n.mcc && d.allNetworks),
    );
    const byCode = await ok("resolveLookupDestinations", call("GET", `/rate-lookup/destinations?q=${n.mccmnc}`));
    assert.equal(byCode.destinations[0].mccmnc, n.mccmnc);
    const byDial = await ok("resolveLookupDestinations", call("GET", `/rate-lookup/destinations?q=${n.dialCode}`));
    assert.ok(
      byDial.destinations.some((d: { country: string }) => d.country === n.country),
      "dial code finds the country",
    );

    const { rows } = await db().query(
      "SELECT d.prefix, m.mccmnc FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id WHERE length(d.prefix) >= 4 ORDER BY d.id LIMIT 1",
    );
    const number = `+${rows[0].prefix}${"1234567".slice(0, 11 - rows[0].prefix.length)}`;
    const byNumber = await ok(
      "resolveLookupDestinations",
      call("GET", `/rate-lookup/destinations?q=${encodeURIComponent(number)}`),
    );
    assert.equal(byNumber.kind, "number");
    assert.equal(byNumber.number.resolvedBy, "prefix");
    assert.ok(byNumber.number.prefix.length >= rows[0].prefix.length);
    const live = await ok(
      "resolveLookupDestinations",
      call("GET", `/rate-lookup/destinations?q=${encodeURIComponent(number)}&live=true`),
    );
    assert.equal(live.number.resolvedBy, "hlr");
    assert.equal(typeof live.number.ported, "boolean");
  });
});

describe("vendor costs and client rates (§13.16)", { skip }, () => {
  test("cheapest first, margins against best and routed vendor, scheduled rates", async () => {
    const n = await busyNetwork();
    const r = await ok("lookupRates", call("POST", "/rate-lookup", { mccmnc: n.mccmnc, showScheduled: true }));
    assert.equal(r.destination.mccmnc, n.mccmnc);
    assert.ok(r.vendors.length >= 2);
    const usd = r.vendors.map((v: { rateConverted: number }) => v.rateConverted);
    assert.deepEqual(
      usd,
      [...usd].sort((a, b) => a - b),
      "cheapest first",
    );
    for (const v of r.vendors) assert.ok([n.mccmnc, n.mcc].includes(v.matchedCode), "network or its country line");
    const active = r.vendors.filter((v: { status: string }) => v.status === "active");
    assert.equal(r.bestCost, Math.min(...active.map((v: { rateConverted: number }) => v.rateConverted)));
    assert.ok(r.clients.length >= 1);
    const routedIds = new Set(
      r.vendors.filter((v: { routed: boolean }) => v.routed).map((v: { vendorTrunkId: number }) => v.vendorTrunkId),
    );
    for (const c of r.clients) {
      assert.ok(Math.abs(c.marginBest - (c.rateConverted - r.bestCost)) < 1e-5);
      if (c.routedVendor) {
        if (c.routedVendor.cost !== null)
          assert.ok(Math.abs(c.marginRouted - (c.rateConverted - c.routedVendor.cost)) < 1e-5);
        if (active.some((v: { vendorTrunkId: number }) => v.vendorTrunkId === c.routedVendor.vendorTrunkId))
          assert.ok(routedIds.has(c.routedVendor.vendorTrunkId), "routed vendors are marked");
      }
    }
  });

  test("converted figures are in the platform currency (EUR by default, decided 2026-10-16)", async () => {
    const ref = await ok("getReference", call("GET", "/meta/reference"));
    assert.equal(ref.platformCurrency, process.env.PLATFORM_CURRENCY ?? "EUR");
    const n = await busyNetwork();
    const r = await ok("lookupRates", call("POST", "/rate-lookup", { mccmnc: n.mccmnc }));
    assert.equal(r.lookupCurrency, ref.platformCurrency);
    const { rows } = await db().query("SELECT iso, rate_per_eur FROM currency_latest");
    const perEur = new Map(rows.map((x) => [String(x.iso).trim(), Number(x.rate_per_eur)]));
    for (const line of [...r.vendors.slice(0, 5), ...r.clients.slice(0, 5)]) {
      const expected = (line.rate / perEur.get(line.currency)!) * perEur.get(ref.platformCurrency)!;
      assert.ok(Math.abs(line.rateConverted - expected) < 2e-6, `${line.rate} ${line.currency}`);
    }
  });

  test("a past date shows the rate charged then; my clients only", async () => {
    const { rows } = await db().query(
      `SELECT l.mccmnc, l.rate, l.rate_table_id, l.valid_from + (l.valid_to - l.valid_from) / 2 AS mid
         FROM rate_lines l JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
         JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id AND vt.deleted_at IS NULL AND vt.status = 'active'
        WHERE l.valid_to IS NOT NULL AND l.valid_to < now() AND l.sender_id IS NULL AND NOT l.is_blocked
          AND length(l.mccmnc) > 3
        ORDER BY l.id LIMIT 1`,
    );
    if (rows[0]) {
      const past = await ok(
        "lookupRates",
        call("POST", "/rate-lookup", { mccmnc: rows[0].mccmnc, asOf: (rows[0].mid as Date).toISOString() }),
      );
      const v = past.vendors.find((x: { rateTableId: number }) => x.rateTableId === Number(rows[0].rate_table_id));
      assert.ok(v, "the vendor had a rate then");
      assert.equal(v.rate, Number(rows[0].rate));
    }
    const n = await busyNetwork();
    const me = await ok("getCurrentUser", call("GET", "/me"));
    const mine = await ok("lookupRates", call("POST", "/rate-lookup", { mccmnc: n.mccmnc, myClientsOnly: true }));
    for (const c of mine.clients) assert.equal(c.accountManager?.id, me.id);
    const unknown = await call("POST", "/rate-lookup", { mccmnc: "99999" });
    assert.equal(unknown.statusCode, 400);
    check("lookupRates", unknown);
  });
});

describe("advanced lookup (§13.16)", { skip }, () => {
  test("four views, paging, highlights and unresolved input", async () => {
    const n = await busyNetwork();
    const base = { countryIds: [n.countryId], limit: 5 };
    for (const view of ["vendor_costs", "client_rates", "margin", "cheapest"]) {
      const m = await ok("rateLookupMatrix", call("POST", "/rate-lookup/matrix", { ...base, view, cheapestN: 3 }));
      assert.ok(m.columns.length <= 60);
      assert.ok(m.rows.length <= 5);
      for (const row of m.rows) assert.equal(row.cells.length, m.columns.length);
      if (view === "cheapest") {
        assert.equal(m.columns.length, 3);
        for (const row of m.rows) {
          const rates = row.cells.filter(Boolean).map((c: { rateConverted: number }) => c.rateConverted);
          assert.deepEqual(
            rates,
            [...rates].sort((a, b) => a - b),
          );
          if (rates.length) assert.equal(rates[0], row.bestCost);
        }
      }
      if (m.total > 5) {
        assert.equal(m.nextCursor, "5");
        const next = await ok(
          "rateLookupMatrix",
          call("POST", "/rate-lookup/matrix", { ...base, view, cursor: m.nextCursor }),
        );
        assert.notEqual(next.rows[0].destination.mccmnc, m.rows[0].destination.mccmnc);
      }
    }
    const flagged = await ok(
      "rateLookupMatrix",
      call("POST", "/rate-lookup/matrix", {
        ...base,
        view: "client_rates",
        highlights: ["single_vendor", "below_cost"],
      }),
    );
    for (const row of flagged.rows)
      assert.ok(row.highlights.some((h: string) => h === "single_vendor" || h === "below_cost"));

    const mixed = await ok(
      "rateLookupMatrix",
      call("POST", "/rate-lookup/matrix", {
        mccmncs: [n.mccmnc, "99999"],
        numbers: ["+999999999"],
        view: "vendor_costs",
      }),
    );
    assert.equal(mixed.total, 1);
    assert.deepEqual(mixed.unresolved.sort(), ["99999", "999999999"]);

    const none = await call("POST", "/rate-lookup/matrix", { view: "vendor_costs" });
    assert.equal(none.statusCode, 400);
    check("rateLookupMatrix", none);
  });

  test("CSV export of every row", async () => {
    const n = await busyNetwork();
    const res = await call("POST", "/rate-lookup/matrix/export", {
      countryIds: [n.countryId],
      view: "cheapest",
      cheapestN: 2,
    });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/csv/);
    const lines = res.body.trim().split("\r\n");
    const head = lines[0] ?? "";
    assert.ok(head.startsWith("MCCMNC,Country,Network"));
    assert.ok(head.endsWith("Cheapest 1,Cheapest 2"));
    const { rows } = await db().query("SELECT count(*)::int AS n FROM mccmnc WHERE country_id = $1", [n.countryId]);
    assert.equal(lines.length - 1, rows[0].n);
  });

  test("saved lookups: create, list, change, delete", async () => {
    const n = await busyNetwork();
    const name = `Test lookup ${Date.now().toString(36)}`;
    const query = { countryIds: [n.countryId], view: "margin", highlights: ["below_cost"] };
    const saved = await ok("createSavedLookup", call("POST", "/rate-lookups", { name, query }), 201);
    assert.deepEqual(saved.query.countryIds, query.countryIds);
    assert.equal(saved.query.view, "margin");
    assert.deepEqual(saved.query.highlights, ["below_cost"]);
    assert.equal(saved.readOnly, false);
    const list = await ok("listSavedLookups", call("GET", "/rate-lookups"));
    assert.ok(list.some((l: { id: number }) => l.id === saved.id));
    const changed = await ok(
      "updateSavedLookup",
      call("PUT", `/rate-lookups/${saved.id}`, { name: `${name} 2`, query: { ...query, view: "cheapest" } }),
    );
    assert.equal(changed.query.view, "cheapest");
    const dup = await call("POST", "/rate-lookups", { name: `${name} 2`, query });
    assert.equal(dup.statusCode, 400);
    const del = await call("DELETE", `/rate-lookups/${saved.id}`);
    assert.equal(del.statusCode, 204);
    const gone = await call("DELETE", `/rate-lookups/${saved.id}`);
    assert.equal(gone.statusCode, 404);
  });
});

describe("side by side (team trial round 1)", { skip }, () => {
  test("options, destinations with ranges, paging, filters and expanded tables, fast at volume", async () => {
    const opts = await ok("rateLookupSideOptions", call("GET", "/rate-lookup/side/options?side=vendor"));
    assert.ok(opts.trunks.length > 0 && opts.countries.length > 0 && opts.codes.length > 0);
    const t0 = performance.now();
    const all = await ok("rateLookupSide", call("POST", "/rate-lookup/side", { side: "vendor", limit: 50 }));
    assert.ok(performance.now() - t0 < 1500, "first page under the budget at full volume");
    assert.equal(all.rows.length, Math.min(50, all.total));
    for (const r of all.rows) assert.ok(r.tables > 0 && r.minSys <= r.maxSys);
    if (all.nextCursor) {
      const next = await ok(
        "rateLookupSide",
        call("POST", "/rate-lookup/side", { side: "vendor", limit: 50, cursor: all.nextCursor }),
      );
      assert.notEqual(next.rows[0]?.mccmnc, all.rows[0]?.mccmnc, "the next page moves on");
    }
    const row = all.rows.find((r: { allNetworks: boolean }) => !r.allNetworks) ?? all.rows[0];
    const one = await ok(
      "rateLookupSide",
      call("POST", "/rate-lookup/side", { side: "vendor", mccs: [row.mcc], search: row.network.slice(0, 4) }),
    );
    assert.ok(
      one.rows.every((r: { mcc: string }) => r.mcc === row.mcc),
      "country filter",
    );
    const lines = await ok(
      "rateLookupSideLines",
      call("POST", "/rate-lookup/side/lines", { side: "vendor", mccmnc: row.mccmnc }),
    );
    assert.equal(lines.lines.length, row.tables, "one line per table the row counted");
    const sys = lines.lines.map((l: { sysRate: number }) => l.sysRate);
    assert.deepEqual(
      sys,
      [...sys].sort((a, b) => a - b),
      "cheapest first",
    );
    assert.ok(Math.abs(sys[0] - row.minSys) < 1e-5 && Math.abs(sys.at(-1) - row.maxSys) < 1e-5, "range matches");
    const trunk = lines.lines[0].trunks[0].id;
    const byTrunk = await ok(
      "rateLookupSide",
      call("POST", "/rate-lookup/side", { side: "vendor", trunkIds: [trunk], mccmncs: [row.mccmnc] }),
    );
    assert.equal(byTrunk.rows[0]?.tables, 1, "trunk filter");
    const cust = await ok(
      "rateLookupSide",
      call("POST", "/rate-lookup/side", { side: "customer", sort: "tables", dir: "desc", limit: 5 }),
    );
    const counts = cust.rows.map((r: { tables: number }) => r.tables);
    assert.deepEqual(
      counts,
      [...counts].sort((a, b) => b - a),
      "sorted by tables",
    );
    const bad = await call("POST", "/rate-lookup/side", { side: "both" });
    assert.equal(bad.statusCode, 400);
  });
});
