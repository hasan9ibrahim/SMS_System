// Tabbed workspace (§13.5): open tabs, order, pins, unsaved-change flags and alert dots.
// The open set is saved per user through PUT /me/workspace (debounced) and restored after
// re-login; a localStorage copy covers the case where the API is unreachable.
// Page state (filters, sort) lives in each tab's path, so it survives restore and pop-out.
import { create } from "zustand";
import type { TabGroup, Workspace, WorkspaceTab } from "@sms/contract";
import { api, unwrap } from "../api/client";
import { HOME, pageForPath } from "../nav/registry";
import { confirmDialog } from "../ui/feedback";
import { channel } from "./channel";

export interface Tab {
  id: string;
  path: string;
  title: string;
  pinned: boolean;
  /** Unsaved changes: closing asks first (§13.5). */
  dirty: boolean;
  /** An incident concerns the data on this tab (§13.5, §13.6). */
  alert: boolean;
  /** Its tab group, Chrome style (team trial round 8); null = none. */
  groupId?: string | null;
}

/** Chrome's group colours (team trial round 8). */
export const GROUP_COLORS: TabGroup["color"][] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

export const HOME_TAB_ID = "home";
const homeTab = (): Tab => ({
  id: HOME_TAB_ID,
  path: "/",
  title: HOME.label,
  pinned: true,
  dirty: false,
  alert: false,
});
const newId = () => Math.random().toString(36).slice(2, 10);
/** The page that opens after signing in (team trial round 3). */
export const DASHBOARD_PATH = "/dashboard";
export const defaultTitle = (path: string) => pageForPath(path)?.label ?? "Page";

export interface OpenOptions {
  /** Open in a new tab instead of the current one. */
  newTab?: boolean;
  /** Always a new tab, even if a tab with the same path is open (Ctrl/middle click). */
  forceNew?: boolean;
  title?: string;
  /** Open without switching to it. */
  background?: boolean;
}

