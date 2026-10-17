// Top menu bar (§15.1): logo, main menu with dropdowns, search / jump-to (Ctrl K), live TPS
// pill, alert bell with count, user avatar.
import { useEffect, useRef, useState } from "react";
import { useMe, useUpdatePreferences } from "../api/hooks";
import { SECTIONS, pagesOf, pageForPath, type SectionKey } from "../nav/registry";
import { Icon } from "../ui/Icon";
import { Menu, Popover } from "../ui/primitives";
import { openIncidents, useLive } from "../live/store";
import { useTabs } from "./tabs";
import { useOpener } from "./useOpener";
import { useToggleTheme } from "./theme";
import { usePalette } from "./CommandPalette";
import { openMyPassword } from "../pages/admin/parts";
import { openAlertSounds } from "../pages/monitoring/alerts/parts";

const fmtTps = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 1 : 0 });

function SectionMenu({ section, current }: { section: SectionKey; current: boolean }) {
  const open = useOpener();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const pages = pagesOf(section);
  const label = SECTIONS.find((s) => s.key === section)!.label;
  if (pages.length === 1) {
    const only = pages[0]!;
    return (
      <button
        type="button"
        className={`menu-top${current ? " current" : ""}`}
        onClick={(e) => open(only.path, e)}
        onAuxClick={(e) => e.button === 1 && open(only.path, e)}
      >
        {label}
      </button>
    );
  }
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`menu-top${current ? " current" : ""}${shown ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={shown}
        onClick={() => setShown((v) => !v)}
      >
        {label}
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover anchor={ref} open={shown} onClose={() => setShown(false)} className="menu-drop">
        <div className="menu" role="menu">
          {pages.map((pg) => (
            <button
              key={pg.key}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={(e) => {
                setShown(false);
                open(pg.path, e);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  setShown(false);
                  open(pg.path, e);
                }
              }}
            >
              <Icon name={pg.icon} size={14} />
              <span>{pg.label}</span>
              {pg.step !== "3" && <span className="menu-step">{pg.step === "5" ? "later" : `step ${pg.step}`}</span>}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function AlertBell() {
  const live = useLive();
  const { data: me } = useMe();
  // The user's alert sounds (§13.6) drive the live store.
  useEffect(() => {
    if (me?.preferences.alertSounds) useLive.setState({ sounds: me.preferences.alertSounds });
  }, [me?.preferences.alertSounds]);
  const open = useOpener();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const active = openIncidents(live);
  const unseen = active.filter((i) => !live.seen.has(i.incidentId)).length;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="bell"
        aria-label={`Alerts: ${active.length} open`}
        title={`${active.length} open incident${active.length === 1 ? "" : "s"}`}
        onClick={() => {
          setShown((v) => !v);
          live.markAllSeen();
        }}
      >
        <Icon name="bell" size={17} />
        {active.length > 0 && <span className={`bell-count${unseen ? " unseen" : ""}`}>{active.length}</span>}
      </button>
      <Popover anchor={ref} open={shown} onClose={() => setShown(false)} align="end" className="bell-pop">
        <div className="bell-head">
          <strong>Incidents</strong>
          <button
            type="button"
            className="link"
            onClick={() => {
              setShown(false);
              open("/monitoring/incidents");
            }}
          >
            All incidents
          </button>
        </div>
        {live.incidents.length === 0 && (
          <p className="muted pad">No incidents yet. They appear here as alert rules fire.</p>
        )}
        <ul className="bell-list">
          {live.incidents.slice(0, 12).map((i) => (
            <li key={i.incidentId} className={`sev-${i.severity}${i.state === "recovered" ? " recovered" : ""}`}>
              <span
                className={`dot dot-${i.state === "recovered" ? "good" : i.severity === "critical" ? "error" : "warning"}`}
              />
              <div>
                <div>{i.message}</div>
                <div className="muted small">
                  {i.state === "recovered" ? "Recovered" : i.state === "acknowledged" ? "Acknowledged" : "Open"} ·{" "}
                  {new Date(i.startedAt).toISOString().slice(11, 16)} UTC
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}

function Avatar() {
  const { data: me } = useMe();
  const toggleTheme = useToggleTheme();
  const prefs = useUpdatePreferences();
  const open = useOpener();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const dark = me?.preferences.theme === "dark";
  return (
    <>
      <button ref={ref} type="button" className="avatar" aria-label="User menu" onClick={() => setShown((v) => !v)}>
        {me?.initials ?? "··"}
      </button>
      <Popover anchor={ref} open={shown} onClose={() => setShown(false)} align="end">
        <div className="avatar-head">
          <strong>{me?.displayName ?? "Not signed in"}</strong>
          <span className="muted small">
            {me?.role} – {me?.businessCompany}
          </span>
        </div>
        <Menu
          onClose={() => setShown(false)}
          items={[
            { label: dark ? "Light theme" : "Dark theme", icon: dark ? "sun" : "moon", onSelect: toggleTheme },
            {
              label:
                me?.preferences.openInNewTab === false ? "Open pages in a new tab" : "Open pages in the current tab",
              icon: "external",
              onSelect: () => prefs.mutate({ openInNewTab: me?.preferences.openInNewTab === false }),
            },
            {
              // Live value animations (§13.3): counter roll, bar grow, row reorder.
              label: me?.preferences.animations === false ? "Turn animations on" : "Turn animations off",
              icon: "sparkles",
              onSelect: () => prefs.mutate({ animations: me?.preferences.animations === false }),
            },
            "separator",
            { label: "My changes", icon: "history", onSelect: () => open(`/admin/changes?mine=1`) },
            // §13.28: current password, 2FA code and the new-password rules.
            { label: "Change password", icon: "lock", disabled: !me, onSelect: () => me && void openMyPassword(me.id) },
            // §13.6: mute and a sound per severity.
            { label: "Alert sounds", icon: "bell", onSelect: () => void openAlertSounds() },
            { label: "Sign out", icon: "logout", disabled: true, hint: "§13.28", onSelect: () => undefined },
          ]}
        />
      </Popover>
    </>
  );
}

export function TopMenu() {
  const activePath = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.path ?? "/");
  const currentSection = pageForPath(activePath)?.section;
  const totalTps = useLive((s) => s.totalTps);
  const connected = useLive((s) => s.connected);
  const openPalette = usePalette((s) => s.show);
  const open = useOpener();
  return (
    <header className="topbar">
      <button type="button" className="logo" onClick={(e) => open("/", e)} aria-label="Home">
        <span className="logo-mark" />
        <span>SMS Platform</span>
      </button>
      <nav className="menu-bar" aria-label="Main menu">
        {SECTIONS.map((s) => (
          <SectionMenu key={s.key} section={s.key} current={s.key === currentSection && activePath !== "/"} />
        ))}
      </nav>
      <div className="topbar-right">
        <button type="button" className="jump" onClick={() => openPalette()}>
          <Icon name="search" size={14} />
          <span>Search or jump to…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button
          type="button"
          className={`tps-pill${connected ? "" : " offline"}`}
          title={connected ? "Total TPS right now (live)" : "Live feed not connected"}
          onClick={(e) => open("/dashboard", e)}
        >
          <span className="dot" />
          {totalTps === null ? "— TPS" : `${fmtTps(totalTps)} TPS`}
        </button>
        <AlertBell />
        <Avatar />
      </div>
    </header>
  );
}
