// Page tab strip (§15.1, §13.5): icon, title and close per tab, pinned Home, red dot on
// tabs with an alert, "+" for a new tab, open-tabs list on the right. Tabs reorder by drag;
// dragging a tab out of the window opens it in its own window, dragging it back docks it.
import { useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { WorkspaceTab } from "@sms/contract";
import { pageForPath } from "../nav/registry";
import { Icon } from "../ui/Icon";
import { Menu, Popover, type MenuItem } from "../ui/primitives";
import { usePalette } from "./CommandPalette";
import { TAB_DRAG_TYPE } from "./channel";
import { HOME_TAB_ID, useTabs, type Tab } from "./tabs";

/** Opens a tab in its own browser window (second monitor) and removes it from the strip. */
export function popOutTab(tab: Tab, at?: { x: number; y: number }) {
  const params = new URLSearchParams({ path: tab.path, title: tab.title, id: tab.id });
  const w = Math.min(1400, Math.round(window.outerWidth * 0.8));
  const h = Math.min(900, Math.round(window.outerHeight * 0.8));
  const left = at ? Math.max(0, at.x - 120) : window.screenX + 60;
  const top = at ? Math.max(0, at.y - 20) : window.screenY + 60;
  const win = window.open(
    `/popout?${params}`,
    `sms-tab-${tab.id}`,
    `popup,width=${w},height=${h},left=${left},top=${top}`,
  );
  if (win) useTabs.getState().detach(tab.id);
}

const outsideWindow = (e: DragEvent) =>
  e.screenX < window.screenX ||
  e.screenX > window.screenX + window.outerWidth ||
  e.screenY < window.screenY ||
  e.screenY > window.screenY + window.outerHeight;

function TabButton({ tab, active, index }: { tab: Tab; active: boolean; index: number }) {
  const { activate, close, move, togglePin, duplicate, closeOthers } = useTabs.getState();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropSide, setDropSide] = useState<"left" | "right" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const page = pageForPath(tab.path);
  const isHome = tab.id === HOME_TAB_ID;

  const onDragStart = (e: DragEvent) => {
    if (isHome) return e.preventDefault();
    const payload: WorkspaceTab = { id: tab.id, path: tab.path, title: tab.title, pinned: tab.pinned };
    e.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify(payload));
    e.dataTransfer.setData("text/plain", tab.title);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = (e: DragEvent) => {
    // Dropped outside the browser window: open the tab in its own window.
    if (e.dataTransfer.dropEffect === "none" && outsideWindow(e)) popOutTab(tab, { x: e.screenX, y: e.screenY });
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = ref.current!.getBoundingClientRect();
    setDropSide(e.clientX < r.left + r.width / 2 ? "left" : "right");
  };
  const onDrop = (e: DragEvent) => {
    setDropSide(null);
    const raw = e.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const dragged = JSON.parse(raw) as WorkspaceTab;
    const r = ref.current!.getBoundingClientRect();
    const target = e.clientX < r.left + r.width / 2 ? index : index + 1;
    const tabs = useTabs.getState().tabs;
    const from = tabs.findIndex((t) => t.id === dragged.id);
    if (from >= 0) move(dragged.id, from < target ? target - 1 : target);
    else useTabs.getState().dock(dragged, target); // dragged back from a pop-out window
  };
  const onMouseUp = (e: ReactMouseEvent) => {
    if (e.button === 1 && !isHome) {
      e.preventDefault();
      void close(tab.id);
    }
  };

  const items: (MenuItem | "separator")[] = isHome
    ? [{ label: "Close other tabs", icon: "x", onSelect: () => void closeOthers(tab.id) }]
    : [
        { label: tab.pinned ? "Unpin" : "Pin", icon: "pin", onSelect: () => togglePin(tab.id) },
        { label: "Duplicate", icon: "copy", onSelect: () => duplicate(tab.id) },
        { label: "Open in new window", icon: "external", onSelect: () => popOutTab(tab) },
        "separator",
        { label: "Close", icon: "x", hint: "Middle-click", onSelect: () => void close(tab.id) },
        { label: "Close other tabs", onSelect: () => void closeOthers(tab.id) },
      ];

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`tab${active ? " active" : ""}${tab.pinned ? " pinned" : ""}${dropSide ? ` drop-${dropSide}` : ""}`}
      draggable={!isHome}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={() => setDropSide(null)}
      onDrop={onDrop}
      onClick={() => activate(tab.id)}
      onMouseUp={onMouseUp}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      title={tab.title}
    >
      <Icon name={page?.icon ?? "file"} size={14} />
      {tab.alert && <span className="tab-alert" aria-label="Alert" />}
      {!isHome && <span className="tab-title">{tab.title}</span>}
      {tab.dirty && <span className="tab-dirty" aria-label="Unsaved changes" title="Unsaved changes" />}
      {!isHome && !tab.pinned && (
        <button
          type="button"
          className="tab-close"
          aria-label={`Close ${tab.title}`}
          onClick={(e) => {
            e.stopPropagation();
            void close(tab.id);
          }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
      <Popover anchor={ref} open={menuOpen} onClose={() => setMenuOpen(false)}>
        <Menu items={items} onClose={() => setMenuOpen(false)} />
      </Popover>
    </div>
  );
}

function OpenTabsList() {
  const tabs = useTabs((s) => s.tabs);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" className="tabs-count" onClick={() => setShown((v) => !v)}>
        {tabs.length} tab{tabs.length === 1 ? "" : "s"} <Icon name="chevronDown" size={12} />
      </button>
      <Popover anchor={ref} open={shown} onClose={() => setShown(false)} align="end">
        <Menu
          onClose={() => setShown(false)}
          items={tabs.map((t) => ({
            label: t.title,
            icon: pageForPath(t.path)?.icon ?? "file",
            onSelect: () => useTabs.getState().activate(t.id),
          }))}
        />
      </Popover>
    </>
  );
}

