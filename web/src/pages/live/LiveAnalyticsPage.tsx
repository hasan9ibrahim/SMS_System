// Live Analytics Report (§13.4): the main monitoring page. In live mode (today) the server pushes the
// figures every 1, 5 or 15 s on live:analytics; only changed cells update, with a brief green / red
// highlight. Report By, search, "only sending now", sort and the compare window go to the server as
// join params (CLAUDE.md rule 3), so the table keeps its scroll while figures change. Pause freezes
// the view; Resume catches up. Yesterday, this week and this month are standard Master Report queries.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { AnalyticsSnapshotEvent } from "@sms/contract";
import { runMasterReport } from "../../api/masterReports";
import { LiveSocket, socketUrl } from "../../live/socket";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { usePageStatus, useTabNavigate } from "../../shell/tabContext";
import { Button } from "../../ui/primitives";
import { problemText } from "../routing/dialogs";
import {
  badWhenUp,
  changes,
  GROUPS,
  historicalQuery,
  isGroup,
  PERIODS,
  rowsFromReport,
  sparkPoints,
  tone,
  type GroupBy,
  type Period,
  type Row,
  type SortKey,
} from "./analyticsModel";

const page = pageForPath("/live/analytics")!;
const fmtInt = (v: number | null) => (v === null ? "—" : Math.round(v).toLocaleString("en-US"));
const fmtMoney = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);
const fmtTps = (v: number | null) => (v === null ? "—" : v.toFixed(1));

type Col = { key: SortKey | "parent" | "sparkline"; label: string; num?: boolean; sortable?: boolean };
const COLS: Col[] = [
  { key: "attempts", label: "Attempts", num: true, sortable: true },
  { key: "submitted" as SortKey, label: "Submitted", num: true },
  { key: "delivered", label: "Delivered", num: true, sortable: true },
  { key: "asr", label: "ASR", num: true, sortable: true },
  { key: "dlr", label: "DLR", num: true, sortable: true },
  { key: "revenue", label: "Revenue", num: true, sortable: true },
  { key: "cost", label: "Cost", num: true, sortable: true },
  { key: "margin", label: "Margin", num: true, sortable: true },
  { key: "marginPct", label: "Margin %", num: true, sortable: true },
  { key: "tps", label: "TPS", num: true, sortable: true },
  { key: "changePct", label: "vs before", num: true, sortable: true },
  { key: "sparkline", label: "Last 60 min" },
];

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** live:analytics with the join params; re-joined when they change. */
function useLiveSnapshot(params: Record<string, unknown> | null) {
  const [snap, setSnap] = useState<AnalyticsSnapshotEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!params) return;
    setSnap(null);
    const s = new LiveSocket(socketUrl());
    s.onStatus = setConnected;
    s.subscribe(
      "live:analytics",
      (event, payload) => event === "snapshot" && setSnap(payload as unknown as AnalyticsSnapshotEvent),
      params,
    );
    s.connect();
    return () => s.close();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { snap, connected };
}

