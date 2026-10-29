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
import { PillSearch } from "../grid/PillSearch";
import { SaveViewButton, ViewsMenu } from "../grid/ViewsMenu";
import {
  countConditions,
  decodeState,
  emptyState,
  encodeState,
  isFiltered,
  switchOf,
  withSwitch,
  type GridState,
} from "../grid/filterModel";
import { HistoryDrawer, useUndoLast, useUndoShortcut, type HistoryScope } from "../history/undo";
import type { PageDef } from "../nav/registry";
import { usePageStatus, useTab, useTabNavigate } from "../shell/tabContext";
import { Icon, type IconName } from "../ui/Icon";
import { confirmDialog } from "../ui/feedback";
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
  /** Actions on one record, shown in the header's record bar (team trial round 1; no row "⋯" menu since round 4). */
  rowActions?: (row: Row) => (MenuItem | "separator")[];
  detail?: (row: Row) => DetailContent;
  onOpen?: (row: Row, e: MouseEvent | KeyboardEvent) => void;
  /**
   * "double": a click only highlights the row (and leaves text free to select and copy); double-click, Enter or
   * `openRef` opens the detail panel on that row, and only those change it (Route rules, team trial rounds 3 and 6).
   * Default: a click opens it.
   */
  detailOpensOn?: "click" | "double";
  /** Set by the list: opens the detail panel on a row, like a double-click (the page's own Edit, round 6). */
  openRef?: RefObject<((row: Row) => void) | null>;
  /** The detail panel opens under the grid instead of beside it (Market moves, team trial round 6). */
  detailBelow?: boolean;
  /** Shows only these columns, whatever the saved choice (Rate manager's list beside an open table, round 6). */
  onlyColumns?: string[];
  /** Columns left out until someone picks them in Columns (team trial round 7: Rate manager's Avg Margin). */
  defaultHidden?: string[];
  /** Columns as wide as their longest value, no truncation (team trial round 7: EDR Search). */
  autoFit?: boolean;
  /** The detail panel's width until dragged, as CSS (team trial round 8: Route rules open it at half the page). */
  detailDefaultWidth?: string;
  /** Taller grid rows for two-line cells (team trial round 4). */
  rowHeight?: number;
  /** Records this page edits; enables the header Undo and History buttons (§13.10). */
  historyScope?: HistoryScope | null;
  primary?: { label: string; icon?: IconName; onClick?: () => void; disabled?: boolean; title?: string };
  /** Filters applied when the tab has none in its URL. */
  initialState?: Partial<GridState>;
  /** Page-specific controls in the filter row (e.g. an account manager picker). */
  toolbar?: (state: GridState, setState: (s: GridState) => void) => ReactNode;
  shortcuts?: string;
  /**
   * Extra header actions, placed before the primary button (e.g. Simulate). A function receives the rows the
   * actions apply to: the selected rows, else the active row.
   */
  actions?: ReactNode | ((targets: Row[]) => ReactNode);
  /** Enables the header Export button; receives the current filters (§13.22). */
  onExport?: (state: GridState) => void;
  /** Export as the page's filled button, last in the header (EDR search, team trial round 2). */
  exportPrimary?: boolean;
  /** Leave out the quick search box (a page whose own toolbar has the search, e.g. EDR search). */
  noQuickSearch?: boolean;
  /** Leave out the bar of actions on the selected row (the page puts them in `actions`). */
  noRecordBar?: boolean;
  /** Filters the page's toolbar shows itself, so they get no chip (e.g. EDR search's period). */
  toolbarFields?: string[];
  /** Selection summary, and the actions the header's record bar offers while several rows are selected (§13.11). */
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
  /** Hides selection (e.g. reports). */
  noSelection?: boolean;
}

