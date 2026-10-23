// Live Analytics (§13.4), redesigned in the team trial (2026-10-18) after the old platform's Analytics
// Report: a calendar period with an hour range applied to every day, a total row whose "+" breaks it
// down by any level, and a "+" on every row to break it down further by any level not used above it
// (Customer → Customer trunk → Destination → 15 minutes …), and every column on screen without side
// scrolling: Attempts, Success, Submitted, Billable (C/V), ASR, DLR (c) as the customer sees it, DLR (v)
// as the vendor reports it, Margin, Revenue, Cost, Delivered, Reported, average rates, delay and HLR.
// DLR and ASR cells turn amber or red below their thresholds, a negative margin red. While the period
// includes today, a live:analytics push (WebSocket) refreshes the open levels at the chosen interval.
// Each row opens its EDRs in a window, exports them, or opens EDR Search. Every breakdown has its own
// search box; changes apply at once (no Search button) and Pause stops the live refresh (team trial round 1).
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FilterCondition, ListQuery, MasterReportRow, ReportDimension } from "@sms/contract";
import { useListFields, useMe, useUpdatePreferences } from "../../api/hooks";
import { runMasterReport } from "../../api/masterReports";
import { DataGrid } from "../../grid/DataGrid";
import { encodeState, type GridState } from "../../grid/filterModel";
import { LiveSocket, socketUrl } from "../../live/socket";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { usePageStatus, useTabNavigate } from "../../shell/tabContext";
import { ask } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { HoursChip, PeriodTabs, RangeChip } from "../../ui/DateRange";
import { Button, Modal, Popover } from "../../ui/primitives";
import { fetchEdrs } from "../monitoring/EdrSearchPage";
import { RequestDialog } from "../monitoring/parts";
import { edrGridState } from "../reports/masterModel";
import { problemText } from "../routing/dialogs";
import {
  ALL_COLUMNS,
  cellTone,
  childConditions,
  columnsFor,
  COLUMNS,
  DEFAULT_COLUMNS,
  fmt,
  bucketWindow,
  DETAIL,
  detailQuery,
  includesToday,
  levelLabel,
  levelOptions,
  levelQuery,
  presetRange,
  rangeProblem,
  TONED,
  nextSort,
  type Column,
  type ColumnSort,
  type Fmt,
  type Settings,
} from "./analyticsTree";

const page = pageForPath("/live/analytics")!;
const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
] as const satisfies { key: Parameters<typeof presetRange>[0]; label: string }[];
const samePeriod = (a: { fromDate: string; toDate: string }, b: { fromDate: string; toDate: string }) =>
  a.fromDate === b.fromDate && a.toDate === b.toDate;

const REFRESH = [
  { value: 0, label: "Off" },
  // Down to 1 s, which the team calls live (team trial round 1).
  { value: 1, label: "1 s (live)" },
  { value: 2, label: "2 s" },
  { value: 5, label: "5 s" },
  { value: 15, label: "15 s" },
  { value: 30, label: "30 s" },
  { value: 60, label: "1 min" },
  // 2, 3, 10 and 15 minutes (team trial round 2).
  { value: 120, label: "2 min" },
  { value: 180, label: "3 min" },
  { value: 300, label: "5 min" },
  { value: 600, label: "10 min" },
  { value: 900, label: "15 min" },
];
/** Old ?by= values (Dashboard links) → the first level. */
const BY: Record<string, ReportDimension> = {
  customer: "customer",
  customer_trunk: "customerTrunk",
  vendor: "vendor",
  vendor_trunk: "vendorTrunk",
  destination: "destination",
  country: "country",
};

const metricsOf = (cols: Column[]) => cols.map((c) => c.metric);
/** Money and rates (6 decimals) get wider columns than counts (team trial round 3). */
const WEIGHT: Record<Fmt, number> = { money: 1.65, rate: 1.35, int: 1.2, pct: 0.95, sec: 0.85, tps: 0.85 };
const weightOf = (cols: Column[]) => cols.reduce((n, c) => n + WEIGHT[c.fmt], 0);
const colWidth = (cols: Column[], c: Column) => `${((WEIGHT[c.fmt] / weightOf(cols)) * 82).toFixed(2)}%`;
/** Below this width the table scrolls sideways instead of cutting figures off. */
const tableMinWidth = (cols: Column[]) => Math.round(weightOf(cols) * 62 + 260);