interface TabsState {
  tabs: Tab[];
  activeId: string;
  /** The other tab shown in split view (§15.1), or null; the active tab is the focused side. */
  splitId: string | null;
  /** True when splitId is on the left (so the active tab is on the right; team trial round 1). */
  splitLeft: boolean;
  userId: number | null;
  hydrate: (userId: number, ws: Workspace | null) => void;
  open: (path: string, opts?: OpenOptions) => string;
  activate: (id: string) => void;
  close: (id: string) => Promise<boolean>;
  closeOthers: (id: string) => Promise<void>;
  duplicate: (id: string) => void;
  togglePin: (id: string) => void;
  move: (id: string, toIndex: number) => void;
  /** `step`: a step for Back even on the same page (a list opening one of its records in place, ?list=12). */
  setPath: (id: string, path: string, opts?: { step?: boolean }) => void;
  setTitle: (id: string, title: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  setAlert: (id: string, alert: boolean) => void;
  toggleSplit: () => void;
  setSplit: (id: string) => void;
  /** Shows a tab on one side of split view and focuses that side (team trial round 1). */
  setPane: (side: "left" | "right", id: string) => void;
  swapSides: () => void;
  /** Removes a tab that moved to its own window. */
  detach: (id: string) => Tab | undefined;
  /** Adds a tab coming back from a window (drag back or Dock button). */
  dock: (tab: WorkspaceTab, atIndex?: number) => void;
  /** Tab groups with a label and colour, Chrome style (team trial round 8, §13.5). */
  groups: TabGroup[];
  /** Puts the tab in a new group (next free colour) and returns the group's id. */
  newGroup: (tabId: string) => string;
  /** Moves the tab into the group, after the group's last tab. */
  addToGroup: (tabId: string, groupId: string) => void;
  removeFromGroup: (tabId: string) => void;
  updateGroup: (groupId: string, patch: Partial<Omit<TabGroup, "id">>) => void;
  /** Keeps the tabs, drops the group. */
  ungroup: (groupId: string) => void;
  closeGroup: (groupId: string) => Promise<void>;
  /** Per tab: the pages opened before in it, and the tab it was opened from (Back, trial round 1). */
  back: Record<string, { paths: string[]; opener?: string }>;
  /** Back to the previous page of the tab, or to the tab it was opened from. False when there is none. */
  goBack: (id: string) => boolean;
}

const BACK_DEPTH = 30;
const pathname = (p: string) => p.split("?")[0];
/** A record page's section (?tab=billing): a step for Back, unlike a filter change. */
const sectionOf = (p: string) => new URLSearchParams(p.split("?")[1] ?? "").get("tab");
/** Remembers the page a tab leaves; filter changes on the same page are not steps, a new section is, and so is a
 * record a list opens in place (`step`). */
function pushBack(back: TabsState["back"], id: string, from: string, to: string, step = false): TabsState["back"] {
  if (!step && pathname(from) === pathname(to) && sectionOf(from) === sectionOf(to)) return back;
  const cur = back[id] ?? { paths: [] };
  return { ...back, [id]: { ...cur, paths: [...cur.paths, from].slice(-BACK_DEPTH) } };
}

/** Query parameters naming a record a list page opens in place, with the parameters that belong to that record (a
 * rate table's ?view=): ?list=12 on Number lists, ?profile= on the Master Table, ?rn= on Incoming RNs, ?table= on the
 * Rate Manager, ?provider= on HLR. */
const RECORD_PARAMS: Record<string, string[]> = {
  list: [],
  profile: [],
  rn: [],
  table: ["view"],
  provider: [],
  // A rule or user a link opens in the list's detail panel (functional QA round 13).
  rule: [],
  user: [],
};

/**
 * The page and the record it shows (/enterprises/218, /rates/manager?table=5), without filters or sections: a title
 * the page gave (an enterprise's name) belongs to that record and goes when the tab leaves it, also for its own list
 * (functional QA round 13: "Enterprise · Aladex" stayed on the Enterprises list after Back).
 */
function recordOf(path: string): string {
  const query = new URLSearchParams(path.split("?")[1] ?? "");
  const param = Object.keys(RECORD_PARAMS).find((k) => query.has(k));
  return `${pathname(path)}${param ? `?${param}=${query.get(param)}` : ""}`;
}
/** The tab's title on its new path: kept on the same record, else the new page's own. */
const titleAfter = (tab: Tab, path: string) => (recordOf(tab.path) === recordOf(path) ? tab.title : defaultTitle(path));

/**
 * Where Back goes in a tab with no earlier page: a record's list (/enterprises/12 → /enterprises,
 * /switch/number-lists?list=12 → /switch/number-lists), else nowhere. Back stays in its tab; it never jumps to another
 * tab (team trial round 12).
 */
export function parentPath(path: string): string | null {
  const query = new URLSearchParams(path.split("?")[1] ?? "");
  const record = Object.keys(RECORD_PARAMS).find((k) => query.has(k));
  if (record && pageForPath(pathname(path)!)) {
    for (const k of [record, ...RECORD_PARAMS[record]!]) query.delete(k);
    const rest = query.toString();
    return `${pathname(path)}${rest ? `?${rest}` : ""}`;
  }
  const parts = pathname(path)!.split("/").filter(Boolean);
  if (parts.length < 2 || !/^(\d+|new)$/.test(parts.at(-1)!)) return null;
  const up = `/${parts.slice(0, -1).join("/")}`;
  return pageForPath(up) ? up : null;
}

/** Whether Back has somewhere to go for this tab. */
export function canGoBack(state: Pick<TabsState, "back" | "tabs">, id: string): boolean {
  const b = state.back[id];
  if (b && b.paths.length > 0) return true;
  const tab = state.tabs.find((t) => t.id === id);
  return !!tab && parentPath(tab.path) !== null;
}

/** Pinned tabs stay left of the others, Home first; the tabs of a group stay together, where its first tab is. */
function ordered(tabs: Tab[]): Tab[] {
  const home = tabs.filter((t) => t.id === HOME_TAB_ID);
  const rest = tabs.filter((t) => !t.pinned);
  const grouped: Tab[] = [];
  const seen = new Set<string>();
  for (const t of rest) {
    if (!t.groupId) grouped.push(t);
    else if (!seen.has(t.groupId)) {
      seen.add(t.groupId);
      grouped.push(...rest.filter((x) => x.groupId === t.groupId));
    }
  }
  return [...home, ...tabs.filter((t) => t.pinned && t.id !== HOME_TAB_ID), ...grouped];
}

/** Drops groups that have no tab left. */
const pruned = (groups: TabGroup[], tabs: Tab[]) => groups.filter((g) => tabs.some((t) => t.groupId === g.id));

/**
 * After a drag (Chrome style): a tab dropped between two tabs of a group joins it; one dropped away from the rest of
 * its group leaves it (a group's only tab keeps its group).
 */
export function regroupAfterMove(tabs: Tab[], id: string): Tab[] {
  const i = tabs.findIndex((t) => t.id === id);
  const tab = tabs[i];
  if (!tab || tab.pinned) return tabs;
  const left = tabs[i - 1]?.groupId ?? null;
  const right = tabs[i + 1]?.groupId ?? null;
  let groupId = tab.groupId ?? null;
  if (left && left === right) groupId = left;
  else if (groupId && left !== groupId && right !== groupId && tabs.some((t) => t.id !== id && t.groupId === groupId))
    groupId = null;
  return groupId === (tab.groupId ?? null) ? tabs : tabs.map((t) => (t.id === id ? { ...t, groupId } : t));
}

/** The tabs in the order they were last in view (most recent last), for closing the tab in view. */
const recentTabs: string[] = [];

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [homeTab()],
  activeId: HOME_TAB_ID,
  splitId: null,
  splitLeft: false,
  userId: null,
  back: {},
  groups: [],

