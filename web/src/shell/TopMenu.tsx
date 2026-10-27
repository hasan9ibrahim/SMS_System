// Top menu bar (§15.1): logo, main menu with dropdowns, search / jump-to (Ctrl K), system clock, live TPS
// pill, alert bell with count, user avatar.
import { useCanView } from "../api/access";
import { useEffect, useRef, useState } from "react";
import { useMe, useUpdatePreferences } from "../api/hooks";
import { SECTIONS, pagesOf, pageForPath, type SectionKey } from "../nav/registry";
import { Icon } from "../ui/Icon";
import { Menu, Popover } from "../ui/primitives";
import { openIncidents, useLive } from "../live/store";
import { useTabs } from "./tabs";
import { useOpener } from "./useOpener";
import { THEMES, useSetTheme } from "./theme";
import { usePalette } from "./CommandPalette";
import { openMyPassword } from "../pages/admin/parts";
import { openAlertSounds } from "../pages/monitoring/alerts/parts";
import { ask } from "../ui/feedback";
import { ViewAsDialog } from "./ViewAsBanner";
import { SystemClock } from "./SystemClock";
import { signOut } from "./SignIn";

const fmtTps = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 1 : 0 });

function SectionMenu({ section, current }: { section: SectionKey; current: boolean }) {
  const open = useOpener();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const canView = useCanView();
  const pages = pagesOf(section).filter((pg) => canView(pg.key)); // §11: pages the access group allows
  const label = SECTIONS.find((s) => s.key === section)!.label;
  if (pages.length === 0) return null;
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
          <p className="muted pad">No incidents yet.</p>
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
  const setTheme = useSetTheme();
  const prefs = useUpdatePreferences();
  const open = useOpener();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const theme = me?.preferences.theme ?? "light";
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
            // The two themes not in use (blue-grey added in team trial round 6).
            ...THEMES.filter((t) => t.value !== theme).map((t) => ({
              label: `${t.label} theme`,
              icon: t.value === "light" ? ("sun" as const) : ("moon" as const),
              onSelect: () => setTheme(t.value),
            })),
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
            // §13.17: administrators preview the system with another user's visibility policy.
            ...(me?.permissions.includes("*")
              ? [
                  {
                    label: "View as user…",
                    icon: "eye" as const,
                    onSelect: () => void ask<null>((done) => <ViewAsDialog done={done} />),
                  },
                ]
              : []),
            // §13.28: current password, 2FA code and the new-password rules.
            { label: "Change password", icon: "lock", disabled: !me, onSelect: () => me && void openMyPassword(me.id) },
            // §13.6: mute and a sound per severity.
            { label: "Alert sounds", icon: "bell", onSelect: () => void openAlertSounds() },
            { label: "Sign out", icon: "logout", onSelect: () => void signOut() },
          ]}
        />
      </Popover>
    </>
  );
}

/** Phones (team trial round 5): the main menu as a drawer behind a menu button; every page one tap away. */
function MobileNav({ onClose }: { onClose: () => void }) {
  const open = useOpener();
  const canView = useCanView();
  const activePath = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.path ?? "/");
  const [section, setSection] = useState<SectionKey | null>(pageForPath(activePath)?.section ?? null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="mnav-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <nav className="mnav" aria-label="Main menu">
        <div className="mnav-head">
          <strong>Menu</strong>
          <button type="button" className="icon-btn" aria-label="Close menu" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {SECTIONS.map((sec) => {
          const pages = pagesOf(sec.key).filter((pg) => canView(pg.key));
          if (!pages.length) return null;
          const expanded = section === sec.key || pages.length === 1;
          return (
            <div key={sec.key} className="mnav-section">
              <button
                type="button"
                className={`mnav-top${expanded ? " open" : ""}`}
                aria-expanded={expanded}
                onClick={(e) => {
                  if (pages.length === 1) {
                    onClose();
                    open(pages[0]!.path, e);
                  } else setSection(expanded ? null : sec.key);
                }}
              >
                <span>{sec.label}</span>
                {pages.length > 1 && <Icon name="chevronDown" size={14} />}
              </button>
              {expanded && pages.length > 1 && (
                <div className="mnav-pages">
                  {pages.map((pg) => (
                    <button
                      key={pg.key}
                      type="button"
                      className={`mnav-page${pg.path === activePath ? " current" : ""}`}
                      onClick={(e) => {
                        onClose();
                        open(pg.path, e);
                      }}
                    >
                      <Icon name={pg.icon} size={15} />
                      <span>{pg.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

export function TopMenu() {
  const [navOpen, setNavOpen] = useState(false);
  const activePath = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.path ?? "/");
  const currentSection = pageForPath(activePath)?.section;
  const totalTps = useLive((s) => s.totalTps);
  const connected = useLive((s) => s.connected);
  const openPalette = usePalette((s) => s.show);
  const open = useOpener();
  return (
    // One bar (team trial round 3): logo, the main menu, then search / jump-to and the status on the right.
    <header className="topbar">
      <div className="topbar-main">
        <button type="button" className="menu-burger" aria-label="Open menu" onClick={() => setNavOpen(true)}>
          <Icon name="list" size={18} />
        </button>
        <button type="button" className="logo" onClick={(e) => open("/", e)} aria-label="Home">
          <span className="logo-mark">
            <Icon name="mail" size={14} />
          </span>
          <span>SMS Platform</span>
        </button>
        <nav className="menu-bar" aria-label="Main menu">
          {SECTIONS.map((s) => (
            <SectionMenu key={s.key} section={s.key} current={s.key === currentSection && activePath !== "/"} />
          ))}
        </nav>
        <div className="topbar-right">
          <button type="button" className="jump" onClick={() => openPalette()}>
            <Icon name="search" size={15} />
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
          <SystemClock />
          <AlertBell />
          <Avatar />
        </div>
      </div>
      {navOpen && <MobileNav onClose={() => setNavOpen(false)} />}
    </header>
  );
}
