// Drag to reorder rows of a small list (team trial round 4: translation and HLR rules on trunks and enterprises).
// HTML5 drag and drop on the rows: grab the handle, drop on another row to take its place. Alt+↑ / Alt+↓ on a
// focused row moves it with the keyboard.
import { useState, type DragEvent, type KeyboardEvent } from "react";

/** Moves item `from` to index `to` (the dropped-on row's place). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
}

export function useDragOrder<T>(rows: T[], onChange: (rows: T[]) => void, disabled = false) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  /** Props for each row (`<tr>`). */
  const rowProps = (i: number) =>
    disabled
      ? {}
      : {
          draggable: true,
          tabIndex: 0,
          className: `${dragging === i ? "dragging" : ""}${over === i && dragging !== i ? " drop-target" : ""}`,
          onDragStart: (e: DragEvent) => {
            setDragging(i);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(i));
          },
          onDragOver: (e: DragEvent) => {
            if (dragging === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (over !== i) setOver(i);
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (dragging !== null) onChange(moveItem(rows, dragging, i));
            setDragging(null);
            setOver(null);
          },
          onDragEnd: () => {
            setDragging(null);
            setOver(null);
          },
          onKeyDown: (e: KeyboardEvent) => {
            if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            onChange(moveItem(rows, i, e.key === "ArrowUp" ? i - 1 : i + 1));
          },
        };
  return { rowProps };
}
