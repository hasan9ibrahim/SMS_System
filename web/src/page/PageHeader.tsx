// Page header (§15.1): title, the sibling pages of the same section as small links (current
// highlighted), actions on the right with the main action as the one filled button (§15.3).
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

export function PageHeader({
  page,
  title,
  heading,
  actions,
}: {
  page: PageDef;
  title?: string;
  /** Replaces the plain title, e.g. a record picker (§5.1); must contain the page's h1. */
  heading?: ReactNode;
  actions?: ReactNode;
}) {
  const navigate = useTabNavigate();
  const siblings = page.key === "home" ? [] : pagesOf(page.section);
  return (
    <div className="page-header">
      <BackButton />
      {heading ?? <h1>{title ?? page.label}</h1>}
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
      <div className="page-actions">{actions}</div>
    </div>
  );
}
