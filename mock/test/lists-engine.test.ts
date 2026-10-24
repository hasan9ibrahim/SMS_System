// List engine (§13.25): the filter tree becomes parameterised SQL; values never end up in
// the SQL text. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ListQuery } from "@sms/contract";
import {
  checkDef,
  compileQuery,
  decodeCursor,
  encodeCursor,
  searchPattern,
  type ListDef,
} from "../src/lists/engine.js";
import { billingReportList, listDefs } from "../src/lists/defs.js";
import { checkChDef, type ChListDef } from "../src/lists/chEngine.js";
import { edrList, failedEdrList } from "../src/lists/edrDefs.js";
import { listFields } from "../src/lists/fields.js";
import { messageList, rateList } from "../src/api/portal.js";

const def = listDefs.enterprises as ListDef<unknown>;
const q = (query: Partial<ListQuery>) => compileQuery(def, query as ListQuery);

test("every list field has SQL and every list has a definition", () => {
  for (const [name, d] of Object.entries(listDefs)) assert.deepEqual(checkDef(name, d), []);
  // The Enterprise report and the EDR lists are answered from the EDR store (enterpriseReport.ts, edrDefs.ts).
  assert.deepEqual(checkChDef("edrs", edrList as ChListDef<unknown>), []);
  assert.deepEqual(checkChDef("failed_edrs", failedEdrList as ChListDef<unknown>), []);
  assert.deepEqual(checkDef("billing_report", billingReportList as ListDef<unknown>), []);
  // Customer portal lists (§1) are built per signed-in enterprise (api/portal.ts).
  assert.deepEqual(checkDef("portal_rates", rateList(1) as ListDef<unknown>), []);
  assert.deepEqual(checkChDef("portal_messages", messageList(1) as ChListDef<unknown>), []);
  assert.deepEqual(
    Object.keys(listDefs).sort(),
    Object.keys(listFields)
      .filter(
        (l) =>
          ![
            "enterprise_report",
            "edrs",
            "failed_edrs",
            "master_report",
            "billing_report",
            "portal_rates",
            "portal_messages",
          ].includes(l),
      )
      .sort(),
  );
});

test("operators compile to case-insensitive, parameterised SQL", () => {
  const { sql, values } = q({
    filter: {
      logic: "and",
      conditions: [
        { field: "name", op: "like", value: "acme%" },
        { field: "alias", op: "eq", value: "ACME" },
        { field: "type", op: "in", values: ["Customer", "vendor"] },
        { field: "id", op: "between", values: [10, 20] },
        { field: "updatedAt", op: "gte", value: "2026-01-01T00:00:00Z" },
        { field: "country", op: "empty" },
        { field: "name", op: "regex", value: "^a.*'; DROP TABLE x; --" },
      ],
    },
  });
  assert.match(sql, /\(e\.name\)::text ILIKE \$1/);
  assert.match(sql, /lower\(\(e\.alias\)::text\) = \$2/);
  assert.match(sql, /lower\(\(e\.type\)::text\) = ANY\(\$3::text\[\]\)/);
  assert.match(sql, /e\.id BETWEEN \$4::bigint AND \$5::bigint/);
  assert.match(sql, /e\.updated_at >= \$6::timestamptz/);
  assert.match(sql, /\(co\.iso IS NULL OR \(co\.iso\)::text = ''\)/);
  assert.match(sql, /\(e\.name\)::text ~\* \$7/);
  assert.ok(!sql.includes("DROP TABLE"), "values are parameters, not SQL");
  assert.deepEqual(values.slice(0, 7), [
    "acme%",
    "acme",
    ["customer", "vendor"],
    10,
    20,
    "2026-01-01T00:00:00Z",
    "^a.*'; DROP TABLE x; --",
  ]);
});

test("AND/OR groups nest and archived records stay hidden", () => {
  const { sql } = q({
    filter: {
      logic: "and",
      conditions: [
        { field: "status", op: "eq", value: "active" },
        {
          logic: "or",
          conditions: [
            { field: "tier", op: "eq", value: "tier1" },
            { field: "id", op: "lt", value: 5 },
          ],
        },
      ],
    },
  });
  assert.match(
    sql,
    /WHERE e\.deleted_at IS NULL AND \(lower\(\(e\.status\)::text\) = \$1 AND \(lower\(\(e\.tier\)::text\) = \$2 OR e\.id < \$3::bigint\)\)/,
  );
});

test("negative operators keep rows with empty values", () => {
  const { sql } = q({ filter: { logic: "and", conditions: [{ field: "country", op: "neq", value: "DE" }] } });
  assert.match(sql, /\(co\.iso IS NULL OR lower\(\(co\.iso\)::text\) <> \$1\)/);
});

test("quick search: plain text means contains, wildcards are used as typed", () => {
  assert.equal(searchPattern("orbit"), "%orbit%");
  assert.equal(searchPattern("orb%"), "orb%");
  assert.equal(searchPattern("o_bit"), "o_bit");
  // Lists of named records match the start (team trial round 3); a neutral ID anywhere.
  assert.equal(searchPattern("orbit", true), "orbit%");
  assert.equal(searchPattern("%orbit", true), "%orbit");
  assert.equal(searchPattern("#12", true), "%#12%");
  const { sql, values } = q({ search: "orbit" });
  assert.match(sql, /\(e\.name\)::text ILIKE \$1 OR \(e\.alias\)::text ILIKE \$1/);
  assert.equal(values[0], "orbit%", "enterprises match the start of a name");
});

test("sort uses the default, puts nulls last and ends with the ID tie-breaker", () => {
  assert.match(q({}).sql, /ORDER BY e\.name ASC NULLS LAST, e\.id ASC/);
  assert.match(
    q({
      sort: [
        { field: "updatedAt", dir: "desc" },
        { field: "name", dir: "asc" },
      ],
    }).sql,
    /ORDER BY e\.updated_at DESC NULLS LAST, e\.name ASC NULLS LAST, e\.id DESC/,
  );
});

test("cursor paging fetches one extra row to know if there is a next page", () => {
  const first = q({ limit: 50 });
  assert.deepEqual(first.values.slice(-2), [51, 0]);
  const next = q({ limit: 50, cursor: encodeCursor(50) });
  assert.deepEqual(next.values.slice(-2), [51, 50]);
  assert.equal(decodeCursor("not-a-cursor"), 0);
});

test("change history matches a record inside bulk changes", () => {
  const { sql, values } = compileQuery(
    listDefs.changes as ListDef<unknown>,
    {
      filter: {
        logic: "and",
        conditions: [
          { field: "entityId", op: "eq", value: 42 },
          { field: "entityType", op: "eq", value: "route_rule" },
        ],
      },
    } as ListQuery,
  );
  assert.match(sql, /\$1::bigint = ANY\(c\.entity_ids\)/);
  assert.equal(values[0], 42);
});