function SplitButton() {
  const splitId = useTabs((s) => s.splitId);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        className={`tabs-split${splitId ? " on" : ""}`}
        title="Show two tabs side by side"
        aria-pressed={!!splitId}
        onClick={() => useTabs.getState().toggleSplit()}
        disabled={tabs.length < 2}
      >
        <Icon name="split" size={13} /> Split view
      </button>
      {splitId && (
        <>
          <button
            ref={ref}
            type="button"
            className="tabs-split-pick"
            aria-label="Choose the right-hand tab"
            onClick={() => setShown((v) => !v)}
          >
            <Icon name="chevronDown" size={12} />
          </button>
          <Popover anchor={ref} open={shown} onClose={() => setShown(false)} align="end">
            <Menu
              onClose={() => setShown(false)}
              items={tabs
                .filter((t) => t.id !== activeId)
                .map((t) => ({
                  label: t.title,
                  icon: t.id === splitId ? "check" : (pageForPath(t.path)?.icon ?? "file"),
                  onSelect: () => useTabs.getState().setSplit(t.id),
                }))}
            />
          </Popover>
        </>
      )}
    </>
  );
}

export function TabStrip() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const openPalette = usePalette((s) => s.show);
  // Dropping a tab from another window on the empty part of the strip docks it at the end.
  const onDrop = (e: DragEvent) => {
    const raw = e.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    const dragged = JSON.parse(raw) as WorkspaceTab;
    const s = useTabs.getState();
    if (s.tabs.some((t) => t.id === dragged.id)) s.move(dragged.id, s.tabs.length);
    else s.dock(dragged);
  };
  return (
    <div
      className="tabstrip"
      onDragOver={(e) => e.dataTransfer.types.includes(TAB_DRAG_TYPE) && e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="tabs" role="tablist" aria-label="Open pages">
        {tabs.map((t, i) => (
          <TabButton key={t.id} tab={t} active={t.id === activeId} index={i} />
        ))}
        <button
          type="button"
          className="tab-new"
          aria-label="New tab"
          title="New tab (Ctrl K)"
          onClick={() => openPalette({ newTab: true })}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="tabstrip-right">
        <SplitButton />
        <OpenTabsList />
      </div>
    </div>
  );
}
