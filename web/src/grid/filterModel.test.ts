// Column filter shorthand, filter tree and URL state (§13.25, §15.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FieldDescriptor } from "@sms/contract";
import type { GridState } from "./filterModel";
import {
  buildFilter,
  conditionLabel,
  decodeState,
  emptyState,
  encodeState,
  formatColumnFilter,
  nextSort,
  isFiltered,
  parseColumnFilter,
  switchOf,
  toListQuery,
  withSwitch,
} from "./filterModel";

const TEXT = ["like", "not_like", "eq", "neq", "in", "not_in", "empty", "not_empty", "regex"] as const;
const NUM = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "empty", "not_empty"] as const;
const name: FieldDescriptor = {
  field: "name",
  label: "Rule",
  type: "text",
  operators: [...TEXT],
  sortable: true,
  hidden: false,
  defaultOperator: "like",
};
const dest: FieldDescriptor = {
  field: "dest",
  label: "Destination",
  type: "mccmnc",
  operators: [...TEXT],
  sortable: true,
  hidden: false,
};
const margin: FieldDescriptor = {
  field: "margin",
  label: "Margin",
  type: "money",
  operators: [...NUM],
  sortable: true,
  hidden: false,
};
const at: FieldDescriptor = {
  field: "at",
  label: "Time",
  type: "datetime",
  operators: ["between", "gt", "gte", "lt", "lte", "empty", "not_empty"],
  sortable: true,
  hidden: false,
};
const type: FieldDescriptor = {
  field: "type",
  label: "Type",
  type: "enum",
  operators: ["in", "not_in", "eq", "neq"],
  sortable: true,
  hidden: false,
  enumValues: [
    { value: "customer", label: "Customer" },
    { value: "vendor", label: "Vendor" },
  ],
};

test("text: plain text and wildcards start with, %x anywhere, = equals, ! excludes, /re/ regex", () => {
  assert.deepEqual(parseColumnFilter(name, "au"), { field: "name", op: "like", value: "au%" });
  assert.deepEqual(parseColumnFilter(name, "%au"), { field: "name", op: "like", value: "%au%" });
  assert.deepEqual(parseColumnFilter(name, "re%"), { field: "name", op: "like", value: "re%" });
  // Wildcards match the start of a value too: a part of a name with `_` in it (functional QA round 13).
  assert.deepEqual(parseColumnFilter(name, "a_c"), { field: "name", op: "like", value: "a_c%" });
  assert.deepEqual(parseColumnFilter(name, "PK_Tel"), { field: "name", op: "like", value: "PK_Tel%" });
  assert.deepEqual(parseColumnFilter(name, "%a_c"), { field: "name", op: "like", value: "%a_c%" });
  assert.deepEqual(parseColumnFilter(name, "tel%com"), { field: "name", op: "like", value: "tel%com%" });
  assert.deepEqual(parseColumnFilter(name, "%tel%com%"), { field: "name", op: "like", value: "%tel%com%" });
  assert.deepEqual(parseColumnFilter(name, "!a_c"), { field: "name", op: "not_like", value: "a_c%" });
  assert.deepEqual(parseColumnFilter(name, "=ACME"), { field: "name", op: "eq", value: "ACME" });
  assert.deepEqual(parseColumnFilter(name, "!test"), { field: "name", op: "not_like", value: "test%" });
  assert.deepEqual(parseColumnFilter(name, "/^ab/"), { field: "name", op: "regex", value: "^ab" });
  assert.ok(parseColumnFilter(name, "/(/") instanceof Error);
  assert.deepEqual(parseColumnFilter(name, "empty"), { field: "name", op: "empty" });
  assert.equal(parseColumnFilter(name, "   "), null);
});

test("matchAnywhere text: plain text and `_` patterns anywhere, `%` patterns as typed", () => {
  const rule: FieldDescriptor = { ...name, matchAnywhere: true };
  assert.deepEqual(parseColumnFilter(rule, "OTP"), { field: "name", op: "like", value: "%OTP%" });
  assert.deepEqual(parseColumnFilter(rule, "VN_04"), { field: "name", op: "like", value: "%VN_04%" });
  assert.deepEqual(parseColumnFilter(rule, "BLOCK%"), { field: "name", op: "like", value: "BLOCK%" });
  for (const input of ["OTP", "%VN_04%", "BLOCK%"]) {
    const c = parseColumnFilter(rule, input);
    assert.ok(c && !(c instanceof Error));
    assert.equal(formatColumnFilter(rule, c), input, input);
  }
});

