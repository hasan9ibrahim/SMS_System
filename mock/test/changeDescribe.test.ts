// Readable change history (§13.10, team trial round 1): names instead of ids, labels, added / removed.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Change } from "@sms/contract";
import { describeChanges, describeField, fieldLabel, type Names } from "../src/history/describe.js";
import { RECORD_TYPE_LABELS } from "../src/lists/fields.js";
import { closeDb, db, dbReady } from "../src/db.js";

const names: Names = new Map([
  ["route_rule", new Map([[7, "NG MTN"]])],
  [
    "vendor_trunk",
    new Map([
      [3, "Kite_DIR"],
      [4, "Orbit_DIR"],
    ]),
  ],
  ["customer_trunk", new Map([[9, "Acme_HQ"]])],
]);

const change = (over: Partial<Change>): Change => ({
  id: 1,
  entityType: "route_rule",
  entityIds: [7],
  changeType: "edit",
  diff: [],
  note: null,
  userId: 1,
  userName: "Test User",
  ip: null,
  at: "2026-10-18T00:00:00Z",
  undoOfId: null,
  undoneById: null,
  ...over,
});

test("field labels read as words", () => {
  assert.equal(fieldLabel("routeType"), "Route type");
  assert.equal(fieldLabel("customerTrunkIds"), "Customer trunks");
  assert.equal(fieldLabel("vendorTrunkId"), "Vendor trunk");
  assert.equal(fieldLabel("mccmncs"), "MCCMNCs");
});

test("ids show as names; list fields say what was added and removed", () => {
  const f = describeField("customerTrunkIds", [9], [9, 12], names);
  assert.equal(f.beforeText, "Acme_HQ");
  assert.deepEqual([f.added, f.removed], [["#12"], []]);
  const v = describeField(
    "vendors",
    [{ level: 1, vendorTrunkId: 3, sharePct: 60, isBackup: false }],
    [{ level: 1, vendorTrunkId: 4, sharePct: 40, isBackup: true, backupForVendorTrunkId: 3 }],
    names,
  );
  assert.deepEqual(v.removed, ["Kite_DIR (level 1, 60 %)"]);
  assert.deepEqual(v.added, ["Orbit_DIR (level 1, 40 %, backup of Kite_DIR)"]);
});

test("the summary names the record and the fields changed", () => {
  const [c] = describeChanges(
    [change({ diff: [{ entityId: 7, field: "routeType", before: "static", after: "block" }] })],
    names,
  );
  assert.deepEqual(c!.entityNames, ["NG MTN"]);
  assert.equal(c!.summary, "Edited route rule “NG MTN”: Route type static → block");
  assert.equal(c!.diff[0]!.label, "Route type");
  const [gone] = describeChanges(
    [
      change({
        entityIds: [99],
        changeType: "create",
        diff: [{ entityId: 99, field: "*", before: null, after: "Old rule" }],
      }),
    ],
    names,
  );
  assert.equal(gone!.summary, "Created route rule “Old rule”", "a created record's name comes from its diff");
  const [bulk] = describeChanges(
    [change({ entityType: "visibility_policy", entityIds: [1, 2], changeType: "delete", diff: [] })],
    names,
  );
  assert.equal(bulk!.summary, "Deleted 2 visibility policies");
});

test("record types read as labels in the summary (team trial round 1)", () => {
  const [c] = describeChanges(
    [
      change({
        entityType: "destination",
        entityIds: [5],
        diff: [{ entityId: 5, field: "dlrTargetPct", before: 1, after: 2 }],
      }),
    ],
    names,
  );
  assert.equal(c!.summary, "Edited MCCMNC code #5: DLR target % 1 → 2");
  const [r] = describeChanges([change({ entityType: "recon_rule", entityIds: [1, 2], changeType: "delete" })], names);
  assert.equal(r!.summary, "Deleted 2 reconciliation rules");
});

const ready = await dbReady();
after(() => closeDb());

test("every record type in the change history has a label", { skip: ready ? false : "no database" }, async () => {
  const { rows } = await db().query<{ t: string }>("SELECT DISTINCT entity_type AS t FROM changes");
  const missing = rows.map((r) => r.t).filter((t) => !RECORD_TYPE_LABELS[t]);
  assert.deepEqual(missing, [], "add a label to RECORD_TYPE_LABELS in src/lists/fields.ts");
});
