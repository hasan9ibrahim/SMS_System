// One tab's page. Every open tab stays mounted (hidden when not shown), so filters, scroll
// position and drafts survive switching tabs (§13.5). Errors stay inside their tab.
import { Component, memo, type ErrorInfo, type ReactNode } from "react";
import { useCan } from "../api/access";
import { pageForPath } from "../nav/registry";
import { PageRoutes } from "../pages/PageRoutes";
import { TabProvider } from "./tabContext";
import { useTabs, type Tab } from "./tabs";
import { SplitPaneBar } from "./SplitPaneBar";
import { useTabReloads } from "./reload";
import { TabDialogs } from "../ui/feedback";

class TabErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page error", error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="grid-message error">
            This page failed: {this.state.error.message}.{" "}
            <button type="button" className="link" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** A page the user's access group (or own override) doesn't allow shows a notice instead (§11, trial round 2). */
function AccessGuard({ path, children }: { path: string; children: ReactNode }) {
  const page = pageForPath(path.split("?")[0]!);
  const allowed = useCan(page?.key ?? "home");
  if (allowed) return <>{children}</>;
  return (
    <div className="page">
      <div className="grid-message">
        No access to {page?.label ?? "this page"}. Ask an administrator to change your GUI access group.
      </div>
    </div>
  );
}

export const TabPane = memo(function TabPane({
  tab,
  shown,
  focused,
  popout = false,
  side = null,
  leftShare = 0.5,
}: {
  tab: Tab;
  shown: boolean;
  focused: boolean;
  popout?: boolean;
  /** Its side in split view, or null (team trial round 1). */
  side?: "left" | "right" | null;
  /** Share of the width the left side takes in split view, 0–1 (dragged by the user, trial round 2). */
  leftShare?: number;
}) {
  const reloads = useTabReloads((s) => s.counts[tab.id] ?? 0);
  return (
    <div
      className={`pane${shown ? "" : " hidden"}${focused ? " focused" : ""}${side ? " pane-split" : ""}`}
      role="tabpanel"
      data-tab-id={tab.id}
      aria-label={tab.title}
      hidden={!shown}
      style={
        side
          ? side === "left"
            ? { order: 1, flex: `0 0 ${(leftShare * 100).toFixed(2)}%` }
            : { order: 2, flex: "1 1 0" }
          : undefined
      }
      // In split view a click in the other pane focuses it, so the tab strip then fills that side.
      onMouseDownCapture={side && !focused ? () => useTabs.getState().activate(tab.id) : undefined}
    >
      {side && <SplitPaneBar side={side} tab={tab} focused={focused} />}
      <TabProvider value={{ tab, active: focused, popout }}>
        {/* A new key on Reload (R9) mounts the page again, as a browser refresh would. */}
        <TabErrorBoundary key={reloads}>
          <AccessGuard path={tab.path}>
            <PageRoutes path={tab.path} />
          </AccessGuard>
        </TabErrorBoundary>
        {/* Its own dialogs, over this tab only (team trial round 12). */}
        <TabDialogs tabId={tab.id} />
      </TabProvider>
    </div>
  );
});
