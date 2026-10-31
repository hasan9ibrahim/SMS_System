// Column fitting (design QA round 13): a two-line cell is measured by its longer line, and a narrow grid takes the
// room no value needs before it cuts any text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { nodeText, shareWidth } from "./fit";

test("a two-line cell is as wide as its longer line", () => {
  const cell = h(
    "span",
    { className: "two-line" },
    h("strong", null, "06 Nov 2026 – 13 Nov 2026"),
    h("span", { className: "muted small" }, "starts in 6 days"),
  );
  assert.equal(nodeText(cell), "06 Nov 2026 – 13 Nov 2026");
  assert.equal(
    nodeText(h("span", { className: "two-line right" }, h("b", null, "10"), "1,469 msgs in 7 days")),
    "1,469 msgs in 7 days",
  );
  // Inline pieces of one line still join.
  assert.equal(nodeText(h("span", null, "↑ ", h("b", null, "+13.2%"))), "↑ +13.2%");
});

test("short of room: empty space goes first, then text, never figures below their floor", () => {
  const cols = [
    { base: 300, floor: 120, content: 320, atomic: false }, // Destination: its longest name needs all of it
    { base: 330, floor: 150, content: 160, atomic: true }, // Checks: short chips in a wide column
    { base: 180, floor: 180, content: 180, atomic: true }, // a date
  ];
  // 100 px short: all of it from the Checks column's empty room; the text and the date keep theirs.
  assert.deepEqual(shareWidth(710, cols).map(Math.round), [300, 230, 180]);
  // 300 px short: Checks down to its values (170 px off), the other 130 px from the text column.
  assert.deepEqual(shareWidth(510, cols).map(Math.round), [170, 160, 180]);
  // More than the floors allow: every column at its floor, the grid scrolls sideways.
  assert.deepEqual(shareWidth(300, cols).map(Math.round), [120, 160, 180]);
  // Room to spare: nothing changes.
  assert.deepEqual(shareWidth(900, cols), [300, 330, 180]);
});
