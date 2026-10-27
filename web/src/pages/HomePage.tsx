// Home tab (pinned, §15.1): Dashboard and Live analytics first, then the user's most used and recent pages.
import { useMe } from "../api/hooks";
import { HOME, PAGES, SECTIONS } from "../nav/registry";
import { PageHeader } from "../page/PageHeader";
import { usePageStatus, useTabNavigate } from "../shell/tabContext";
import { Icon } from "../ui/Icon";
import { useMyPages } from "../api/team";
import { ago, homeEntries, type HomeEntry } from "./homeModel";

function EntryButton({ entry, open, meta }: { entry: HomeEntry; open: OpenFn; meta?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => open(entry.path, e)}
      onAuxClick={(e) => e.button === 1 && open(entry.path, e)}
    >
      <Icon name={entry.page.icon} />
      <span>
        <strong>{entry.label}</strong>
        <span className="muted small">{entry.path === entry.page.path ? entry.page.summary : entry.page.label}</span>
      </span>
      {meta && <span className="muted small home-meta">{meta}</span>}
    </button>
  );
}

type OpenFn = (path: string, e: React.MouseEvent) => void;

export function HomePage() {
  const { data: me } = useMe();
  const mine = useMyPages();
  const navigate = useTabNavigate();
  usePageStatus({ rows: `${PAGES.length} pages in ${SECTIONS.length} menus` });
  const open: OpenFn = (path, e) =>
    navigate(path, e.ctrlKey || e.metaKey || e.button === 1 ? { forceNew: true } : { newTab: true });
  const { pinned, mostUsed, fromHistory, recent } = homeEntries(mine.data?.pages ?? []);
  return (
    <div className="page home">
      <PageHeader page={HOME} title={me ? `Welcome, ${me.displayName.split(" ")[0]}` : "Welcome"} />
      <div className="home-body">
        <section className="card">
          <h2>Daily screens</h2>
          {/* Dashboard and Live analytics always first (team trial round 1). */}
          <div className="home-pinned">
            {pinned.map((entry) => (
              <EntryButton key={entry.path} entry={entry} open={open} />
            ))}
          </div>
          <h3 className="home-sub">{fromHistory ? "Most used by you" : "Most used"}</h3>
          <ul className="home-list">
            {mostUsed.map((entry) => (
              <li key={entry.path}>
                <EntryButton
                  entry={entry}
                  open={open}
                  meta={entry.views ? `${entry.views.toLocaleString("en-US")}× in 30 days` : undefined}
                />
              </li>
            ))}
          </ul>
          <h3 className="home-sub">Recently opened</h3>
          {recent.length ? (
            <ul className="home-list">
              {recent.map((entry) => (
                <li key={entry.path}>
                  <EntryButton entry={entry} open={open} meta={entry.lastAt ? ago(entry.lastAt) : undefined} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Pages and records you open show here.</p>
          )}
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
        </section>
      </div>
    </div>
  );
}
