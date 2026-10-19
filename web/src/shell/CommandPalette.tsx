// Search or jump to (Ctrl K, §15.1): pages from the menu registry, and records (enterprises,
// trunks, rate tables, route rules, users) from GET /search.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import type { SearchHit } from "@sms/contract";
import { useRecordSearch } from "../api/hooks";
import { PAGES, SECTIONS, HOME, type PageDef } from "../nav/registry";
import { Icon, type IconName } from "../ui/Icon";
import { useOpener } from "./useOpener";

interface PaletteState {
  open: boolean;
  newTab: boolean;
  show: (opts?: { newTab?: boolean }) => void;
  hide: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  newTab: false,
  show: (opts) => set({ open: true, newTab: opts?.newTab ?? false }),
  hide: () => set({ open: false }),
}));

/** Where a search hit opens. Records whose screens come later open their page with the ID. */
export function recordPath(hit: SearchHit): string {
  switch (hit.kind) {
    case "enterprise":
      return `/enterprises/${hit.id}`;
    case "customer_trunk":
      return `/enterprises/customer-trunks/${hit.id}`;
    case "vendor_trunk":
      return `/enterprises/vendor-trunks/${hit.id}`;
    case "rate_table":
      return `/rates/manager?table=${hit.id}`;
    case "route_rule":
      return `/routing/rules?rule=${hit.id}`;
    case "user":
      return `/admin/users?user=${hit.id}`;
  }
}

const KIND: Record<SearchHit["kind"], { label: string; icon: IconName }> = {
  enterprise: { label: "Enterprise", icon: "building" },
  customer_trunk: { label: "Customer trunk", icon: "route" },
  vendor_trunk: { label: "Vendor trunk", icon: "route" },
  rate_table: { label: "Rate table", icon: "tag" },
  route_rule: { label: "Route rule", icon: "route" },
  user: { label: "User", icon: "user" },
};

interface Item {
  key: string;
  icon: IconName;
  label: string;
  detail: string;
  path: string;
  group: "Pages" | "Records";
}

const sectionLabel = (pg: PageDef) => SECTIONS.find((s) => s.key === pg.section)!.label;

function matchPages(q: string): Item[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = [HOME, ...PAGES];
  const scored = all
    .map((pg) => {
      const hay = `${pg.label} ${sectionLabel(pg)} ${pg.summary} ${pg.spec}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      const label = pg.label.toLowerCase();
      const score = words.reduce((s, w) => s + (label.startsWith(w) ? 3 : label.includes(w) ? 2 : 0), 0);
      return { pg, score };
    })
    .filter((x): x is { pg: PageDef; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || a.pg.label.localeCompare(b.pg.label));
  return scored.slice(0, words.length ? 8 : 10).map(({ pg }) => ({
    key: `page:${pg.key}`,
    icon: pg.icon,
    label: pg.label,
    detail: `${sectionLabel(pg)} · ${pg.summary}`,
    path: pg.path,
    group: "Pages",
  }));
}

export function CommandPalette({ popout = false }: { popout?: boolean }) {
  const { open, newTab, hide } = usePalette();
  const opener = useOpener({ popout });
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const records = useRecordSearch(debounced);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ("");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const pages = matchPages(q);
    const hits: Item[] = (q.trim() && records.data ? records.data.hits : []).map((h) => ({
      key: `${h.kind}:${h.id}`,
      icon: KIND[h.kind].icon,
      label: h.label,
      detail: h.detail ?? KIND[h.kind].label,
      path: recordPath(h),
      group: "Records",
    }));
    return [...pages, ...hits];
  }, [q, records.data]);

  useEffect(() => setIndex((i) => Math.min(i, Math.max(0, items.length - 1))), [items.length]);

  if (!open) return null;
  const choose = (item: Item, forceNew: boolean) => {
    hide();
    opener(
      item.path,
      forceNew || newTab ? { ctrlKey: true } : undefined,
      item.group === "Records" ? item.label : undefined,
    );
  };

  return createPortal(
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && hide()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search or jump to">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={q}
            placeholder="Page, enterprise, trunk, rate table, rule or user…"
            aria-label="Search"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") hide();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              }
              if (e.key === "Enter" && items[index]) choose(items[index]!, e.ctrlKey || e.metaKey);
            }}
          />
          {records.isFetching && <span className="muted small">searching…</span>}
        </div>
        <div className="palette-results" role="listbox">
          {items.length === 0 && (
            <p className="muted pad">
              {records.isError ? "Record search needs the mock server and seeded database." : "No matches."}
            </p>
          )}
          {items.map((item, i) => (
            <div key={item.key}>
              {(i === 0 || items[i - 1]!.group !== item.group) && <div className="palette-group">{item.group}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                className={`palette-item${i === index ? " selected" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={(e) => choose(item, e.ctrlKey || e.metaKey)}
              >
                <Icon name={item.icon} size={15} />
                <span className="palette-label">{item.label}</span>
                <span className="palette-detail">{item.detail}</span>
              </button>
            </div>
          ))}
        </div>
        <div className="palette-foot muted small">
          <span>↑↓ move</span>
          <span>Enter open</span>
          <span>Ctrl+Enter new tab</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