  hydrate: (userId, ws) => {
    const groups = ws?.groups ?? [];
    const restored = (ws?.tabs ?? [])
      .filter((t) => t.id !== HOME_TAB_ID)
      .map(
        (t): Tab => ({
          ...t,
          groupId: t.groupId && groups.some((g) => g.id === t.groupId) ? t.groupId : null,
          dirty: false,
          alert: false,
        }),
      );
    // Signing in shows the Dashboard (team trial round 3): its saved tab if there is one, else a new tab right
    // after the pinned ones. Home stays the pinned first tab.
    let dashboard = restored.find((t) => t.path.split("?")[0] === DASHBOARD_PATH);
    if (!dashboard) {
      dashboard = {
        id: newId(),
        path: DASHBOARD_PATH,
        title: defaultTitle(DASHBOARD_PATH),
        pinned: false,
        dirty: false,
        alert: false,
      };
      restored.splice(restored.filter((t) => t.pinned).length, 0, dashboard);
    }
    const tabs = ordered([homeTab(), ...restored]);
    set({ tabs, activeId: dashboard.id, userId, groups: pruned(groups, tabs) });
  },

  open: (path, opts = {}) => {
    const { tabs, activeId } = get();
    if (!opts.forceNew) {
      // Same page already open: focus it. A plain page link (no query) also matches the
      // page with filters in its URL, so the user's filters stay.
      const pathname = path.split("?")[0];
      const existing =
        tabs.find((t) => t.path === path) ??
        (path.includes("?") ? undefined : tabs.find((t) => t.path.split("?")[0] === pathname));
      if (existing) {
        if (!opts.background) set({ activeId: existing.id });
        return existing.id;
      }
    }
    const active = tabs.find((t) => t.id === activeId);
    // Navigate in place unless asked for a new tab or the current tab is pinned (Home).
    if (!opts.newTab && !opts.forceNew && active && !active.pinned) {
      set({
        tabs: tabs.map((t) => (t.id === active.id ? { ...t, path, title: opts.title ?? defaultTitle(path) } : t)),
        back: pushBack(get().back, active.id, active.path, path),
      });
      return active.id;
    }
    const at = Math.max(tabs.findIndex((t) => t.id === activeId) + 1, tabs.filter((t) => t.pinned).length);
    // Opened next to a grouped tab (Chrome style): it joins that group.
    const tab: Tab = {
      id: newId(),
      path,
      title: opts.title ?? defaultTitle(path),
      pinned: false,
      dirty: false,
      alert: false,
      groupId: active && !active.pinned && tabs[at - 1]?.id === active.id ? (active.groupId ?? null) : null,
    };
    const next = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
    set({
      tabs: ordered(next),
      activeId: opts.background ? activeId : tab.id,
      back: { ...get().back, [tab.id]: { paths: [], opener: activeId } },
    });
    return tab.id;
  },