/** Grid state in the tab URL: ?g=<encoded>. Filter changes replace, not push. */
/** The filters of a state, to tell whether Clear all would change anything. */
const filtersOf = (s: GridState) =>
  JSON.stringify([s.columns, s.pills ?? {}, s.switches ?? {}, countConditions(s.builder) ? s.builder : null, s.search]);

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
        {fields.fields
          .filter((f) => !f.filterOnly)
          .map((f) => (
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

/** "Show deleted" (§13.29): lists archived rows next to live ones, greyed out. A page switch (team trial round 10). */
export function ShowDeleted({ state, onChange }: { state: GridState; onChange: (s: GridState) => void }) {
  const on = !!switchOf(state, "archived");
  return (
    <label className="toggle-inline">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) =>
          onChange(
            withSwitch(state, "archived", e.target.checked ? { field: "archived", op: "in", values: [true, false] } : null),
          )
        }
      />
      Show deleted
    </label>
  );
}

/**
 * Width of the detail panel on the right of the grid (team trial round 3: it sits beside the grid and narrows it),
 * dragged with the bar on its left edge and remembered per list in this browser. Null = the default share.
 */
function useDetailWidth(list: string): [number | null, (w: number | null) => void] {
  const key = `sms.detailWidth.${list}`;
  const [w, setW] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const set = (v: number | null) => {
    setW(v);
    try {
      if (v === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(Math.round(v)));
    } catch {
      // Private mode: the width lasts for this page only.
    }
  };
  return [w, set];
}

const DETAIL_MIN = 320;

/** The drag bar between the grid and the detail panel; double-click switches between wide and default. */
function DetailSplitter({
  width,
  onChange,
  container,
}: {
  width: number | null;
  onChange: (w: number | null) => void;
  container: RefObject<HTMLDivElement | null>;
}) {
  const max = () => Math.max(DETAIL_MIN, (container.current?.clientWidth ?? 1200) - 360);
  const start = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const panel = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement | null;
    const startX = e.clientX;
    const startW = panel?.offsetWidth ?? width ?? 480;
    const move = (ev: globalThis.PointerEvent) =>
      onChange(Math.min(max(), Math.max(DETAIL_MIN, startW + startX - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-split");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("resizing-split");
  };
  return (
    <div
      className="detail-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the details (double-click: wide or default)"
      title="Drag to resize · double-click: wide or default"
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={() => onChange(width !== null && width > max() * 0.6 ? null : max())}
      onKeyDown={(e) => {
        const cur = width ?? (e.currentTarget.nextElementSibling as HTMLElement | null)?.offsetWidth ?? 480;
        if (e.key === "ArrowLeft") onChange(Math.min(max(), cur + 40));
        if (e.key === "ArrowRight") onChange(Math.max(DETAIL_MIN, cur - 40));
      }}
    />
  );
}

/** The drag bar between the grid and a detail panel below it: drag up or down; double-click for the default height. */
function BelowSplitter({
  height,
  onChange,
  container,
}: {
  height: number | null;
  onChange: (h: number | null) => void;
  container: RefObject<HTMLDivElement | null>;
}) {
  const start = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const panel = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement | null;
    const startY = e.clientY;
    const startH = panel?.offsetHeight ?? height ?? 320;
    const max = Math.max(200, (container.current?.clientHeight ?? 800) - 200);
    const move = (ev: globalThis.PointerEvent) => onChange(Math.min(max, Math.max(200, startH + startY - ev.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-split-h");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("resizing-split-h");
  };
  return (
    <div
      className="h-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the details"
      title="Drag to resize · double-click: default height"
      onPointerDown={start}
      onDoubleClick={() => onChange(null)}
    />
  );
}

function DetailPanel({
  content,
  onClose,
  section,
  setSection,
  width,
  defaultWidth,
  below = false,
}: {
  content: DetailContent;
  onClose: () => void;
  section: string | null;
  setSection: (key: string) => void;
  /** Its width beside the grid, or its height below it. */
  width: number | null;
  /** Width while not dragged, as CSS (e.g. "50%": half the page, team trial round 8 Route rules). */
  defaultWidth?: string | undefined;
  below?: boolean;
}) {
  const current = content.sections.find((s) => s.key === section) ?? content.sections[0];
  // On the right (team trial round 3): title, the sections as tabs, the section, then the aside facts.
  return (
    <section
      className={`detail${below ? " below" : ""}`}
      aria-label="Details"
      style={width ? { flex: `0 0 ${width}px` } : defaultWidth && !below ? { flex: `0 0 ${defaultWidth}` } : undefined}
    >
      <div className="detail-title">
        {content.title}
        <span className="fb-spacer" />
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {content.sections.length > 1 && (
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
      )}
      <div className="detail-main">
        {current?.actions && <div className="detail-actions-row">{current.actions}</div>}
        {current?.content}
        {content.aside && <aside className="detail-aside">{content.aside}</aside>}
      </div>
    </section>
  );
}

/** A selection action without its own dialog (no "…") asks first, naming how many rows it applies to. */
function confirmFirst(it: MenuItem, count: number): MenuItem {
  if (/…$/.test(it.label)) return it;
  return {
    ...it,
    onSelect: async () => {
      const ok = await confirmDialog({
        title: it.label,
        message: `${it.label} for the ${count.toLocaleString("en-US")} selected rows?`,
        ok: it.label,
        ...(it.danger ? { danger: true } : {}),
      });
      if (ok) it.onSelect();
    },
  };
}

/**
 * Record actions next to New (team trial round 1): Clone, Delete and the page's main action in sight,
 * the rest under More; greyed while nothing is selected or when the action does not apply. A double-click
 * or Enter on a row opens it. With several rows selected the bar offers the page's actions on the selection
 * instead (team trial round 4, replacing Bulk edit); one without its own dialog asks first, naming the count.
 */
function RecordActionBar<Row extends { id: number }>({
  target,
  multi,
  template,
  rowActions,
  bulk,
  count,
}: {
  target: Row | null;
  multi: boolean;
  template: Row | null;
  rowActions?: (row: Row) => (MenuItem | "separator")[];
  /** The page's actions on the selected rows (several selected). */
  bulk?: (MenuItem | "separator")[];
  count: number;
}) {
  const onSelection = multi && !!bulk;
  // Labels come from the selected row, or from any loaded row while nothing is selected.
  const items = (
    onSelection
      ? bulk.map((it) => (it === "separator" ? it : confirmFirst(it, count)))
      : rowActions && (target ?? template)
        ? rowActions((target ?? template)!)
        : []
  )
    .filter((it): it is MenuItem => it !== "separator")
    // Opening is a double-click or Enter on the row, so Open is left out of the bar.
    .filter((it) => !/^open\b/i.test(it.label))
    // One-record actions (Clone) have no place on a selection.
    .filter((it) => !onSelection || !/^(clone|duplicate)\b/i.test(it.label));
  const enabled = onSelection || !!target;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  if (!items.length) return null;
  const why = multi ? "Select one row for this action" : "Select a row first";
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
      disabled={!enabled || it.disabled}
      title={!enabled ? why : (it.hint ?? it.label)}
      onClick={() => enabled && !it.disabled && it.onSelect()}
    >
      {it.icon && <Icon name={it.icon} size={13} />}
      <span>{it.label.replace(/…$/, "")}</span>
    </button>
  );
  return (
    <span
      className={`record-actions${onSelection ? " on-selection" : ""}`}
      role="group"
      aria-label={onSelection ? `Actions on the ${count} selected rows` : "Actions on the selected row"}
    >
      {onSelection && <span className="ra-count">{count.toLocaleString("en-US")} selected</span>}
      {clone.map(button)}
      {del.map(button)}
      {main.map(button)}
      {rest.length > 0 && (
        <>
          <button
            ref={moreRef}
            type="button"
            className="ra-btn"
            disabled={!enabled}
            title={enabled ? "More actions" : why}
            aria-haspopup="menu"
            onClick={() => setMoreOpen((o) => !o)}
          >
            <span>More</span>
            <Icon name="chevronDown" size={12} />
          </button>
          <Popover anchor={moreRef} open={moreOpen && enabled} onClose={() => setMoreOpen(false)} align="end">
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
    exportPrimary = false,
    noQuickSearch = false,
    noRecordBar = false,
    toolbarFields = [],
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
    detailOpensOn = "click",
    detailBelow = false,
    onlyColumns,
    defaultHidden,
    autoFit,
    detailDefaultWidth,
    rowHeight,
  } = props;
  const bodyRef = useRef<HTMLDivElement>(null);
  // Below the grid the remembered size is a height (its own key).
  const [detailWidth, setDetailWidth] = useDetailWidth(detailBelow ? `${list}.below` : list);
  // No "⋯" menu at the end of each row any more (team trial round 4): the record actions in the header act on the
  // highlighted row or on the selected rows.
  const trailing = trailingProp;
  const { active } = useTab();
  const fields = useListFields(list);
  const [state, setState] = useGridUrlState(initialState);
  const [activeRow, setActiveRow] = useState<Row | null>(null);
  const [detailOpen, setDetailOpen] = useState(detailOpensOn === "click");
  // "double": the panel keeps the row it was opened on; a click elsewhere only moves the highlight.
  const [panelRow, setPanelRow] = useState<Row | null>(null);
  const detailRow = detailOpensOn === "double" ? panelRow : activeRow;
  const showDetail = !!detail && !!detailRow && detailOpen;
  const openPanel = useCallback((row: Row) => {
    setActiveRow(row);
    setPanelRow(row);
    setDetailOpen(true);
  }, []);
  if (props.openRef) (props.openRef as { current: ((row: Row) => void) | null }).current = openPanel;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // The open detail section stays the same while the user moves between rows.
  const ownSection = useState<string | null>(null);
  const [section, setSection] = props.section ?? ownSection;
  const [rows, setRows] = useState<Row[]>([]);
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
  // The columns shown before anyone chooses: every column the list offers, less those hidden by default.
  const shownState: GridState =
    onlyColumns
      ? { ...state, visible: onlyColumns }
      : state.visible === null && defaultHidden?.length && fields.data
        ? {
            ...state,
            visible: fields.data.fields.filter((f) => !f.hidden && !defaultHidden.includes(f.field)).map((f) => f.field),
          }
        : state;
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
        // A row picked from outside (a new rule, the simulator) opens its panel.
        return openPanel(wanted);
      }
    }
    if (panelRow) {
      const freshPanel = rows.find((r) => r.id === panelRow.id);
      if (freshPanel && freshPanel !== panelRow) setPanelRow(freshPanel);
    }
    if (!activeRow) return;
    const fresh = rows.find((r) => r.id === activeRow.id);
    if (fresh && fresh !== activeRow) setActiveRow(fresh);
  }, [rows, selectId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new filter or search changes the rows: drop a selection the user can no longer see,
  // so the selection actions never act on hidden rows.
  const filterKey = JSON.stringify([state.columns, state.pills, state.switches, state.builder, state.search]);
  useEffect(() => setSelected(new Set()), [filterKey]);
  const onActive = useCallback((row: Row | null) => setActiveRow(row), []);
  const builderCount = countConditions(state.builder);
  // Clear all: the page's own filters and switches, the columns and sort as they are.
  const cleared: GridState = {
    ...emptyState(),
    ...initialState,
    columns: { ...(initialState?.columns ?? {}) },
    switches: { ...(initialState?.switches ?? {}) },
    visible: state.visible,
    sort: state.sort,
  };

  // Quick search with field pills (team trial round 3): replaces Add filter and the filter chips.
  const pills = (
    <PillSearch
      fields={fields.data?.fields}
      visible={state.visible}
      columns={state.pills ?? {}}
      onColumns={(pills) => setState({ ...state, pills })}
      search={state.search}
      onSearch={(search) => setState({ ...state, search })}
      freeText={!noQuickSearch}
      exclude={toolbarFields}
      onAdvanced={() => setBuilderOpen(true)}
    />
  );

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
            {!exportPrimary && (
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
            )}
            {typeof actions === "function"
              ? actions(selected.size ? rows.filter((r) => selected.has(r.id)) : activeRow ? [activeRow] : [])
              : actions}
            {exportPrimary && (
              <Button
                variant="primary"
                icon="download"
                disabled={!onExport}
                onClick={() => onExport?.(state)}
                title="Export the rows matching the current filters"
              >
                Export
              </Button>
            )}
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
            {!noRecordBar && (
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
                count={selected.size}
                {...(rowActions ? { rowActions } : {})}
                {...(selection?.bulk && selected.size > 1
                  ? {
                      bulk: selection.bulk(
                        [...selected],
                        () => setSelected(new Set()),
                        rows.filter((r) => selected.has(r.id)),
                      ),
                    }
                  : {})}
              />
            )}
          </>
        }
      />
      {above}
      {/* Filters in one card (design refresh): search first, the page's own filters, chips, Add filter. */}
      <div className="filter-card">
        <div className="filter-row">
          {/* Quick search with field pills first; a page with its own search box shows it before the pills. */}
          {!noQuickSearch && pills}
          {toolbar?.(state, setState)}
          {noQuickSearch && pills}
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
          {byName.has("archived") && <ShowDeleted state={state} onChange={setState} />}
          {isFiltered(state) && filtersOf(state) !== filtersOf(cleared) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              // Back to the page's own defaults (e.g. EDR search's today), not to nothing (team trial round 2).
              onClick={() => setState(cleared)}
            >
              Clear all
            </button>
          )}
          {/* Views, selection and Columns at the end of the filter row (team trial round 3). */}
          <span className="fb-spacer" />
          {/* Saved views sit with Columns (compact layout, team trial round 2). */}
          {isFiltered(state) && !state.viewId && <SaveViewButton list={list} state={state} onSaved={setState} />}
          <ViewsMenu list={list} state={state} onApply={setState} />
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
          <ColumnsMenu fields={fields.data} state={shownState} onChange={setState} />
        </div>
      </div>
      <div className={`list-body${showDetail ? " with-detail" : ""}${detailBelow ? " detail-below" : ""}`} ref={bodyRef}>
        {/* The grid in a Records card (design refresh); the count in the footer. */}
        <section className="records-card">
          {fields.data ? (
            <DataGrid<Row>
              list={list}
              {...(rowHeight ? { rowHeight } : {})}
              {...(autoFit ? { autoFit } : {})}
              fields={fields.data}
              state={shownState}
              onStateChange={(next) => setState(onlyColumns ? { ...next, visible: state.visible } : next)}
              {...(columns ? { columns } : {})}
              {...(trailing ? { trailing } : {})}
              activeId={activeRow?.id ?? null}
              onActiveChange={onActive}
              selected={selected}
              onSelectedChange={setSelected}
              {...(onOpen || detailOpensOn === "double"
                ? {
                    onOpen: (row: Row, e: MouseEvent | KeyboardEvent) => {
                      openPanel(row);
                      onOpen?.(row, e);
                    },
                  }
                : {})}
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
          <div className="records-foot muted">
            {total === null
              ? meta.fetching
                ? "Loading…"
                : ""
              : `Showing ${Math.min(meta.loaded, total).toLocaleString("en-US")} of ${total.toLocaleString("en-US")}${meta.isEstimate ? "+" : ""} records`}
            {total !== null && meta.loaded < total && <span>&nbsp;· scroll for more</span>}
          </div>
        </section>
        {showDetail &&
          (detailBelow ? (
            <BelowSplitter height={detailWidth} onChange={setDetailWidth} container={bodyRef} />
          ) : (
            <DetailSplitter width={detailWidth} onChange={setDetailWidth} container={bodyRef} />
          ))}
        {showDetail && detailRow && (
          <DetailPanel
            key={detailRow.id}
            content={detail(detailRow)}
            section={section}
            setSection={setSection}
            onClose={() => (detailOpensOn === "double" ? setDetailOpen(false) : setActiveRow(null))}
            width={detailWidth}
            defaultWidth={detailDefaultWidth}
            below={detailBelow}
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
