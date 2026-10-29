// A tab dragged out into its own window (§13.5): the page without the tab strip, a bar to
// drag it back onto the main window's strip or dock it with a button. Theme and live data
// come from the main window.
import { useEffect, useMemo, type DragEvent } from "react";
import type { WorkspaceTab } from "@sms/contract";
import { useMe } from "../api/hooks";
import { startLiveRelay } from "../live/store";
import { pageForPath } from "../nav/registry";
import { FeedbackLayer } from "../ui/feedback";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/primitives";
import { channel, TAB_DRAG_TYPE } from "./channel";
import { CommandPalette } from "./CommandPalette";
import { IncidentPopups } from "./IncidentPopups";
import { StatusBar } from "./StatusBar";
import { TabPane } from "./TabPane";
import { popoutPath } from "./tabContext";
import { defaultTitle, type Tab } from "./tabs";
import { useThemeSync } from "./theme";
import { SignInScreen, useSignInRequired } from "./SignIn";

const params = new URLSearchParams(location.search);
const tabId = params.get("id") ?? `w${Date.now()}`;
popoutPath.setState({ path: params.get("path") ?? "/" });

export function Popout() {
  useThemeSync();
  const { data: me } = useMe();
  const signInRequired = useSignInRequired();
  const path = popoutPath((s) => s.path);
  const title =
    params.get("title") && pageForPath(path) === pageForPath(params.get("path") ?? "/")
      ? params.get("title")!
      : defaultTitle(path);
  const tab = useMemo<Tab>(
    () => ({ id: tabId, path, title, pinned: false, dirty: false, alert: false }),
    [path, title],
  );
  const asWorkspaceTab = (): WorkspaceTab => ({ id: tab.id, path: tab.path, title: tab.title, pinned: false });

  useEffect(() => {
    document.title = `${title} · Xpert`;
    history.replaceState(null, "", `/popout?${new URLSearchParams({ path, title, id: tabId })}`);
  }, [path, title]);
  useEffect(() => (me ? startLiveRelay(me.id) : undefined), [me]);
  // The main window docked this tab (drag back or Dock button): close this window.
  useEffect(() => channel.on((m) => m.type === "docked" && m.tabId === tabId && window.close()), []);

  const dock = () => channel.post({ type: "dock", tab: asWorkspaceTab() });
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify(asWorkspaceTab()));
    e.dataTransfer.setData("text/plain", tab.title);
    e.dataTransfer.effectAllowed = "move";
  };

  if (signInRequired)
    return (
      <div className="shell popout">
        <SignInScreen />
      </div>
    );
  return (
    <div className="shell popout">
      <header className="popout-bar">
        <span
          className="popout-handle"
          draggable
          onDragStart={onDragStart}
          title="Drag onto the main window's tab strip to dock"
        >
          <Icon name={pageForPath(path)?.icon ?? "file"} size={14} />
          <span>{title}</span>
        </span>
        <span className="fb-spacer" />
        <Button small icon="dock" onClick={dock}>
          Dock back
        </Button>
      </header>
      <main className="panes">
        <TabPane tab={tab} shown focused popout />
      </main>
      <StatusBar tabId={tabId} />
      <CommandPalette popout />
      <IncidentPopups popout />
      <FeedbackLayer />
    </div>
  );
}
