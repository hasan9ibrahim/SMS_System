// Rating destination tree (team trial round 1): search narrows networks, whole countries become countries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitByCountry, treeRows, type TreeCountry } from "./DestinationTree";

const tree: TreeCountry[] = [
  {
    mcc: "505",
    name: "Australia",
    iso: "AU",
    codes: [
      { mccmnc: "505", network: "All networks", allNetworks: true },
      { mccmnc: "50501", network: "Telstra", allNetworks: false },
      { mccmnc: "50502", network: "Optus", allNetworks: false },
    ],
  },
  { mcc: "234", name: "United Kingdom", iso: "GB", codes: [{ mccmnc: "23410", network: "O2", allNetworks: false }] },
];

test("closed countries show one row; a search opens the matching networks only", () => {
  const all = treeRows(tree, "", new Set());
  assert.equal(all.rows.length, 2);
  assert.equal(all.shown.length, 4, "select all takes every network");
  const opt = treeRows(tree, "optus", new Set());
  assert.deepEqual(
    opt.rows.map((r) => (r.kind === "country" ? r.country.name : r.mccmnc)),
    ["Australia", "50502"],
  );
  assert.deepEqual(opt.shown, ["50502"], "select shown takes only the match");
  const country = treeRows(tree, "austr", new Set(["505"]));
  assert.equal(country.shown.length, 3, "a country match keeps all its networks");
});

test("whole countries go in as countries, the rest as codes", () => {
  assert.deepEqual(splitByCountry(tree, ["505", "50501", "50502", "23410"]), { countries: ["AU", "GB"], mccmncs: [] });
  assert.deepEqual(splitByCountry(tree, ["50501"]), { countries: [], mccmncs: ["50501"] });
});
