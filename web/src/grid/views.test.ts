// Saved views restore the grid exactly (§13.25): column filters go back under their headers,
// everything else into the filter builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SavedView } from "@sms/contract";
import { emptyState, type GridState } from "./filterModel";
import { fromViewState, toViewState } from "./ViewsMenu";

const view = (state: SavedView["state"]): SavedView => ({
  id: 3,
  list: "enterprises",
  name: "v",
  owner: { id: 1, displayName: "x" },
  sharedWithUserIds: [],
  readOnly: false,
  state,
  updatedAt: "2026-10-16T00:00:00Z",
});

test("save then restore gives back the same grid state", () => {
  const state: GridState = {
    ...emptyState(),
    columns: {
      name: { field: "name", op: "like", value: "%or%" },
      type: { field: "type", op: "in", values: ["vendor"] },
    },
    builder: {
      logic: "or",
      conditions: [
        { field: "tier", op: "eq", value: "tier1" },
        { field: "country", op: "not_empty" },
      ],
    },
    search: "acme",
    sort: [{ field: "name", dir: "desc" }],
    visible: ["id", "name"],
  };
  assert.deepEqual(fromViewState(view(toViewState(state))), { ...state, viewId: 3 });
});

test("an OR filter saved elsewhere opens in the builder", () => {
  const restored = fromViewState(
    view({
      filter: {
        logic: "or",
        conditions: [
          { field: "a", op: "eq", value: 1 },
          { field: "b", op: "eq", value: 2 },
        ],
      },
    }),
  );
  assert.deepEqual(restored.columns, {});
  assert.deepEqual(restored.builder, {
    logic: "or",
    conditions: [
      { field: "a", op: "eq", value: 1 },
      { field: "b", op: "eq", value: 2 },
    ],
  });
});

test("a view keeps the page's switches apart from its filters (team trial round 10)", () => {
  const state: GridState = {
    ...emptyState(),
    columns: { kind: { field: "kind", op: "in", values: ["vendor", "customer"] } },
    switches: { kind: { field: "kind", op: "in", values: ["customer"] } },
  };
  const saved = toViewState(state);
  assert.deepEqual(saved.switches, state.switches);
  assert.deepEqual(saved.filter, { logic: "and", conditions: [state.columns.kind] });
  assert.deepEqual(fromViewState(view(saved)), { ...state, viewId: 3 });
});
