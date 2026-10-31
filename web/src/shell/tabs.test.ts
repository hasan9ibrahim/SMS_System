// Tab workspace rules (§13.5): Home stays pinned first, the same page is focused instead of
// duplicated, pinned tabs stay left, closing picks a neighbour, split view follows tabs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HOME_TAB_ID, canGoBack, parentPath, toWorkspace, useTabs } from "./tabs";

const s = () => useTabs.getState();
const paths = () => s().tabs.map((t) => t.path);

beforeEach(() => {
  useTabs.setState({ back: {} });
  s().hydrate(1, { tabs: [], activeTabId: null });
  // Start from Home alone (signing in also opens the Dashboard; tested below).
  useTabs.setState({ tabs: [s().tabs[0]!], activeId: HOME_TAB_ID, splitId: null });
});

test("signing in opens the Dashboard; Home stays the pinned first tab (team trial round 3)", () => {
  s().hydrate(1, { tabs: [], activeTabId: null });
  assert.deepEqual(paths(), ["/", "/dashboard"]);
  assert.equal(s().tabs.find((t) => t.id === s().activeId)!.path, "/dashboard");
  const saved = s().open("/enterprises", { newTab: true });
  const ws = toWorkspace(s());
  s().hydrate(1, { ...ws, activeTabId: saved });
  assert.deepEqual(paths(), ["/", "/dashboard", "/enterprises"], "a saved Dashboard tab is reused, not doubled");
  assert.equal(s().tabs.find((t) => t.id === s().activeId)!.path, "/dashboard");
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
  assert.deepEqual(paths(), ["/", "/b", "/dashboard", "/a"], "the Dashboard opens after the pinned tabs");
  assert.equal(s().tabs.find((t) => t.id === s().activeId)!.path, "/dashboard");
});

test("Back: previous page and section in the tab (filters kept); never another tab (team trial round 12)", () => {
  const first = s().open("/enterprises", { newTab: true });
  s().setPath(first, "/enterprises?g=abc");
  s().setPath(first, "/enterprises?g=abd");
  s().setPath(first, "/enterprises/12");
  s().setPath(first, "/enterprises/12?tab=billing");
  assert.equal(s().goBack(first), true);
  assert.equal(s().tabs.find((t) => t.id === first)!.path, "/enterprises/12", "a section is a step");
  assert.equal(s().goBack(first), true);
  assert.equal(s().tabs.find((t) => t.id === first)!.path, "/enterprises?g=abd", "filter changes are not steps");
  assert.equal(canGoBack(s(), first), false, "nothing before the list: Back does not jump to another tab");
  // A record opened in its own tab goes back to its list, in that tab.
  const second = s().open("/enterprises/customer-trunks/7", { forceNew: true });
  assert.equal(canGoBack(s(), second), true);
  assert.equal(s().goBack(second), true);
  assert.equal(s().activeId, second);
  assert.equal(s().tabs.find((t) => t.id === second)!.path, "/enterprises/customer-trunks");
});

test("Back from a record a list opens in place (?list=12) returns to the list (team trial round 13)", () => {
  const tab = s().open("/switch/number-lists", { newTab: true });
  s().setPath(tab, "/switch/number-lists?q=fake");
  s().setPath(tab, "/switch/number-lists?list=12", { step: true });
  assert.equal(canGoBack(s(), tab), true);
  assert.equal(s().goBack(tab), true);
  assert.equal(s().tabs.find((t) => t.id === tab)!.path, "/switch/number-lists?q=fake", "the list with its filters");
  // Opened straight into its own tab: Back goes up to the list, in that tab.
  const own = s().open("/switch/number-lists?list=7", { forceNew: true });
  assert.equal(s().goBack(own), true);
  assert.equal(s().tabs.find((t) => t.id === own)!.path, "/switch/number-lists");
  assert.equal(parentPath("/rates/manager?table=5&view=log&kind=customer"), "/rates/manager?kind=customer");
  assert.equal(parentPath("/rates/incoming?rn=3"), "/rates/incoming");
  assert.equal(parentPath("/switch/hlr?view=providers&provider=2"), "/switch/hlr?view=providers");
  assert.equal(parentPath("/switch/number-lists?q=fake"), null, "a list with filters has no parent");
});

test("closing the tab in view goes back to the tab used before it (team trial round 12)", () => {
  const a = s().open("/rates", { newTab: true });
  s().open("/routing/rules", { newTab: true });
  s().open("/finance", { newTab: true });
  s().activate(a);
  const d = s().open("/admin/users", { newTab: true });
  void s().close(d);
  assert.equal(s().activeId, a);
});

test("a closed tab is never made active (team trial round 12)", () => {
  const a = s().open("/rates", { newTab: true });
  const b = s().open("/routing/rules", { newTab: true });
  void s().close(b);
  s().activate(b);
  assert.equal(s().activeId, a);
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

test("tab groups: together, join by opening or dragging in, collapse, saved and restored (team trial round 8)", () => {
  const a = s().open("/enterprises", { newTab: true });
  const b = s().open("/admin/changes", { newTab: true });
  const c = s().open("/rates", { newTab: true });
  const g = s().newGroup(a);
  assert.equal(s().groups.length, 1);
  s().addToGroup(c, g);
  const order = () => s().tabs.map((t) => t.id).slice(1);
  assert.deepEqual(order(), [a, c, b], "a group's tabs sit together");
  // A tab opened from a grouped tab joins its group.
  s().activate(c);
  const d = s().open("/routing/rules", { newTab: true });
  assert.equal(s().tabs.find((t) => t.id === d)!.groupId, g);
  // Dragged out of the group's span: leaves it; dropped back between two of its tabs: joins.
  s().move(d, s().tabs.length);
  assert.equal(s().tabs.find((t) => t.id === d)!.groupId, null);
  s().move(b, 2);
  assert.equal(s().tabs.find((t) => t.id === b)!.groupId, g, "dropped between a and c");
  // Collapsing the group of the open tab moves to a tab outside it; opening a hidden tab expands it.
  s().activate(a);
  s().updateGroup(g, { collapsed: true, label: "Ops" });
  assert.equal(s().activeId, d);
  s().activate(c);
  assert.equal(s().groups[0]!.collapsed, false);
  const ws = toWorkspace(s());
  assert.deepEqual(ws.groups, [{ id: g, label: "Ops", color: "grey", collapsed: false }]);
  s().hydrate(1, ws);
  assert.equal(s().tabs.filter((t) => t.groupId === g).length, 3);
  // Ungroup keeps the tabs; a group with no tabs left is dropped.
  s().ungroup(g);
  assert.equal(s().groups.length, 0);
  assert.equal(s().tabs.length, 6, "Home, Dashboard and the four tabs");
});
