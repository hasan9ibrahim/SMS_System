// Rate Lookup side by side (team trial round 1, §13.16): customer rates on the left, vendor rates on
// the right, each with its own filters (product category, trunk, country, MCCMNC check lists and a
// search). A side lists the destinations its rate tables price now, with the number of tables and the
// price range; clicking a destination opens the tables pricing it, cheapest first. Lists are filtered,
// sorted and paged on the server (CLAUDE.md rule 3) and scroll with virtualisation.
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import type { LookupSide, LookupSideLine } from "@sms/contract";
import { api, unwrap } from "../../api/client";
import { usePageStatus, useTabNavigate } from "../../shell/tabContext";
import { CheckListButton } from "../../ui/CheckList";
import { Icon } from "../../ui/Icon";
import { VirtualTable, type VColumn } from "./VirtualTable";
import {
  flatten,
  noRange,
  optionItems,
  range,
  rangeBounds,
  sideFilters,
  type FlatRow,
  type RangeFilter,
  type SideSort,
  type SideState,
} from "./sideModel";

const TITLE: Record<LookupSide, string> = { customer: "Customer rates · sell", vendor: "Vendor rates · buy" };
const TRUNK: Record<LookupSide, string> = { customer: "Customer trunk", vendor: "Vendor trunk" };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A text filter under a column header: applied after a short pause, like the other grids. */
function TextFilter({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [v, setV] = useState(value);
  const d = useDebounced(v, 350);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (d !== value) onChange(d);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      value={v}
      aria-label={`Filter ${label}`}
      placeholder={placeholder ?? "Filter…"}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
    />
  );
}

/** A number filter under a column header: ≥, ≤ or between (team trial round 2). */
function RangeInput({
  value,
  onChange,
  label,
}: {
  value: RangeFilter;
  onChange: (v: RangeFilter) => void;
  label: string;
}) {
  const [r, setR] = useState(value);
  useEffect(() => setR(value), [value]);
  const commit = (next: RangeFilter) => {
    setR(next);
    const a = rangeBounds(next);
    const b = rangeBounds(value);
    if (a.min !== b.min || a.max !== b.max || (!next.op && value.op)) onChange(next);
  };
  return (
    <span className="vt-range" onClick={(e) => e.stopPropagation()}>
      <select
        aria-label={`${label} filter`}
        value={r.op}
        onChange={(e) => commit({ ...r, op: e.target.value as RangeFilter["op"] })}
      >
        <option value="">Any</option>
        <option value="gte">≥</option>
        <option value="lte">≤</option>
        <option value="between">Range</option>
      </select>
      {r.op && (
        <input
          inputMode="decimal"
          aria-label={`${label} ${r.op === "lte" ? "at most" : "at least"}`}
          placeholder={r.op === "between" ? "from" : ""}
          value={r.a}
          onChange={(e) => setR({ ...r, a: e.target.value })}
          onBlur={() => commit(r)}
          onKeyDown={(e) => e.key === "Enter" && commit(r)}
        />
      )}
      {r.op === "between" && (
        <input
          inputMode="decimal"
          aria-label={`${label} at most`}
          placeholder="to"
          value={r.b}
          onChange={(e) => setR({ ...r, b: e.target.value })}
          onBlur={() => commit(r)}
          onKeyDown={(e) => e.key === "Enter" && commit(r)}
        />
      )}
    </span>
  );
}

