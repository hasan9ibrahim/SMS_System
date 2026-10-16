// Tabbed workspace (§13.5): open tabs, order, pins, unsaved-change flags and alert dots.
// The open set is saved per user through PUT /me/workspace (debounced) and restored after
// re-login; a localStorage copy covers the case where the API is unreachable.
// Page state (filters, sort) lives in each tab's path, so it survives restore and pop-out.
import { create } from "zustand";
import type { Workspace, WorkspaceTab } from "@sms/contract";
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
}

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
  /** Tab shown on the right in split view (§15.1), or null. */
  splitId: string | null;
  userId: number | null;
  hydrate: (userId: number, ws: Workspace | null) => void;
  open: (path: string, opts?: OpenOptions) => string;
  activate: (id: string) => void;
  close: (id: string) => Promise<boolean>;
  closeOthers: (id: string) => Promise<void>;
  duplicate: (id: string) => void;
  togglePin: (id: string) => void;
  move: (id: string, toIndex: number) => void;
  setPath: (id: string, path: string) => void;
  setTitle: (id: string, title: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  setAlert: (id: string, alert: boolean) => void;
  toggleSplit: () => void;
  setSplit: (id: string) => void;
  /** Removes a tab that moved to its own window. */
  detach: (id: string) => Tab | undefined;
  /** Adds a tab coming back from a window (drag back or Dock button). */
  dock: (tab: WorkspaceTab, atIndex?: number) => void;
}

/** Pinned tabs stay left of the others, Home first. */
function ordered(tabs: Tab[]): Tab[] {
  const home = tabs.filter((t) => t.id === HOME_TAB_ID);
  return [...home, ...tabs.filter((t) => t.pinned && t.id !== HOME_TAB_ID), ...tabs.filter((t) => !t.pinned)];
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [homeTab()],
  activeId: HOME_TAB_ID,
  splitId: null,
  userId: null,

  hydrate: (userId, ws) => {
    const restored = (ws?.tabs ?? [])
      .filter((t) => t.id !== HOME_TAB_ID)
      .map((t): Tab => ({ ...t, dirty: false, alert: false }));
    const tabs = ordered([homeTab(), ...restored]);
    const activeId = tabs.some((t) => t.id === ws?.activeTabId) ? ws!.activeTabId! : HOME_TAB_ID;
    set({ tabs, activeId, userId });
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
      });
      return active.id;
    }
    const tab: Tab = {
      id: newId(),
      path,
      title: opts.title ?? defaultTitle(path),
      pinned: false,
      dirty: false,
      alert: false,
    };
    const at = Math.max(tabs.findIndex((t) => t.id === activeId) + 1, tabs.filter((t) => t.pinned).length);
    const next = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
    set({ tabs: ordered(next), activeId: opts.background ? activeId : tab.id });
    return tab.id;
  },

  activate: (id) => {
    const { splitId, activeId } = get();
    // Clicking the tab shown on the right swaps the panes.
    set({ activeId: id, splitId: splitId === id ? activeId : splitId });
  },

  toggleSplit: () => {
    const { splitId, tabs, activeId } = get();
    if (splitId) return set({ splitId: null });
    const other = tabs.find((t) => t.id !== activeId && t.id !== HOME_TAB_ID) ?? tabs.find((t) => t.id !== activeId);
    set({ splitId: other?.id ?? null });
  },
  setSplit: (id) => set({ splitId: id === get().activeId ? null : id }),

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
    const nextActive = activeId === id ? (next[Math.min(idx, next.length - 1)] ?? next[0]!).id : activeId;
    const splitId = get().splitId;
    set({ tabs: next, activeId: nextActive, splitId: splitId === id || splitId === nextActive ? null : splitId });
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
    set({ tabs: ordered(get().tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))) });
  },

  move: (id, toIndex) => {
    const tabs = [...get().tabs];
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0 || id === HOME_TAB_ID) return;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(1, Math.min(toIndex, tabs.length)), 0, tab!);
    set({ tabs: ordered(tabs) });
  },

  setPath: (id, path) => {
    set({
      tabs: get().tabs.map((t) => {
        if (t.id !== id || t.path === path) return t;
        // Keep a page-given title while staying on the same page; reset it when leaving.
        const samePage = pageForPath(t.path) === pageForPath(path);
        return { ...t, path, title: samePage ? t.title : defaultTitle(path) };
      }),
    });
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
    set({ tabs: next, activeId: nextActive, splitId: splitId === id || splitId === nextActive ? null : splitId });
    return tab;
  },

  dock: (tab, atIndex) => {
    const tabs = get().tabs.filter((t) => t.id !== tab.id);
    const docked: Tab = { ...tab, dirty: false, alert: false };
    const at = atIndex ?? tabs.length;
    tabs.splice(Math.max(1, Math.min(at, tabs.length)), 0, docked);
    set({ tabs: ordered(tabs), activeId: docked.id });
  },
}));

// ---- persistence (§13.5: the open tab set is restored after re-login, per user) ----

const storageKey = (userId: number) => `sms.workspace.${userId}`;

export function toWorkspace(state: Pick<TabsState, "tabs" | "activeId">): Workspace {
  return {
    tabs: state.tabs
      .filter((t) => t.id !== HOME_TAB_ID)
      .slice(0, 50)
      .map(({ id, path, title, pinned }) => ({ id, path, title: title.slice(0, 200), pinned })),
    activeTabId: state.activeId,
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
