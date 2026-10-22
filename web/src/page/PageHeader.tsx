// Page header (§15.1): title and purpose, actions on the right with the main action as the one filled button
// (§15.3), then the sibling pages of the same section as pills (current filled).
import { useContext, useEffect, type ReactNode } from "react";
import { pagesOf, type PageDef } from "../nav/registry";
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
}: {
  page: PageDef;
  title?: string;
  /** Help topic the ? button opens; defaults to the page's own (a record screen names its own). */
  helpTopic?: string;
  /** Replaces the plain title, e.g. a record picker (§5.1); must contain the page's h1. */
  heading?: ReactNode;
  actions?: ReactNode;
}) {
  const navigate = useTabNavigate();
  const siblings = page.key === "home" ? [] : pagesOf(page.section);
  // Design refresh (team trial round 2): title with the page's one-line purpose under it and the actions on the
  // right, then the sibling pages as pills.
  const subtitle = !heading && !title ? page.summary : null;
  return (
    <div className="page-header">
      <div className="page-header-top">
        <BackButton />
        <div className="page-heading">
          <div className="page-title-row">
            {heading ?? <h1>{title ?? page.label}</h1>}
            {page.key !== "help" && <HelpButton topic={helpTopic ?? page.key} />}
          </div>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        <div className="page-actions">{actions}</div>
      </div>
      {siblings.length > 1 && (
        <nav className="siblings" aria-label={`${page.label} and related pages`}>
          {siblings.map((s) => (
            <a
              key={s.key}
              href={s.path}
              className={s.key === page.key ? "current" : ""}
              aria-current={s.key === page.key ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(s.path, e.ctrlKey || e.metaKey ? { forceNew: true } : {});
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  navigate(s.path, { forceNew: true });
                }
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
