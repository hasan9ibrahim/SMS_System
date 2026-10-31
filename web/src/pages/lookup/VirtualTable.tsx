// A compact virtualised table for result panels and the lookup matrix (CLAUDE.md rule 3:
// lists scroll with virtualisation). Sticky header, optional sticky left columns, rows
// loaded page by page through onEndReached. Rows come from the server in server order.
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  /** A filter shown under the header, like the column filters of the other grids (team trial round 2). */
  filter?: ReactNode;
}

/** Plain text in its own box, so a value wider than its cell ends in an ellipsis (design QA round 13). */
const textBox = (v: ReactNode) =>
  typeof v === "string" || typeof v === "number" ? <span className="vt-text">{v}</span> : v;

export function VirtualTable<Row>({
  rows,
  columns: given,
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

  // Columns grow to fill a wider panel, e.g. one side of Rate Lookup on its own (team trial round 7); never shrink.
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    ro.observe(el);
    setBoxWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const natural = given.reduce((s, c) => s + c.width, 0);
  const grow = natural > 0 && boxWidth > natural ? boxWidth / natural : 1;
  const columns = grow === 1 ? given : given.map((c) => ({ ...c, width: Math.floor(c.width * grow) }));

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
              {textBox(c.header)}
            </div>
          ))}
        </div>
        {columns.some((c) => c.filter) && (
          <div className="vt-filters" role="row">
            {columns.map((c, i) => (
              <div key={c.key} role="cell" className={`vt-cell${c.sticky ? " sticky" : ""}`} style={cellStyle(c, i)}>
                {c.filter}
              </div>
            ))}
          </div>
        )}
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
                    {textBox(c.render(row))}
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
