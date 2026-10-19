// Split view side bar (§15.1, team trial round 1: "control what tabs I see in each view"): each side
// picks its own tab, the two can swap, and the focused side is marked; clicking a tab in the strip
// shows it on the focused side.
import { useTabs, type Tab } from "./tabs";
import { Icon } from "../ui/Icon";

export function SplitPaneBar({ side, tab, focused }: { side: "left" | "right"; tab: Tab; focused: boolean }) {
  const tabs = useTabs((s) => s.tabs);
  const label = side === "left" ? "Left" : "Right";
  return (
    <div className={`split-bar${focused ? " focused" : ""}`}>
      <span className="split-bar-side">{label}</span>
      <select
        aria-label={`${label} side tab`}
        value={tab.id}
        onChange={(e) => useTabs.getState().setPane(side, e.target.value)}
      >
        {tabs.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
      {focused && <span className="muted small">Tabs you click open here</span>}
      <span className="fb-spacer" />
      {side === "left" && (
        <button
          type="button"
          className="icon-btn"
          title="Swap sides"
          aria-label="Swap sides"
          onClick={() => useTabs.getState().swapSides()}
        >
          <Icon name="shuffle" size={13} />
        </button>
      )}
      {side === "right" && (
        <button
          type="button"
          className="icon-btn"
          title="Close split view"
          aria-label="Close split view"
          onClick={() => useTabs.getState().toggleSplit()}
        >
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
}
