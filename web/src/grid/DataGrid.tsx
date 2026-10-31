// The standard grid (§15.1, §15.3, CLAUDE.md rule 3). Filtering, sorting and paging run on
// the server through POST /{list}/query; rows are virtualised and the next page loads in the
// background as the user scrolls, so every matching row is on one scrollable page (§13.25).
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useReactTable, getCoreRowModel, type ColumnDef, type ColumnSizingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FieldDescriptor, ListFields, ListId, ListQuery } from "@sms/contract";
import { fetchListPage, type ListPage } from "../api/hooks";
import { ApiError } from "../api/client";
import { Icon } from "../ui/Icon";
import { StatusPill } from "../ui/primitives";
import { ColumnFilter } from "./ColumnFilter";
import { isChoice, isNumeric, isTime, nextSort, toListQuery, type GridState } from "./filterModel";

export const ROW_HEIGHT = 42;
/** Most rows "Select all matching" takes (one bulk action stays reviewable). */
const SELECT_ALL_MAX = 5000;
const PAGE_SIZE = 200;
/** Narrowest a column gets when the columns are fitted to the grid's width. */
const FIT_MIN = 56;
/** Phones (team trial round 5): below this grid width each row is a card instead of a table row. */
const CARD_BELOW = 640;
const CARD_HEIGHT = 128;
const CARD_FIELDS = 4;

export interface ColumnOverride<Row> {
  width?: number;
  /** Header text instead of the field label (e.g. the traffic window "24h"). */
  label?: string;
  render?: (row: Row) => ReactNode;
  align?: "left" | "right" | "center";
}

export interface GridMeta {
  total: number | null;
  loaded: number;
  isEstimate: boolean;
  fetching: boolean;
  error: ApiError | null;
}

export interface DataGridProps<Row extends { id: number }> {
  list: ListId;
  fields: ListFields;
  state: GridState;
  onStateChange: (next: GridState) => void;
  columns?: Partial<Record<string, ColumnOverride<Row>>>;
  activeId: number | null;
  onActiveChange: (row: Row | null) => void;
  selected: ReadonlySet<number>;
  onSelectedChange: (next: Set<number>) => void;
  onOpen?: (row: Row, e: MouseEvent | KeyboardEvent) => void;
  onMeta?: (meta: GridMeta) => void;
  trailing?: { header: string; width: number; render: (row: Row) => ReactNode };
  /** Extra class for a row, e.g. a negative-margin tint (§13.12). */
  rowClass?: (row: Row) => string | undefined;
  /** The rows loaded so far (for actions on the selection). */
  onRows?: (rows: Row[]) => void;
  /** Keys the grid does not handle itself (page shortcuts); return true when handled. */
  onKeyAction?: (key: string, row: Row | null) => boolean;
  /** Fetches a page instead of POST /{list}/query (e.g. a report with its settings). */
  fetchPage?: (body: ListQuery) => Promise<ListPage<Row>>;
  /** Extra query key parts, so other settings re-run the query. */
  queryScope?: unknown;
  /** False holds the query (e.g. until a report is run). */
  enabled?: boolean;
  /** Taller rows for two-line cells (e.g. Network status, Incidents; team trial round 4). */
  rowHeight?: number;
  /** Shown instead of "Loading…" while the query is held (what to choose or press first). */
  idleMessage?: ReactNode;
  /**
   * Each column as wide as its header and longest loaded value, never cut off; the grid scrolls sideways when they
   * do not fit (team trial round 7, EDR Search and the Live analytics EDR window).
   */
  autoFit?: boolean;
}

