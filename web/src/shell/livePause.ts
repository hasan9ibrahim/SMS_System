// Tabs whose live page is paused or showing a past period (team trial round 6): their tab light turns red.
import { useEffect } from "react";
import { create } from "zustand";

const usePausedTabs = create<{ paused: Record<string, boolean>; set: (tab: string, paused: boolean) => void }>(
  (set) => ({
    paused: {},
    set: (tab, paused) => set((s) => (s.paused[tab] === paused ? s : { paused: { ...s.paused, [tab]: paused } })),
  }),
);

/** Whether the tab's live page is stopped (paused, refresh off, or a period without today). */
export const useTabPaused = (tab: string) => usePausedTabs((s) => !!s.paused[tab]);

/** Called by a live page with whether its figures are updating; cleared when the page closes. */
export function useReportLive(tab: string | undefined, running: boolean) {
  useEffect(() => {
    if (!tab) return;
    usePausedTabs.getState().set(tab, !running);
    return () => usePausedTabs.getState().set(tab, false);
  }, [tab, running]);
}