export function SidePanel({
  side,
  state,
  setState,
}: {
  side: LookupSide;
  state: SideState;
  setState: (s: SideState) => void;
}) {
  const navigate = useTabNavigate();

  const options = useQuery({
    queryKey: ["lookup-side-options", side],
    queryFn: () => unwrap(api.GET("/rate-lookup/side/options", { params: { query: { side } } })),
    staleTime: 60_000,
  });
  const items = useMemo(() => optionItems(options.data, state), [options.data, state]);
  const filters = useMemo(() => sideFilters(side, state), [side, state]);

  const pages = useInfiniteQuery({
    queryKey: ["lookup-side", filters, state.sort, state.dir],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.POST("/rate-lookup/side", {
          body: { ...filters, sort: state.sort, dir: state.dir, limit: 200, cursor: pageParam },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = useMemo(() => pages.data?.pages.flatMap((p) => p.rows) ?? [], [pages.data]);
  const total = pages.data?.pages[0]?.total ?? null;
  const currency = pages.data?.pages[0]?.platformCurrency ?? "";

  // Open destinations and their tables (loaded when opened, with the side's filters).
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => setOpen(new Set()), [filters]);
  const openList = [...open];
  const lineQueries = useQueries({
    queries: openList.map((code) => ({
      queryKey: ["lookup-side-lines", filters, code],
      queryFn: () => unwrap(api.POST("/rate-lookup/side/lines", { body: { ...filters, mccmnc: code } })),
      staleTime: 30_000,
    })),
  });
  const lines = new Map<string, LookupSideLine[] | "loading" | "error">();
  openList.forEach((code, i) => {
    const q = lineQueries[i]!;
    lines.set(code, q.data ? q.data.lines : q.isError ? "error" : "loading");
  });
  const flat = flatten(rows, open, lines);
  const toggle = (code: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });

  const set = (patch: Partial<SideState>) => setState({ ...state, ...patch });
  const sortBy = (sort: SideSort) =>
    set({
      sort,
      dir: state.sort === sort ? (state.dir === "asc" ? "desc" : "asc") : sort === "tables" ? "desc" : "asc",
    });
  const sortHead = (label: string, sort: SideSort) => (
    <button type="button" className="link vt-sort" onClick={() => sortBy(sort)} title={`Sort by ${label}`}>
      {label}
      {state.sort === sort ? (state.dir === "asc" ? " ▲" : " ▼") : ""}
    </button>
  );
  const openTable = (id: number, name: string) =>
    navigate(`/rates/manager?table=${id}`, { forceNew: true, title: `Rates · ${name}` });

  const columns: VColumn<FlatRow>[] = [
    {
      key: "dest",
      header: sortHead("Destination", "destination"),
      width: 250,
      filter: (
        <TextFilter
          label="destination"
          placeholder="Country or network…"
          value={state.destination ?? ""}
          onChange={(destination) => set({ destination })}
        />
      ),
      render: (r) =>
        r.kind === "dest" ? (
          <span className="sl-dest">
            <Icon name={r.open ? "chevronDown" : "chevronRight"} size={12} />
            <span className="strong">{r.row.country}</span>
            <span className={r.row.allNetworks ? "muted" : ""}> · {r.row.network}</span>
          </span>
        ) : r.kind === "line" ? (
          <span className="sl-line" title={r.line.trunks.map((t) => `${t.name} (${t.enterpriseName})`).join("\n")}>
            <button
              type="button"
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                openTable(r.line.rateTableId, r.line.rateTableName);
              }}
            >
              {r.line.rateTableName}
            </button>
            <span className="muted">
              {" "}
              · {r.line.trunks.length === 1 ? r.line.trunks[0]!.name : `${r.line.trunks.length} trunks`}
            </span>
          </span>
        ) : (
          <span className="sl-line muted">{r.text}</span>
        ),
    },
    {
      key: "code",
      header: "MCCMNC",
      // Fits the bold header (design QA round 13).
      width: 92,
      filter: (
        <TextFilter label="MCCMNC" placeholder="262…" value={state.code ?? ""} onChange={(code) => set({ code })} />
      ),
      render: (r) =>
        r.kind === "dest" ? (
          <span className="mono">{r.row.mccmnc}</span>
        ) : r.kind === "line" ? (
          <span className="muted">{r.line.category ?? ""}</span>
        ) : null,
    },
    {
      key: "tables",
      header: sortHead("Tables", "tables"),
      width: 96,
      filter: <RangeInput label="Tables" value={state.tables ?? noRange()} onChange={(tables) => set({ tables })} />,
      align: "right",
      render: (r) => (r.kind === "dest" ? <span className="strong">{r.row.tables}</span> : null),
    },
    {
      key: "price",
      header: "Price",
      title: "In the table currency",
      width: 160,
      filter: <RangeInput label="Price" value={state.price ?? noRange()} onChange={(price) => set({ price })} />,
      align: "right",
      render: (r) =>
        r.kind === "dest" ? (
          r.row.currency ? (
            <span className="num">
              {range(r.row.minRate, r.row.maxRate)} {r.row.currency}
            </span>
          ) : (
            <span className="muted" title="The tables use several currencies; compare in Sys price or open the row">
              several currencies
            </span>
          )
        ) : r.kind === "line" ? (
          <span
            className="num"
            title={
              r.line.nextRate !== null
                ? `Next: ${r.line.nextRate} from ${r.line.nextFrom?.slice(0, 10)}`
                : `Since ${r.line.effectiveFrom.slice(0, 10)}`
            }
          >
            {r.line.rate.toFixed(5)} {r.line.currency}
            {r.line.nextRate !== null && (
              <span className={r.line.nextRate > r.line.rate ? "tone-error" : "tone-success"}>
                {r.line.nextRate > r.line.rate ? " ▲" : " ▼"}
              </span>
            )}
          </span>
        ) : null,
    },
    {
      key: "sys",
      header: sortHead(`Sys price${currency ? ` (${currency})` : ""}`, "minSys"),
      title: "In the platform currency",
      width: 150,
      filter: <RangeInput label="Sys price" value={state.sys ?? noRange()} onChange={(sys) => set({ sys })} />,
      align: "right",
      render: (r) =>
        r.kind === "dest" ? (
          <span className="num strong">{range(r.row.minSys, r.row.maxSys)}</span>
        ) : r.kind === "line" ? (
          <span className={`num${r.best ? " tone-success strong" : ""}`}>{r.line.sysRate.toFixed(5)}</span>
        ) : null,
    },
  ];

  // The filters under the column headers stay (team trial round 3: destination, MCCMNC, tables and price ranges).
  const chosen =
    state.categoryIds.length +
    state.trunkIds.length +
    state.mccmncs.length +
    state.mccs.length +
    (state.destination ? 1 : 0) +
    (state.code ? 1 : 0) +
    (state.tables?.op ? 1 : 0) +
    (state.price?.op ? 1 : 0) +
    (state.sys?.op ? 1 : 0);
  return (
    <section className={`sl-side sl-${side}`} aria-label={TITLE[side]}>
      {/* Title, count and this side's own filters in one compact header (team trial round 3). */}
      <header className={`sl-head sl-head-${side}`}>
        <span className="sl-head-icon" aria-hidden="true">
          <Icon name={side === "customer" ? "arrowUpRight" : "arrowDownLeft"} size={14} />
        </span>
        <div className="sl-head-title">
          <h2>{TITLE[side]}</h2>
          <span className="muted small">
            {total === null ? "…" : `${total.toLocaleString("en-US")} destination${total === 1 ? "" : "s"}`}
            {state.search ? ` · filtered by "${state.search}"` : ""}
          </span>
        </div>
        <span className="fb-spacer" />
        {state.search && (
          <span className="chip accent">
            &quot;{state.search}&quot;
            <button type="button" aria-label="Clear the search" onClick={() => set({ search: "" })}>
              <Icon name="x" size={11} />
            </button>
          </span>
        )}
        <CheckListButton
          title="Product"
          items={items.categories}
          selected={state.categoryIds}
          onChange={(categoryIds) => set({ categoryIds })}
        />
        <CheckListButton
          title={TRUNK[side]}
          items={items.trunks}
          selected={state.trunkIds}
          onChange={(trunkIds) => set({ trunkIds })}
        />
        <CheckListButton
          title="Country"
          items={items.countries}
          selected={state.mccs}
          onChange={(mccs) => {
            // Codes outside the chosen countries drop out.
            const keep = mccs.length ? state.mccmncs.filter((c) => mccs.includes(c.slice(0, 3))) : state.mccmncs;
            set({ mccs, mccmncs: keep });
          }}
        />
        <CheckListButton
          title="MCCMNC"
          items={items.codes}
          selected={state.mccmncs}
          onChange={(mccmncs) => set({ mccmncs })}
        />
        {chosen > 0 && (
          <button
            type="button"
            className="link small"
            onClick={() =>
              setState({
                ...state,
                categoryIds: [],
                trunkIds: [],
                mccs: [],
                mccmncs: [],
                destination: "",
                code: "",
                tables: noRange(),
                price: noRange(),
                sys: noRange(),
              })
            }
          >
            Clear
          </button>
        )}
      </header>
      <div className="sl-table">
        {pages.isError ? (
          <div className="vt-empty tone-error">Could not load the rates. Try again.</div>
        ) : (
          <VirtualTable<FlatRow>
            label={TITLE[side]}
            rows={flat}
            columns={columns}
            rowHeight={32}
            rowKey={(r) =>
              r.kind === "dest"
                ? r.row.mccmnc
                : r.kind === "line"
                  ? `${r.code}:${r.line.rateTableId}`
                  : `${r.code}:note`
            }
            rowClass={(r) => (r.kind === "dest" ? `sl-dest-row${r.open ? " open" : ""}` : "sl-line-row")}
            onRowClick={(r) => r.kind === "dest" && toggle(r.row.mccmnc)}
            onEndReached={() => pages.hasNextPage && void pages.fetchNextPage()}
            loadingMore={pages.isFetchingNextPage}
            empty={pages.isPending ? "Loading…" : "No destination matches these filters"}
          />
        )}
      </div>
    </section>
  );
}

