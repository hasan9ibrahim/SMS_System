// Page tab strip (§15.1, §13.5): icon, title and close per tab, pinned Home, red dot on
// tabs with an alert, "+" for a new tab, open-tabs list on the right. Tabs reorder by drag;
// dragging a tab out of the window opens it in its own window, dragging it back docks it.
// Tabs can be grouped under a label and colour, Chrome style (team trial round 8).
import { useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { TabGroup, WorkspaceTab } from "@sms/contract";
import { pageForPath } from "../nav/registry";
import { Icon } from "../ui/Icon";
import { Menu, Popover, type MenuItem } from "../ui/primitives";
import { usePalette } from "./CommandPalette";
import { TAB_DRAG_TYPE } from "./channel";
import { GROUP_COLORS, HOME_TAB_ID, useTabs, type Tab } from "./tabs";
import { useLive } from "../live/store";
import { useTabPaused } from "./livePause";
import { useReloadTab } from "./reload";

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

function TabButton({
  tab,
  active,
  index,
  editGroup,
}: {
  tab: Tab;
  active: boolean;
  index: number;
  editGroup: (id: string) => void;
}) {
  const { activate, close, move, togglePin, duplicate, closeOthers } = useTabs.getState();
  const reload = useReloadTab();
  const groups = useTabs((s) => s.groups);
  const group = groups.find((g) => g.id === tab.groupId);
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
        // Tab groups (team trial round 8).
        { label: "Add tab to new group", icon: "plus", onSelect: () => editGroup(useTabs.getState().newGroup(tab.id)) },
        ...groups
          .filter((g) => g.id !== tab.groupId)
          .map((g) => ({
            label: `Add to group “${g.label || colorName(g.color)}”`,
            icon: "folder" as const,
            onSelect: () => useTabs.getState().addToGroup(tab.id, g.id),
          })),
        ...(tab.groupId
          ? [{ label: "Remove from group", icon: "x" as const, onSelect: () => useTabs.getState().removeFromGroup(tab.id) }]
          : []),
        "separator",
        { label: tab.pinned ? "Unpin" : "Pin", icon: "pin", onSelect: () => togglePin(tab.id) },
        { label: "Reload", icon: "refresh", onSelect: () => reload(tab.id) },
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
      className={`tab${active ? " active" : ""}${tab.pinned ? " pinned" : ""}${group ? ` grouped tg-${group.color}` : ""}${
        dropSide ? ` drop-${dropSide}` : ""
      }`}
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
      {isLivePath(tab.path) ? <LiveLight tab={tab.id} /> : tab.alert && <span className="tab-alert" aria-label="Alert" />}
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

const colorName = (c: TabGroup["color"]) => c[0]!.toUpperCase() + c.slice(1);

/**
 * The group's label in its colour, before its tabs (Chrome style, team trial round 8): click folds or unfolds the
 * group; right-click (or a new group) opens the editor: name, colour, new tab in the group, ungroup, close group.
 */
function GroupChip({
  group,
  count,
  editing,
  setEditing,
}: {
  group: TabGroup;
  count: number;
  editing: boolean;
  setEditing: (on: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { updateGroup } = useTabs.getState();
  const [dropOver, setDropOver] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`tab-group tg-${group.color}${group.collapsed ? " collapsed" : ""}${group.label ? "" : " empty"}${
          dropOver ? " drop" : ""
        }`}
        aria-expanded={!group.collapsed}
        title={`${group.label || "Unnamed group"} · ${count} tab${count === 1 ? "" : "s"} · click to ${
          group.collapsed ? "show" : "hide"
        } them, right-click to edit`}
        onClick={() => updateGroup(group.id, { collapsed: !group.collapsed })}
        onContextMenu={(e) => {
          e.preventDefault();
          setEditing(true);
        }}
        // A tab dropped on the label joins the group.
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
          e.preventDefault();
          setDropOver(true);
        }}
        onDragLeave={() => setDropOver(false)}
        onDrop={(e) => {
          setDropOver(false);
          const raw = e.dataTransfer.getData(TAB_DRAG_TYPE);
          if (!raw) return;
          e.preventDefault();
          e.stopPropagation();
          const dragged = JSON.parse(raw) as WorkspaceTab;
          if (useTabs.getState().tabs.some((t) => t.id === dragged.id))
            useTabs.getState().addToGroup(dragged.id, group.id);
        }}
      >
        {group.label ? <span className="tab-group-label">{group.label}</span> : <span className="tab-group-dot" />}
        {group.collapsed && <span className="tab-group-count">{count}</span>}
      </button>
      <Popover anchor={ref} open={editing} onClose={() => setEditing(false)}>
        <GroupEditor group={group} done={() => setEditing(false)} />
      </Popover>
    </>
  );
}

