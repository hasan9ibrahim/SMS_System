// Left panel of the Rate Manager detail mode (§13.12): Customer (sell) / Vendor (buy)
// switch, filter box, tables grouped by product category with their rate count and a
// scheduled-changes badge, "+ New rate table" at the bottom. Loads page by page as it
// scrolls; the server sorts and filters (CLAUDE.md rule 3).
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ListQuery, RateTableRow } from "@sms/contract";
import { fetchListPage } from "../../api/hooks";
import { useRateTable } from "../../api/records";
import { Button } from "../../ui/primitives";
import { newRateTable, useOpenTable } from "./RateManagerPage";

export function RateTablePanel({ openId }: { openId: number }) {
  const open = useOpenTable();
  const current = useRateTable(openId);
  const [kind, setKind] = useState<"customer" | "vendor" | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const effectiveKind = kind ?? current.data?.kind ?? "customer";
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const tables = useInfiniteQuery({
    queryKey: ["list", "rate_tables", "panel", effectiveKind, q],
    queryFn: ({ pageParam }) =>
      fetchListPage<RateTableRow>("rate_tables", {
        filter: { logic: "and", conditions: [{ field: "kind", op: "eq", value: effectiveKind }] },
        ...(q ? { search: q } : {}),
        sort: [
          { field: "category", dir: "asc" },
          { field: "name", dir: "asc" },
        ],
        limit: 100,
        cursor: pageParam,
        withTotal: true,
      } as ListQuery),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
  });
  const rows = tables.data?.pages.flatMap((p) => p.rows) ?? [];
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && tables.hasNextPage && !tables.isFetchingNextPage) void tables.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [tables]);

  let lastCategory = "";
  return (
    <aside className="rate-panel" aria-label="Rate tables">
      <div className="segmented" role="tablist">
        {(["customer", "vendor"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={effectiveKind === k}
            className={effectiveKind === k ? "on" : ""}
            onClick={() => setKind(k)}
          >
            {k === "customer" ? "Customer (sell)" : "Vendor (buy)"}
          </button>
        ))}
      </div>
      <input
        className="panel-filter"
        placeholder="Filter rate tables…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Filter rate tables"
      />
      <div className="panel-list">
        {rows.map((r) => {
          const header = r.category !== lastCategory;
          lastCategory = r.category;
          return (
            <div key={r.id}>
              {header && (
                <div className="panel-group">
                  {r.kind === "customer" ? "Customer" : "Vendor"} · {r.category}
                </div>
              )}
              <button
                type="button"
                className={`panel-item${r.id === openId ? " on" : ""}`}
                onClick={(e) => open(r.id, { newTab: e.ctrlKey || e.metaKey, name: r.name })}
                onAuxClick={(e) => e.button === 1 && open(r.id, { newTab: true, name: r.name })}
                title={`${r.name} · ${r.currency}`}
              >
                <span className="panel-name">{r.name}</span>
                <span className="muted small num">{r.activeLines.toLocaleString("en-US")} rates</span>
                {r.scheduledChanges > 0 && (
                  <span className="tag panel-badge num">{r.scheduledChanges.toLocaleString("en-US")} scheduled</span>
                )}
              </button>
            </div>
          );
        })}
        {tables.isSuccess && rows.length === 0 && <p className="muted small pad">No table matches.</p>}
        <div ref={sentinel} className="panel-more">
          {tables.isFetchingNextPage ? <span className="muted small">Loading more…</span> : null}
        </div>
      </div>
      <div className="panel-foot">
        <span className="muted small">{tables.data?.pages[0]?.total.toLocaleString("en-US") ?? ""} tables</span>
        <Button small icon="plus" onClick={() => void newRateTable((id) => open(id))}>
          New rate table
        </Button>
        <Button small variant="ghost" icon="columns" onClick={() => open(null)} title="Back to the full list">
          Full list
        </Button>
      </div>
    </aside>
  );
}
