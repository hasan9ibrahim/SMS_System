// Page header (§15.1): title, actions on the right with the main action as the one filled button
// (§15.3), then the sibling pages of the same section as pills (current filled).
import { useContext, useEffect, type ReactNode } from "react";
import type { PageDef } from "../nav/registry";
import { TabContext, useTabNavigate } from "../shell/tabContext";
import { canGoBack, useTabs } from "../shell/tabs";
import { Icon } from "../ui/Icon";

/**
 * Back to the page opened before in this tab, or to the tab this one was opened from (team trial
 * round 1). Alt+Left does the same on the active tab.
 */
function BackButton() {
  const ctx = useContext(TabContext);
  const id = ctx?.tab.id;
  const enabled = useTabs((s) => (id && !ctx?.popout ? canGoBack(s, id) : false));
  const active = !!ctx?.active && !ctx.popout;
  useEffect(() => {
    if (!active || !id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "ArrowLeft" && useTabs.getState().goBack(id)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, id]);
  if (!id || ctx?.popout) return null;
  return (
    <button
      type="button"
      className="icon-btn page-back"
      title="Back to the previous page (Alt+←)"
      aria-label="Back"
      disabled={!enabled}
      onClick={() => useTabs.getState().goBack(id)}
    >
      <Icon name="arrowLeft" />
    </button>
  );
}

/** Opens this page's help topic in a new tab (§15.1 help). */
function HelpButton({ topic }: { topic: string }) {
  return (
    <button
      type="button"
      className="icon-btn page-help"
      title="Help for this page"
      aria-label="Help for this page"
      onClick={() => useTabs.getState().open(`/help?topic=${topic}`, { newTab: true })}
    >
      <Icon name="help" />
    </button>
  );
}

export function PageHeader({
  page,
  title,
  heading,
  actions,
  helpTopic,
  crumbs,
  avatar,
  meta,
}: {
  page: PageDef;
  title?: string;
  /**
   * Record screens (team trial round 4): a breadcrumb above the title (the list, then the record) instead of the
   * sibling pills, a coloured initials tile before the title and a line of chips and facts under it.
   */
  crumbs?: { label: string; path?: string }[];
  avatar?: ReactNode;
  meta?: ReactNode;
  /** Help topic the ? button opens; defaults to the page's own (a record screen names its own). */
  helpTopic?: string;
  /** Replaces the plain title, e.g. a record picker (§5.1); must contain the page's h1. */
  heading?: ReactNode;
  actions?: ReactNode;
}) {
  const navigate = useTabNavigate();
  // Design refresh (team trial round 2): title and the actions on the right. The one-line purpose under the title was
  // dropped (round 3); the sibling page pills beside it too (round 5: the top menu already lists them).
  return (
    <div className={`page-header${crumbs ? " record-header" : ""}`}>
      {crumbs && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className="crumb">
              {i > 0 && <Icon name="chevronRight" size={12} />}
              {c.path ? (
                <a
                  href={c.path}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(c.path!, e.ctrlKey || e.metaKey ? { forceNew: true } : {});
                  }}
                >
                  {c.label}
                </a>
              ) : (
                <span aria-current="page">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="page-header-top">
        <BackButton />
        {avatar}
        <div className="page-heading">
          <div className="page-title-row">
            {heading ?? <h1>{title ?? page.label}</h1>}
            {page.key !== "help" && <HelpButton topic={helpTopic ?? page.key} />}
          </div>
          {meta && <div className="record-chips">{meta}</div>}
        </div>
        <div className="page-actions">{actions}</div>
      </div>
    </div>
  );
}

/** Initials on a soft colour tile, the colour picked from the name (record headers and cards, team trial round 4). */
export function Avatar({ name, size = "lg", icon }: { name: string; size?: "sm" | "md" | "lg"; icon?: ReactNode }) {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/);
  const initials = ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 6;
  return (
    <span className={`avatar-tile size-${size} hue-${h}`} aria-hidden="true">
      {icon ?? initials}
    </span>
  );
}