/**
 * Add or remove columns, like dashboard panels (team trial round 3): grouped checkboxes, saved in the user's
 * preferences; Reset brings back the default set.
 */
function ColumnsPicker({ shown }: { shown: Column[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const prefs = useUpdatePreferences();
  const on = new Set(shown.map((c) => c.metric));
  const groups = [...new Set(ALL_COLUMNS.map((c) => c.group))];
  const save = (next: Set<string>) => {
    if (next.size === 0) return;
    const list = ALL_COLUMNS.filter((c) => next.has(c.metric)).map((c) => c.metric);
    const isDefault = list.length === DEFAULT_COLUMNS.length && list.every((m, i) => m === DEFAULT_COLUMNS[i]);
    prefs.mutate({ liveAnalytics: { columns: isDefault ? [] : list } });
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-default btn-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="columns" size={13} /> Columns
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end" className="la-cols-pop">
        <div className="la-cols">
          {groups.map((g) => (
            <fieldset key={g}>
              <legend>{g}</legend>
              {ALL_COLUMNS.filter((c) => c.group === g).map((c) => (
                <label key={c.metric} className="check" title={c.title}>
                  <input
                    type="checkbox"
                    checked={on.has(c.metric)}
                    disabled={on.has(c.metric) && on.size === 1}
                    onChange={(e) => {
                      const next = new Set(on);
                      if (e.target.checked) next.add(c.metric);
                      else next.delete(c.metric);
                      save(next);
                    }}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <div className="la-cols-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => save(new Set(DEFAULT_COLUMNS))}>
            Reset to default columns
          </button>
        </div>
      </Popover>
    </>
  );
}

/** The columns on screen (team trial round 3: the user adds or removes them, saved in their preferences). */
const ColsCtx = createContext<Column[]>(COLUMNS);
const useCols = () => useContext(ColsCtx);

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Chain = { row: MasterReportRow; dims: ReportDimension[] }[];
interface Detail {
  key: string;
  title: string;
  conditions: FilterCondition[];
  chain: Chain;
}

/** Under the table: the double-clicked row's traffic per second, minute, 15 minutes, hour or day. */
function DetailPanel({
  width,
  settings,
  by,
  setBy,
  detail,
  tick,
  onPick,
  onClose,
}: {
  width: number | null;
  settings: Settings;
  by: ReportDimension;
  setBy: (d: ReportDimension) => void;
  detail: Detail;
  tick: number;
  onPick: (at: NonNullable<Settings["at"]>) => void;
  onClose: () => void;
}) {
  const cols = useCols();
  const [limit, setLimit] = useState(500);
  const whole = { ...settings, at: null };
  const q = useQuery({
    queryKey: ["analytics-detail", whole, by, detail.conditions, limit, tick, metricsOf(cols)],
    queryFn: () => runMasterReport(detailQuery(whole, by, detail.conditions, limit, metricsOf(cols))),
    placeholderData: keepPreviousData,
  });
  return (
    <section
      className="la-detail"
      aria-label={`Traffic over time: ${detail.title}`}
      style={width ? { flex: `0 0 ${width}px` } : undefined}
    >
      <div className="la-detail-head">
        <strong>{detail.title}</strong>
        <span className="muted small">over time · click a time to see all traffic at that moment above</span>
        <span className="fb-spacer" />
        <label className="field inline">
          <span>Period</span>
          <select value={by} onChange={(e) => setBy(e.target.value as ReportDimension)}>
            {DETAIL.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="icon-btn" aria-label="Close the detail panel" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="la-detail-body">
        <table className="la-grid" style={{ minWidth: tableMinWidth(cols) }}>
          <colgroup>
            <col className="la-col-name" />
            {cols.map((c) => (
              <col key={c.metric} style={{ width: colWidth(cols, c) }} />
            ))}
            <col className="la-col-act" />
          </colgroup>
          <thead>
            <tr>
              <th>{DETAIL.find((d) => d.value === by)?.label ?? "Time"} (UTC)</th>
              {cols.map((c) => (
                <th key={c.metric} className="num" title={c.title}>
                  {c.label}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {q.isError && (
              <tr>
                <td colSpan={cols.length + 2} className="tone-error">
                  {problemText(q.error)}
                </td>
              </tr>
            )}
            {q.data?.rows.map((r) => {
              const id = String(r.dims[by]?.id ?? "");
              const at = bucketWindow(by, id);
              return (
                <tr
                  key={r.key}
                  className={`la-row${settings.at?.from === at?.from ? " la-selected" : ""}`}
                  onClick={() => at && onPick(at)}
                  title={at ? `Show all traffic at ${at.label} above` : undefined}
                >
                  <td className="la-name">
                    <span className="la-label num">{r.dims[by]?.label ?? id}</span>
                  </td>
                  <Cells metrics={r.metrics} />
                  <td />
                </tr>
              );
            })}
            {q.data?.nextCursor && (
              <MoreOnScroll busy={q.isFetching} text="Loading older…" onMore={() => setLimit((l) => l + 500)} />
            )}
            {!q.data && !q.isError && (
              <tr>
                <td colSpan={cols.length + 2} className="muted">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The bar between the table and the detail panel: drag sideways to resize, double-click for the default width. */
function SideSplitter({ width, onChange }: { width: number | null; onChange: (w: number | null) => void }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const panel = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement | null;
    const host = (e.currentTarget as HTMLElement).parentElement;
    const startX = e.clientX;
    const startW = panel?.offsetWidth ?? width ?? 520;
    const max = Math.max(360, (host?.clientWidth ?? 1200) - 420);
    const move = (ev: PointerEvent) => onChange(Math.min(max, Math.max(360, startW + startX - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-split");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("resizing-split");
  };
  return (
    <div
      className="detail-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the detail panel"
      title="Drag to resize · double-click: default width"
      onPointerDown={start}
      onDoubleClick={() => onChange(null)}
    />
  );
}

/** Columns in money: shown in the platform currency (EUR, §13.4, team trial round 2). */
const moneyCols = new Set<Fmt>(["money", "rate"]);

/**
 * Pushes on live:analytics pace the refresh; at most one per chosen interval, and none while the previous
 * refresh is still loading (so a 1 s refresh never piles up queries).
 */
function useLiveTick(seconds: number, enabled: boolean): number {
  const [tick, setTick] = useState(0);
  const last = useRef(0);
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled || !seconds) return;
    const s = new LiveSocket(socketUrl());
    s.subscribe(
      "live:analytics",
      (event) => {
        if (event !== "snapshot") return;
        const now = Date.now();
        const busy =
          client.isFetching({ queryKey: ["analytics-level"] }) + client.isFetching({ queryKey: ["analytics-total"] }) >
          0;
        if (!busy && now - last.current >= seconds * 1000 - 100) {
          last.current = now;
          setTick((t) => t + 1);
        }
      },
      // The push comes every 1, 5 or 15 s; the fastest one at or under the chosen interval.
      { groupBy: "customer", intervalSeconds: seconds < 5 ? 1 : seconds < 15 ? 5 : 15, limit: 1 },
    );
    s.connect();
    // Without pushes (socket down or reconnecting) a timer keeps the refresh going.
    const timer = setInterval(() => {
      const now = Date.now();
      const busy =
        client.isFetching({ queryKey: ["analytics-level"] }) + client.isFetching({ queryKey: ["analytics-total"] }) > 0;
      if (!busy && now - last.current >= seconds * 1500) {
        last.current = now;
        setTick((t) => t + 1);
      }
    }, seconds * 1000);
    return () => {
      clearInterval(timer);
      s.close();
    };
  }, [seconds, enabled, client]);
  return tick;
}

function EdrWindow({ title, state, done }: { title: string; state: GridState; done: () => void }) {
  const fields = useListFields("edrs");
  const navigate = useTabNavigate();
  const [grid, setGrid] = useState<GridState>(state);
  const [active, setActive] = useState<number | null>(null);
  return (
    <Modal
      title={`EDRs · ${title}`}
      width={1240}
      onClose={done}
      footer={
        <>
          <span className="muted small la-cdr-note">The hours-of-day filter is not applied here.</span>
          <Button
            icon="external"
            onClick={() => {
              navigate(`/monitoring/edr?g=${encodeState(grid)}`, { newTab: true });
              done();
            }}
          >
            Open in EDR search
          </Button>
          <Button
            variant="primary"
            icon="download"
            onClick={() => void ask<void>((d) => <RequestDialog kind="edr" state={grid} done={() => d()} />)}
          >
            Export…
          </Button>
        </>
      }
    >
      <div className="la-cdr">
        {fields.data ? (
          <DataGrid
            list="edrs"
            fields={fields.data}
            state={grid}
            onStateChange={setGrid}
            fetchPage={(b: ListQuery) => fetchEdrs(b)}
            activeId={active}
            onActiveChange={(r) => setActive(r?.id ?? null)}
            selected={new Set()}
            onSelectedChange={() => undefined}
          />
        ) : (
          <div className="grid-message muted">Loading…</div>
        )}
      </div>
    </Modal>
  );
}

function Cells({ metrics }: { metrics: Record<string, number | null> }) {
  const cols = useCols();
  return (
    <>
      {cols.map((c) => {
        const v = metrics[c.metric];
        const t = cellTone(c.metric, v);
        return (
          <td key={c.metric} className={`num${TONED.has(c.metric) ? " la-strong" : ""}${t ? ` la-${t}` : ""}`}>
            {/* Orange and red sit in a rounded box inside the cell (team trial round 1). */}
            {t === "warn" || t === "bad" ? <span className="la-pill">{fmt(v, c.fmt)}</span> : fmt(v, c.fmt)}
          </td>
        );
      })}
    </>
  );
}

/** The "+" of a row: a menu of the levels not used above it; "−" closes the breakdown (team trial round 1). */
function ExpandButton({
  name,
  open,
  used,
  conds = [],
  onPick,
  onClose,
}: {
  name: string;
  open: ReportDimension | null;
  used: readonly ReportDimension[];
  /** The row's and its parents' conditions (each numeric Sender ID only under a Numeric row). */
  conds?: readonly FilterCondition[];
  onPick: (d: ReportDimension) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const options = levelOptions(used, conds);
  if (!open && !options.length) return <span className="la-toggle-gap" />;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="la-toggle"
        aria-label={open ? `Close the breakdown of ${name}` : `Break down ${name}`}
        aria-expanded={!!open}
        aria-haspopup={open ? undefined : "menu"}
        title={open ? `Close (by ${levelLabel(open).toLowerCase()})` : "Break down by…"}
        onClick={() => (open ? onClose() : setMenu((v) => !v))}
      >
        <Icon name={open ? "minus" : "plus"} size={11} />
      </button>
      <Popover anchor={ref} open={menu} onClose={() => setMenu(false)}>
        <div className="la-menu">
          <LevelMenu
            options={options}
            onPick={(d) => {
              setMenu(false);
              onPick(d);
            }}
          />
        </div>
      </Popover>
    </>
  );
}

function Level({
  settings,
  dim,
  used,
  parents,
  chain,
  tick,
  search,
  window,
  onDetail,
  selected,
  sort,
  framed = false,
}: {
  settings: Settings;
  /** Inside an expanded row: its rows carry the frame around the expanded group (team trial round 2). */
  framed?: boolean;
  /** This breakdown's level; `used` holds it and the levels above, which the rows' "+" leave out. */
  dim: ReportDimension;
  used: ReportDimension[];
  parents: FilterCondition[];
  chain: Chain;
  tick: number;
  /** The top breakdown's search (in the column header); a nested breakdown has its own search row. */
  search?: string;
  window: { from: string; to: string };
  onDetail: (d: Detail) => void;
  selected: string | null;
  sort: ColumnSort | null;
}) {
  const cols = useCols();
  // Row key → the level it is broken down by.
  const [open, setOpen] = useState<Map<string, ReportDimension>>(new Map());
  const [limit, setLimit] = useState(100);
  const [own, setOwn] = useState("");
  const typed = useDebounced((search ?? own).trim(), 300);
  const depth = chain.length;
  // Searches match the start of the name: "Colo" finds rows starting with Colo (team trial round 3).
  const conds = typed ? [...parents, { field: dim, op: "like" as const, value: `${typed}%` }] : parents;
  const q = useQuery({
    queryKey: ["analytics-level", settings, dim, conds, limit, tick, sort, metricsOf(cols)],
    queryFn: () => runMasterReport(levelQuery(settings, dim, conds, limit, sort, metricsOf(cols))),
    placeholderData: keepPreviousData,
  });
  const indent = { paddingLeft: 8 + (depth + 1) * 18 };
  const fr = framed ? " la-framed" : "";
  const setRow = (key: string, d: ReportDimension | null) =>
    setOpen((m) => {
      const n = new Map(m);
      if (d) n.set(key, d);
      else n.delete(key);
      return n;
    });
  // Every breakdown under a row searches its own rows, like the old platform (team trial round 1).
  const searchRow =
    search === undefined ? (
      <tr className={`la-search-row${fr}`}>
        <td className="la-name" style={indent}>
          <span className="la-toggle-gap" />
          <input
            className="la-row-search"
            placeholder={levelLabel(dim)}
            aria-label={`Search ${levelLabel(dim).toLowerCase()} of ${chain.map((c) => c.row.dims[c.dims[0]!]?.label).join(" › ")}`}
            value={own}
            onChange={(e) => setOwn(e.target.value)}
          />
        </td>
        <td colSpan={cols.length + 1} />
      </tr>
    ) : null;
  if (q.isError)
    return (
      <>
        {searchRow}
        <tr className={fr.trim() || undefined}>
          <td colSpan={cols.length + 2} className="tone-error" style={indent}>
            {problemText(q.error)}
          </td>
        </tr>
      </>
    );
  if (!q.data)
    return (
      <>
        {searchRow}
        <tr className={fr.trim() || undefined}>
          <td colSpan={cols.length + 2} className="muted" style={indent}>
            Loading {levelLabel(dim).toLowerCase()}…
          </td>
        </tr>
      </>
    );
  return (
    <>
      {searchRow}
      {q.data.rows.map((r) => {
        const next = open.get(r.key) ?? null;
        const label = r.dims[dim]?.label ?? r.key;
        const rowChain = [...chain, { row: r, dims: [dim] }];
        return (
          <Fragment key={r.key}>
            <tr
              className={`la-row depth-${depth}${fr}${next ? " la-open" : ""}${selected === rowChain.map((c) => c.row.key).join("/") ? " la-selected" : ""}`}
              title="Double-click: this row's traffic over time below"
              onDoubleClick={() =>
                onDetail({
                  key: rowChain.map((c) => c.row.key).join("/"),
                  title: rowChain.map((c) => c.row.dims[c.dims[0]!]?.label).join(" › "),
                  conditions: childConditions(parents, r, dim),
                  chain: rowChain,
                })
              }
            >
              <td className="la-name" style={indent} title={`${levelLabel(dim)}: ${label}`}>
                <ExpandButton
                  name={label}
                  open={next}
                  used={used}
                  conds={childConditions(parents, r, dim)}
                  onPick={(d) => setRow(r.key, d)}
                  onClose={() => setRow(r.key, null)}
                />
                <span className="la-label">{label}</span>
              </td>
              <Cells metrics={r.metrics} />
              <td className="la-actions">
                <button
                  type="button"
                  className="la-act"
                  title="EDRs of this row in a window, with export"
                  onClick={() =>
                    void ask<void>((d) => (
                      <EdrWindow
                        title={rowChain.map((c) => c.row.dims[c.dims[0]!]?.label).join(" › ")}
                        state={edrGridState(rowChain, window.from, window.to)}
                        done={() => d()}
                      />
                    ))
                  }
                >
                  EDRs
                </button>
                <button
                  type="button"
                  className="la-act"
                  title="Export this row's EDRs (CSV or Excel)"
                  aria-label={`Export EDRs of ${label}`}
                  onClick={() =>
                    void ask<void>((d) => (
                      <RequestDialog
                        kind="edr"
                        state={edrGridState(rowChain, window.from, window.to)}
                        done={() => d()}
                      />
                    ))
                  }
                >
                  <Icon name="download" size={12} />
                </button>
              </td>
            </tr>
            {next && (
              <Level
                settings={settings}
                dim={next}
                used={[...used, next]}
                parents={childConditions(parents, r, dim)}
                chain={rowChain}
                tick={tick}
                window={window}
                onDetail={onDetail}
                selected={selected}
                sort={sort}
                framed
              />
            )}
            {/* The bottom edge of the frame around an expanded row and its sub rows. */}
            {next && (
              <tr className={`la-group-end${fr}`} aria-hidden="true">
                <td colSpan={cols.length + 2} />
              </tr>
            )}
          </Fragment>
        );
      })}
      {q.data.nextCursor && (
        <MoreOnScroll
          className={fr.trim() || undefined}
          busy={q.isFetching}
          style={indent}
          text={`Loading more · ${q.data.rows.length.toLocaleString("en-US")} of ${q.data.total.toLocaleString("en-US")}`}
          onMore={() => setLimit((l) => l + 100)}
        />
      )}
      {q.data.rows.length === 0 && (
        <tr className={fr.trim() || undefined}>
          <td colSpan={cols.length + 2} className="muted" style={indent}>
            {typed ? "Nothing matches." : "No traffic."}
          </td>
        </tr>
      )}
    </>
  );
}

export function LiveAnalyticsPage() {
  const location = useLocation();
  const me = useMe();
  const cols = columnsFor(me.data?.preferences.liveAnalytics?.columns);
  const url = new URLSearchParams(location.search);
  const first = BY[url.get("by") ?? ""] ?? "customer";
  const [draft, setDraft] = useState<Settings>(() => ({ ...presetRange("today"), hourFrom: 0, hourTo: 23 }));
  // How the total row is broken down (its "+"); opens by customer, or by the Dashboard link's ?by=.
  const [top, setTop] = useState<ReportDimension | null>(first);
  // A clicked header sorts every breakdown, up or down (team trial round 1).
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const arrow = (key: ColumnSort["key"]) => (sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  const [settings, setSettings] = useState<Settings>(draft);
  // "Today" is the server's report day: the latest day with traffic (the fake data stops when it was
  // generated). Presets count from it, and the page opens on it.
  const probe = useQuery({
    queryKey: ["analytics-today"],
    queryFn: () =>
      runMasterReport({
        groupBy: ["customer"],
        metrics: ["attempts"],
        timezone: "UTC",
        period: "today",
        compare: "none",
        limit: 1,
      }),
    staleTime: 5 * 60_000,
  });
  const reportToday = probe.data ? new Date(Date.parse(probe.data.to) - 1) : new Date();
  const opened = useRef(false);
  useEffect(() => {
    if (!probe.data || opened.current) return;
    opened.current = true;
    const day = presetRange("today", new Date(Date.parse(probe.data.to) - 1));
    setDraft((d) => ({ ...d, ...day }));
    setSettings((st) => ({ ...st, ...day }));
  }, [probe.data]);
  const [search, setSearch] = useState(url.get("q") ?? "");
  const [refresh, setRefresh] = useState(30);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailBy, setDetailBy] = useState<ReportDimension>("minute");
  const [detailWidth, setDetailWidth] = useState<number | null>(null);
  const live = includesToday(settings, reportToday);
  // Pause stops the live refresh without losing the chosen interval (team trial round 1).
  const [paused, setPaused] = useState(false);
  const running = live && !!refresh && !paused;
  const tick = useLiveTick(refresh, live && !paused);
  const problem = rangeProblem(draft);
  // No Search button: every change of period or hours applies at once while it is valid (team trial round 1).
  useEffect(() => {
    if (!rangeProblem(draft)) setSettings(draft);
  }, [draft]);
  const window = useMemo(
    () =>
      settings.at
        ? { from: settings.at.from, to: settings.at.to }
        : {
            from: `${settings.fromDate}T00:00:00.000Z`,
            to: new Date(Date.parse(`${settings.toDate}T00:00:00Z`) + 86_400_000).toISOString(),
          },
    [settings],
  );
  const total = useQuery({
    queryKey: ["analytics-total", settings, tick, metricsOf(cols)],
    queryFn: () =>
      runMasterReport({ ...levelQuery(settings, top ?? "customer", [], 1, null, metricsOf(cols)), limit: 1 }),
    placeholderData: keepPreviousData,
  });
  const currency = total.data?.currency ?? "EUR";
  usePageStatus({
    rows: total.data && top ? `${total.data.total.toLocaleString("en-US")} × ${levelLabel(top).toLowerCase()}` : "",
    shortcuts: "+ breaks a row down by any level · EDRs opens the messages of a row · times in UTC",
  });
  const setRange = (k: Parameters<typeof presetRange>[0]) => setDraft({ ...draft, ...presetRange(k, reportToday) });
  return (
    <ColsCtx.Provider value={cols}>
      <div className="page la-page">
        <PageHeader
          page={page}
          actions={
            <>
              <span
                className={`la-live${running ? " on" : ""}`}
                title={live ? "Refreshes while the period includes today" : "The period is over, so nothing changes"}
              >
                <span className="la-live-dot" /> {running ? "Live" : live ? "Paused" : "Not live"}
              </span>
              {/* Pause right after Live, the refresh interval after them (team trial round 3). */}
              <Button
                variant="primary"
                icon={paused ? "play" : "pause"}
                disabled={!live || !refresh}
                title={!live ? "The period does not include today" : undefined}
                onClick={() => setPaused((p) => !p)}
              >
                {paused ? "Resume" : "Pause"}
              </Button>
              <label className="field inline">
                <span>Refresh</span>
                <select value={refresh} onChange={(e) => setRefresh(Number(e.target.value))}>
                  {REFRESH.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              {problem && <span className="tone-error small">{problem}</span>}
            </>
          }
        />
        {/* Period in the shared style (design refresh): quick periods, the day range and the hours of each day. */}
        <div className="la-bar">
          <PeriodTabs
            options={PRESETS}
            value={PRESETS.find((p) => samePeriod(presetRange(p.key, reportToday), draft))?.key ?? null}
            onPick={setRange}
          />
          <RangeChip
            from={draft.fromDate}
            to={draft.toDate}
            empty="Pick days"
            onChange={(fromDate, toDate) =>
              fromDate && toDate && setDraft({ ...draft, fromDate, toDate: toDate < fromDate ? fromDate : toDate })
            }
          />
          <HoursChip
            from={draft.hourFrom}
            to={draft.hourTo}
            onChange={(hourFrom, hourTo) => setDraft({ ...draft, hourFrom, hourTo })}
          />
          <span className="fb-spacer" />
          <ColumnsPicker shown={cols} />
        </div>
        {settings.at && (
          <div className="la-at" role="status">
            <strong>Showing only {settings.at.label}</strong>
            <span className="muted small">picked in the detail panel; levels and totals are for that moment</span>
            <Button
              onClick={() => {
                setSettings({ ...settings, at: null });
                setDraft({ ...draft, at: null });
              }}
            >
              Show the whole period
            </Button>
          </div>
        )}
        {/* The detail panel sits on the right of the table and narrows it (team trial round 3). */}
        <div className="la-body">
          <div className="la-wrap">
            <table className="la-grid" style={{ minWidth: tableMinWidth(cols) }}>
              <colgroup>
                <col className="la-col-name" />
                {cols.map((c) => (
                  <col key={c.metric} style={{ width: colWidth(cols, c) }} />
                ))}
                <col className="la-col-act" />
              </colgroup>
              <thead>
                <tr>
                  <th className="la-th-name" title="Use + on a row to break it down by any level">
                    {top ? (
                      <span className="la-th-search">
                        <input
                          className="la-row-search"
                          placeholder={levelLabel(top)}
                          aria-label={`Search ${levelLabel(top).toLowerCase()}`}
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                        <button
                          type="button"
                          className="la-sort"
                          title="Sort by name"
                          aria-label="Sort by name"
                          onClick={() => setSort(nextSort(sort, "name"))}
                        >
                          A–Z{arrow("name")}
                        </button>
                      </span>
                    ) : (
                      "Total"
                    )}
                  </th>
                  {cols.map((c) => (
                    <th
                      key={c.metric}
                      className="num"
                      title={moneyCols.has(c.fmt) ? `${c.title} · in ${currency}` : c.title}
                      aria-sort={sort?.key === c.metric ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      <button type="button" className="la-sort" onClick={() => setSort(nextSort(sort, c.metric))}>
                        {c.label}
                        {/* Money and rates are in the platform currency (EUR); the header's tooltip says so (team trial
                        round 2: no currency in the header text). */}
                        {arrow(c.metric)}
                      </button>
                    </th>
                  ))}
                  <th>EDRs</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  className={`la-total${detail?.key === "" ? " la-selected" : ""}`}
                  title="Double-click: all traffic over time below"
                  onDoubleClick={() => setDetail({ key: "", title: "All traffic", conditions: [], chain: [] })}
                >
                  <td className="la-name">
                    <ExpandButton name="the total" open={top} used={[]} onPick={setTop} onClose={() => setTop(null)} />
                    <span className="la-label">Total</span>
                    {top && <span className="la-by">by {levelLabel(top).toLowerCase()}</span>}
                  </td>
                  {total.data ? (
                    <Cells metrics={total.data.totals.metrics} />
                  ) : (
                    <td colSpan={cols.length} className="muted">
                      {total.isError ? problemText(total.error) : "Loading…"}
                    </td>
                  )}
                  <td className="la-actions">
                    <button
                      type="button"
                      className="la-act"
                      onClick={() =>
                        void ask<void>((d) => (
                          <EdrWindow
                            title="All traffic"
                            state={edrGridState([], window.from, window.to)}
                            done={() => d()}
                          />
                        ))
                      }
                    >
                      EDRs
                    </button>
                  </td>
                </tr>
                {top && (
                  <Level
                    key={top}
                    settings={settings}
                    dim={top}
                    used={[top]}
                    parents={[]}
                    chain={[]}
                    tick={tick}
                    search={search}
                    window={window}
                    onDetail={setDetail}
                    selected={detail?.key ?? null}
                    sort={sort}
                  />
                )}
              </tbody>
            </table>
          </div>
          {detail && <SideSplitter width={detailWidth} onChange={setDetailWidth} />}
          {detail && (
            <DetailPanel
              width={detailWidth}
              settings={settings}
              by={detailBy}
              setBy={setDetailBy}
              detail={detail}
              tick={tick}
              onPick={(at) => {
                setSettings({ ...settings, at });
                setDraft({ ...draft, at });
              }}
              onClose={() => setDetail(null)}
            />
          )}
        </div>
      </div>
    </ColsCtx.Provider>
  );
}

/**
 * The next rows load when this row scrolls into view (team trial round 2: no Show more button). Waits for the
 * previous page, so one scroll loads one page.
 */
function MoreOnScroll({
  busy,
  text,
  onMore,
  style,
  className,
}: {
  busy: boolean;
  text: string;
  onMore: () => void;
  style?: React.CSSProperties;
  className?: string | undefined;
}) {
  const cols = useCols();
  const ref = useRef<HTMLTableRowElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || busy) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more.current(), {
      rootMargin: "200px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [busy]);
  return (
    <tr ref={ref} className={className}>
      <td colSpan={cols.length + 2} className="muted small" style={style}>
        {text}
      </td>
    </tr>
  );
}

/**
 * The "+" menu (team trial round 2): the levels, with the time periods under one Time entry that opens them to
 * its right on hover (or on click / arrow right).
 */
function LevelMenu({
  options,
  onPick,
}: {
  options: { value: ReportDimension; label: string; time?: boolean }[];
  onPick: (d: ReportDimension) => void;
}) {
  const [timeOpen, setTimeOpen] = useState(false);
  const plain = options.filter((o) => !o.time);
  const times = options.filter((o) => o.time);
  return (
    <div className="menu" role="menu">
      {plain.map((o) => (
        <button key={o.value} type="button" role="menuitem" className="menu-item" onClick={() => onPick(o.value)}>
          <span className="menu-icon-space" />
          <span>{o.label}</span>
        </button>
      ))}
      {times.length > 0 && (
        <div className="la-submenu" onMouseEnter={() => setTimeOpen(true)} onMouseLeave={() => setTimeOpen(false)}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={timeOpen}
            className="menu-item"
            onClick={() => setTimeOpen((v) => !v)}
            onKeyDown={(e) => e.key === "ArrowRight" && setTimeOpen(true)}
          >
            <span className="menu-icon-space" />
            <span>Time</span>
            <Icon name="chevronRight" size={12} />
          </button>
          {timeOpen && (
            <div className="menu la-submenu-list" role="menu">
              {times.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => onPick(o.value)}
                >
                  <span className="menu-icon-space" />
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