  activate: (id) => {
    const { splitId, activeId, splitLeft } = get();
    // A tab that is gone (closed meanwhile) is never made active: that left a grey page.
    if (!get().tabs.some((t) => t.id === id)) return;
    // The other split tab takes the focus and both stay on their side; any other tab replaces
    // the focused side.
    // A tab in a collapsed group opens the group (Chrome style).
    const groupId = get().tabs.find((t) => t.id === id)?.groupId;
    if (groupId && get().groups.some((g) => g.id === groupId && g.collapsed))
      set({ groups: get().groups.map((g) => (g.id === groupId ? { ...g, collapsed: false } : g)) });
    if (splitId === id) return set({ activeId: id, splitId: activeId, splitLeft: !splitLeft });
    set({ activeId: id });
  },

  toggleSplit: () => {
    const { splitId, tabs, activeId } = get();
    if (splitId) return set({ splitId: null, splitLeft: false });
    const other = tabs.find((t) => t.id !== activeId && t.id !== HOME_TAB_ID) ?? tabs.find((t) => t.id !== activeId);
    set({ splitId: other?.id ?? null, splitLeft: false });
  },
  setSplit: (id) => set({ splitId: id === get().activeId ? null : id }),

  setPane: (side, id) => {
    const { splitId, activeId, splitLeft } = get();
    if (!splitId) return;
    const left = splitLeft ? splitId : activeId;
    const right = splitLeft ? activeId : splitId;
    // Choosing the tab already on the other side swaps the two.
    const [nl, nr] = side === "left" ? [id, id === right ? left : right] : [id === left ? right : left, id];
    if (nl === nr) return;
    set(
      side === "left"
        ? { activeId: nl, splitId: nr, splitLeft: false }
        : { activeId: nr, splitId: nl, splitLeft: true },
    );
  },
  swapSides: () => set({ splitLeft: !get().splitLeft }),

  close: async (id) => {
    if (id === HOME_TAB_ID) return false;
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return false;
    if (tab.dirty) {
      const ok = await confirmDialog({
        title: "Close tab with unsaved changes?",
        message: `"${tab.title}" has changes that are not saved. They will be lost.`,
        ok: "Close tab",
        danger: true,
      });
      if (!ok) return false;
    }
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    // Closing the tab in view goes back to the tab used before it (team trial round 12), else its neighbour.
    const before = [...recentTabs].reverse().find((r) => r !== id && next.some((t) => t.id === r));
    const nextActive =
      activeId === id ? (before ?? (next[Math.min(idx, next.length - 1)] ?? next[0]!).id) : activeId;
    const splitId = get().splitId;
    set({
      tabs: next,
      activeId: nextActive,
      splitId: splitId === id || splitId === nextActive ? null : splitId,
      groups: pruned(get().groups, next),
    });
    return true;
  },

  closeOthers: async (id) => {
    for (const t of get().tabs) {
      if (t.id !== id && !t.pinned) await get().close(t.id);
    }
    set({ activeId: id });
  },

