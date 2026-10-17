// A compact virtualised table for result panels and the lookup matrix (CLAUDE.md rule 3:
// lists scroll with virtualisation). Sticky header, optional sticky left columns, rows
// loaded page by page through onEndReached. Rows come from the server in server order.
import { useEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export interface VColumn<Row> {
  key: string;
  header: ReactNode;
  width: number;
  align?: "left" | "right" | "center";
  /** Stays in view when scrolling sideways (the first columns only). */
  sticky?: boolean;
  title?: string;
  render: (row: Row) => ReactNode;
  cellClass?: (row: Row) => string | undefined;
}

export function VirtualTable<Row>({
  rows,
  columns,
  rowKey,
  rowHeight = 34,
  onEndReached,
  loadingMore,
  empty,
  rowClass,
  label,
  onRowClick,
}: {
  rows: Row[];
  columns: VColumn<Row>[];
  rowKey: (row: Row) => string;
  rowHeight?: number;
  onEndReached?: () => void;
  loadingMore?: boolean;
  empty?: ReactNode;
  rowClass?: (row: Row) => string | undefined;
  label: string;
  /** Selects a row (e.g. to open it in a side panel). */
  onRowClick?: (row: Row) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();
  const last = items.length ? items[items.length - 1]!.index : -1;
  useEffect(() => {
    if (onEndReached && !loadingMore && rows.length > 0 && last >= rows.length - 15) onEndReached();
  }, [last, rows.length, loadingMore, onEndReached]);

  let left = 0;
  const offsets = columns.map((c) => {
    const at = left;
    if (c.sticky) left += c.width;
    return at;
  });
  const width = columns.reduce((s, c) => s + c.width, 0);
  const cellStyle = (c: VColumn<Row>, i: number) => ({
    width: c.width,
    ...(c.sticky ? { position: "sticky" as const, left: offsets[i], zIndex: 1 } : {}),
  });

  return (
    <div className="vt" ref={scroll} role="table" aria-label={label} aria-rowcount={rows.length}>
      <div className="vt-inner" style={{ width }}>
        <div className="vt-head" role="row">
          {columns.map((c, i) => (
            <div
              key={c.key}
              role="columnheader"
              className={`vt-cell align-${c.align ?? "left"}${c.sticky ? " sticky" : ""}`}
              style={cellStyle(c, i)}
              title={c.title}
            >
              {c.header}
            </div>
          ))}
        </div>
        <div className="vt-body" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={rowKey(row)}
                role="row"
                className={`vt-row${rowClass?.(row) ? ` ${rowClass(row)}` : ""}${onRowClick ? " clickable" : ""}`}
                style={{ transform: `translateY(${item.start}px)`, height: rowHeight }}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c, i) => (
                  <div
                    key={c.key}
                    role="cell"
                    className={`vt-cell align-${c.align ?? "left"}${c.sticky ? " sticky" : ""}${c.cellClass?.(row) ? ` ${c.cellClass(row)}` : ""}`}
                    style={cellStyle(c, i)}
                  >
                    {c.render(row)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && empty && <div className="vt-empty muted">{empty}</div>}
        {loadingMore && <div className="vt-empty muted">Loading more…</div>}
      </div>
    </div>
  );
}
