// Home tab (pinned, §15.1): where the daily screens are, and what each build step brings.
import { useMe } from "../api/hooks";
import { HOME, PAGES, SECTIONS } from "../nav/registry";
import { PageHeader } from "../page/PageHeader";
import { usePageStatus, useTabNavigate } from "../shell/tabContext";
import { Icon } from "../ui/Icon";

const DAILY = ["enterprises", "rate-manager", "route-rules", "rate-lookup", "enterprise-report", "dashboard"];

export function HomePage() {
  const { data: me } = useMe();
  const navigate = useTabNavigate();
  usePageStatus({ rows: `${PAGES.length} pages in ${SECTIONS.length} menus` });
  const open = (path: string, e: React.MouseEvent) =>
    navigate(path, e.ctrlKey || e.metaKey || e.button === 1 ? { forceNew: true } : { newTab: true });
  return (
    <div className="page home">
      <PageHeader page={HOME} title={me ? `Welcome, ${me.displayName.split(" ")[0]}` : "Welcome"} />
      <div className="home-body">
        <section className="card">
          <h2>Daily screens</h2>
          <ul className="home-list">
            {DAILY.map((key) => {
              const pg = PAGES.find((p) => p.key === key)!;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={(e) => open(pg.path, e)}
                    onAuxClick={(e) => e.button === 1 && open(pg.path, e)}
                  >
                    <Icon name={pg.icon} />
                    <span>
                      <strong>{pg.label}</strong>
                      <span className="muted small">{pg.summary}</span>
                    </span>
                    <span className="tag">{pg.step === "3" ? "ready" : `step ${pg.step}`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="card">
          <h2>Working with the app</h2>
          <ul className="tips">
            <li>
              <kbd>Ctrl K</kbd> searches pages and records: enterprises, trunks, rate tables, rules and users.
            </li>
            <li>Ctrl-click or middle-click opens any link in a new tab; middle-click a tab to close it.</li>
            <li>
              Drag a tab out of the window to open it in its own window, and drag it back onto the tab strip to dock it.
            </li>
            <li>
              Every list filters on the server: type under a column header (<code>au</code>, <code>505%</code>,{" "}
              <code>&gt;=5</code>, <code>5..10</code>), or use Add filter for AND/OR conditions on any field.
            </li>
            <li>Filters can be saved as views and shared read-only with chosen colleagues.</li>
            <li>
              <kbd>Ctrl Z</kbd> undoes your last change on the page; History lists every change with Undo.
            </li>
          </ul>
          <p className="muted small">
            The open tabs and the theme are saved to your profile and come back after you sign in again.
          </p>
        </section>
      </div>
    </div>
  );
}
