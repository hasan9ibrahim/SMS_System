// Main window layout (§15.1): top menu bar, page tab strip, the open pages, status bar.
import { useEffect, useState } from "react";
import { useMe } from "../api/hooks";
import { startLive } from "../live/store";
import { FeedbackLayer } from "../ui/feedback";
import { channel } from "./channel";
import { CommandPalette, usePalette } from "./CommandPalette";
import { IncidentPopups, useTabAlertDots } from "./IncidentPopups";
import { StatusBar } from "./StatusBar";
import { TabPane } from "./TabPane";
import { TabStrip } from "./TabStrip";
import { TopMenu } from "./TopMenu";
import { ViewAsBanner } from "./ViewAsBanner";
import { listenForDocking, loadWorkspace, startWorkspaceSync, useTabs } from "./tabs";
import { useThemeSync } from "./theme";
import { recordPageView } from "../api/team";

const currentUrl = () => `${location.pathname}${location.search}`;

/** Loads the user, restores their tabs, then keeps tabs, URL and live feed in sync. */
function useBootstrap(): boolean {
  const me = useMe();
  const [ready, setReady] = useState(false);
  const userId = me.data?.id ?? (me.isError ? 0 : null);
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    const deepLink = currentUrl();
    void loadWorkspace(userId).then((ws) => {
      if (cancelled) return;
      useTabs.getState().hydrate(userId, ws);
      // A link opened in the address bar opens (or focuses) its own tab.
      if (deepLink !== "/" && !deepLink.startsWith("/popout")) useTabs.getState().open(deepLink, { newTab: true });
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  useEffect(() => {
    if (!ready) return;
    const stops = [startWorkspaceSync(), listenForDocking(), startLive(userId ?? 0)];
    // Pages opened from pop-out windows open here.
    stops.push(
      channel.on(
        (m) =>
          m.type === "open" &&
          useTabs.getState().open(m.path, { newTab: true, ...(m.title ? { title: m.title } : {}) }),
      ),
    );
    return () => stops.forEach((s) => s());
  }, [ready, userId]);
  return ready;
}

/**
 * The address bar shows the active tab's page, so it can be copied or bookmarked. It waits
 * for the workspace, so a deep link in the address bar survives until it opens its tab.
 */
function useUrlSync(ready: boolean) {
  const path = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.path ?? "/");
  const title = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.title ?? "");
  useEffect(() => {
    if (!ready) return;
    if (currentUrl() !== path) history.replaceState(null, "", path);
    document.title = title && title !== "Home" ? `${title} · SMS Platform` : "SMS Platform";
  }, [path, title, ready]);
  // Pages opened feed "pages most used" and the page shown in Online now (§13.18).
  const page = path.split("?")[0]!;
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => recordPageView(page), 1500);
    return () => clearTimeout(t);
  }, [page, ready]);
}

/** Ctrl/Cmd+K opens jump-to anywhere (§15.1). */
function usePaletteShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const p = usePalette.getState();
        if (p.open) p.hide();
        else p.show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function Shell() {
  const ready = useBootstrap();
  useThemeSync();
  useUrlSync(ready);
  usePaletteShortcut();
  useTabAlertDots();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const splitId = useTabs((s) => s.splitId);
  const split = splitId && splitId !== activeId && tabs.some((t) => t.id === splitId) ? splitId : null;
  return (
    <div className="shell">
      <TopMenu />
      <TabStrip />
      <ViewAsBanner />
      <main className={`panes${split ? " split" : ""}`}>
        {ready ? (
          tabs.map((t) => (
            <TabPane key={t.id} tab={t} shown={t.id === activeId || t.id === split} focused={t.id === activeId} />
          ))
        ) : (
          <div className="grid-message muted">Opening your workspace…</div>
        )}
      </main>
      <StatusBar tabId={activeId} />
      <CommandPalette />
      <IncidentPopups />
      <FeedbackLayer />
    </div>
  );
}