  duplicate: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab) get().open(tab.path, { forceNew: true, title: tab.title });
  },

  togglePin: (id) => {
    if (id === HOME_TAB_ID) return;
    // A pinned tab leaves its group (Chrome style).
    const tabs = ordered(get().tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned, groupId: null } : t)));
    set({ tabs, groups: pruned(get().groups, tabs) });
  },

  move: (id, toIndex) => {
    const tabs = [...get().tabs];
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0 || id === HOME_TAB_ID) return;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(1, Math.min(toIndex, tabs.length)), 0, tab!);
    const next = ordered(regroupAfterMove(tabs, id));
    set({ tabs: next, groups: pruned(get().groups, next) });
  },

  setPath: (id, path, opts = {}) => {
    const from = get().tabs.find((t) => t.id === id)?.path;
    if (from !== undefined && from !== path) set({ back: pushBack(get().back, id, from, path, opts.step) });
    set({
      tabs: get().tabs.map((t) => {
        if (t.id !== id || t.path === path) return t;
        // Keep a page-given title while staying on the same record; reset it when leaving.
        return { ...t, path, title: titleAfter(t, path) };
      }),
    });
  },
  goBack: (id) => {
    const b = get().back[id] ?? { paths: [] };
    const prev = b.paths.at(-1);
    if (prev !== undefined) {
      set({
        back: { ...get().back, [id]: { ...b, paths: b.paths.slice(0, -1) } },
        tabs: get().tabs.map((t) => {
          if (t.id !== id) return t;
          return { ...t, path: prev, title: titleAfter(t, prev) };
        }),
      });
      return true;
    }
    const tab = get().tabs.find((t) => t.id === id);
    const up = tab ? parentPath(tab.path) : null;
    if (up) {
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, path: up, title: defaultTitle(up) } : t)) });
      return true;
    }
    return false;
  },
  setTitle: (id, title) =>
    set({ tabs: get().tabs.map((t) => (t.id === id && t.title !== title ? { ...t, title } : t)) }),
  setDirty: (id, dirty) =>
    set({ tabs: get().tabs.map((t) => (t.id === id && t.dirty !== dirty ? { ...t, dirty } : t)) }),
  setAlert: (id, alert) =>
    set({ tabs: get().tabs.map((t) => (t.id === id && t.alert !== alert ? { ...t, alert } : t)) }),

  detach: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.id === HOME_TAB_ID) return undefined;
    const { tabs, activeId } = get();
    const idx = tabs.indexOf(tab);
    const next = tabs.filter((t) => t.id !== id);
    const nextActive = activeId === id ? (next[Math.max(0, idx - 1)] ?? next[0]!).id : activeId;
    const splitId = get().splitId;
    set({
      tabs: next,
      activeId: nextActive,
      splitId: splitId === id || splitId === nextActive ? null : splitId,
      groups: pruned(get().groups, next),
    });
    return tab;
  },

  dock: (tab, atIndex) => {
    const tabs = get().tabs.filter((t) => t.id !== tab.id);
    const docked: Tab = { ...tab, groupId: null, dirty: false, alert: false };
    const at = atIndex ?? tabs.length;
    tabs.splice(Math.max(1, Math.min(at, tabs.length)), 0, docked);
    set({ tabs: ordered(regroupAfterMove(tabs, docked.id)), activeId: docked.id });
  },

  newGroup: (tabId) => {
    const { groups, tabs } = get();
    const used = new Set(groups.map((g) => g.color));
    const color = GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[groups.length % GROUP_COLORS.length]!;
    const group: TabGroup = { id: newId(), label: "", color, collapsed: false };
    const next = ordered(tabs.map((t) => (t.id === tabId ? { ...t, pinned: false, groupId: group.id } : t)));
    set({ tabs: next, groups: pruned([...groups, group], next) });
    return group.id;
  },
  addToGroup: (tabId, groupId) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId);
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || tabId === HOME_TAB_ID) return;
    const last = tabs.map((t) => t.groupId).lastIndexOf(groupId);
    tabs.splice(last >= 0 ? last + 1 : tabs.length, 0, { ...tab, pinned: false, groupId });
    const next = ordered(tabs);
    set({ tabs: next, groups: pruned(get().groups, next) });
  },
  removeFromGroup: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.groupId) return;
    // Out of the group, to its right.
    const tabs = get().tabs.filter((t) => t.id !== tabId);
    const last = tabs.map((t) => t.groupId).lastIndexOf(tab.groupId);
    tabs.splice(last >= 0 ? last + 1 : tabs.length, 0, { ...tab, groupId: null });
    const next = ordered(tabs);
    set({ tabs: next, groups: pruned(get().groups, next) });
  },
  updateGroup: (groupId, patch) => {
    const { groups, tabs, activeId } = get();
    // Collapsing the group of the open tab moves to the nearest tab outside it (Chrome style).
    if (patch.collapsed && tabs.find((t) => t.id === activeId)?.groupId === groupId) {
      const i = tabs.findIndex((t) => t.id === activeId);
      const outside = [...tabs.slice(i + 1), ...tabs.slice(0, i).reverse()].find((t) => t.groupId !== groupId);
      if (!outside) return;
      set({ activeId: outside.id, splitId: get().splitId === outside.id ? null : get().splitId });
    }
    set({ groups: groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)) });
  },
  ungroup: (groupId) =>
    set({
      tabs: get().tabs.map((t) => (t.groupId === groupId ? { ...t, groupId: null } : t)),
      groups: get().groups.filter((g) => g.id !== groupId),
    }),
  closeGroup: async (groupId) => {
    for (const t of get().tabs.filter((x) => x.groupId === groupId)) await get().close(t.id);
  },
}));

