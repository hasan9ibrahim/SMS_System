// Column fitting for the standard grid (§15.1): the text a cell shows, to measure it, and how columns share a width
// that is too narrow for all of them (design QA round 13).
import { isValidElement, type ReactNode } from "react";

/** The text in a column's render (a time with "UTC", a rate to 6 places, "↑ +13.2%"); empty for a component. */
export function nodeText(n: ReactNode): string {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join("");
  if (isValidElement(n)) {
    const props = n.props as { children?: ReactNode; className?: unknown };
    // A two-line cell (a value over a muted note) is as wide as its longer line, not both side by side (QA round 13).
    if (typeof props.className === "string" && /\btwo-line\b/.test(props.className)) {
      const lines = (Array.isArray(props.children) ? props.children : [props.children]).map(nodeText);
      return lines.reduce((a, b) => (b.length > a.length ? b : a), "");
    }
    return nodeText(props.children);
  }
  return "";
}

/**
 * Narrows columns to `space`. First the room no value needs, from any column (a wide Checks column with short chips);
 * then text columns give theirs down to their floor. Figures, codes and dates never go below their floor: when that is
 * not enough the total stays wider than `space` and the grid scrolls sideways.
 */
export function shareWidth(
  space: number,
  cols: { base: number; floor: number; content: number; atomic: boolean }[],
): number[] {
  const width = cols.map((c) => c.base);
  let short = width.reduce((n, w) => n + w, 0) - space;
  if (short <= 0) return width;
  const fit = cols.map((c) => Math.min(c.base, Math.max(c.floor, c.content)));
  const all = cols.map((_, i) => i);
  const text = all.filter((i) => !cols[i]!.atomic);
  const floor = cols.map((c) => c.floor);
  for (const [idx, to] of [
    [all, fit],
    [text, floor],
  ] as const) {
    const slack = idx.reduce((n, i) => n + width[i]! - to[i]!, 0);
    if (short <= 0 || slack <= 0) continue;
    const take = Math.min(short, slack);
    for (const i of idx) width[i] = width[i]! - ((width[i]! - to[i]!) * take) / slack;
    short -= take;
  }
  return width;
}