function Spark({ values }: { values: number[] | null }) {
  if (!values || values.length < 2) return <span className="muted">—</span>;
  return (
    <svg className="la-spark" width={90} height={22} viewBox="0 0 90 22" aria-hidden="true">
      <polyline points={sparkPoints(values)} fill="none" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
}

function Change({ v }: { v: number | null }) {
  if (v === null) return <span className="muted">—</span>;
  const up = v > 0;
  return (
    <span className={Math.abs(v) < 0.05 ? "muted" : up ? "tone-good" : "tone-error"}>
      {up ? "▲" : v < 0 ? "▼" : ""} {Math.abs(v).toFixed(1)} %
    </span>
  );
}

function cell(r: Row, k: Col["key"]) {
  switch (k) {
    case "attempts":
    case "submitted" as SortKey:
    case "delivered":
      return fmtInt(r[k as "attempts"]);
    case "asr":
    case "dlr":
      return <span className={`tone-${tone(k, r[k])}`}>{fmtPct(r[k])}</span>;
    case "marginPct":
      return <span className={`tone-${tone("marginPct", r.marginPct)}`}>{fmtPct(r.marginPct)}</span>;
    case "revenue":
    case "cost":
      return fmtMoney(r[k]);
    case "margin":
      return <span className={r.margin !== null && r.margin < 0 ? "tone-error" : ""}>{fmtMoney(r.margin)}</span>;
    case "tps":
      return fmtTps(r.tps);
    case "changePct":
      return <Change v={r.changePct} />;
    case "sparkline":
      return <Spark values={r.sparkline} />;
    default:
      return null;
  }
}

export function LiveAnalyticsPage() {
  const location = useLocation();
  const navigate = useTabNavigate();
  const url = new URLSearchParams(location.search);
  const [groupBy, setGroupBy] = useState<GroupBy>(isGroup(url.get("by")) ? (url.get("by") as GroupBy) : "customer");
  const [search, setSearch] = useState(url.get("q") ?? "");
  const [period, setPeriod] = useState<Period>(
    (PERIODS.find((p) => p.value === url.get("period"))?.value ?? "live") as Period,
  );
  const [interval, setIntervalS] = useState<1 | 5 | 15>(5);
  const [compare, setCompare] = useState<5 | 15 | 60>(15);
  const [onlyActive, setOnlyActive] = useState(false);
  const [sort, setSort] = useState<SortKey>("attempts");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [paused, setPaused] = useState(false);
  const q = useDebounced(search);
  const live = period === "live";

  // The tab URL keeps Report By, search and period (§13.5 tab state).
  useEffect(() => {
    const p = new URLSearchParams();
    p.set("by", groupBy);
    if (q) p.set("q", q);
    if (period !== "live") p.set("period", period);
    const next = `/live/analytics?${p.toString()}`;
    if (next !== `${location.pathname}${location.search}`) navigate(next, { replace: true });
  }, [groupBy, q, period]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = live
    ? { groupBy, intervalSeconds: interval, compareMinutes: compare, search: q, onlyActive, sort, dir, limit: 200 }
    : null;
  const { snap, connected } = useLiveSnapshot(params);
  const hist = useQuery({
    queryKey: ["list", "live-analytics-history", groupBy, period, q, sort, dir],
    queryFn: () => runMasterReport(historicalQuery(groupBy, period as Exclude<Period, "live">, q, sort, dir)),
    enabled: !live,
  });

  // Pause keeps the last shown snapshot; Resume catches up with the newest.
  const [shown, setShown] = useState<AnalyticsSnapshotEvent | null>(null);
  const prev = useRef<Row[] | null>(null);
  const [flash, setFlash] = useState<ReturnType<typeof changes>>(new Map());
  useEffect(() => {
    if (!live || paused || !snap) return;
    setFlash(shown && shown.groupBy === snap.groupBy ? changes(prev.current, snap.rows) : new Map());
    prev.current = snap.rows;
    setShown(snap);
  }, [snap, paused, live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    prev.current = null;
    setShown(null);
  }, [groupBy, q, onlyActive, sort, dir, compare]);

  const rows: Row[] = useMemo(
    () => (live ? (shown?.rows ?? []) : hist.data ? rowsFromReport(hist.data, groupBy) : []),
    [live, shown, hist.data, groupBy],
  );
  const total = live ? (shown?.total ?? 0) : (hist.data?.total ?? rows.length);
  const totals = live ? shown?.totals : null;
  const currency = live ? shown?.currency : hist.data?.currency;

  usePageStatus({
    rows: live
      ? connected
        ? `${paused ? "Paused" : "Live"} · ${rows.length} of ${total} · ${shown ? new Date(shown.at).toLocaleTimeString("en-GB") : "waiting for data"}`
        : "Reconnecting to the live feed…"
      : hist.isPending
        ? "Loading…"
        : `${rows.length} of ${total} · ${PERIODS.find((p) => p.value === period)?.label}`,
    shortcuts: "Click a column to sort · figures in " + (currency ?? "the platform currency"),
  });

  const onSort = (k: SortKey) => {
    if (k === sort) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setSort(k);
      setDir(k === "name" ? "asc" : "desc");
    }
  };
  const cols = COLS.filter((c) => live || (c.key !== "changePct" && c.key !== "sparkline"));
  const groupLabel = GROUPS.find((g) => g.value === groupBy)!.label;

  return (
    <div className="page la">
      <PageHeader
        page={page}
        actions={
          live ? (
            <>
              <span className={`dash-live${connected && !paused ? " on" : ""}`} role="status">
                <span className="dot" /> {paused ? "Paused" : connected ? "Live" : "Offline"}
              </span>
              <Button icon={paused ? "play" : "minus"} onClick={() => setPaused(!paused)}>
                {paused ? "Resume" : "Pause"}
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="la-controls">
        <div className="segmented small" role="tablist" aria-label="Report By">
          {GROUPS.map((g) => (
            <button
              key={g.value}
              type="button"
              role="tab"
              aria-selected={groupBy === g.value}
              className={groupBy === g.value ? "on" : ""}
              onClick={() => setGroupBy(g.value)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <label className="la-control">
          Period
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {live && (
          <>
            <label className="la-control">
              Update every
              <select value={interval} onChange={(e) => setIntervalS(Number(e.target.value) as 1 | 5 | 15)}>
                {[1, 5, 15].map((s) => (
                  <option key={s} value={s}>
                    {s} s
                  </option>
                ))}
              </select>
            </label>
            <label className="la-control">
              Compare TPS with
              <select value={compare} onChange={(e) => setCompare(Number(e.target.value) as 5 | 15 | 60)}>
                {[5, 15, 60].map((m) => (
                  <option key={m} value={m}>
                    the {m} min before
                  </option>
                ))}
              </select>
            </label>
            <label className="toggle-inline">
              <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
              Only sending now
            </label>
          </>
        )}
        <input
          className="la-search"
          type="search"
          placeholder={`Search ${groupLabel.toLowerCase()} (% and _ wildcards)…`}
          aria-label="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {totals && (
        <div className="la-totals" aria-label="Totals">
          <span>
            <b className="num">{fmtInt(totals.attempts)}</b> attempts
          </span>
          <span>
            <b className="num">{fmtInt(totals.delivered)}</b> delivered
          </span>
          <span>
            ASR <b className={`num tone-${tone("asr", totals.asr)}`}>{fmtPct(totals.asr)}</b>
          </span>
          <span>
            DLR <b className={`num tone-${tone("dlr", totals.dlr)}`}>{fmtPct(totals.dlr)}</b>
          </span>
          {totals.revenue !== null && (
            <span>
              Revenue <b className="num">{fmtMoney(totals.revenue)}</b>
            </span>
          )}
          {totals.margin !== null && (
            <span>
              Margin <b className={`num tone-${tone("marginPct", totals.marginPct)}`}>{fmtMoney(totals.margin)}</b> (
              {fmtPct(totals.marginPct)})
            </span>
          )}
          {totals.tps !== null && (
            <span>
              <b className="num">{fmtTps(totals.tps)}</b> TPS now
            </span>
          )}
          <span className="muted">
            {currency} · today {shown?.day} (platform day)
          </span>
        </div>
      )}
      <div className="la-table-wrap">
        {hist.isError && <p className="error-text pad">{problemText(hist.error)}</p>}
        <table className="la-table">
          <thead>
            <tr>
              <th className="la-name">
                <button type="button" className="la-sort" onClick={() => onSort("name")}>
                  {groupLabel} {sort === "name" ? (dir === "asc" ? "▲" : "▼") : ""}
                </button>
              </th>
              {cols.map((c) => (
                <th key={c.key} className={c.num ? "num" : ""}>
                  {c.sortable ? (
                    <button type="button" className="la-sort" onClick={() => onSort(c.key as SortKey)}>
                      {c.label} {sort === c.key ? (dir === "asc" ? "▲" : "▼") : ""}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const f = flash.get(r.key);
              return (
                <tr key={r.key}>
                  <td className="la-name">
                    <strong>{r.name}</strong>
                    {r.parent && <span className="muted small"> · {r.parent}</span>}
                  </td>
                  {cols.map((c) => {
                    const d = f?.[c.key as keyof NonNullable<typeof f>];
                    const cls = d ? (d > 0 !== badWhenUp(c.key) ? " flash-up" : " flash-down") : "";
                    // A new key on change remounts the cell, so the highlight animation runs again.
                    return (
                      <td key={`${c.key}-${d ? shown?.at : ""}`} className={`${c.num ? "num" : ""}${cls}`}>
                        {cell(r, c.key)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length + 1} className="muted pad">
                  {live && !shown ? "Waiting for the first figures…" : "Nothing matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
