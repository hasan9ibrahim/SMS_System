// Opening pages (§13.5): menu items and row links open in a new tab or the current tab by
// user preference; Ctrl/Cmd-click or middle-click always opens a new tab.
import { useMe } from "../api/hooks";
import { channel } from "./channel";
import { useTabs } from "./tabs";

export interface OpenEvent {
  ctrlKey?: boolean;
  metaKey?: boolean;
  button?: number;
}

export function useOpener(opts: { popout?: boolean } = {}) {
  const { data: me } = useMe();
  return (path: string, e?: OpenEvent, title?: string) => {
    if (opts.popout) {
      // A pop-out window has no tab strip: open in the main window.
      channel.post({ type: "open", path, ...(title ? { title } : {}) });
      return;
    }
    const force = !!e && (e.ctrlKey === true || e.metaKey === true || e.button === 1);
    useTabs.getState().open(path, {
      newTab: force || (me?.preferences.openInNewTab ?? true),
      forceNew: force,
      background: e?.button === 1,
      ...(title ? { title } : {}),
    });
  };
}
