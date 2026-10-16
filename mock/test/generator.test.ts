// Fake data generator (build-order step 2): determinism, integrity, fake-data guards and
// EDRs that follow rates, routing and AM history at send time (CLAUDE.md rules 1 and 4).
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWorld, Rng } from "../src/generator/index.js";
import { EDR_COLUMNS, generateEdrs, type EdrWriter } from "../src/generator/edr.js";
import { PROFILES, type Profile } from "../src/generator/profiles.js";
import { TableSink } from "../src/generator/sink.js";
import { TABLE_ORDER } from "../src/generator/loaders.js";
import { amAt, type RateVersion, type World } from "../src/generator/world.js";

const ANCHOR = Date.parse("2026-10-16T12:00:00Z");
const profile: Profile = { ...PROFILES.small!, enterprises: 40, routeRules: 150 };

async function build(dir: string): Promise<World> {
  const sink = new TableSink(dir);
  const world = await generateWorld({ seed: "test", profile, anchor: ANCHOR, sink });
  await sink.close();
  return world;
}

function readCsv(dir: string, table: string): Record<string, string>[] {
  const [header = "", ...lines] = readFileSync(join(dir, `${table}.csv`), "utf8")
    .trim()
    .split("\n");
  const cols = header.split(",");
  return lines.map((l) => {
    const vals: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') {
        if (quoted && l[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
        continue;
      }
      if (ch === "," && !quoted) {
        vals.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    vals.push(cur);
    return Object.fromEntries(cols.map((c, i): [string, string] => [c, vals[i] ?? ""]));
  });
}

const dirA = mkdtempSync(join(tmpdir(), "gen-a-"));
const dirB = mkdtempSync(join(tmpdir(), "gen-b-"));
after(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

const world = await build(dirA);
const edrs: string[][] = [];
const writer: EdrWriter = {
  write: async (chunk) => {
    for (const l of chunk.split("\n")) if (l) edrs.push(l.split("\t"));
  },
  close: async () => {},
};
await generateEdrs(world, new Rng("test:edr"), writer, { count: 30_000, days: 2, chunkRows: 5000 });

type Column = (typeof EDR_COLUMNS)[number];
const col = new Map<string, number>(EDR_COLUMNS.map((c, i) => [c, i]));
const cell = (r: string[], c: Column) => r[col.get(c)!] ?? "";
const time = (s: string) => Date.parse(s.replace(" ", "T") + "Z");
const versionById = new Map<number, RateVersion>();
for (const t of world.rateTables) for (const vs of t.lines.values()) for (const v of vs) versionById.set(v.id, v);

describe("determinism", () => {
  test("same seed and anchor give identical files", async () => {
    await build(dirB);
    for (const t of ["enterprises", "customer_trunks", "rate_lines", "route_rules", "invoices"]) {
      const h = (d: string) =>
        createHash("sha1")
          .update(readFileSync(join(d, `${t}.csv`)))
          .digest("hex");
      assert.equal(h(dirB), h(dirA), t);
    }
  });

  test("every generated table has a load position", () => {
    const files = readdirSync(dirA)
      .filter((f) => f.endsWith(".csv"))
      .map((f) => f.slice(0, -4));
    assert.ok(files.length > 30);
    for (const f of files) assert.ok(TABLE_ORDER.includes(f), f);
  });
});

describe("MCC/MNC master (spec §6.1, §13.21)", () => {
  test("uses the real list with unique codes and country-level codes", () => {
    assert.ok(world.mccmnc.filter((m) => !m.isAllNetworks).length > 1900);
    assert.equal(new Set(world.mccmnc.map((m) => m.code)).size, world.mccmnc.length);
    assert.ok(world.mccmncByCode.get("20801")?.network);
    assert.equal(world.mccmncByCode.get("208")?.isAllNetworks, true);
  });

  test("dial-code prefixes start with the country dial code and are unique", () => {
    const rows = readCsv(dirA, "dial_codes");
    assert.equal(new Set(rows.map((r) => r.prefix)).size, rows.length);
    for (const r of rows) {
      const m = world.mccmncById.get(Number(r.mccmnc_id))!;
      assert.ok(r.prefix!.startsWith(world.countryById.get(m.countryId)!.dialCode), r.prefix);
    }
  });
});

describe("rate history (spec §6.2, §13.32)", () => {
  test("versions of a destination are ordered and never overlap", () => {
    let keys = 0;
    for (const table of world.rateTables) {
      for (const versions of table.lines.values()) {
        keys++;
        for (let i = 1; i < versions.length; i++) assert.ok(versions[i]!.from >= versions[i - 1]!.to);
      }
    }
    assert.ok(keys > 1000);
  });

  test("has history, scheduled changes and back-dated vendor lines", () => {
    const rows = readCsv(dirA, "rate_lines");
    assert.ok(rows.some((r) => r.change_type === "increase"));
    assert.ok(rows.some((r) => r.valid_to !== ""));
    assert.ok(rows.some((r) => Date.parse(r.valid_from!) > ANCHOR));
    const backDated = rows.filter((r) => r.stated_valid_from !== "");
    assert.ok(backDated.length > 0);
    for (const r of backDated) assert.ok(Date.parse(r.stated_valid_from!) < Date.parse(r.valid_from!));
  });

  test("every vendor trunk has exactly one vendor table", () => {
    for (const v of world.vendorTrunks) assert.equal(world.rateTableById.get(v.rateTableId)?.vendorTrunkId, v.id);
  });
});

describe("fake data only (CLAUDE.md rule 1)", () => {
  test("uses documentation or private IPs and .example domains", () => {
    const ipOk = (ip: string) => /^(198\.51\.100|203\.0\.113|192\.0\.2)\.\d+$|^10\.\d+\.\d+\.\d+$/.test(ip);
    for (const t of world.customerTrunks) for (const ip of t.hostIps) assert.ok(ipOk(ip), ip);
    for (const v of world.vendorTrunks) assert.ok(ipOk(v.host), v.host);
    for (const r of readCsv(dirA, "users")) assert.ok(r.email!.endsWith(".example"), r.email);
    for (const r of readCsv(dirA, "enterprise_contacts")) assert.match(r.emails!, /\.example/);
  });
});

describe("route rules (spec §6.3, §13.27)", () => {
  test("reference existing vendor trunks and have a catch-all per used category", () => {
    for (const r of world.routeRules) for (const v of r.vendors) assert.ok(world.vendorTrunkById.has(v.vendorTrunkId));
    for (const c of new Set(world.customerTrunks.map((t) => t.categoryId))) {
      assert.ok(
        world.routeRules.some((r) => r.routeType === "dynamic" && r.mccmncs.length === 0 && r.categoryIds.includes(c)),
      );
    }
  });
});

describe("EDRs (spec §9.1, §13.29, §13.30)", () => {
  test("rows have one value per column", () => {
    assert.ok(edrs.length > 25_000);
    for (const r of edrs.slice(0, 2000)) assert.equal(r.length, EDR_COLUMNS.length);
  });

  test("copy the customer and vendor rate valid at send time", () => {
    let checked = 0;
    for (const r of edrs) {
      if (cell(r, "c_rate_line_id") === "0") continue;
      const t = time(cell(r, "start_time"));
      const version = versionById.get(Number(cell(r, "c_rate_line_id")))!;
      assert.ok(version.from <= t && t < version.to);
      assert.ok(Math.abs(Number(cell(r, "c_rate")) - version.rate) < 1e-6);
      if (cell(r, "v_trunk_id") !== "0") {
        const vt = world.vendorTrunkById.get(Number(cell(r, "v_trunk_id")))!;
        const vVersion = versionById.get(Number(cell(r, "v_rate_line_id")))!;
        const submit = time(cell(r, "submit_time"));
        assert.ok(vVersion.from <= submit && submit < vVersion.to);
        assert.ok(Math.abs(Number(cell(r, "v_rate")) - vVersion.rate) < 1e-6);
        // the line belongs to the routed vendor's own buy table
        assert.ok([...world.rateTableById.get(vt.rateTableId)!.lines.values()].some((vs) => vs.includes(vVersion)));
      }
      if (++checked >= 1500) break;
    }
    assert.equal(checked, 1500);
  });

  test("bill per billing type and multiply by message parts", () => {
    for (const r of edrs.slice(0, 5000)) {
      const revenue = Number(cell(r, "revenue"));
      if (cell(r, "is_customer_billable") === "1") {
        assert.ok(Math.abs(revenue - Number(cell(r, "c_rate")) * Number(cell(r, "msg_count"))) < 1e-5);
        if (cell(r, "c_billing_type") === "delivery") assert.equal(cell(r, "msg_status"), "DELIVRD");
      } else {
        assert.equal(revenue, 0);
      }
    }
  });

  test("store the AM who held the account at send time", () => {
    for (const r of edrs.slice(0, 3000)) {
      const e = world.enterpriseById.get(Number(cell(r, "c_enterprise_id")))!;
      assert.equal(Number(cell(r, "c_am_user_id")), amAt(e, time(cell(r, "start_time"))));
    }
  });

  test("look realistic: most messages deliver, some are re-routed", () => {
    const final = edrs.filter((r) => cell(r, "is_final_attempt") === "1");
    const delivered = final.filter((r) => cell(r, "msg_status") === "DELIVRD").length / final.length;
    assert.ok(delivered > 0.5 && delivered < 0.97, String(delivered));
    assert.ok(edrs.some((r) => cell(r, "attempt_no") === "2"));
    assert.ok(edrs.some((r) => cell(r, "route_decided_by") === "lcr"));
  });
});
