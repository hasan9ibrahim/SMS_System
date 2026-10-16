// Pages whose screens come in a later build step: the layout, menu, tabs and Ctrl K already
// reach them, and they say what they will hold.
import { useLocation, useParams } from "react-router";
import { PAGES, pageForPath, type PageDef } from "../nav/registry";
import { PageHeader } from "../page/PageHeader";
import { usePageStatus } from "../shell/tabContext";
import { Icon } from "../ui/Icon";

export function PlaceholderPage({ page }: { page: PageDef }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const context = [...params.entries()].filter(([k]) => k !== "g").map(([k, v]) => `${k} #${v}`);
  usePageStatus({ rows: "" });
  const when = page.step.startsWith("4")
    ? `build step ${page.step} (screens the team uses daily)`
    : "build step 5 (remaining screens, in spec order)";
  return (
    <div className="page">
      <PageHeader page={page} />
      <div className="placeholder">
        <Icon name={page.icon} size={28} />
        <h2>{page.label}</h2>
        <p>{page.summary}.</p>
        <p className="muted">
          Spec {page.spec} · arrives in {when}.
        </p>
        {context.length > 0 && <p className="muted small">Opened for {context.join(", ")}.</p>}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { "customer-trunks": "Customer trunk", "vendor-trunks": "Vendor trunk" };

export function TrunkPlaceholder() {
  const { kind = "", id = "" } = useParams();
  const page = pageForPath("/enterprises")!;
  usePageStatus({ rows: "" });
  return (
    <div className="page">
      <PageHeader page={page} title={`${KIND_LABEL[kind] ?? "Trunk"} #${id}`} />
      <div className="placeholder">
        <Icon name="route" size={28} />
        <h2>
          {KIND_LABEL[kind] ?? "Trunk"} #{id}
        </h2>
        <p className="muted">
          The trunk form and its Rules tab arrive with the Enterprises screen (build step 4.1, spec §5.4, §5.5, §13.2).
        </p>
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
