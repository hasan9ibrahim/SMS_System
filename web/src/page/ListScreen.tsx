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
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useLocation } from "react-router";
import type { ListId, ListQuery } from "@sms/contract";
import { useListFields, type ListPage } from "../api/hooks";
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
  /** A "⋯" menu at the end of each row: act on a record without opening it (team trial round 1). */
  rowActions?: (row: Row) => (MenuItem | "separator")[];
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
    /** Actions on the selection; `rows` are the selected rows loaded on screen. */
    bulk?: (ids: number[], clear: () => void, rows: Row[]) => (MenuItem | "separator")[];
  };
  /** Page shortcuts on the grid (e.g. E edit, D duplicate); return true when handled. */
  onKey?: (key: string, row: Row | null) => boolean;
  rowClass?: (row: Row) => string | undefined;
  /** Makes this row the active one once it is loaded (e.g. a rule just added). */
  selectId?: number | null;
  /** Controlled detail section, when the page opens a section itself. */
  section?: [string | null, (key: string) => void];
  /** Shown between the header and the filter row (e.g. report settings and totals). */
  above?: ReactNode;
  /** Passed to the grid: custom fetch, extra query key, and whether to query yet. */
  fetchPage?: (body: ListQuery) => Promise<ListPage<Row>>;
  queryScope?: unknown;
  enabled?: boolean;
  /** What to choose or press first, shown while `enabled` is false. */
  idleMessage?: ReactNode;
  /** Hides selection and Bulk edit (e.g. reports). */
  noSelection?: boolean;
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

/**
 * Height of the detail panel, dragged with the bar above it and remembered per list in this browser
 * (team trial round 1: "the bottom window can be stretched or pulled"). Null = the default share.
 */
function useDetailHeight(list: string): [number | null, (h: number | null) => void] {
  const key = `sms.detailHeight.${list}`;
  const [h, setH] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const set = (v: number | null) => {
    setH(v);
    try {
      if (v === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(Math.round(v)));
    } catch {
      // Private mode: the height lasts for this page only.
    }
  };
  return [h, set];
}

const DETAIL_MIN = 140;