function GroupEditor({ group, done }: { group: TabGroup; done: () => void }) {
  const s = useTabs.getState();
  const openPalette = usePalette((p) => p.show);
  const [label, setLabel] = useState(group.label);
  const save = (next: string) => s.updateGroup(group.id, { label: next.slice(0, 40) });
  return (
    <div className="tab-group-editor" role="dialog" aria-label="Tab group">
      <input
        autoFocus
        value={label}
        maxLength={40}
        placeholder="Name this group"
        aria-label="Group name"
        onChange={(e) => {
          setLabel(e.target.value);
          save(e.target.value);
        }}
        onKeyDown={(e) => e.key === "Enter" && done()}
      />
      <div className="tab-group-colors" role="radiogroup" aria-label="Colour">
        {GROUP_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={group.color === c}
            aria-label={colorName(c)}
            title={colorName(c)}
            className={`tab-group-swatch tg-${c}${group.color === c ? " on" : ""}`}
            onClick={() => s.updateGroup(group.id, { color: c })}
          />
        ))}
      </div>
      <Menu
        onClose={done}
        items={[
          {
            label: "New tab in group",
            icon: "plus",
            // From the group's last tab, the page picker's new tab lands next to it and joins the group.
            onSelect: () => {
              const last = [...s.tabs].reverse().find((t) => t.groupId === group.id);
              if (last) s.activate(last.id);
              openPalette({ newTab: true });
            },
          },
          { label: "Ungroup", icon: "x", onSelect: () => s.ungroup(group.id) },
          { label: "Close group", icon: "x", danger: true, onSelect: () => void s.closeGroup(group.id) },
        ]}
      />
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
  const groups = useTabs((s) => s.groups);
  const [editing, setEditing] = useState<string | null>(null);
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
        {tabs.map((t, i) => {
          const group = groups.find((g) => g.id === t.groupId);
          // The group's label goes before its first tab; a folded group hides its tabs.
          const first = group && tabs[i - 1]?.groupId !== group.id;
          return [
            first && (
              <GroupChip
                key={`g-${group.id}`}
                group={group}
                count={tabs.filter((x) => x.groupId === group.id).length}
                editing={editing === group.id}
                setEditing={(on) => setEditing(on ? group.id : null)}
              />
            ),
            !group?.collapsed && (
              <TabButton
                key={t.id}
                tab={t}
                active={t.id === activeId}
                index={i}
                editGroup={(id) => setEditing(id)}
              />
            ),
          ];
        })}
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

/** Pages fed by the live connection (Dashboard, Live analytics …) show its light on their tab (team trial round 6). */
export const isLivePath = (path: string) =>
  ["/dashboard", "/live"].some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));

/** Green while live data arrives; red while the connection is down or the page is paused / not live (round 6). */
function LiveLight({ tab }: { tab: string }) {
  const connected = useLive((s) => s.connected);
  const paused = useTabPaused(tab);
  const label = !connected ? "Live data disconnected" : paused ? "Not live (paused or a past period)" : "Live";
  return <span className={`tab-live${connected && !paused ? " on" : ""}`} role="img" aria-label={label} title={label} />;
}

