// Page header (§15.1): title, the sibling pages of the same section as small links (current
// highlighted), actions on the right with the main action as the one filled button (§15.3).
import type { ReactNode } from "react";
import { pagesOf, type PageDef } from "../nav/registry";
import { useTabNavigate } from "../shell/tabContext";

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
