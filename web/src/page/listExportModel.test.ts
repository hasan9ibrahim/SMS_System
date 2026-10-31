// What a list page sends to the one list export (§13.22, §13.25): the columns in view, in order, never filter-only
// fields; the query's filters, search and sort without paging.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FieldDescriptor } from "@sms/contract";
import { exportColumns, exportQuery } from "./listExportModel";

const f = (field: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  field,
  label: field,
  type: "text",
  operators: ["eq"],
  sortable: true,
  hidden: false,
  ...extra,
});
const fields = [f("id"), f("name"), f("archived", { hidden: true, type: "boolean" }), f("q", { filterOnly: true }), f("updatedAt")];

test("the columns: the chosen ones in their order, else every shown column; filter-only fields never", () => {
  assert.deepEqual(exportColumns(fields, null), ["id", "name", "updatedAt"]);
  assert.deepEqual(exportColumns(fields, ["updatedAt", "archived", "id", "q"]), ["updatedAt", "archived", "id"]);
  // A column the list no longer has (an old saved view) is left out.
  assert.deepEqual(exportColumns(fields, ["gone", "name"]), ["name"]);
});

test("the query keeps filters, quick search and sort, and drops paging", () => {
  const filter = { logic: "and" as const, conditions: [{ field: "name", op: "like" as const, value: "Acme%" }] };
  assert.deepEqual(exportQuery({ filter, search: "x", sort: [{ field: "id", dir: "desc" }] }), {
    filter,
    search: "x",
    sort: [{ field: "id", dir: "desc" }],
  });
  assert.deepEqual(exportQuery({ sort: [] }), {});
  const paged = { filter, limit: 100, cursor: "abc", withTotal: true } as Parameters<typeof exportQuery>[0];
  assert.deepEqual(exportQuery(paged), { filter });
});