useTabs.subscribe((state, prev) => {
  if (state.activeId === prev.activeId || !prev.activeId) return;
  const i = recentTabs.indexOf(prev.activeId);
  if (i >= 0) recentTabs.splice(i, 1);
  recentTabs.push(prev.activeId);
  if (recentTabs.length > 50) recentTabs.shift();
});

// ---- persistence (§13.5: the open tab set is restored after re-login, per user) ----

const storageKey = (userId: number) => `sms.workspace.${userId}`;

export function toWorkspace(state: Pick<TabsState, "tabs" | "activeId"> & { groups?: TabGroup[] }): Workspace {
  const tabs = state.tabs.filter((t) => t.id !== HOME_TAB_ID).slice(0, 50);
  return {
    tabs: tabs.map(({ id, path, title, pinned, groupId }) => ({
      id,
      path,
      title: title.slice(0, 200),
      pinned,
      groupId: groupId ?? null,
    })),
    activeTabId: state.activeId,
    groups: pruned(state.groups ?? [], tabs).slice(0, 25),
  };
}

export async function loadWorkspace(userId: number): Promise<Workspace | null> {
  try {
    return await unwrap(api.GET("/me/workspace"));
  } catch {
    try {
      const raw = localStorage.getItem(storageKey(userId));
      return raw ? (JSON.parse(raw) as Workspace) : null;
    } catch {
      return null;
    }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaved = "";

/** Starts saving the workspace whenever tabs change (main window only). */
export function startWorkspaceSync(): () => void {
  return useTabs.subscribe((state) => {
    if (state.userId === null) return;
    const ws = toWorkspace(state);
    const json = JSON.stringify(ws);
    if (json === lastSaved) return;
    lastSaved = json;
    try {
      localStorage.setItem(storageKey(state.userId), json);
    } catch {
      // Private mode or full storage: the server copy is enough.
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      unwrap(api.PUT("/me/workspace", { body: ws })).catch(() => undefined);
    }, 800);
  });
}

// ---- docking from other windows ----

export function listenForDocking(): () => void {
  return channel.on((msg) => {
    if (msg.type === "dock") {
      useTabs.getState().dock(msg.tab, msg.atIndex);
      channel.post({ type: "docked", tabId: msg.tab.id });
    }
  });
}