/** The drag bar between the grid and the detail panel; double-click switches between tall and default. */
function DetailSplitter({
  height,
  onChange,
  container,
}: {
  height: number | null;
  onChange: (h: number | null) => void;
  container: RefObject<HTMLDivElement | null>;
}) {
  const max = () => Math.max(DETAIL_MIN, (container.current?.clientHeight ?? 600) - 120);
  const start = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const panel = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement | null;
    const startY = e.clientY;
    const startH = panel?.offsetHeight ?? height ?? 260;
    const move = (ev: globalThis.PointerEvent) =>
      onChange(Math.min(max(), Math.max(DETAIL_MIN, startH + startY - ev.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-rows");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("resizing-rows");
  };
  return (
    <div
      className="detail-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the details (double-click: tall or default)"
      title="Drag to resize · double-click: tall or default"
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={() => onChange(height !== null && height > max() * 0.6 ? null : max())}
      onKeyDown={(e) => {
        const cur = height ?? (e.currentTarget.nextElementSibling as HTMLElement | null)?.offsetHeight ?? 260;
        if (e.key === "ArrowUp") onChange(Math.min(max(), cur + 40));
        if (e.key === "ArrowDown") onChange(Math.max(DETAIL_MIN, cur - 40));
      }}
    />
  );
}

function DetailPanel({
  content,
  onClose,
  section,
  setSection,
  height,
}: {
  content: DetailContent;
  onClose: () => void;
  section: string | null;
  setSection: (key: string) => void;
  height: number | null;
}) {
  const current = content.sections.find((s) => s.key === section) ?? content.sections[0];
  return (
    <section className="detail" aria-label="Details" style={height ? { flex: `0 0 ${height}px` } : undefined}>
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

/** The "⋯" button of a row; the items are built when it opens. */
function RowMenu({ items }: { items: () => (MenuItem | "separator")[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="icon-btn"
        aria-label="Actions"
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Icon name="more" size={15} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end">
        {open && <Menu items={items()} onClose={() => setOpen(false)} />}
      </Popover>
    </>
  );
}

/**
 * Record actions next to New (team trial round 1): Clone, Delete and the page's main action in sight,
 * the rest under More; greyed while nothing (or more than one row) is selected or when the action does
 * not apply. A double-click or Enter on a row opens it; the "⋯" row menu offers the same actions.
 */
function RecordActionBar<Row extends { id: number }>({
  target,
  multi,
  template,
  rowActions,
}: {
  target: Row | null;
  multi: boolean;
  template: Row | null;
  rowActions?: (row: Row) => (MenuItem | "separator")[];
}) {
  // Labels come from the selected row, or from any loaded row while nothing is selected.
  const items = (rowActions && (target ?? template) ? rowActions((target ?? template)!) : [])
    .filter((it): it is MenuItem => it !== "separator")
    // Opening is a double-click or Enter on the row, so Open is left out of the bar.
    .filter((it) => !/^open\b/i.test(it.label));
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  if (!items.length) return null;
  const why = multi ? "Select one row (Bulk edit acts on several)" : "Select a row first";
  // In sight: Clone, Delete and the page's main action (marked `main`, else the first other one);
  // everything else goes under More (team trial round 1).
  const isClone = (it: MenuItem) => /^(clone|duplicate)\b/i.test(it.label);
  const isDelete = (it: MenuItem) => it.danger === true || /^(delete|archive|restore)\b/i.test(it.label);
  const clone = items.filter(isClone).slice(0, 1);
  const del = items.filter(isDelete).slice(0, 1);
  const others = items.filter((it) => !clone.includes(it) && !del.includes(it));
  const main = others.filter((it) => it.main).slice(0, 2);
  if (!main.length && others[0]) main.push(others[0]);
  const rest = others.filter((it) => !main.includes(it));
  const button = (it: MenuItem) => (
    <button
      key={it.label}
      type="button"
      className={`ra-btn${it.danger ? " danger" : ""}`}
      disabled={!target || it.disabled}
      title={!target ? why : (it.hint ?? it.label)}
      onClick={() => target && !it.disabled && it.onSelect()}
    >
      {it.icon && <Icon name={it.icon} size={13} />}
      <span>{it.label.replace(/…$/, "")}</span>
    </button>
  );
  return (
    <span className="record-actions" role="group" aria-label="Actions on the selected row">
      {clone.map(button)}
      {del.map(button)}
      {main.map(button)}
      {rest.length > 0 && (
        <>
          <button
            ref={moreRef}
            type="button"
            className="ra-btn"
            disabled={!target}
            title={target ? "More actions" : why}
            aria-haspopup="menu"
            onClick={() => setMoreOpen((o) => !o)}
          >
            <span>More</span>
            <Icon name="chevronDown" size={12} />
          </button>
          <Popover anchor={moreRef} open={moreOpen && !!target} onClose={() => setMoreOpen(false)} align="end">
            <Menu items={rest} onClose={() => setMoreOpen(false)} />
          </Popover>
        </>
      )}
    </span>
  );
}

export function ListScreen<Row extends { id: number }>(props: ListScreenProps<Row>) {
  const {
    list,
    page,
    title,
    columns,
    trailing: trailingProp,
    rowActions,
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
    above,
    fetchPage,
    queryScope,
    enabled,
    idleMessage,
    noSelection,
  } = props;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [detailHeight, setDetailHeight] = useDetailHeight(list);
  const trailing = rowActions
    ? {
        header: trailingProp?.header ?? "",
        width: (trailingProp?.width ?? 0) + 40,
        render: (row: Row) => (
          <span className="row-actions">
            {trailingProp?.render(row)}
            <RowMenu items={() => rowActions(row)} />
          </span>
        ),
      }
    : trailingProp;
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
            <RecordActionBar<Row>
              target={
                selected.size === 1
                  ? (rows.find((r) => selected.has(r.id)) ?? null)
                  : selected.size === 0
                    ? activeRow
                    : null
              }
              multi={selected.size > 1}
              template={rows[0] ?? null}
              {...(rowActions ? { rowActions } : {})}
            />
          </>
        }
      />
      {above}
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
        {noSelection ? null : selection?.bulk ? (
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
                items={selection.bulk(
                  [...selected],
                  () => setSelected(new Set()),
                  rows.filter((r) => selected.has(r.id)),
                )}
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
      <div className={`list-body${detail && activeRow ? " with-detail" : ""}`} ref={bodyRef}>
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
            {...(fetchPage ? { fetchPage } : {})}
            {...(queryScope !== undefined ? { queryScope } : {})}
            {...(enabled !== undefined ? { enabled } : {})}
            {...(idleMessage !== undefined ? { idleMessage } : {})}
            onRows={setRows}
            onMeta={onMeta}
          />
        ) : (
          <div className="grid-message muted">Loading…</div>
        )}
        {detail && activeRow && <DetailSplitter height={detailHeight} onChange={setDetailHeight} container={bodyRef} />}
        {detail && activeRow && (
          <DetailPanel
            key={activeRow.id}
            content={detail(activeRow)}
            section={section}
            setSection={setSection}
            onClose={() => setActiveRow(null)}
            height={detailHeight}
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