/** Default cell text by field type. */
export function defaultCell(f: FieldDescriptor, value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  if (f.field === "status" && (value === "active" || value === "inactive")) {
    // The dot with its word in a pill (team trial round 4).
    return <StatusPill active={value === "active"} />;
  }
  if (f.type === "enum") return f.enumValues?.find((e) => e.value === value)?.label ?? String(value);
  if (f.type === "boolean") return value ? "Yes" : "No";
  if (isTime(f)) return String(value).slice(0, 16).replace("T", " ");
  if (f.type === "money" || f.type === "decimal")
    return Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (f.type === "percent") return `${Number(value).toFixed(1)}%`;
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** Widest an auto-fitted column gets (a long message text). */
const AUTO_FIT_MAX = 1600;
/** Rows measured for auto-fit: the first pages, so widths settle instead of growing while scrolling. */
const AUTO_FIT_ROWS = 400;
let measureCanvas: HTMLCanvasElement | null = null;

/** The text a cell shows, near enough to measure its width (renders add at most a dot or icon). */
function fitText(f: FieldDescriptor, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (isTime(f)) return String(value).slice(0, 19).replace("T", " ");
  if (typeof value === "number") return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Header and cell widths from the loaded rows, measured in the grid's own fonts. */
function fitWidths(
  el: HTMLElement | null,
  fields: FieldDescriptor[],
  rows: object[],
  labels: (f: FieldDescriptor) => string,
): Map<string, number> {
  measureCanvas ??= document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  const out = new Map<string, number>();
  if (!ctx) return out;
  const style = el ? getComputedStyle(el) : null;
  const family = style?.fontFamily || "Inter, sans-serif";
  const size = style?.fontSize || "14px";
  const sample = rows.slice(0, AUTO_FIT_ROWS) as Record<string, unknown>[];
  for (const f of fields) {
    // Header: bold label, sort arrow and padding; cells: text, a status dot or icon and padding.
    ctx.font = `700 13px ${family}`;
    let w = ctx.measureText(labels(f)).width + 34;
    ctx.font = `400 ${size} ${family}`;
    // Figures use tabular digits, as wide as "0" (the canvas measures proportional ones).
    for (const r of sample) w = Math.max(w, ctx.measureText(fitText(f, r[f.field]).replace(/\d/g, "0")).width + 34);
    out.set(f.field, Math.min(AUTO_FIT_MAX, Math.ceil(w)));
  }
  return out;
}

// Widths for the roomier design refresh (13.5 px text, 12 px cell padding).
const defaultWidth = (f: FieldDescriptor) =>
  f.field === "id" ? 84 : isNumeric(f) ? 120 : isChoice(f) ? 130 : isTime(f) ? 178 : f.field === "status" ? 80 : 190;

function HeaderCell({
  field,
  state,
  onStateChange,
  width,
  onResizeStart,
  align,
  label,
}: {
  label?: string | undefined;
  field: FieldDescriptor;
  state: GridState;
  onStateChange: (s: GridState) => void;
  width: number;
  onResizeStart: (e: React.MouseEvent | React.TouchEvent) => void;
  align: string;
}) {
  const idx = state.sort.findIndex((s) => s.field === field.field);
  const dir = idx >= 0 ? state.sort[idx]!.dir : null;
  return (
    <div
      className={`gh-cell align-${align}${field.sortable ? " sortable" : ""}${dir ? " sorted" : ""}`}
      style={{ width }}
      role="columnheader"
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
      onClick={(e) =>
        field.sortable && onStateChange({ ...state, sort: nextSort(state.sort, field.field, e.shiftKey) })
      }
      title={field.sortable ? "Click to sort, Shift-click to add a second sort" : field.label}
    >
      <span className="gh-label">{label ?? field.label}</span>
      {dir && (
        <span className="gh-sort">
          {dir === "asc" ? "▲" : "▼"}
          {state.sort.length > 1 && <sub>{idx + 1}</sub>}
        </span>
      )}
      <span
        className="gh-resize"
        onMouseDown={onResizeStart}
        onTouchStart={onResizeStart}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

interface RowProps<Row> {
  row: Row;
  index: number;
  top: number;
  cells: {
    field: FieldDescriptor;
    width: number;
    align: string;
    label?: string | undefined;
    render?: ((row: Row) => ReactNode) | undefined;
  }[];
  active: boolean;
  checked: boolean;
  onClick: (row: Row, e: MouseEvent) => void;
  onDoubleClick: (row: Row, e: MouseEvent) => void;
  onCheck: (row: Row, shift: boolean) => void;
  trailing?: DataGridProps<{ id: number }>["trailing"];
  extraClass?: string | undefined;
  /** Values withheld by the viewer's visibility policy (§13.17): field → what to show. */
  masked?: Map<string, string> | undefined;
}

/** Archived rows (shown with "Show deleted", §13.29) are greyed out. */
const isArchived = (row: object) => {
  const r = row as { archived?: unknown; archivedAt?: unknown };
  return r.archived === true || !!r.archivedAt;
};

function GridRowInner<Row extends { id: number }>({
  row,
  index,
  top,
  cells,
  active,
  checked,
  onClick,
  onDoubleClick,
  onCheck,
  trailing,
  extraClass,
  masked,
}: RowProps<Row>) {
  return (
    <div
      className={`gr${active ? " active" : ""}${checked ? " checked" : ""}${isArchived(row) ? " archived" : ""}${extraClass ? ` ${extraClass}` : ""}`}
      style={{ transform: `translateY(${top}px)` }}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={checked}
      onClick={(e) => onClick(row, e)}
      onDoubleClick={(e) => onDoubleClick(row, e)}
      onAuxClick={(e) => e.button === 1 && onDoubleClick(row, e)}
    >
      <div className="gc gc-check" role="gridcell">
        <input
          type="checkbox"
          checked={checked}
          aria-label={`Select row ${row.id}`}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onCheck(row, (e.nativeEvent as unknown as globalThis.MouseEvent).shiftKey)}
        />
      </div>
      {cells.map((c) => (
        <div
          key={c.field.field}
          className={`gc align-${c.align}${isNumeric(c.field) ? " num" : ""}`}
          style={{ width: c.width }}
          role="gridcell"
        >
          {masked?.has(c.field.field) ? (
            <Withheld text={masked.get(c.field.field)!} />
          ) : c.render ? (
            c.render(row)
          ) : (
            defaultCell(c.field, (row as Record<string, unknown>)[c.field.field])
          )}
        </div>
      ))}
      {trailing && (
        <div
          className="gc gc-trailing"
          style={{ width: trailing.width }}
          role="gridcell"
          onClick={(e) => e.stopPropagation()}
        >
          {trailing.render(row)}
        </div>
      )}
    </div>
  );
}
const GridRow = memo(GridRowInner) as typeof GridRowInner;

/** Phones: sorting from a picker, since the card layout has no column headers. */
function MobileSort({
  cells,
  state,
  onStateChange,
}: {
  cells: { field: FieldDescriptor; label?: string | undefined }[];
  state: GridState;
  onStateChange: (s: GridState) => void;
}) {
  const first = state.sort[0];
  const sortable = cells.filter((c) => c.field.sortable);
  if (!sortable.length) return null;
  return (
    <div className="gm-sort">
      <span className="muted small">Sort</span>
      <select
        aria-label="Sort by"
        value={first?.field ?? ""}
        onChange={(e) =>
          onStateChange({ ...state, sort: e.target.value ? [{ field: e.target.value, dir: first?.dir ?? "asc" }] : [] })
        }
      >
        <option value="">Default</option>
        {sortable.map((c) => (
          <option key={c.field.field} value={c.field.field}>
            {c.label ?? c.field.label}
          </option>
        ))}
      </select>
      {first && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-label={first.dir === "asc" ? "Ascending" : "Descending"}
          onClick={() =>
            onStateChange({ ...state, sort: [{ field: first.field, dir: first.dir === "asc" ? "desc" : "asc" }] })
          }
        >
          {first.dir === "asc" ? "↑ A–Z" : "↓ Z–A"}
        </button>
      )}
    </div>
  );
}

/** A row as a card on phones: the first column as the title, the next few as label and value. */
function MobileCardInner<Row extends { id: number }>({
  row,
  index,
  top,
  cells,
  active,
  checked,
  onClick,
  extraClass,
  masked,
}: RowProps<Row>) {
  const shown = cells.filter((c) => c.field.field !== "id");
  const [title, ...rest] = shown;
  const value = (c: (typeof cells)[number]) =>
    masked?.has(c.field.field) ? (
      <Withheld text={masked.get(c.field.field)!} />
    ) : c.render ? (
      c.render(row)
    ) : (
      defaultCell(c.field, (row as Record<string, unknown>)[c.field.field])
    );
  return (
    <div
      className={`gcard${active ? " active" : ""}${checked ? " checked" : ""}${isArchived(row) ? " archived" : ""}${extraClass ? ` ${extraClass}` : ""}`}
      style={{ transform: `translateY(${top}px)` }}
      role="row"
      aria-rowindex={index + 2}
      onClick={(e) => onClick(row, e)}
    >
      <div className="gcard-title">{title ? value(title) : `#${row.id}`}</div>
      <div className="gcard-fields">
        {rest.slice(0, CARD_FIELDS).map((c) => (
          <div key={c.field.field} className="gcard-field">
            <span className="gcard-label">{c.label ?? c.field.label}</span>
            <span className={`gcard-value${isNumeric(c.field) ? " num" : ""}`}>{value(c)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
const MobileCard = memo(MobileCardInner) as typeof MobileCardInner;

/** A value the visibility policy withholds (§13.17): Hidden, a band (Low / Normal / High) or Above limit. */
export function Withheld({ text }: { text: string }) {
  return (
    <span className="withheld" title="Hidden by your visibility policy">
      {text}
    </span>
  );
}

/** The x of each column's right edge, after the 40 px check column. */
function lineOffsets(cells: { width: number }[]): number[] {
  let x = 40;
  return cells.map((c) => (x += c.width) - 1);
}

export function DataGrid<Row extends { id: number }>(props: DataGridProps<Row>) {
  const {
    list,
    fields,
    state,
    onStateChange,
    columns = {},
    activeId,
    onActiveChange,
    selected,
    onSelectedChange,
    onOpen,
    onMeta,
    trailing,
    rowClass,
    onRows,
    onKeyAction,
    fetchPage,
    queryScope = null,
    enabled = true,
    idleMessage = "Choose the settings above to see rows.",
    autoFit = false,
    rowHeight = ROW_HEIGHT,
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastChecked = useRef<number | null>(null);
  const query = useMemo(() => toListQuery(state), [state]);

  const result = useInfiniteQuery({
    queryKey: ["list", list, query, queryScope],
    queryFn: ({ pageParam }) =>
      (fetchPage ?? ((b: ListQuery) => fetchListPage<Row>(list, b)))({
        ...query,
        limit: PAGE_SIZE,
        cursor: pageParam,
        withTotal: true,
      } as ListQuery),
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
  });
  const rows = useMemo(() => result.data?.pages.flatMap((p) => p.rows) ?? [], [result.data]);
  const masked = useMemo(() => {
    const m = new Map<number, Map<string, string>>();
    for (const p of result.data?.pages ?? [])
      for (const x of p.masked ?? []) {
        if (!m.has(x.id)) m.set(x.id, new Map());
        m.get(x.id)!.set(x.field, x.text);
      }
    return m;
  }, [result.data]);
  useEffect(() => onRows?.(rows), [rows, onRows]);
  const first = result.data?.pages[0];
  const error =
    result.error instanceof ApiError
      ? result.error
      : result.error
        ? new ApiError(0, { title: String(result.error), status: 0 })
        : null;

  useEffect(() => {
    onMeta?.({
      total: first?.total ?? null,
      loaded: rows.length,
      isEstimate: first?.totalIsEstimate ?? false,
      fetching: result.isFetching,
      error,
    });
  }, [first?.total, first?.totalIsEstimate, rows.length, result.isFetching, error, onMeta]);

  // New filter or sort: back to the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [query]);

  const visibleFields = useMemo(() => {
    const byName = new Map(fields.fields.map((f) => [f.field, f]));
    const names = state.visible ?? fields.fields.filter((f) => !f.hidden).map((f) => f.field);
    // Filter-only fields (e.g. EDR Number or Msg ID) never become columns.
    return names.map((n) => byName.get(n)).filter((f): f is FieldDescriptor => !!f && !f.filterOnly);
  }, [fields, state.visible]);

  // Auto-fit (team trial round 7): measured again when more of the first rows load or the columns change.
  const fitRows = Math.min(rows.length, AUTO_FIT_ROWS);
  const fitted = useMemo(
    () =>
      autoFit && fitRows
        ? fitWidths(scrollRef.current, visibleFields, rows, (f) => columns[f.field]?.label ?? f.label)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autoFit, fitRows, rows[0], visibleFields, columns],
  );

  // TanStack Table holds the column model and widths; data stays server-side (manual mode).
  const [sizing, setSizing] = useState<ColumnSizingState>({});
  const columnDefs = useMemo<ColumnDef<Row>[]>(
    () =>
      visibleFields.map((f) => ({
        id: f.field,
        size: fitted?.get(f.field) ?? columns[f.field]?.width ?? defaultWidth(f),
        minSize: 48,
        maxSize: autoFit ? AUTO_FIT_MAX : 800,
      })),
    [visibleFields, columns, fitted, autoFit],
  );
  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    state: { columnSizing: sizing },
    onColumnSizingChange: setSizing,
    getRowId: (r) => String(r.id),
  });
  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const naturalCells = useMemo(
    () =>
      headers.map((h) => {
        const f = visibleFields.find((x) => x.field === h.column.id)!;
        const o = columns[f.field];
        return {
          field: f,
          width: h.getSize(),
          align: o?.align ?? (isNumeric(f) ? "right" : f.field === "status" ? "center" : "left"),
          render: o?.render,
          label: o?.label,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [headers.map((h) => `${h.column.id}:${h.getSize()}`).join(), visibleFields, columns],
  );
  // Columns fit the grid's width (team trial round 5: no sideways scrolling): the set widths are scaled to the
  // space there is, never below FIT_MIN, so dragging a column wider takes the room from the others.
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    ro.observe(el);
    setBoxWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const cells = useMemo(() => {
    const fixed = 40 + (trailing?.width ?? 0);
    const sum = naturalCells.reduce((n, c) => n + c.width, 0);
    if (boxWidth <= 0 || sum <= 0) return naturalCells;
    // Auto-fitted columns only grow to fill the width, never shrink (no truncation; the grid scrolls sideways).
    const scale = autoFit ? Math.max(1, (boxWidth - fixed - 2) / sum) : (boxWidth - fixed - 2) / sum;
    return naturalCells.map((c) => ({ ...c, width: Math.max(FIT_MIN, Math.floor(c.width * scale)) }));
  }, [naturalCells, boxWidth, trailing?.width, autoFit]);
  const totalWidth = 40 + cells.reduce((s, c) => s + c.width, 0) + (trailing?.width ?? 0);
  // Cards on a phone-sized window only (team trial round 6): a narrow pane on a desktop (Rate manager beside an open
  // table) keeps the table and scrolls sideways.
  const mobile = boxWidth > 0 && window.innerWidth < CARD_BELOW;

  const virtualizer = useVirtualizer({
    count: rows.length + (result.hasNextPage ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (mobile ? CARD_HEIGHT : rowHeight),
    overscan: 12,
  });
  useEffect(() => virtualizer.measure(), [mobile]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1]!.index : 0;
  useEffect(() => {
    if (result.hasNextPage && !result.isFetchingNextPage && lastIndex >= rows.length - 40) void result.fetchNextPage();
  }, [lastIndex, rows.length, result]);

  const activeIndex = activeId === null ? -1 : rows.findIndex((r) => r.id === activeId);

  const onRowClick = useCallback(
    (row: Row, e: MouseEvent) => {
      if ((e.ctrlKey || e.metaKey) && onOpen) return onOpen(row, e);
      // Text being selected to copy is not a click on the row (team trial round 6).
      if (window.getSelection()?.toString()) return;
      onActiveChange(row);
      scrollRef.current?.focus({ preventScroll: true });
    },
    [onActiveChange, onOpen],
  );
  const onRowDouble = useCallback((row: Row, e: MouseEvent) => onOpen?.(row, e), [onOpen]);
  const onCheck = useCallback(
    (row: Row, shift: boolean) => {
      const next = new Set(selected);
      const idx = rows.findIndex((r) => r.id === row.id);
      if (shift && lastChecked.current !== null) {
        // Shift: select the range from the last checked row.
        const from = Math.min(lastChecked.current, idx);
        const to = Math.max(lastChecked.current, idx);
        for (let i = from; i <= to; i++) next.add(rows[i]!.id);
      } else if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      lastChecked.current = idx;
      onSelectedChange(next);
    },
    [rows, selected, onSelectedChange],
  );

  // ↑↓ move · Space select · Enter open · Home / End (§15.4 status bar shortcuts).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("input, select, textarea, button")) return;
    let next = activeIndex;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, activeIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, activeIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "PageDown") next = Math.min(rows.length - 1, activeIndex + 15);
    else if (e.key === "PageUp") next = Math.max(0, activeIndex - 15);
    else if (e.key === " " && activeIndex >= 0) {
      e.preventDefault();
      onCheck(rows[activeIndex]!, e.shiftKey);
      return;
    } else if (e.key === "Enter" && activeIndex >= 0) {
      onOpen?.(rows[activeIndex]!, e);
      return;
    } else {
      if (!e.ctrlKey && !e.metaKey && !e.altKey && onKeyAction?.(e.key, rows[activeIndex] ?? null)) e.preventDefault();
      return;
    }
    e.preventDefault();
    if (next >= 0 && rows[next]) {
      onActiveChange(rows[next]!);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someChecked = !allChecked && rows.some((r) => selected.has(r.id));

  // Select all matching (team trial round 1): loads the remaining pages, up to SELECT_ALL_MAX rows,
  // then selects every row the filters match, not only the loaded ones.
  const [selectingAll, setSelectingAll] = useState(false);
  useEffect(() => {
    if (!selectingAll || result.isFetching) return;
    if (result.hasNextPage && rows.length < SELECT_ALL_MAX) {
      void result.fetchNextPage();
      return;
    }
    setSelectingAll(false);
    onSelectedChange(new Set(rows.slice(0, SELECT_ALL_MAX).map((r) => r.id)));
  }, [selectingAll, result.isFetching, result.hasNextPage, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = first?.total ?? null;
  const moreMatch = allChecked && total !== null && total > rows.length && !first?.totalIsEstimate;

  return (
    <div
      className={`grid${mobile ? " mobile" : ""}`}
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="grid"
      style={rowHeight !== ROW_HEIGHT ? ({ "--grid-body-row-height": `${rowHeight}px` } as CSSProperties) : undefined}
      aria-rowcount={first?.total ?? -1}
      aria-busy={result.isFetching}
    >
      <div className="grid-inner" style={{ width: mobile ? "100%" : totalWidth }}>
        {mobile && <MobileSort cells={cells} state={state} onStateChange={onStateChange} />}
        <div className="gh" role="row">
          <div className="gh-cell gc-check">
            <input
              type="checkbox"
              aria-label="Select all loaded rows"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = someChecked;
              }}
              onChange={() => onSelectedChange(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
            />
          </div>
          {cells.map((c, i) => (
            <HeaderCell
              key={c.field.field}
              field={c.field}
              state={state}
              onStateChange={onStateChange}
              width={c.width}
              align={c.align}
              label={c.label}
              onResizeStart={headers[i]!.getResizeHandler()}
            />
          ))}
          {trailing && (
            <div className="gh-cell" style={{ width: trailing.width }}>
              {trailing.header}
            </div>
          )}
        </div>
        <div className="gf" role="row">
          <div className="gf-cell gc-check" />
          {cells.map((c) => (
            <div key={c.field.field} className="gf-cell" style={{ width: c.width }}>
              {c.field.operators.length > 0 && (
                <ColumnFilter
                  field={c.field}
                  condition={state.columns[c.field.field]}
                  onChange={(cond) => {
                    const columns = { ...state.columns };
                    if (cond) columns[c.field.field] = cond;
                    else delete columns[c.field.field];
                    onStateChange({ ...state, columns, viewId: state.viewId });
                  }}
                />
              )}
            </div>
          ))}
          {trailing && <div className="gf-cell" style={{ width: trailing.width }} />}
        </div>
        {(moreMatch || selectingAll) && (
          <div className="grid-selall" role="status">
            {selectingAll ? (
              <span>Selecting… {rows.length.toLocaleString("en-US")} loaded</span>
            ) : (
              <>
                <span>All {rows.length.toLocaleString("en-US")} loaded rows are selected.</span>
                <button type="button" className="link" onClick={() => setSelectingAll(true)}>
                  Select all {Math.min(total!, SELECT_ALL_MAX).toLocaleString("en-US")}
                  {total! > SELECT_ALL_MAX ? ` of ${total!.toLocaleString("en-US")}` : ""} matching
                </button>
              </>
            )}
          </div>
        )}
        <div className="gb" style={{ height: Math.max(virtualizer.getTotalSize(), 120) }} role="rowgroup">
          {error && (
            <div className="grid-message error">
              <Icon name="alert" />{" "}
              {error.status === 503 ? `${error.problem.title}. ${error.problem.detail ?? ""}` : error.message}
              {error.problem.errors?.length ? (
                <ul>
                  {error.problem.errors.map((e, i) => (
                    <li key={i}>
                      {e.path}: {e.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          {!error && result.isSuccess && rows.length === 0 && (
            <div className="grid-message muted">No rows match these filters.</div>
          )}
          {!error && result.isPending && (
            // A held query never loads by itself: say what starts it instead of "Loading…".
            <div className="grid-message muted">{enabled ? "Loading…" : idleMessage}</div>
          )}
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) {
              return (
                <div key="loader" className="gr loader" style={{ transform: `translateY(${item.start}px)` }}>
                  <div className="gc muted">Loading more…</div>
                </div>
              );
            }
            const Item = mobile ? MobileCard : GridRow;
            return (
              <Item
                key={row.id}
                row={row}
                index={item.index}
                top={item.start}
                cells={cells}
                active={row.id === activeId}
                checked={selected.has(row.id)}
                onClick={onRowClick}
                onDoubleClick={onRowDouble}
                onCheck={onCheck}
                trailing={trailing as RowProps<Row>["trailing"]}
                extraClass={rowClass?.(row)}
                masked={masked.get(row.id)}
              />
            );
          })}
          {/* Column lines (team trial round 6): one overlay over the rows, at each column's right edge. */}
          {!mobile && (
            <div className="g-lines" style={{ height: virtualizer.getTotalSize() }} aria-hidden>
              {lineOffsets(cells).map((x) => (
                <span key={x} style={{ left: x }} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
