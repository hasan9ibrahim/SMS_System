// Reload one tab (team trial round 9): what the browser's refresh does, for that page only. The page is mounted again
// (its filters, scroll and drafts reset, as after a refresh) and its data is fetched again; the other tabs stay as
// they are.
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";

export const useTabReloads = create<{ counts: Record<string, number>; bump: (id: string) => void }>((set) => ({
  counts: {},
  bump: (id) => set((s) => ({ counts: { ...s.counts, [id]: (s.counts[id] ?? 0) + 1 } })),
}));

export function useReloadTab() {
  const qc = useQueryClient();
  return (tabId: string) => {
    // Everything cached counts as old: the remounted page fetches its own data again; the other tabs' data refreshes
    // only when they next ask for it.
    void qc.invalidateQueries({ refetchType: "none" });
    useTabReloads.getState().bump(tabId);
  };
}
