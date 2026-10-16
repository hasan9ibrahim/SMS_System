// A complete list page in the adopted layout (§15.1): page header, active-filter row,
// data grid with a filter under every column, detail panel, status-bar text. Grid state
// (filters, search, sort, columns, view) lives in the tab's URL (§13.5).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useLocation } from "react-router";
import type { ListId } from "@sms/contract";
import { useListFields } from "../api/hooks";
import { DataGrid, type ColumnOverride, type GridMeta } from "../grid/DataGrid";
import { FilterBuilder } from "../grid/FilterBuilder";
import { SaveViewButton, ViewsMenu } from "../grid/ViewsMenu";
import {
  conditionLabel,
  countConditions,
  decodeState,
  emptyState,
  encodeState,
  isFiltered,
  type GridState,
} from "../grid/filterModel";
import { HistoryDrawer, useUndoLast, useUndoShortcut, type HistoryScope } from "../history/undo";
import type { PageDef } from "../nav/registry";
import { usePageStatus, useTab, useTabNavigate } from "../shell/tabContext";
import { Icon, type IconName } from "../ui/Icon";
import { Button, Menu, Popover, type MenuItem } from "../ui/primitives";
import { PageHeader } from "./PageHeader";

export interface DetailContent {
  title: ReactNode;
  /** `actions` sit at the right of the title row while that section is shown. */
  sections: { key: string; label: string; content: ReactNode; actions?: ReactNode }[];
  aside?: ReactNode;
}

export interface ListScreenProps<Row extends { id: number }> {
  list: ListId;
  page: PageDef;
  title?: string;
  columns?: Partial<Record<string, ColumnOverride<Row>>>;
  trailing?: { header: string; width: number; render: (row: Row) => ReactNode };
  detail?: (row: Row) => DetailContent;
  onOpen?: (row: Row, e: MouseEvent | KeyboardEvent) => void;
  /** Records this page edits; enables the header Undo and History buttons (§13.10). */
  historyScope?: HistoryScope | null;
  primary?: { label: string; icon?: IconName; onClick?: () => void; disabled?: boolean; title?: string };
  /** Filters applied when the tab has none in its URL. */
  initialState?: Partial<GridState>;
  /** Page-specific controls in the filter row (e.g. an account manager picker). */
  toolbar?: (state: GridState, setState: (s: GridState) => void) => ReactNode;
  shortcuts?: string;
  /** Extra header actions, placed before the primary button (e.g. Simulate). */
  actions?: ReactNode;
  /** Enables the header Export button; receives the current filters (§13.22). */
  onExport?: (state: GridState) => void;
  /** Selection summary and the Bulk edit menu (§13.11). */
  selection?: {
    summary?: (rows: Row[], ids: ReadonlySet<number>) => ReactNode;
    bulk?: (ids: number[], clear: () => void) => (MenuItem | "separator")[];
  };
  /** Page shortcuts on the grid (e.g. E edit, D duplicate); return true when handled. */
  onKey?: (key: string, row: Row | null) => boolean;
  rowClass?: (row: Row) => string | undefined;
  /** Makes this row the active one once it is loaded (e.g. a rule just added). */
  selectId?: number | null;
  /** Controlled detail section, when the page opens a section itself. */
  section?: [string | null, (key: string) => void];
}

