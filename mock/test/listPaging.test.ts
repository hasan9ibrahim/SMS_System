// Paging while rows arrive (QA 2026-10-31, §13.25): an offset repeated rows (or skipped them) once new ones sorted
// before it. EDR lists page by the last row's sort values; lists that grow (audit log, incidents) leave out rows added
// after the first page. EDRs use an enterprise ID and a day no other test reads, and are removed after (with their
// long-term totals), as are the audit rows.
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { EdrRow, ListQuery } from "@sms/contract";
import { closeDb, db, dbReady } from "../src/db.js";
import { chQuery, chRows } from "../src/edr.js";
import { runChList } from "../src/lists/chEngine.js";
import { edrList } from "../src/lists/edrDefs.js";
import { runList, type ListDef, type ListPage } from "../src/lists/engine.js";
import { listDefs } from "../src/lists/defs.js";
import { deleteTestEdrs } from "./testEdrs.js";

const ready = await dbReady();
const edrStore = ready && (await chRows<{ n: string }>("SELECT count() FROM edr LIMIT 1")) !== null;
const skip = ready && edrStore ? false : "seeded database and EDR store not available";

const ent = 5_000_000 + Math.floor(Math.random() * 900_000);
const day = "2025-02-10";
type ListSort = NonNullable<ListQuery["sort"]>[number];

const auditTag = `qa-paging-${process.pid}`;
after(async () => {
  if (edrStore) await deleteTestEdrs(`c_enterprise_id = ${ent}`);
  if (ready) await db().query("DELETE FROM audit_log WHERE controller = $1", [auditTag]);
  await closeDb();
});

/** n EDRs a second apart from `from` (seconds after 10:00), every third without a submit response time. */
async function insert(from: number, n: number) {
  const rows = Array.from({ length: n }, (_, i) => {
    const s = from + i;
    const t = `${day} 10:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    const resp = s % 3 === 0 ? "NULL" : `'${t}'`;
    return `('${randomUUID()}', '${t}', '${t}', ${resp}, ${ent}, ${900 + (s % 4)}, '2060${s % 5}')`;
  });
  await chQuery(
    `INSERT INTO edr (edr_id, start_time, submit_time, submit_resp_time, c_enterprise_id, c_trunk_id, c_mccmnc)
     VALUES ${rows.join(", ")}`,
  );
}

const query = (sort: ListSort[], cursor?: string | null): ListQuery => ({
  filter: {
    logic: "and",
    conditions: [
      { field: "startTime", op: "between", values: [`${day}T00:00:00Z`, `${day}T23:59:59Z`] },
      { field: "customerEnterpriseId", op: "eq", value: ent },
    ],
  },
  sort,
  limit: 7,
  cursor: cursor ?? null,
  withTotal: false,
});

describe("EDR lists page by keys (§13.25)", { skip }, () => {
  test("setup", async () => {
    await insert(0, 30);
  });

  for (const sort of [
    [{ field: "startTime", dir: "desc" }],
    [{ field: "submitRespTime", dir: "asc" }],
    [{ field: "submitRespTime", dir: "desc" }],
    [
      { field: "customerMccmnc", dir: "asc" },
      { field: "startTime", dir: "desc" },
    ],
    [
      { field: "customerTrunk", dir: "desc" },
      { field: "submitRespTime", dir: "asc" },
    ],
  ] as ListSort[][]) {
    test(`new EDRs while paging neither repeat nor push rows off (${sort.map((s) => `${s.field} ${s.dir}`).join(", ")})`, async () => {
      const before = (await runChList(db(), edrList, { ...query(sort), limit: 1000 })).rows.map((r) => r.id);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const p: ListPage<EdrRow> = await runChList(db(), edrList, query(sort, cursor));
        seen.push(...p.rows.map((r) => r.id));
        // Later EDRs of the same day, sorting anywhere, arrive after the first page.
        if (page === 0) await insert(100 + sort.length * 10, 5);
        cursor = p.nextCursor;
        if (!cursor) break;
      }
      assert.equal(new Set(seen).size, seen.length, "no row twice");
      for (const id of before) assert.ok(seen.includes(id), `row ${id} of the first page's result is on a page`);
      const order = (await runChList(db(), edrList, { ...query(sort), limit: 1000 })).rows.map((r) => r.id);
      assert.deepEqual(
        seen,
        order.filter((id) => seen.includes(id)),
        "pages keep the sort order",
      );
    });
  }
});

describe("lists that grow keep their pages in place (§13.25)", { skip: ready ? false : "seeded database not available" }, () => {
  test("audit rows written after the first page are left out of the next ones", async () => {
    const audit = (n: number) =>
      db().query(
        `INSERT INTO audit_log (module, controller, method, action, status)
         SELECT 'qa', $1, 'POST', 'paging', 200 FROM generate_series(1, $2::int)`,
        [auditTag, n],
      );
    await audit(12);
    const def = listDefs.audit_log as ListDef<unknown>;
    const q = (cursor: string | null) => ({
      filter: { logic: "and" as const, conditions: [{ field: "controller", op: "eq" as const, value: auditTag }] },
      limit: 5,
      cursor,
      withTotal: false,
    });
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const p: ListPage<unknown> = await runList(db(), def, q(cursor), null);
      seen.push(...p.rows.map((r) => Number((r as { id: number }).id)));
      if (page === 0) await audit(3);
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 12, "the 12 rows there when the first page was read");
    assert.equal(new Set(seen).size, 12, "no row twice");
    const fresh = await runList(db(), def, { ...q(null), limit: 100 }, null);
    assert.equal(fresh.rows.length, 15, "a new first page has them all");
  });
});
