// Live Analytics (§13.4), redesigned in the team trial (2026-10-18) after the old platform's Analytics
// Report: a calendar period with an hour range applied to every day, drill-down levels (Customer →
// Customer trunk → Destination → 15 minutes …), a total row, and every column on screen without side
// scrolling: Attempts, Success, Submitted, Billable (C/V), ASR, DLR (c) as the customer sees it, DLR (v)
// as the vendor reports it, Margin, Revenue, Cost, Delivered, Reported, average rates, delay and HLR.
// DLR and ASR cells turn amber or red below their thresholds, a negative margin red. While the period
// includes today, a live:analytics push (WebSocket) refreshes the open levels at the chosen interval.
// Each row opens its CDRs in a window, exports them, or opens EDR Search.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { FilterCondition, ListQuery, MasterReportRow, ReportDimension } from "@sms/contract";
import { useListFields } from "../../api/hooks";
import { runMasterReport } from "../../api/masterReports";
import { DataGrid } from "../../grid/DataGrid";
import { encodeState, type GridState } from "../../grid/filterModel";
import { LiveSocket, socketUrl } from "../../live/socket";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { usePageStatus, useTabNavigate } from "../../shell/tabContext";
import { ask } from "../../ui/feedback";
import { Icon } from "../../ui/Icon";
import { Button, Modal } from "../../ui/primitives";
import { fetchEdrs } from "../monitoring/EdrSearchPage";
import { RequestDialog } from "../monitoring/parts";
import { edrGridState } from "../reports/masterModel";
import { problemText } from "../routing/dialogs";
import {
  cellTone,
  childConditions,
  COLUMNS,
  fmt,
  bucketWindow,
  DETAIL,
  detailQuery,
  includesToday,
  LEVELS,
  levelLabel,
  levelQuery,
  presetRange,
  rangeProblem,
  type Settings,
} from "./analyticsTree";

