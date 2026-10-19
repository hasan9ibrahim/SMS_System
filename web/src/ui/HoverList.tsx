// Hover list (team trial round 1): pointing at a cell that holds several items (destinations, trunks,
// vendors) opens a small window listing them all, one per line.
import { useRef, useState, type ReactNode } from "react";
import { Popover } from "./primitives";

export function HoverList({
  items,
  more = 0,
  heading,
  disabled,
  children,
}: {
  items: string[];
  /** Items not listed (shown as "… and N more"). */
  more?: number;
  heading?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const enter = () => {
    clear();
    timer.current = window.setTimeout(() => setOpen(true), 300);
  };
  const leave = () => {
    clear();
    timer.current = window.setTimeout(() => setOpen(false), 200);
  };
  // One item says it all in the cell; the window is for lists.
  const useful = !disabled && items.length + more > 1;
  return (
    <>
      <span
        ref={anchor}
        className="hover-list-target"
        onMouseEnter={useful ? enter : undefined}
        onMouseLeave={useful ? leave : undefined}
      >
        {children}
      </span>
      <Popover anchor={anchor} open={open && useful} onClose={() => setOpen(false)} className="hover-list">
        <div onMouseEnter={clear} onMouseLeave={leave}>
          {heading && <div className="hover-list-head">{heading}</div>}
          <ul>
            {items.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
          {more > 0 && <div className="hover-list-more">… and {more} more</div>}
        </div>
      </Popover>
    </>
  );
}
