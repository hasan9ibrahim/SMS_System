// Per-tab context: each tab renders its own route tree from its own path, so every tab
// keeps its own state (§13.5). Pages navigate inside their tab with useTabNavigate and
// can set the tab title, the unsaved-changes flag and the status bar text.
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { create } from "zustand";
import { useTabs, type OpenOptions, type Tab } from "./tabs";

interface TabContextValue {
  tab: Tab;
  active: boolean;
  /** True when the tab runs in its own window (dragged out of the strip). */
  popout: boolean;
}

const TabContext = createContext<TabContextValue | null>(null);

export function TabProvider({ value, children }: { value: TabContextValue; children: ReactNode }) {
  return <TabContext.Provider value={value}>{children}</TabContext.Provider>;
}

export function useTab(): TabContextValue {
  const ctx = useContext(TabContext);
  if (!ctx) throw new Error("useTab outside a tab");
  return ctx;
}

/** Navigate this tab (replace = no history entry, used for filter changes). */
export function useTabNavigate() {
  const { tab, popout } = useTab();
  return useMemo(
    () =>
      (to: string, opts: { replace?: boolean } & OpenOptions = {}) => {
        if (opts.newTab || opts.forceNew) {
          useTabs.getState().open(to, opts);
          return;
        }
        if (popout) {
          popoutPath.getState().set(to);
          return;
        }
        useTabs.getState().setPath(tab.id, to);
      },
    [tab.id, popout],
  );
}

/** In a pop-out window there is no tab store entry; the path lives here. */
export const popoutPath = create<{ path: string; set: (p: string) => void }>((set) => ({
  path: "/",
  set: (path) => set({ path }),
}));

export function useTabTitle(title: string | undefined) {
  const { tab, popout } = useTab();
  useEffect(() => {
    if (!title) return;
    if (popout) document.title = `${title} · SMS Platform`;
    else useTabs.getState().setTitle(tab.id, title);
  }, [title, tab.id, popout]);
}

export function useTabDirty(dirty: boolean) {
  const { tab } = useTab();
  useEffect(() => {
    useTabs.getState().setDirty(tab.id, dirty);
    return () => useTabs.getState().setDirty(tab.id, false);
  }, [dirty, tab.id]);
}

// ---- status bar text per tab (§15.1: row counts, shortcuts) ----

export interface PageStatus {
  rows?: string;
  shortcuts?: string;
}

export const usePageStatusStore = create<{
  byTab: Record<string, PageStatus>;
  set: (id: string, s: PageStatus | null) => void;
}>((set, get) => ({
  byTab: {},
  set: (id, s) => {
    const byTab = { ...get().byTab };
    if (s) byTab[id] = s;
    else delete byTab[id];
    set({ byTab });
  },
}));

export function usePageStatus(status: PageStatus) {
  const { tab } = useTab();
  const { rows, shortcuts } = status;
  useEffect(() => {
    usePageStatusStore.getState().set(tab.id, { rows, shortcuts });
  }, [tab.id, rows, shortcuts]);
  useEffect(() => () => usePageStatusStore.getState().set(tab.id, null), [tab.id]);
}