/** Grid state in the tab URL: ?g=<encoded>. Filter changes replace, not push. */
export function useGridUrlState(initial?: Partial<GridState>): [GridState, (s: GridState) => void] {
  const location = useLocation();
  const navigate = useTabNavigate();
  const encoded = new URLSearchParams(location.search).get("g");
  const state = useMemo(() => (encoded ? decodeState(encoded) : { ...emptyState(), ...initial }), [encoded]); // eslint-disable-line react-hooks/exhaustive-deps
  const setState = useCallback(
    (next: GridState) => {
      const params = new URLSearchParams(location.search);
      const enc = encodeState(next);
      if (enc) params.set("g", enc);
      else params.delete("g");
      const qs = params.toString();
      navigate(`${location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
    },
    [location.pathname, location.search, navigate],
  );
  return [state, setState];
}

function ColumnsMenu({
  fields,
  state,
  onChange,
}: {
  fields: ReturnType<typeof useListFields>["data"];
  state: GridState;
  onChange: (s: GridState) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!fields) return null;
  const visible = state.visible ?? fields.fields.filter((f) => !f.hidden).map((f) => f.field);
  return (
    <>
      <button ref={ref} type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>
        <Icon name="columns" size={13} /> Columns
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end" className="choice-pop">
        {fields.fields.map((f) => (
          <label key={f.field} className="choice-row">
            <input
              type="checkbox"
              checked={visible.includes(f.field)}
              onChange={(e) => {
                const next = e.target.checked
                  ? fields.fields.map((x) => x.field).filter((n) => n === f.field || visible.includes(n))
                  : visible.filter((n) => n !== f.field);
                if (next.length) onChange({ ...state, visible: next });
              }}
            />
            {f.label}
            {f.hidden && <span className="muted small">hidden by default</span>}
          </label>
        ))}
        <div className="menu-sep" />
        <button type="button" className="menu-item" onClick={() => onChange({ ...state, visible: null })}>
          <Icon name="refresh" size={13} /> <span>Default columns</span>
        </button>
      </Popover>
    </>
  );
}

/** "Show deleted" (§13.29): lists archived rows next to live ones, greyed out. */
export function ShowDeleted({ state, onChange }: { state: GridState; onChange: (s: GridState) => void }) {
  const on = !!state.columns.archived;
  return (
    <label className="toggle-inline">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          const columns = { ...state.columns };
          if (e.target.checked) columns.archived = { field: "archived", op: "in", values: [true, false] };
          else delete columns.archived;
          onChange({ ...state, columns });
        }}
      />
      Show deleted
    </label>
  );
}

function DetailPanel({
  content,
  onClose,
  section,
  setSection,
}: {
  content: DetailContent;
  onClose: () => void;
  section: string | null;
  setSection: (key: string) => void;
}) {
  const current = content.sections.find((s) => s.key === section) ?? content.sections[0];
  return (
    <section className="detail" aria-label="Details">
      <nav className="detail-nav">
        {content.sections.map((s) => (
          <button
            key={s.key}
            type="button"
            className={s.key === current?.key ? "on" : ""}
            onClick={() => setSection(s.key)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="detail-main">
        <div className="detail-title">
          {content.title}
          <span className="fb-spacer" />
          {current?.actions}
          <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {current?.content}
      </div>
      {content.aside && <aside className="detail-aside">{content.aside}</aside>}
    </section>
  );
}

export function ListScreen<Row extends { id: number }>(props: ListScreenProps<Row>) {
  const {
    list,
    page,
    title,
    columns,
    trailing,
    detail,
    onOpen,
    historyScope = null,
    primary,
    initialState,
    shortcuts,
    toolbar,
    actions,
    onExport,
    selection,
    onKey,
    rowClass,
    selectId = null,
  } = props;
  const { active } = useTab();
  const fields = useListFields(list);
  const [state, setState] = useGridUrlState(initialState);
  const [activeRow, setActiveRow] = useState<Row | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // The open detail section stays the same while the user moves between rows.
  const ownSection = useState<string | null>(null);
  const [section, setSection] = props.section ?? ownSection;
  const [rows, setRows] = useState<Row[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkRef = useRef<HTMLButtonElement>(null);
  const [meta, setMeta] = useState<GridMeta>({
    total: null,
    loaded: 0,
    isEstimate: false,
    fetching: false,
    error: null,
  });
  const [builderOpen, setBuilderOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { undoLast } = useUndoLast(historyScope);
  useUndoShortcut(historyScope, active);

  const byName = useMemo(() => new Map((fields.data?.fields ?? []).map((f) => [f.field, f])), [fields.data]);
  const total = meta.total;
  usePageStatus({
    rows:
      total === null
        ? meta.fetching
          ? "Loading…"
          : ""
        : `${total.toLocaleString("en-US")}${meta.isEstimate ? "+" : ""} rows${meta.loaded < total ? ` · ${meta.loaded.toLocaleString("en-US")} loaded` : ""}${selected.size ? ` · ${selected.size} selected` : ""}`,
    shortcuts: shortcuts ?? "↑↓ move · Space select · Enter open · Shift-click sort by two columns · Ctrl+Z undo",
  });

  const onMeta = useCallback((m: GridMeta) => setMeta(m), []);
  // Keep the active row in step with refreshed rows (a save or undo changes its figures),
  // and pick up a row the page asked for.
  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (selectId !== null && applied.current !== selectId) {
      const wanted = rows.find((r) => r.id === selectId);
      if (wanted) {
        applied.current = selectId;
        return setActiveRow(wanted);
      }
    }
    if (!activeRow) return;
    const fresh = rows.find((r) => r.id === activeRow.id);
    if (fresh && fresh !== activeRow) setActiveRow(fresh);
  }, [rows, selectId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new filter or search changes the rows: drop a selection the user can no longer see,
  // so Bulk edit never acts on hidden rows.
  const filterKey = JSON.stringify([state.columns, state.builder, state.search]);
  useEffect(() => setSelected(new Set()), [filterKey]);
  const onActive = useCallback((row: Row | null) => setActiveRow(row), []);
  const removeColumn = (field: string) => {
    const next = { ...state.columns };
    delete next[field];
    setState({ ...state, columns: next });
  };
  const builderCount = countConditions(state.builder);

  if (fields.isError) {
    return (
      <div className="page">
        <PageHeader page={page} {...(title ? { title } : {})} />
        <div className="grid-message error">
          <Icon name="alert" /> {(fields.error as Error).message}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        page={page}
        {...(title ? { title } : {})}
        actions={
          <>
            {historyScope && (
              <>
                <Button
                  variant="ghost"
                  icon="undo"
                  onClick={() => void undoLast()}
                  title="Undo your last change on this page (Ctrl+Z)"
                >
                  Undo
                </Button>
                <Button variant="ghost" icon="history" onClick={() => setHistoryOpen(true)}>
                  History
                </Button>
              </>
            )}
            <Button
              icon="download"
              disabled={!onExport}
              onClick={() => onExport?.(state)}
              title={
                onExport
                  ? "Export the rows matching the current filters (CSV)"
                  : "Export follows the current filters; it arrives with import/export (§13.22)"
              }
            >
              Export
            </Button>
            {actions}
            {primary && (
              <Button
                variant="primary"
                icon={primary.icon ?? "plus"}
                onClick={primary.onClick}
                disabled={primary.disabled}
                title={primary.title}
              >
                {primary.label}
              </Button>
            )}
          </>
        }
      />
      <div className="filter-row">
        <span className="muted">Filters:</span>
        {Object.values(state.columns)
          .filter((c) => c.field !== "archived")
          .map((c) => (
            <span key={c.field} className="chip accent">
              {conditionLabel(byName.get(c.field), c)}
              <button
                type="button"
                aria-label={`Remove filter ${byName.get(c.field)?.label ?? c.field}`}
                onClick={() => removeColumn(c.field)}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        {builderCount > 0 && (
          <span className="chip accent">
            <button type="button" className="chip-text" onClick={() => setBuilderOpen(true)}>
              {state.builder!.logic === "or" ? "Any of" : "All of"} {builderCount} condition
              {builderCount === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              aria-label="Remove builder filter"
              onClick={() => setState({ ...state, builder: null })}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBuilderOpen(true)}>
          <Icon name="filter" size={13} /> {builderCount ? "Edit filter" : "Add filter"}
        </button>
        <div className="quick-search">
          <Icon name="search" size={13} />
          <input
            key={state.search === "" ? "empty" : "set"}
            defaultValue={state.search}
            placeholder="Quick search…"
            aria-label="Quick search"
            onKeyDown={(e) => {
              if (e.key === "Enter") setState({ ...state, search: (e.target as HTMLInputElement).value });
              if (e.key === "Escape") {
                (e.target as HTMLInputElement).value = "";
                setState({ ...state, search: "" });
              }
            }}
            onBlur={(e) => e.target.value !== state.search && setState({ ...state, search: e.target.value })}
          />
        </div>
        {isFiltered(state) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setState({ ...emptyState(), visible: state.visible, sort: state.sort })}
          >
            Clear all
          </button>
        )}
        {isFiltered(state) && !state.viewId && <SaveViewButton list={list} state={state} onSaved={setState} />}
        {byName.has("archived") && <ShowDeleted state={state} onChange={setState} />}
        {toolbar?.(state, setState)}
        <ViewsMenu list={list} state={state} onApply={setState} />
        <span className="fb-spacer" />
        {selected.size > 0 && (
          <>
            <span className="muted">
              {selection?.summary ? selection.summary(rows, selected) : `${selected.size} selected`}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </>
        )}
        {selection?.bulk ? (
          <>
            <button
              ref={bulkRef}
              type="button"
              className="btn btn-default btn-sm"
              disabled={selected.size === 0}
              aria-haspopup="menu"
              onClick={() => setBulkOpen((v) => !v)}
            >
              Bulk edit <Icon name="chevronDown" size={12} />
            </button>
            <Popover anchor={bulkRef} open={bulkOpen} onClose={() => setBulkOpen(false)} align="end">
              <Menu
                items={selection.bulk([...selected], () => setSelected(new Set()))}
                onClose={() => setBulkOpen(false)}
              />
            </Popover>
          </>
        ) : (
          <Button
            small
            icon="layers"
            disabled={selected.size === 0}
            title="Bulk edit opens the bulk workspace (§13.11, build step 5)"
          >
            Bulk edit
          </Button>
        )}
        <ColumnsMenu fields={fields.data} state={state} onChange={setState} />
      </div>
      <div className={`list-body${detail && activeRow ? " with-detail" : ""}`}>
        {fields.data ? (
          <DataGrid<Row>
            list={list}
            fields={fields.data}
            state={state}
            onStateChange={setState}
            {...(columns ? { columns } : {})}
            {...(trailing ? { trailing } : {})}
            activeId={activeRow?.id ?? null}
            onActiveChange={onActive}
            selected={selected}
            onSelectedChange={setSelected}
            {...(onOpen ? { onOpen } : {})}
            {...(onKey ? { onKeyAction: onKey } : {})}
            {...(rowClass ? { rowClass } : {})}
            onRows={setRows}
            onMeta={onMeta}
          />
        ) : (
          <div className="grid-message muted">Loading…</div>
        )}
        {detail && activeRow && (
          <DetailPanel
            key={activeRow.id}
            content={detail(activeRow)}
            section={section}
            setSection={setSection}
            onClose={() => setActiveRow(null)}
          />
        )}
      </div>
      {builderOpen && fields.data && (
        <FilterBuilder
          fields={fields.data}
          value={state.builder}
          onApply={(b) => setState({ ...state, builder: b })}
          onClose={() => setBuilderOpen(false)}
        />
      )}
      {historyOpen && historyScope && (
        <HistoryDrawer scope={historyScope} title={title ?? page.label} onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}