test("prefix and destination fields mean starts with", () => {
  assert.deepEqual(parseColumnFilter(dest, "505"), { field: "dest", op: "like", value: "505%" });
});

test("numbers: comparisons, ranges and lists", () => {
  assert.deepEqual(parseColumnFilter(margin, "5"), { field: "margin", op: "eq", value: 5 });
  assert.deepEqual(parseColumnFilter(margin, ">=5"), { field: "margin", op: "gte", value: 5 });
  assert.deepEqual(parseColumnFilter(margin, "≤ 2.5"), { field: "margin", op: "lte", value: 2.5 });
  assert.deepEqual(parseColumnFilter(margin, "<0"), { field: "margin", op: "lt", value: 0 });
  assert.deepEqual(parseColumnFilter(margin, "-3..10"), { field: "margin", op: "between", values: [-3, 10] });
  assert.deepEqual(parseColumnFilter(margin, "1,2,3"), { field: "margin", op: "in", values: [1, 2, 3] });
  assert.deepEqual(parseColumnFilter(margin, "!=4"), { field: "margin", op: "neq", value: 4 });
  assert.ok(parseColumnFilter(margin, "abc") instanceof Error);
  assert.ok(parseColumnFilter(margin, "1..x") instanceof Error);
});

test("dates: ranges, comparisons, and a bare date means the whole day", () => {
  // A date-only upper bound includes that day (round 13 QA: the last day was dropped).
  assert.deepEqual(parseColumnFilter(at, "2026-10-01..2026-10-16"), {
    field: "at",
    op: "between",
    values: ["2026-10-01T00:00:00.000Z", "2026-10-16T23:59:59.999Z"],
  });
  assert.deepEqual(parseColumnFilter(at, "<=2026-10-16"), {
    field: "at",
    op: "lte",
    value: "2026-10-16T23:59:59.999Z",
  });
  assert.deepEqual(parseColumnFilter(at, ">2026-10-16"), {
    field: "at",
    op: "gt",
    value: "2026-10-16T23:59:59.999Z",
  });
  assert.deepEqual(parseColumnFilter(at, "<2026-10-16"), { field: "at", op: "lt", value: "2026-10-16T00:00:00.000Z" });
  // With a time, the time is kept as typed.
  assert.deepEqual(parseColumnFilter(at, "2026-10-01..2026-10-16T12:00:00Z"), {
    field: "at",
    op: "between",
    values: ["2026-10-01T00:00:00.000Z", "2026-10-16T12:00:00.000Z"],
  });
  assert.deepEqual(parseColumnFilter(at, ">=2026-10-01"), {
    field: "at",
    op: "gte",
    value: "2026-10-01T00:00:00.000Z",
  });
  assert.deepEqual(parseColumnFilter(at, "2026-10-16"), {
    field: "at",
    op: "between",
    values: ["2026-10-16T00:00:00.000Z", "2026-10-16T23:59:59.999Z"],
  });
  assert.ok(parseColumnFilter(at, "yesterday") instanceof Error);
});

test("what the box shows round-trips through the parser", () => {
  for (const [f, input] of [
    [name, "au"],
    [name, "=ACME"],
    [name, "!test"],
    [name, "/^ab/"],
    [name, "%re%"],
    [name, "a_c%"],
    [name, "%tel%com%"],
    [dest, "505"],
    [margin, ">=5"],
    [margin, "-3..10"],
    [margin, "1,2,3"],
    [margin, "5"],
    [at, ">=2026-10-01"],
    [at, "2026-10-01..2026-10-16"],
    [at, "<=2026-10-16"],
    [at, ">2026-10-16"],
  ] as const) {
    const c = parseColumnFilter(f, input);
    assert.ok(c && !(c instanceof Error));
    assert.equal(formatColumnFilter(f, c), input, input);
  }
});

test("chips read like the design: 'Rule au', 'Type Customer, Vendor', 'Margin < 0'", () => {
  assert.equal(conditionLabel(name, { field: "name", op: "like", value: "au%" }), "Rule au");
  assert.equal(conditionLabel(name, { field: "name", op: "like", value: "%au%" }), "Rule %au%");
  assert.equal(
    conditionLabel(type, { field: "type", op: "in", values: ["customer", "vendor"] }),
    "Type Customer, Vendor",
  );
  assert.equal(conditionLabel(margin, { field: "margin", op: "lt", value: 0 }), "Margin < 0");
  assert.equal(conditionLabel(margin, { field: "margin", op: "between", values: [1, 2] }), "Margin 1–2");
});

