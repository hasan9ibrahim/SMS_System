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
} from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useReactTable, getCoreRowModel, type ColumnDef, type ColumnSizingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FieldDescriptor, ListFields, ListId } from "@sms/contract";
import { fetchListPage } from "../api/hooks";
import { ApiError } from "../api/client";
import { Icon } from "../ui/Icon";
import { StatusDot } from "../ui/primitives";
import { ColumnFilter } from "./ColumnFilter";
import { isChoice, isNumeric, isTime, nextSort, toListQuery, type GridState } from "./filterModel";

export const ROW_HEIGHT = 38;
const PAGE_SIZE = 200;

export interface ColumnOverride<Row> {
  width?: number;
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
}

/** Default cell text by field type. */
export function defaultCell(f: FieldDescriptor, value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  if (f.field === "status" && (value === "active" || value === "inactive")) {
    return (
      <StatusDot
        tone={value === "active" ? "good" : "neutral"}
        hollow={value === "inactive"}
        label={value === "active" ? "Active" : "Inactive"}
      />
    );
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

const defaultWidth = (f: FieldDescriptor) =>
  f.field === "id" ? 80 : isNumeric(f) ? 110 : isChoice(f) ? 120 : isTime(f) ? 150 : f.field === "status" ? 70 : 180;

function HeaderCell({
  field,
  state,
  onStateChange,
  width,
  onResizeStart,
  align,
}: {
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
      <span className="gh-label">{field.label}</span>
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
  cells: { field: FieldDescriptor; width: number; align: string; render?: (row: Row) => ReactNode }[];
  active: boolean;
  checked: boolean;
  onClick: (row: Row, e: MouseEvent) => void;
  onDoubleClick: (row: Row, e: MouseEvent) => void;
  onCheck: (row: Row, shift: boolean) => void;
  trailing?: DataGridProps<{ id: number }>["trailing"];
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
}: RowProps<Row>) {
  return (
    <div
      className={`gr${active ? " active" : ""}${checked ? " checked" : ""}${isArchived(row) ? " archived" : ""}`}
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
          {c.render ? c.render(row) : defaultCell(c.field, (row as Record<string, unknown>)[c.field.field])}
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
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastChecked = useRef<number | null>(null);
  const query = useMemo(() => toListQuery(state), [state]);

  const result = useInfiniteQuery({
    queryKey: ["list", list, query],
    queryFn: ({ pageParam }) =>
      fetchListPage<Row>(list, { ...query, limit: PAGE_SIZE, cursor: pageParam, withTotal: true }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
  });
  const rows = useMemo(() => result.data?.pages.flatMap((p) => p.rows) ?? [], [result.data]);
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
    return names.map((n) => byName.get(n)).filter((f): f is FieldDescriptor => !!f);
  }, [fields, state.visible]);

  // TanStack Table holds the column model and widths; data stays server-side (manual mode).
  const [sizing, setSizing] = useState<ColumnSizingState>({});
  const columnDefs = useMemo<ColumnDef<Row>[]>(
    () =>
      visibleFields.map((f) => ({
        id: f.field,
        size: columns[f.field]?.width ?? defaultWidth(f),
        minSize: 48,
        maxSize: 800,
      })),
    [visibleFields, columns],
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
  const cells = useMemo(
    () =>
      headers.map((h) => {
        const f = visibleFields.find((x) => x.field === h.column.id)!;
        const o = columns[f.field];
        return {
          field: f,
          width: h.getSize(),
          align: o?.align ?? (isNumeric(f) ? "right" : f.field === "status" ? "center" : "left"),
          render: o?.render,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [headers.map((h) => `${h.column.id}:${h.getSize()}`).join(), visibleFields, columns],
  );
  const totalWidth = 40 + cells.reduce((s, c) => s + c.width, 0) + (trailing?.width ?? 0);

  const virtualizer = useVirtualizer({
    count: rows.length + (result.hasNextPage ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1]!.index : 0;
  useEffect(() => {
    if (result.hasNextPage && !result.isFetchingNextPage && lastIndex >= rows.length - 40) void result.fetchNextPage();
  }, [lastIndex, rows.length, result]);

  const activeIndex = activeId === null ? -1 : rows.findIndex((r) => r.id === activeId);

  const onRowClick = useCallback(
    (row: Row, e: MouseEvent) => {
      if ((e.ctrlKey || e.metaKey) && onOpen) return onOpen(row, e);
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
    } else return;
    e.preventDefault();
    if (next >= 0 && rows[next]) {
      onActiveChange(rows[next]!);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someChecked = !allChecked && rows.some((r) => selected.has(r.id));

  return (
    <div
      className="grid"
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="grid"
      aria-rowcount={first?.total ?? -1}
      aria-busy={result.isFetching}
    >
      <div className="grid-inner" style={{ width: totalWidth }}>
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
            </div>
          ))}
          {trailing && <div className="gf-cell" style={{ width: trailing.width }} />}
        </div>
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
          {!error && result.isPending && <div className="grid-message muted">Loading…</div>}
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) {
              return (
                <div key="loader" className="gr loader" style={{ transform: `translateY(${item.start}px)` }}>
                  <div className="gc muted">Loading more…</div>
                </div>
              );
            }
            return (
              <GridRow
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
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
