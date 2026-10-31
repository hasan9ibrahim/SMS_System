// Pages whose screens come in a later build step (CLAUDE.md "Build order"): the layout, menu,
// tabs and Ctrl K already reach them, and they say what they will hold, without build-step or
// spec numbers (§15).
import { useLocation } from "react-router";
import { PAGES, type PageDef } from "../nav/registry";
import { PageHeader } from "../page/PageHeader";
import { usePageStatus } from "../shell/tabContext";
import { Icon } from "../ui/Icon";

export function PlaceholderPage({ page }: { page: PageDef }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const context = [...params.entries()].filter(([k]) => k !== "g").map(([k, v]) => `${k} #${v}`);
  usePageStatus({ rows: "" });
  return (
    <div className="page">
      <PageHeader page={page} />
      <div className="placeholder">
        <Icon name={page.icon} size={28} />
        <h2>{page.label}</h2>
        <p>{page.summary}.</p>
        <p className="muted">This page is not available yet.</p>
        {context.length > 0 && <p className="muted small">Opened for {context.join(", ")}.</p>}
      </div>
    </div>
  );
}

export function NotFoundPage() {
  const location = useLocation();
  usePageStatus({ rows: "" });
  return (
    <div className="page">
      <div className="placeholder">
        <Icon name="alert" size={28} />
        <h2>No page at {location.pathname}</h2>
        <p className="muted">Use the menu or Ctrl K to find a page. {PAGES.length} pages are available.</p>
      </div>
    </div>
  );
}