export function SideLookup({
  show,
  customer,
  vendor,
  setCustomer,
  setVendor,
  setBoth,
}: {
  show: "both" | "customer" | "vendor";
  customer: SideState;
  vendor: SideState;
  setCustomer: (s: SideState) => void;
  setVendor: (s: SideState) => void;
  setBoth: (customer: SideState, vendor: SideState) => void;
}) {
  usePageStatus({
    rows: "",
    shortcuts: "Click a destination to see its rate tables · click a table name to open it in Rate Manager",
  });
  // One search and Include inactive trunks for both sides (team trial round 3).
  const [search, setSearch] = useState(customer.search || vendor.search);
  const debounced = useDebounced(search, 300);
  useEffect(() => {
    if (debounced !== customer.search || debounced !== vendor.search)
      setBoth({ ...customer, search: debounced }, { ...vendor, search: debounced });
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  // A chip's × on one side clears the shared box too.
  useEffect(() => {
    if (!customer.search && !vendor.search) setSearch("");
  }, [customer.search, vendor.search]);
  const inactive = customer.includeInactive && vendor.includeInactive;
  return (
    <div className="sl-page">
      <div className="sl-common">
        <div className="sl-search">
          <Icon name="search" size={14} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Country, network or MCCMNC — searches both sides (% _ wildcards)"
            aria-label="Search both sides"
          />
        </div>
        <label className="toggle-inline">
          <input
            type="checkbox"
            checked={inactive}
            onChange={(e) =>
              setBoth(
                { ...customer, includeInactive: e.target.checked },
                { ...vendor, includeInactive: e.target.checked },
              )
            }
          />
          Include inactive trunks
        </label>
      </div>
      <div className={`sl-wrap sl-show-${show}`}>
        {show !== "vendor" && <SidePanel side="customer" state={customer} setState={setCustomer} />}
        {show !== "customer" && <SidePanel side="vendor" state={vendor} setState={setVendor} />}
      </div>
    </div>
  );
}
