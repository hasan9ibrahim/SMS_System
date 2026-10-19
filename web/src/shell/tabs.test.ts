// Tab workspace rules (§13.5): Home stays pinned first, the same page is focused instead of
// duplicated, pinned tabs stay left, closing picks a neighbour, split view follows tabs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HOME_TAB_ID, canGoBack, toWorkspace, useTabs } from "./tabs";

const s = () => useTabs.getState();
const paths = () => s().tabs.map((t) => t.path);

beforeEach(() => {
  useTabs.setState({ back: {} });
  s().hydrate(1, { tabs: [], activeTabId: null });
});

test("opening pages: new tab from Home, focus an open page, keep its filters", () => {
  s().open("/enterprises", { newTab: true });
  s().setPath(s().activeId, "/enterprises?g=abc");
  s().open("/admin/changes", { newTab: true });
  const id = s().open("/enterprises", { newTab: true });
  assert.deepEqual(paths(), ["/", "/enterprises?g=abc", "/admin/changes"]);
  assert.equal(s().activeId, id);
  s().open("/enterprises", { forceNew: true });
  assert.equal(paths().length, 4, "Ctrl-click always opens a new tab");
});

test("navigating in place unless the current tab is pinned", () => {
  s().open("/enterprises", { newTab: true });
  s().open("/admin/changes");
  assert.deepEqual(paths(), ["/", "/admin/changes"]);
  s().activate(HOME_TAB_ID);
  s().open("/dashboard");
  assert.deepEqual(
    paths(),
    ["/", "/dashboard", "/admin/changes"],
    "Home is never replaced; the new tab opens next to it",
  );
});

test("pinned tabs stay left, Home first; moving cannot pass Home", () => {
  const a = s().open("/a", { newTab: true });
  const b = s().open("/b", { newTab: true });
  s().togglePin(b);
  assert.deepEqual(paths(), ["/", "/b", "/a"]);
  s().move(a, 0);
  assert.equal(s().tabs[0]!.id, HOME_TAB_ID);
  s().togglePin(HOME_TAB_ID);
  assert.equal(s().tabs[0]!.pinned, true);
});

test("closing activates a neighbour; Home cannot close; split view resets", async () => {
  const a = s().open("/a", { newTab: true });
  const b = s().open("/b", { newTab: true });
  s().activate(a);
  s().toggleSplit();
  assert.equal(s().splitId, b);
  assert.equal(await s().close(HOME_TAB_ID), false);
  await s().close(b);
  assert.equal(s().splitId, null);
  await s().close(a);
  assert.equal(s().activeId, HOME_TAB_ID);
});

test("detach and dock (pop-out windows)", () => {
  const a = s().open("/a", { newTab: true, title: "A" });
  const tab = s().detach(a)!;
  assert.deepEqual(paths(), ["/"]);
  s().dock({ id: tab.id, path: tab.path, title: tab.title, pinned: false });
  assert.deepEqual(paths(), ["/", "/a"]);
  assert.equal(s().activeId, a);
});

test("the saved workspace leaves Home out and restores in order", () => {
  s().open("/a", { newTab: true, title: "A" });
  const b = s().open("/b", { newTab: true, title: "B" });
  s().togglePin(b);
  const ws = toWorkspace(s());
  assert.deepEqual(
    ws.tabs.map((t) => [t.path, t.pinned]),
    [
      ["/b", true],
      ["/a", false],
    ],
  );
  s().hydrate(1, ws);
  assert.deepEqual(paths(), ["/", "/b", "/a"]);
  assert.equal(s().activeId, b);
});

test("Back: previous page in the tab (filters kept), then the tab it was opened from (trial round 1)", () => {
  const first = s().open("/enterprises", { newTab: true });
  s().setPath(first, "/enterprises?g=abc");
  s().setPath(first, "/enterprises?g=abd");
  s().setPath(first, "/rates");
  const second = s().open("/routing/rules", { newTab: true });
  assert.equal(s().goBack(second), true, "back to the opener tab");
  assert.equal(s().activeId, first);
  assert.equal(s().goBack(first), true);
  assert.equal(s().tabs.find((t) => t.id === first)!.path, "/enterprises?g=abd", "filter changes are not steps");
  assert.equal(canGoBack(s(), first), true, "Home opened it");
  s().close(first);
  assert.equal(canGoBack(s(), second), false, "opener closed");
});

test("split view: each side picks its tab, the strip fills the focused side (team trial round 1)", async () => {
  const s = () => useTabs.getState();
  const a = s().open("/enterprises", { newTab: true });
  const b = s().open("/rates/manager", { newTab: true });
  const c = s().open("/routing/rules", { newTab: true });
  s().activate(a);
  s().setSplit(b);
  const sides = () => (s().splitLeft ? [s().splitId, s().activeId] : [s().activeId, s().splitId]);
  assert.deepEqual(sides(), [a, b]);
  // Focusing the right side keeps both where they are.
  s().activate(b);
  assert.deepEqual(sides(), [a, b]);
  assert.equal(s().activeId, b);
  // A tab clicked in the strip opens on the focused (right) side.
  s().activate(c);
  assert.deepEqual(sides(), [a, c]);
  // Picking for the left side; picking the tab on the other side swaps them.
  s().setPane("left", b);
  assert.deepEqual(sides(), [b, c]);
  s().setPane("left", c);
  assert.deepEqual(sides(), [c, b]);
  s().swapSides();
  assert.deepEqual(sides(), [b, c]);
});
