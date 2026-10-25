// Main window layout (§15.1): top menu bar, page tab strip, the open pages, status bar.
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { ChangePasswordScreen, PasswordBanner, usePasswordBlocked } from "./PasswordGate";
import { SignInScreen, useSignInRequired } from "./SignIn";
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

const SHARE_KEY = "sms.splitShare";
/** The left side's share of split view, kept per browser (team trial round 2). */
function useSplitShare(): [number, (v: number) => void] {
  const [share, setShare] = useState(() => {
    try {
      const v = Number(localStorage.getItem(SHARE_KEY));
      return v >= 0.15 && v <= 0.85 ? v : 0.5;
    } catch {
      return 0.5;
    }
  });
  const set = (v: number) => {
    const clamped = Math.min(0.85, Math.max(0.15, v));
    setShare(clamped);
    try {
      localStorage.setItem(SHARE_KEY, String(clamped));
    } catch {
      /* private window */
    }
  };
  return [share, set];
}

/** The bar between the two sides: drag to resize, double-click for half and half, arrows by 2 %. */
function SplitDivider({ share, onChange }: { share: number; onChange: (v: number) => void }) {
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    const host = e.currentTarget.parentElement!;
    const rect = host.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-split");
    const move = (ev: PointerEvent) => onChange((ev.clientX - rect.left) / rect.width);
    const up = () => {
      document.body.classList.remove("resizing-split");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize split view"
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      title="Drag to resize · double-click for half and half"
      style={{ left: `${share * 100}%` }}
      onPointerDown={start}
      onDoubleClick={() => onChange(0.5)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(share - 0.02);
        if (e.key === "ArrowRight") onChange(share + 0.02);
      }}
    />
  );
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
  const splitLeft = useTabs((s) => s.splitLeft);
  const [splitShare, setSplitShare] = useSplitShare();
  // Split view sides (team trial round 1): the focused tab and the other one, each on its own side.
  const sideOf = (id: string): "left" | "right" | null =>
    !split
      ? null
      : id === activeId
        ? splitLeft
          ? "right"
          : "left"
        : id === split
          ? splitLeft
            ? "left"
            : "right"
          : null;
  const blocked = usePasswordBlocked();
  const signInRequired = useSignInRequired();
  // Backend step 9: no session (or it ended) shows only Sign in.
  if (signInRequired)
    return (
      <div className="shell">
        <SignInScreen />
      </div>
    );
  // §13.28: an expired, temporary or must-change password leaves only the Change Password screen.
  if (blocked)
    return (
      <div className="shell">
        <ChangePasswordScreen />
        <FeedbackLayer />
      </div>
    );
  return (
    <div className="shell">
      <TopMenu />
      <TabStrip />
      <PasswordBanner />
      <ViewAsBanner />
      <main className={`panes${split ? " split" : ""}`}>
        {ready ? (
          tabs.map((t) => (
            <TabPane
              key={t.id}
              tab={t}
              shown={t.id === activeId || t.id === split}
              focused={t.id === activeId}
              side={sideOf(t.id)}
              leftShare={splitShare}
            />
          ))
        ) : (
          <div className="grid-message muted">Opening your workspace…</div>
        )}
        {split && <SplitDivider share={splitShare} onChange={setSplitShare} />}
      </main>
      <StatusBar tabId={activeId} />
      <CommandPalette />
      <IncidentPopups />
      <FeedbackLayer />
    </div>
  );
}