test("column filters and the builder become one AND tree", () => {
  const state = {
    ...emptyState(),
    columns: { name: { field: "name", op: "like" as const, value: "%a%" } },
    builder: {
      logic: "or" as const,
      conditions: [
        { field: "type", op: "eq" as const, value: "vendor" },
        { field: "margin", op: "lt" as const, value: 0 },
      ],
    },
    search: "  x ",
    sort: [{ field: "name", dir: "asc" as const }],
  };
  assert.deepEqual(buildFilter(state), { logic: "and", conditions: [state.columns.name, state.builder] });
  assert.deepEqual(toListQuery(state), { filter: buildFilter(state), search: "x", sort: state.sort });
  assert.deepEqual(toListQuery(emptyState()), {});
  assert.equal(buildFilter({ columns: {}, builder: { logic: "and", conditions: [] } }), undefined);
});

test("header click sorts asc, desc, off; Shift adds a second key", () => {
  assert.deepEqual(nextSort([], "a", false), [{ field: "a", dir: "asc" }]);
  assert.deepEqual(nextSort([{ field: "a", dir: "asc" }], "a", false), [{ field: "a", dir: "desc" }]);
  assert.deepEqual(nextSort([{ field: "a", dir: "desc" }], "a", false), []);
  assert.deepEqual(nextSort([{ field: "a", dir: "asc" }], "b", true), [
    { field: "a", dir: "asc" },
    { field: "b", dir: "asc" },
  ]);
  assert.deepEqual(nextSort([{ field: "a", dir: "asc" }], "b", false), [{ field: "b", dir: "asc" }]);
});

test("grid state survives the URL, including non-ASCII text", () => {
  const state = {
    ...emptyState(),
    columns: { name: { field: "name", op: "like" as const, value: "%Zürich – ü%" } },
    search: "日本",
    sort: [{ field: "name", dir: "desc" as const }],
    visible: ["name", "type"],
    viewId: 7,
  };
  const encoded = encodeState(state);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, "URL-safe");
  assert.deepEqual(decodeState(encoded), state);
  assert.equal(encodeState(emptyState()), "");
  assert.deepEqual(decodeState("%%%garbage"), emptyState());
});

test("pills and header boxes on the same field both apply (team trial round 7)", () => {
  const state: GridState = {
    ...emptyState(),
    pills: { customer: { field: "customer", op: "like", value: "acme%" } },
    columns: { customer: { field: "customer", op: "like", value: "%uk%" } },
  };
  assert.deepEqual(buildFilter(state), {
    logic: "and",
    conditions: [state.pills!.customer, state.columns.customer],
  });
  assert.deepEqual(decodeState(encodeState(state)), state);
});

test("switches, pills and header boxes are three separate filters that all apply (team trial round 10)", () => {
  const kind = { field: "kind", op: "in" as const, values: ["customer"] };
  const box = { field: "kind", op: "in" as const, values: ["vendor", "customer"] };
  const pill = { field: "kind", op: "in" as const, values: ["customer"] };
  let state: GridState = { ...emptyState(), columns: { kind: box }, pills: { kind: pill } };
  state = withSwitch(state, "kind", kind);
  // Setting the switch leaves the header box and the pill alone...
  assert.deepEqual(state.columns, { kind: box });
  assert.deepEqual(state.pills, { kind: pill });
  assert.deepEqual(switchOf(state, "kind"), kind);
  assert.deepEqual(buildFilter(state), { logic: "and", conditions: [kind, pill, box] });
  assert.deepEqual(decodeState(encodeState(state)), state);
  // ...and clearing it does too.
  const cleared = withSwitch(state, "kind", null);
  assert.equal(switchOf(cleared, "kind"), undefined);
  assert.deepEqual(cleared.columns, { kind: box });
  assert.ok(isFiltered(withSwitch(emptyState(), "kind", kind)));
});

test("a tab saved before switches had their own place keeps them as switches", () => {
  // Rate manager kept its switch in the columns under "kindSwitch" (round 7).
  const old = { ...emptyState(), columns: { kindSwitch: { field: "kind", op: "in" as const, values: ["vendor"] } } };
  const g = decodeState(encodeState(old));
  assert.deepEqual(g.columns, {});
  assert.deepEqual(g.switches, { kind: { field: "kind", op: "in", values: ["vendor"] } });
});