const page = pageForPath("/live/analytics")!;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const REFRESH = [
  { value: 0, label: "Off" },
  { value: 15, label: "15 s" },
  { value: 30, label: "30 s" },
  { value: 60, label: "1 min" },
  { value: 300, label: "5 min" },
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

type Chain = { row: MasterReportRow; dims: ReportDimension[] }[];
interface Detail {
  key: string;
  title: string;
  conditions: FilterCondition[];
  chain: Chain;
}

/** Under the table: the double-clicked row's traffic per second, minute, 15 minutes, hour or day. */
function DetailPanel({
  settings,
  by,
  setBy,
  detail,
  tick,
  onPick,
  onClose,
}: {
  settings: Settings;
  by: ReportDimension;
  setBy: (d: ReportDimension) => void;
  detail: Detail;
  tick: number;
  onPick: (at: NonNullable<Settings["at"]>) => void;
  onClose: () => void;
}) {
  const [limit, setLimit] = useState(500);
  const whole = { ...settings, at: null };
  const q = useQuery({
    queryKey: ["analytics-detail", whole, by, detail.conditions, limit, tick],
    queryFn: () => runMasterReport(detailQuery(whole, by, detail.conditions, limit)),
    placeholderData: keepPreviousData,
  });
  return (
    <section className="la-detail" aria-label={`Traffic over time: ${detail.title}`}>
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
        <table className="la-grid">
          <colgroup>
            <col className="la-col-name" />
            {COLUMNS.map((c) => (
              <col key={c.metric} />
            ))}
            <col className="la-col-act" />
          </colgroup>
          <thead>
            <tr>
              <th>{DETAIL.find((d) => d.value === by)?.label ?? "Time"} (UTC)</th>
              {COLUMNS.map((c) => (
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
                <td colSpan={COLUMNS.length + 2} className="tone-error">
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
              <tr>
                <td colSpan={COLUMNS.length + 2}>
                  <button type="button" className="link small" onClick={() => setLimit((l) => l + 500)}>
                    Show older
                  </button>
                </td>
              </tr>
            )}
            {!q.data && !q.isError && (
              <tr>
                <td colSpan={COLUMNS.length + 2} className="muted">
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

/** Pushes on live:analytics pace the refresh; at most one per chosen interval. */
function useLiveTick(seconds: number, enabled: boolean): number {
  const [tick, setTick] = useState(0);
  const last = useRef(0);
  useEffect(() => {
    if (!enabled || !seconds) return;
    const s = new LiveSocket(socketUrl());
    s.subscribe(
      "live:analytics",
      (event) => {
        if (event !== "snapshot") return;
        const now = Date.now();
        if (now - last.current >= seconds * 1000) {
          last.current = now;
          setTick((t) => t + 1);
        }
      },
      { groupBy: "customer", intervalSeconds: 15, limit: 1 },
    );
    s.connect();
    return () => s.close();
  }, [seconds, enabled]);
  return tick;
}

function CdrWindow({ title, state, done }: { title: string; state: GridState; done: () => void }) {
  const fields = useListFields("edrs");
  const navigate = useTabNavigate();
  const [grid, setGrid] = useState<GridState>(state);
  const [active, setActive] = useState<number | null>(null);
  return (
    <Modal
      title={`CDRs · ${title}`}
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
  return (
    <>
      {COLUMNS.map((c) => {
        const v = metrics[c.metric];
        const t = cellTone(c.metric, v);
        return (
          <td key={c.metric} className={`num${t ? ` la-${t}` : ""}`}>
            {fmt(v, c.fmt)}
          </td>
        );
      })}
    </>
  );
}

function Level({
  settings,
  depth,
  parents,
  chain,
  tick,
  search,
  window,
  onDetail,
  selected,
}: {
  settings: Settings;
  depth: number;
  parents: FilterCondition[];
  chain: Chain;
  tick: number;
  search: string;
  window: { from: string; to: string };
  onDetail: (d: Detail) => void;
  selected: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(100);
  const dim = settings.levels[depth]!;
  const conds =
    depth === 0 && search.trim()
      ? [...parents, { field: dim, op: "like" as const, value: `%${search.trim()}%` }]
      : parents;
  const q = useQuery({
    queryKey: ["analytics-level", settings, depth, conds, limit, tick],
    queryFn: () => runMasterReport(levelQuery(settings, depth, conds, limit)),
    placeholderData: keepPreviousData,
  });
  const indent = { paddingLeft: 8 + depth * 18 };
  if (q.isError)
    return (
      <tr>
        <td colSpan={COLUMNS.length + 2} className="tone-error" style={indent}>
          {problemText(q.error)}
        </td>
      </tr>
    );
  if (!q.data)
    return (
      <tr>
        <td colSpan={COLUMNS.length + 2} className="muted" style={indent}>
          Loading {levelLabel(dim).toLowerCase()}…
        </td>
      </tr>
    );
  const hasNext = depth + 1 < settings.levels.length;
  return (
    <>
      {q.data.rows.map((r) => {
        const isOpen = open.has(r.key);
        const label = r.dims[dim]?.label ?? r.key;
        const rowChain = [...chain, { row: r, dims: [dim] }];
        return (
          <Fragment key={r.key}>
            <tr
              className={`la-row depth-${depth}${selected === rowChain.map((c) => c.row.key).join("/") ? " la-selected" : ""}`}
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
                {hasNext ? (
                  <button
                    type="button"
                    className="la-toggle"
                    aria-label={isOpen ? `Close ${label}` : `Open ${label}`}
                    aria-expanded={isOpen}
                    onClick={() =>
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(r.key)) n.delete(r.key);
                        else n.add(r.key);
                        return n;
                      })
                    }
                  >
                    <Icon name={isOpen ? "minus" : "plus"} size={11} />
                  </button>
                ) : (
                  <span className="la-toggle-gap" />
                )}
                <span className="la-label">{label}</span>
              </td>
              <Cells metrics={r.metrics} />
              <td className="la-actions">
                <button
                  type="button"
                  className="la-act"
                  title="CDRs of this row in a window, with export"
                  onClick={() =>
                    void ask<void>((d) => (
                      <CdrWindow
                        title={rowChain.map((c) => c.row.dims[c.dims[0]!]?.label).join(" › ")}
                        state={edrGridState(rowChain, window.from, window.to)}
                        done={() => d()}
                      />
                    ))
                  }
                >
                  CDRs
                </button>
                <button
                  type="button"
                  className="la-act"
                  title="Export this row's CDRs (CSV or Excel)"
                  aria-label={`Export CDRs of ${label}`}
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
            {isOpen && hasNext && (
              <Level
                settings={settings}
                depth={depth + 1}
                parents={childConditions(parents, r, dim)}
                chain={rowChain}
                tick={tick}
                search=""
                window={window}
                onDetail={onDetail}
                selected={selected}
              />
            )}
          </Fragment>
        );
      })}
      {q.data.nextCursor && (
        <tr>
          <td colSpan={COLUMNS.length + 2} style={indent}>
            <button type="button" className="link small" onClick={() => setLimit((l) => l + 100)}>
              Show {Math.min(100, q.data.total - q.data.rows.length).toLocaleString("en-US")} more of{" "}
              {q.data.total.toLocaleString("en-US")}
            </button>
          </td>
        </tr>
      )}
      {q.data.rows.length === 0 && (
        <tr>
          <td colSpan={COLUMNS.length + 2} className="muted" style={indent}>
            No traffic.
          </td>
        </tr>
      )}
    </>
  );
}

export function LiveAnalyticsPage() {
  const location = useLocation();
  const url = new URLSearchParams(location.search);
  const first = BY[url.get("by") ?? ""] ?? "customer";
  const [draft, setDraft] = useState<Settings>(() => ({
    ...presetRange("today"),
    hourFrom: 0,
    hourTo: 23,
    levels: first === "customer" ? ["customer", "customerTrunk", "destination"] : [first, "quarterHour"],
  }));
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
  const live = includesToday(settings, reportToday);
  const tick = useLiveTick(refresh, live);
  const problem = rangeProblem(draft);
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
    queryKey: ["analytics-total", settings, tick],
    queryFn: () => runMasterReport({ ...levelQuery(settings, 0, []), limit: 1 }),
    placeholderData: keepPreviousData,
  });
  usePageStatus({
    rows: total.data
      ? `${total.data.total.toLocaleString("en-US")} ${levelLabel(settings.levels[0]!).toLowerCase()}s`
      : "",
    shortcuts: "+ opens the next level · CDRs opens the messages of a row · times in UTC",
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const setRange = (k: Parameters<typeof presetRange>[0]) => setDraft({ ...draft, ...presetRange(k, reportToday) });
  const unused = LEVELS.filter((l) => !draft.levels.includes(l.value));
  return (
    <div className="page la-page">
      <PageHeader
        page={page}
        actions={
          <>
            <span
              className={`la-live${live && refresh ? " on" : ""}`}
              title="Refreshes while the period includes today"
            >
              <span className="la-live-dot" /> {live && refresh ? "Live" : "Paused"}
            </span>
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
            <Button
              variant="primary"
              icon="search"
              disabled={!!problem || !dirty}
              title={problem ?? undefined}
              onClick={() => setSettings(draft)}
            >
              Search
            </Button>
          </>
        }
      />
      <div className="la-bar">
        <div className="la-range">
          <label className="field">
            <span>From day</span>
            <input
              type="date"
              value={draft.fromDate}
              onChange={(e) => setDraft({ ...draft, fromDate: e.target.value })}
            />
          </label>
          <label className="field">
            <span>To day</span>
            <input type="date" value={draft.toDate} onChange={(e) => setDraft({ ...draft, toDate: e.target.value })} />
          </label>
          <div className="la-presets">
            <button type="button" className="la-chip" onClick={() => setRange("today")}>
              Today
            </button>
            <button type="button" className="la-chip" onClick={() => setRange("yesterday")}>
              Yesterday
            </button>
            <button type="button" className="la-chip" onClick={() => setRange("last7")}>
              Last 7 days
            </button>
            <button type="button" className="la-chip" onClick={() => setRange("thisMonth")}>
              This month
            </button>
            <button type="button" className="la-chip" onClick={() => setRange("lastMonth")}>
              Last month
            </button>
          </div>
          <label className="field">
            <span>Each day from</span>
            <select value={draft.hourFrom} onChange={(e) => setDraft({ ...draft, hourFrom: Number(e.target.value) })}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>to</span>
            <select value={draft.hourTo} onChange={(e) => setDraft({ ...draft, hourTo: Number(e.target.value) })}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:59
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="la-levels">
          <span className="muted small">Levels</span>
          {draft.levels.map((l, i) => (
            <span key={l} className="la-level">
              {i > 0 && <span className="muted">›</span>}
              <span className="la-chip on">
                {levelLabel(l)}
                <button
                  type="button"
                  aria-label={`Remove ${levelLabel(l)}`}
                  onClick={() => setDraft({ ...draft, levels: draft.levels.filter((x) => x !== l) })}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            </span>
          ))}
          {draft.levels.length < 5 && (
            <select
              aria-label="Add a level"
              value=""
              onChange={(e) =>
                e.target.value && setDraft({ ...draft, levels: [...draft.levels, e.target.value as ReportDimension] })
              }
            >
              <option value="">+ Add level…</option>
              {unused.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          )}
          <input
            className="la-search"
            placeholder={`Search ${levelLabel(settings.levels[0]!).toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
      <div className="la-wrap">
        <table className="la-grid">
          <colgroup>
            <col className="la-col-name" />
            {COLUMNS.map((c) => (
              <col key={c.metric} />
            ))}
            <col className="la-col-act" />
          </colgroup>
          <thead>
            <tr>
              <th>{settings.levels.map(levelLabel).join(" › ")}</th>
              {COLUMNS.map((c) => (
                <th key={c.metric} className="num" title={c.title}>
                  {c.label}
                </th>
              ))}
              <th>CDRs</th>
            </tr>
          </thead>
          <tbody>
            <tr
              className={`la-total${detail?.key === "" ? " la-selected" : ""}`}
              title="Double-click: all traffic over time below"
              onDoubleClick={() => setDetail({ key: "", title: "All traffic", conditions: [], chain: [] })}
            >
              <td className="la-name">
                <span className="la-toggle-gap" />
                Total
              </td>
              {total.data ? (
                <Cells metrics={total.data.totals.metrics} />
              ) : (
                <td colSpan={COLUMNS.length} className="muted">
                  {total.isError ? problemText(total.error) : "Loading…"}
                </td>
              )}
              <td className="la-actions">
                <button
                  type="button"
                  className="la-act"
                  onClick={() =>
                    void ask<void>((d) => (
                      <CdrWindow
                        title="All traffic"
                        state={edrGridState([], window.from, window.to)}
                        done={() => d()}
                      />
                    ))
                  }
                >
                  CDRs
                </button>
              </td>
            </tr>
            <Level
              settings={settings}
              depth={0}
              parents={[]}
              chain={[]}
              tick={tick}
              search={search}
              window={window}
              onDetail={setDetail}
              selected={detail?.key ?? null}
            />
          </tbody>
        </table>
      </div>
      {detail && (
        <DetailPanel
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
  );
}
