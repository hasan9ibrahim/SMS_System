// One tab's page. Every open tab stays mounted (hidden when not shown), so filters, scroll
// position and drafts survive switching tabs (§13.5). Errors stay inside their tab.
import { Component, memo, type ErrorInfo, type ReactNode } from "react";
import { PageRoutes } from "../pages/PageRoutes";
import { TabProvider } from "./tabContext";
import type { Tab } from "./tabs";

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

export const TabPane = memo(function TabPane({
  tab,
  shown,
  focused,
  popout = false,
}: {
  tab: Tab;
  shown: boolean;
  focused: boolean;
  popout?: boolean;
}) {
  return (
    <div
      className={`pane${shown ? "" : " hidden"}${focused ? " focused" : ""}`}
      role="tabpanel"
      aria-label={tab.title}
      hidden={!shown}
    >
      <TabProvider value={{ tab, active: focused, popout }}>
        <TabErrorBoundary>
          <PageRoutes path={tab.path} />
        </TabErrorBoundary>
      </TabProvider>
    </div>
  );
});
