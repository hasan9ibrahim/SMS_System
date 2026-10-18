// Rate Lookup side by side (team trial round 1): URL state, request filters, rows on screen, ranges.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LookupSideOptions, LookupSideRow } from "@sms/contract";
import { decodeSide, emptySide, encodeSide, flatten, optionItems, range, sideFilters } from "./sideModel";
import { applyToShown, matcher } from "../../ui/CheckList";

test("side state round-trips through the URL; an empty side writes nothing", () => {
  assert.equal(encodeSide(emptySide()), null);
  const s = { ...emptySide(), mccs: ["505"], search: "Telstra é", sort: "minSys" as const };
  assert.deepEqual(decodeSide(encodeSide(s)), s);
  assert.deepEqual(decodeSide("not-base64!"), emptySide());
});

test("chosen codes win over countries; empty lists mean all", () => {
  const s = { ...emptySide(), mccs: ["505"], mccmncs: ["50501"], categoryIds: [1] };
  assert.deepEqual(sideFilters("vendor", s), { side: "vendor", categoryIds: [1], mccmncs: ["50501"] });
  assert.deepEqual(sideFilters("customer", { ...s, mccmncs: [] }), {
    side: "customer",
    categoryIds: [1],
    mccs: ["505"],
  });
});

test("codes follow the chosen countries", () => {
  const o: LookupSideOptions = {
    side: "vendor",
    categories: [],
    trunks: [],
    countries: [
      { mcc: "505", name: "Australia", iso: "AU", tables: 3 },
      { mcc: "234", name: "United Kingdom", iso: "GB", tables: 0 },
    ],
    codes: [
      { mccmnc: "50501", mcc: "505", network: "Telstra", allNetworks: false, tables: 3 },
      { mccmnc: "23410", mcc: "234", network: "O2", allNetworks: false, tables: 0 },
    ],
  };
  const all = optionItems(o, emptySide());
  assert.equal(all.codes.length, 2);
  assert.equal(all.codes[0]!.label, "Australia · Telstra");
  assert.equal(all.countries[1]!.muted, true);
  const au = optionItems(o, { ...emptySide(), mccs: ["505"] });
  assert.deepEqual(
    au.codes.map((c) => c.label),
    ["Telstra"],
  );
});

test("open destinations show their tables, cheapest marked", () => {
  const row = { mccmnc: "50501" } as LookupSideRow;
  const line = { rateTableId: 1 } as never;
  const rows = flatten(
    [row, { mccmnc: "50502" } as LookupSideRow],
    new Set(["50501"]),
    new Map([["50501", [line, line]]]),
  );
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["dest", "line", "line", "dest"],
  );
  assert.equal(rows[1]!.kind === "line" && rows[1]!.best, true);
  assert.equal(flatten([row], new Set(["50501"]), new Map())[1]!.kind, "note");
});

test("check all acts on the shown items only; search takes wildcards", () => {
  assert.deepEqual(applyToShown(["a"], ["b", "c"], true), ["a", "b", "c"]);
  assert.deepEqual(applyToShown(["a", "b"], ["b"], false), ["a"]);
  assert.equal(matcher("aus tel")("Australia · Telstra"), true);
  assert.equal(matcher("505%")("50501"), true);
  assert.equal(matcher("505%")("23410"), false);
  assert.equal(range(0.01, 0.02), "0.0100 – 0.0200");
  assert.equal(range(null, null), "mixed currencies");
});
