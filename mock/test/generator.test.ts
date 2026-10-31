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
import {
  amAt,
  rulesForTrunk,
  targetMatches,
  type RateVersion,
  type RuleSet,
  type World,
} from "../src/generator/world.js";

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

  test("dial-code prefixes start with the country dial code and are unique per profile", () => {
    const rows = readCsv(dirA, "dial_codes");
    // The extra Master Table profiles (masterData.ts) reuse prefixes of "All" by design.
    for (const profile of new Set(rows.map((r) => r.profile))) {
      const own = rows.filter((r) => r.profile === profile);
      assert.equal(new Set(own.map((r) => r.prefix)).size, own.length, profile);
    }
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

  test("a live customer trunk is priced by a live rate table (QA 2026-10-31, §5.4, §13.29)", async () => {
    // A table made for an archived trunk is archived with it; it must not be shared with a live trunk. Enough
    // enterprises for archived trunks to own tables (the shared world above has too few).
    const dir = mkdtempSync(join(tmpdir(), "gen-live-"));
    try {
      const sink = new TableSink(dir);
      await generateWorld({ seed: "test", profile: { ...profile, enterprises: 120 }, anchor: ANCHOR, sink });
      await sink.close();
      const archived = new Set(
        readCsv(dir, "rate_tables")
          .filter((r) => r.deleted_at !== "")
          .map((r) => r.id),
      );
      assert.ok(archived.size > 0, "some tables are archived");
      const byTrunk = new Map<string, string[]>();
      for (const r of readCsv(dir, "customer_trunk_rate_tables"))
        byTrunk.set(r.customer_trunk_id!, [...(byTrunk.get(r.customer_trunk_id!) ?? []), r.rate_table_id!]);
      for (const t of readCsv(dir, "customer_trunks")) {
        const tables = byTrunk.get(t.id!) ?? [];
        if (t.deleted_at !== "" || !tables.length) continue;
        assert.ok(
          tables.some((id) => !archived.has(id)),
          `live trunk ${t.name} has only archived tables ${tables}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every vendor trunk has exactly one vendor table", () => {
    for (const v of world.vendorTrunks) assert.equal(world.rateTableById.get(v.rateTableId)?.vendorTrunkId, v.id);
  });

  test("most vendors take any destination TON / NPI; some trunks fix TON / NPI automatically (§5.5, S-4.7)", () => {
    const vendors = readCsv(dirA, "vendor_trunks");
    const anyDst = vendors.filter((v) => v.allowed_dst_ton === "" && v.allowed_dst_npi === "").length;
    const onlyIntl = vendors.filter((v) => v.allowed_dst_ton === "{1}" && v.allowed_dst_npi === "{1}").length;
    assert.equal(anyDst + onlyIntl, vendors.length);
    assert.ok(anyDst > vendors.length * 0.8, `${anyDst} of ${vendors.length} take any destination TON / NPI`);
    assert.ok(onlyIntl > 0, "a few still take international numbers only");
    for (const table of ["vendor_trunks", "customer_trunks"]) {
      const modes = readCsv(dirA, table).map((t) => t.ton_npi_mode);
      assert.ok(
        modes.every((m) => m === "as_sent" || m === "auto"),
        table,
      );
      const auto = modes.filter((m) => m === "auto").length;
      assert.ok(auto > 0 && auto < modes.length / 2, `${table}: ${auto} of ${modes.length} on auto`);
    }
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

describe("rule targets and per-trunk order (spec §13.2, option A)", () => {
  test("rules target trunks, enterprises, categories and all trunks", () => {
    const types = new Set(world.translationRules.targets.map((t) => t.type));
    for (const type of ["trunk", "enterprise", "category", "all"]) assert.ok(types.has(type as never), type);
  });

  test("a trunk added later inherits enterprise and category rules", () => {
    const set = world.translationRules;
    for (const type of ["enterprise", "category"] as const) {
      const t = set.targets.find((x) => x.type === type && set.activeRuleIds.has(x.ruleId))!;
      const newTrunk = {
        id: 9_999_999,
        enterpriseId: type === "enterprise" ? t.targetId! : -1,
        categoryId: type === "category" ? t.targetId! : -1,
      };
      assert.ok(rulesForTrunk(set, t.trunkKind, newTrunk).includes(t.ruleId), type);
    }
  });

  test("a rule switched off for one trunk does not run there", () => {
    const set = world.translationRules;
    const [key] = [...set.settings].find(([, s]) => !s.enabled)!;
    const [kind, trunkId, ruleId] = key.split(":") as ["customer" | "vendor", string, string];
    const trunk = (kind === "customer" ? world.customerTrunks : world.vendorTrunks).find(
      (t) => t.id === Number(trunkId),
    )!;
    assert.ok(set.targets.some((t) => t.ruleId === Number(ruleId) && targetMatches(t, kind, trunk)));
    assert.ok(!rulesForTrunk(set, kind, trunk).includes(Number(ruleId)));
  });

  test("order: unpositioned top rules, then positioned, then the rest; off and inactive rules skipped", () => {
    const set: RuleSet = {
      activeRuleIds: new Set([1, 2, 3, 4, 6]),
      targets: [
        { ruleId: 1, type: "enterprise", trunkKind: "customer", targetId: 7, insertAt: "bottom" },
        { ruleId: 2, type: "trunk", trunkKind: "customer", targetId: 5, insertAt: "bottom" },
        { ruleId: 3, type: "all", trunkKind: "customer", targetId: null, insertAt: "top" },
        { ruleId: 4, type: "category", trunkKind: "customer", targetId: 9, insertAt: "bottom" },
        { ruleId: 5, type: "all", trunkKind: "customer", targetId: null, insertAt: "bottom" },
        { ruleId: 6, type: "all", trunkKind: "vendor", targetId: null, insertAt: "bottom" },
      ],
      settings: new Map([
        ["customer:5:2", { position: 1, enabled: true }],
        ["customer:5:4", { position: null, enabled: false }],
      ]),
    };
    assert.deepEqual(rulesForTrunk(set, "customer", { id: 5, enterpriseId: 7, categoryId: 9 }), [3, 2, 1]);
    assert.deepEqual(rulesForTrunk(set, "vendor", { id: 5, enterpriseId: 7, categoryId: 9 }), [6]);
  });

  test("each trunk's rule list is computed from targets and settings", () => {
    for (const t of world.customerTrunks) {
      assert.deepEqual(t.translationRuleIds, rulesForTrunk(world.translationRules, "customer", t));
      assert.deepEqual(
        t.hlrRules.map((r) => r.ruleId),
        rulesForTrunk(world.hlrRules, "customer", t),
      );
    }
    for (const t of world.vendorTrunks)
      assert.deepEqual(t.translationRuleIds, rulesForTrunk(world.translationRules, "vendor", t));
  });
});

describe("EDRs (spec §9.1, §13.29, §13.30)", () => {
  test("HLR provider comes from the trunk's first rule matching the number", () => {
    let withHlr = 0;
    for (const r of edrs.slice(0, 5000)) {
      const trunk = world.customerTrunkById.get(Number(cell(r, "c_trunk_id")))!;
      const first = trunk.hlrRules.find((h) => cell(r, "dst_addr").startsWith(h.dnidPrefix));
      assert.equal(Number(cell(r, "hlr_provider_id")), first?.providerId ?? 0);
      if (first) withHlr++;
    }
    assert.ok(withHlr > 0);
  });

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

  test("the attempt that re-sends after a failed receipt is the DLR re-route, as the switch writes it (S-5.11)", () => {
    // Attempts of one message share the customer's message ID and follow each other by attempt number.
    const byMsg = new Map<string, string[][]>();
    for (const r of edrs) byMsg.set(cell(r, "c_message_id"), [...(byMsg.get(cell(r, "c_message_id")) ?? []), r]);
    let reroutes = 0;
    for (const rows of byMsg.values()) {
      rows.sort((a, b) => Number(cell(a, "attempt_no")) - Number(cell(b, "attempt_no")));
      for (const [i, r] of rows.entries()) {
        if (cell(r, "dlr_reroute") !== "1") continue;
        reroutes++;
        const before = rows[i - 1];
        assert.ok(before, "never the first attempt");
        assert.equal(cell(before, "is_submit_success"), "1", "the attempt before was taken by its vendor");
        assert.notEqual(cell(before, "msg_status"), "DELIVRD", "and got a failed receipt");
      }
    }
    assert.ok(reroutes > 0, "some messages are re-routed on a failed receipt");
  });

  test("look realistic: most messages deliver, some are re-routed", () => {
    const final = edrs.filter((r) => cell(r, "is_final_attempt") === "1");
    const delivered = final.filter((r) => cell(r, "msg_status") === "DELIVRD").length / final.length;
    assert.ok(delivered > 0.5 && delivered < 0.97, String(delivered));
    assert.ok(edrs.some((r) => cell(r, "attempt_no") === "2"));
    assert.ok(edrs.some((r) => cell(r, "route_decided_by") === "lcr"));
  });
});
