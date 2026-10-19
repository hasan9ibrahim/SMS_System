// Messages between the main window and tabs dragged out into their own windows (§13.5):
// docking back, theme changes and the shared live data feed.
import type { Theme, WorkspaceTab } from "@sms/contract";

export type ShellMessage =
  | { type: "dock"; tab: WorkspaceTab; atIndex?: number }
  | { type: "docked"; tabId: string }
  | { type: "theme"; theme: Theme }
  | { type: "live"; frame: unknown }
  | { type: "live-hello" }
  | { type: "live-owner" }
  | { type: "open"; path: string; title?: string };

type Listener = (msg: ShellMessage) => void;

class ShellChannel {
  private bc: BroadcastChannel | null =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("sms-shell");
  private listeners = new Set<Listener>();

  constructor() {
    // Node (unit tests) would otherwise stay alive for the open channel; browsers have no unref.
    (this.bc as unknown as { unref?: () => void } | null)?.unref?.();
    this.bc?.addEventListener("message", (e: MessageEvent<ShellMessage>) => {
      for (const l of this.listeners) l(e.data);
    });
  }

  post(msg: ShellMessage) {
    this.bc?.postMessage(msg);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const channel = new ShellChannel();

/** Data type used when a tab is dragged between windows. */
export const TAB_DRAG_TYPE = "application/x-sms-tab";
