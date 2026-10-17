// Live dashboard (§4, §13.3): the NOC view of today's traffic. Everything on it is pushed over
// the Phoenix socket (CLAUDE.md rule 5): live:dashboard sends the summary bar each second and
// the movers and top lists every 5 s; live:tps sends an hour of TPS history on join and a tick
// each second. The movers window and threshold travel as live:dashboard join params
// (dashboard.join.json), so changing them re-joins. Window, threshold, chart length and hidden
// panels are saved per user (preferences.dashboard). Rows and chart points open the Analytics
// view in a new tab (§13.5).
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DashboardMoversEvent,
  DashboardSettings,
  DashboardSummaryEvent,
  DashboardTopsEvent,
  MoverRow,
  PartyRef,
  TpsHistoryEvent,
  TpsTickEvent,
  TrunkTps,
} from "@sms/contract";
import { useMe, useUpdatePreferences } from "../../api/hooks";
import { useMarketSummary } from "../../api/market";
import { useReference } from "../../api/records";
import { LiveSocket, socketUrl } from "../../live/socket";
import { pageForPath } from "../../nav/registry";
import { PageHeader } from "../../page/PageHeader";
import { usePageStatus, useTabNavigate } from "../../shell/tabContext";
import { Chart, useChartColors } from "../../ui/Chart";
import { Icon } from "../../ui/Icon";
import { Popover } from "../../ui/primitives";
import {
  analyticsPath,
  appendTick,
  bufferFromHistory,
  chartWindow,
  limitLevel,
  newKeys,
  type ChartBuffer,
} from "./dashboardModel";

const page = pageForPath("/dashboard")!;

const DEFAULTS: DashboardSettings = { windowMinutes: 15, thresholdPct: 30, chartMinutes: 15, hiddenPanels: [] };
type Panel = DashboardSettings["hiddenPanels"][number];
const PANELS: { key: Panel; label: string }[] = [
  { key: "summary", label: "Today's summary" },
  { key: "movers", label: "Traffic movers" },
  { key: "chart", label: "Live TPS chart" },
  { key: "tps", label: "TPS per trunk" },
  { key: "tops", label: "Top clients and vendors" },
  { key: "destinations", label: "Top destinations" },
];

const int = (v: number) => Math.round(v).toLocaleString("en-US");
const dec = (v: number, d = 1) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
const money = (v: number, currency: string) =>
  v.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 0 });

// ---------------------------------------------------------------- live feed

interface Feed {
  connected: boolean;
  summary: DashboardSummaryEvent | null;
  movers: DashboardMoversEvent | null;
  tops: DashboardTopsEvent | null;
  tick: TpsTickEvent | null;
  chart: ChartBuffer | null;
}

/** Two sockets: live:tps once, live:dashboard re-joined when the movers params change. */
function useDashboardFeed(windowMinutes: number, thresholdPct: number): Feed {
  const [feed, setFeed] = useState<Feed>({
    connected: false,
    summary: null,
    movers: null,
    tops: null,
    tick: null,
    chart: null,
  });
  useEffect(() => {
    const s = new LiveSocket(socketUrl());
    s.onStatus = (connected) => setFeed((f) => ({ ...f, connected }));
    s.subscribe("live:tps", (event, payload) => {
      if (event === "history")
        setFeed((f) => ({ ...f, chart: bufferFromHistory(payload as unknown as TpsHistoryEvent) }));
      if (event === "tick") {
        const tick = payload as unknown as TpsTickEvent;
        setFeed((f) => ({ ...f, tick, chart: f.chart && appendTick(f.chart, tick) }));
      }
    });
    s.connect();
    return () => s.close();
  }, []);
  useEffect(() => {
    const s = new LiveSocket(socketUrl());
    s.subscribe(
      "live:dashboard",
      (event, payload) => {
        if (event === "summary") setFeed((f) => ({ ...f, summary: payload as unknown as DashboardSummaryEvent }));
        if (event === "movers") setFeed((f) => ({ ...f, movers: payload as unknown as DashboardMoversEvent }));
        if (event === "tops") setFeed((f) => ({ ...f, tops: payload as unknown as DashboardTopsEvent }));
      },
      { windowMinutes, thresholdPct },
    );
    s.connect();
    return () => s.close();
  }, [windowMinutes, thresholdPct]);
  return feed;
}

/** Rolls a number to its new value over 600 ms (§13.3 "counter roll"); instant when animations are off. */
function useRolling(value: number, animate: boolean): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (!animate) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const frame = (t: number) => {
      const p = Math.min(1, (t - start) / 600);
      const v = a + (value - a) * (1 - (1 - p) ** 3);
      from.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [value, animate]);
  return shown;
}

// ---------------------------------------------------------------- page

export function DashboardPage() {
  const { data: me } = useMe();
  const prefs = useUpdatePreferences();
  const saved = me?.preferences.dashboard ?? DEFAULTS;
  const animate = me?.preferences.animations !== false;
  const navigate = useTabNavigate();
  const feed = useDashboardFeed(saved.windowMinutes, saved.thresholdPct);
  const hidden = new Set(saved.hiddenPanels);
  const save = (patch: Partial<DashboardSettings>) => prefs.mutate({ dashboard: { ...saved, ...patch } });
  const open = (target: PartyRef | { mccmnc: string }, title: string) =>
    navigate(analyticsPath(target), { forceNew: true, title: `Analytics · ${title}` });

  const at = feed.summary?.at ?? feed.tick?.at;
  usePageStatus({
    rows: feed.connected
      ? `Live · ${at ? new Date(at).toLocaleTimeString("en-GB") : "waiting for data"}`
      : "Reconnecting to the live feed…",
    shortcuts: "Click a row or chart point to open its Analytics view in a new tab",
  });

  return (
    <div className={`page dash${animate ? " dash-anim" : ""}`}>
      <PageHeader
        page={page}
        actions={
          <>
            <label className="dash-control">
              Movers window
              <select
                value={saved.windowMinutes}
                onChange={(e) => save({ windowMinutes: Number(e.target.value) as DashboardSettings["windowMinutes"] })}
              >
                {[5, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    {m === 60 ? "Last hour" : `Last ${m} minutes`}
                  </option>
                ))}
              </select>
            </label>
            <ThresholdInput value={saved.thresholdPct} onChange={(thresholdPct) => save({ thresholdPct })} />
            <PanelsMenu
              hidden={hidden}
              onToggle={(p) =>
                save({
                  hiddenPanels: hidden.has(p) ? saved.hiddenPanels.filter((x) => x !== p) : [...saved.hiddenPanels, p],
                })
              }
            />
            <span className={`dash-live${feed.connected ? " on" : ""}`} role="status">
              <span className="dot" /> {feed.connected ? "Live" : "Offline"}
            </span>
          </>
        }
      />
      <div className="dash-body">
        {!hidden.has("summary") && <SummaryBar summary={feed.summary} animate={animate} onOpen={open} />}
        {!hidden.has("movers") && <MoversPanel movers={feed.movers} onOpen={open} />}
        {!hidden.has("chart") && (
          <TpsChart
            chart={feed.chart}
            minutes={saved.chartMinutes}
            onMinutes={(chartMinutes) => save({ chartMinutes })}
            onOpen={open}
          />
        )}
        {!hidden.has("tps") && <TpsTables tick={feed.tick} onOpen={open} />}
        {!hidden.has("tops") && <TopParties tops={feed.tops} onOpen={open} />}
        {!hidden.has("destinations") && <TopDestinations tops={feed.tops} onOpen={open} />}
        {hidden.size === PANELS.length && (
          <div className="grid-message muted">All panels are hidden. Use Panels to show them again.</div>
        )}
      </div>
    </div>
  );
}

type Open = (target: PartyRef | { mccmnc: string }, title: string) => void;

function ThresholdInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 5 && n <= 500 && n !== value) onChange(n);
    else setDraft(String(value));
  };
  return (
    <label className="dash-control" title="Clients changing by more than this count as increasing or decreasing">
      Threshold ±
      <input
        className="dash-threshold"
        type="number"
        min={5}
        max={500}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      %
    </label>
  );
}

function PanelsMenu({ hidden, onToggle }: { hidden: Set<Panel>; onToggle: (p: Panel) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-default"
        onClick={() => setShown((v) => !v)}
        aria-expanded={shown}
      >
        <Icon name="columns" size={15} /> Panels
      </button>
      <Popover anchor={ref} open={shown} onClose={() => setShown(false)} align="end">
        <div className="dash-panels" role="group" aria-label="Panels shown">
          {PANELS.map((p) => (
            <label key={p.key}>
              <input type="checkbox" checked={!hidden.has(p.key)} onChange={() => onToggle(p.key)} /> {p.label}
            </label>
          ))}
        </div>
      </Popover>
    </>
  );
}

function Section({
  title,
  extra,
  children,
  className,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`dash-panel${className ? ` ${className}` : ""}`} aria-label={title}>
      <header>
        <h2>{title}</h2>
        {extra}
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- 1. summary bar

function Counter({
  label,
  value,
  format,
  tone,
  animate,
  sub,
}: {
  label: string;
  value: number | undefined;
  format: (v: number) => string;
  tone?: "good" | "warn" | "bad";
  animate: boolean;
  sub?: string;
}) {
  const shown = useRolling(value ?? 0, animate);
  return (
    <div className={`dash-kpi${tone ? ` ${tone}` : ""}`}>
      <span className="label">{label}</span>
      <span className="value">{value === undefined ? "—" : format(shown)}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

/** Compact card of open market moves (§13.14); opens Rates › Market moves. */
function MarketMovesChip() {
  const q = useMarketSummary();
  const navigate = useTabNavigate();
  const s = q.data;
  if (!s) return null;
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost dash-mm"
      title={`${s.up} up · ${s.down} down${s.mine ? ` · ${s.mine} for your clients` : ""}`}
      onClick={() => navigate("/rates/market-moves")}
    >
      Market moves <strong className="num">{s.open.toLocaleString("en-US")}</strong>
      {s.urgent > 0 && <span className="chip-mini tone-error">{s.urgent} urgent</span>}
    </button>
  );
}

function SummaryBar({
  summary: s,
  animate,
  onOpen,
}: {
  summary: DashboardSummaryEvent | null;
  animate: boolean;
  onOpen: Open;
}) {
  const cur = s?.currency ?? "EUR";
  // Today is the day in the platform time zone (decision 2026-10-16).
  const tz = useReference().data?.platformTimezone ?? "UTC";
  const ratioTone = (v: number | undefined, good: number, warn: number) =>
    v === undefined ? undefined : v >= good ? undefined : v >= warn ? "warn" : "bad";
  return (
    <Section
      title="Today"
      className="dash-summary"
      extra={
        <>
          <MarketMovesChip />
          <span className="muted small">
            {tz} day · {cur}
          </span>
        </>
      }
    >
      <div className="dash-kpis">
        <Counter label="Attempts" value={s?.attempts} format={int} animate={animate} />
        <Counter label="Submitted" value={s?.submitted} format={int} animate={animate} />
        <Counter label="Delivered" value={s?.delivered} format={int} animate={animate} />
        <Counter label="Revenue" value={s?.revenue} format={(v) => money(v, cur)} animate={animate} />
        <Counter label="Cost" value={s?.cost} format={(v) => money(v, cur)} animate={animate} />
        <Counter
          label="Margin"
          value={s?.margin}
          format={(v) => money(v, cur)}
          tone={s && s.margin < 0 ? "bad" : undefined}
          animate={animate}
          sub={s ? `${s.marginPct.toFixed(1)}%` : undefined}
        />
        <Counter
          label="ASR"
          value={s?.asr}
          format={(v) => `${v.toFixed(1)}%`}
          tone={ratioTone(s?.asr, 80, 60)}
          animate={animate}
        />
        <Counter
          label="DLR"
          value={s?.dlr}
          format={(v) => `${v.toFixed(1)}%`}
          tone={ratioTone(s?.dlr, 70, 50)}
          animate={animate}
        />
        <Counter label="TPS now" value={s?.tps} format={(v) => dec(v)} animate={animate} />
        <Counter
          label="Online"
          value={s?.onlineCustomers}
          format={int}
          animate={animate}
          sub={s ? `customers · ${s.onlineVendors} vendors` : undefined}
        />
      </div>
      {s && s.topDestinations.length > 0 && (
        <div className="dash-topdest">
          <span className="muted small">Top destinations</span>
          {s.topDestinations.map((d, i) => (
            <button
              key={d.mccmnc}
              type="button"
              className="chip"
              onClick={() => onOpen({ mccmnc: d.mccmnc }, `${d.country} ${d.network}`)}
              title={`${d.country} – ${d.network} (${d.mccmnc})`}
            >
              <span className="muted">{i + 1}</span> {d.country} {d.network}{" "}
              <span className="num">{int(d.attempts)}</span>
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- 2. movers

const Sparkline = memo(function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 0.1);
  const w = 72;
  const h = 18;
  const pts = values.map(
    (v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`,
  );
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
});

type MoverKind = "started" | "increasing" | "decreasing" | "stopped";
const MOVER_GROUPS: { key: MoverKind; label: string; tone: string }[] = [
  { key: "started", label: "Started sending", tone: "good" },
  { key: "increasing", label: "Increasing", tone: "good" },
  { key: "decreasing", label: "Decreasing", tone: "bad" },
  { key: "stopped", label: "Stopped", tone: "bad" },
];

function MoversPanel({ movers, onOpen }: { movers: DashboardMoversEvent | null; onOpen: Open }) {
  // Started rows not in the previous push get the "new" badge and a pulse.
  const prev = useRef<Set<string>>(new Set());
  const fresh = useMemo(() => {
    if (!movers) return new Set<string>();
    const keys = movers.started.map((r) => String(r.trunk.id));
    const out = prev.current.size ? newKeys(prev.current, keys) : new Set(keys);
    prev.current = new Set(keys);
    return out;
  }, [movers]);
  return (
    <Section
      title="Traffic movers"
      className="dash-movers"
      extra={
        movers && (
          <span className="muted small">
            Last {movers.windowMinutes} min vs the {movers.windowMinutes} min before · ±{movers.thresholdPct}%
          </span>
        )
      }
    >
      <div className="dash-mover-groups">
        {MOVER_GROUPS.map((g) => {
          const rows = movers?.[g.key] ?? [];
          return (
            <div key={g.key} className={`dash-mover-group ${g.tone}`}>
              <h3>
                {g.label} <span className="count num">{movers ? rows.length : "…"}</span>
              </h3>
              {movers && rows.length === 0 && <div className="muted small dash-empty">None</div>}
              <ul>
                {rows.map((r) => (
                  <MoverItem
                    key={r.trunk.id}
                    row={r}
                    kind={g.key}
                    isNew={g.key === "started" && fresh.has(String(r.trunk.id))}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function MoverItem({ row, kind, isNew, onOpen }: { row: MoverRow; kind: MoverKind; isNew: boolean; onOpen: Open }) {
  const change =
    row.changePct === null ? null : (
      <span className={`chg ${row.changePct >= 0 ? "up" : "down"}`}>
        <span aria-hidden="true">{row.changePct >= 0 ? "▲" : "▼"}</span> {Math.abs(row.changePct).toFixed(0)}%
      </span>
    );
  return (
    <li>
      <button
        type="button"
        className={`dash-mover${isNew ? " is-new" : ""}`}
        onClick={() => onOpen(row.enterprise, row.enterprise.name)}
        title={`${row.enterprise.name} · ${row.trunk.name}: ${row.tpsBefore} → ${row.tpsNow} TPS. ASR ${pct(row.asr)}, DLR ${pct(row.dlr)}`}
      >
        <span className="who">
          <span className="name">
            {row.enterprise.name}
            {isNew && <span className="badge-new">new</span>}
          </span>
          <span className="trunk muted">{row.trunk.name}</span>
        </span>
        <Sparkline values={row.sparkline} />
        <span className="tps num">
          {kind === "stopped" ? dec(row.tpsBefore) : dec(row.tpsNow)}
          <span className="muted"> {kind === "stopped" ? "was" : `from ${dec(row.tpsBefore)}`}</span>
        </span>
        {change ?? <span className="chg muted">—</span>}
        <span className="ratios num muted">
          {pct(row.asr)} · {pct(row.dlr)}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- 3. TPS chart

function TpsChart({
  chart,
  minutes,
  onMinutes,
  onOpen,
}: {
  chart: ChartBuffer | null;
  minutes: DashboardSettings["chartMinutes"];
  onMinutes: (m: DashboardSettings["chartMinutes"]) => void;
  onOpen: Open;
}) {
  const colors = useChartColors();
  const win = useMemo(() => (chart ? chartWindow(chart, minutes) : null), [chart, minutes]);
  const option = useMemo(() => {
    if (!win) return {};
    const fmt = (t: number) =>
      new Date(t).toLocaleTimeString("en-GB", minutes > 15 ? { hour: "2-digit", minute: "2-digit" } : undefined);
    return {
      animation: false,
      grid: { left: 52, right: 44, top: 52, bottom: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => `${dec(v)} TPS` },
      legend: { type: "scroll", top: 0, textStyle: { color: colors.secondary }, inactiveColor: colors.border },
      xAxis: {
        type: "category",
        data: win.times.map(fmt),
        boundaryGap: false,
        axisLine: { lineStyle: { color: colors.border } },
        axisLabel: { color: colors.secondary },
      },
      // Total on the left, the top-10 trunks on the right: on one axis they would lie flat at the bottom.
      yAxis: [
        {
          type: "value",
          name: "Total",
          nameTextStyle: { color: colors.secondary },
          splitLine: { lineStyle: { color: colors.border } },
          axisLabel: { color: colors.secondary },
        },
        {
          type: "value",
          name: "Per trunk",
          nameTextStyle: { color: colors.secondary },
          splitLine: { show: false },
          axisLabel: { color: colors.secondary },
        },
      ],
      series: [
        {
          id: "total",
          name: "Total",
          type: "line",
          data: win.total,
          showSymbol: false,
          lineStyle: { width: 2, color: colors.accent },
          itemStyle: { color: colors.accent },
          areaStyle: { color: colors.accent, opacity: 0.08 },
        },
        ...win.series.map((s) => ({
          id: `t${s.trunk.id}`,
          name: s.trunk.name,
          type: "line",
          yAxisIndex: 1,
          data: s.values,
          showSymbol: false,
          lineStyle: { width: 1 },
        })),
      ],
    };
  }, [win, colors, minutes]);
  return (
    <Section
      title="Live TPS"
      className="dash-chart"
      extra={
        <div className="segmented small" role="radiogroup" aria-label="Chart length">
          {([5, 15, 60] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={minutes === m}
              className={minutes === m ? "on" : ""}
              onClick={() => onMinutes(m)}
            >
              {m === 60 ? "1 h" : `${m} min`}
            </button>
          ))}
        </div>
      }
    >
      {win ? (
        <Chart
          option={option}
          merge
          height={260}
          label="Total TPS and the ten busiest client trunks"
          onClick={(p) => {
            const s = chart?.series.find((x) => `t${x.trunk.id}` === p.seriesId);
            if (s) onOpen(s.trunk, s.trunk.name);
          }}
        />
      ) : (
        <div className="grid-message muted dash-wait">Waiting for the live feed…</div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- 4. TPS tables

const ROW_H = 28;

/** Rows positioned by rank, so a rank change slides the row (§13.3 "rows re-sort smoothly"). */
function RankedList<T>({
  rows,
  rowKey,
  render,
  height,
  label,
}: {
  rows: T[];
  rowKey: (r: T) => string;
  render: (r: T, i: number) => ReactNode;
  height: number;
  label: string;
}) {
  return (
    <div className="dash-ranked" style={{ height }} role="list" aria-label={label}>
      <div style={{ height: rows.length * ROW_H, position: "relative" }}>
        {rows.map((r, i) => (
          <div
            key={rowKey(r)}
            role="listitem"
            className="dash-rank-row"
            style={{ transform: `translateY(${i * ROW_H}px)` }}
          >
            {render(r, i)}
          </div>
        ))}
      </div>
    </div>
  );
}

function TpsTables({ tick, onOpen }: { tick: TpsTickEvent | null; onOpen: Open }) {
  const customers = tick?.trunks.filter((t) => t.trunk.kind === "customer_trunk") ?? [];
  const vendors = tick?.trunks.filter((t) => t.trunk.kind === "vendor_trunk") ?? [];
  return (
    <div className="dash-pair">
      <TpsTable title="TPS per client trunk" rows={customers} onOpen={onOpen} waiting={!tick} />
      <TpsTable title="TPS per vendor trunk" rows={vendors} onOpen={onOpen} waiting={!tick} />
    </div>
  );
}

function TpsTable({
  title,
  rows,
  onOpen,
  waiting,
}: {
  title: string;
  rows: TrunkTps[];
  onOpen: Open;
  waiting: boolean;
}) {
  const total = rows.reduce((s, r) => s + r.tps, 0);
  return (
    <Section
      title={title}
      className="dash-tps"
      extra={
        <span className="muted small num">
          {rows.length} sending · {dec(total)} TPS
        </span>
      }
    >
      <div className="dash-cols dash-tps-row head" aria-hidden="true">
        <span>Trunk</span>
        <span className="r">TPS</span>
        <span className="r">Limit</span>
        <span>Use of limit</span>
        <span className="r">Queue</span>
      </div>
      {waiting ? (
        <div className="grid-message muted dash-wait">Waiting for the live feed…</div>
      ) : (
        <RankedList
          rows={rows}
          label={title}
          height={ROW_H * 10}
          rowKey={(r) => String(r.trunk.id)}
          render={(r) => {
            const { pct: used, level } = limitLevel(r.tps, r.tpsLimit);
            return (
              <button type="button" className="dash-cols dash-tps-row" onClick={() => onOpen(r.trunk, r.trunk.name)}>
                <span className="ellipsis" title={r.trunk.name}>
                  {r.trunk.name}
                </span>
                <span className="r num">{dec(r.tps)}</span>
                <span className="r num muted">{int(r.tpsLimit)}</span>
                <span className={`dash-bar ${level}`} title={`${used.toFixed(0)}% of the limit`}>
                  <span style={{ width: `${Math.min(100, used)}%` }} />
                  <em className="num">{used.toFixed(0)}%</em>
                </span>
                <span className={`r num${r.queueDepth > 0 ? " queue" : " muted"}`}>{int(r.queueDepth)}</span>
              </button>
            );
          }}
        />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- 5 and 6. top lists

function TopParties({ tops, onOpen }: { tops: DashboardTopsEvent | null; onOpen: Open }) {
  const cur = tops?.currency ?? "EUR";
  return (
    <div className="dash-pair">
      {(["clients", "vendors"] as const).map((side) => {
        const rows = tops?.[side] ?? [];
        const max = Math.max(1, ...rows.map((r) => r.attempts));
        return (
          <Section
            key={side}
            title={side === "clients" ? "Top clients today" : "Top vendors today"}
            className="dash-top"
          >
            <div className="dash-cols dash-top-row head" aria-hidden="true">
              <span>#</span>
              <span>{side === "clients" ? "Client" : "Vendor"}</span>
              <span className="r">Volume</span>
              <span className="r">{side === "clients" ? "Revenue" : "Cost"}</span>
              <span className="r">Margin</span>
              <span className="r">ASR</span>
              <span className="r">DLR</span>
            </div>
            {!tops ? (
              <div className="grid-message muted dash-wait">Waiting for the live feed…</div>
            ) : (
              <RankedList
                rows={rows}
                label={side}
                height={ROW_H * 10}
                rowKey={(r) => String(r.party.id)}
                render={(r, i) => (
                  <button
                    type="button"
                    className="dash-cols dash-top-row"
                    onClick={() => onOpen(r.party, r.party.name)}
                  >
                    <span className="muted num">{i + 1}</span>
                    <span className="ellipsis dash-named" title={r.party.name}>
                      <span className="dash-volbar" style={{ width: `${(r.attempts / max) * 100}%` }} />
                      <span className="t">{r.party.name}</span>
                    </span>
                    <span className="r num">{int(r.attempts)}</span>
                    <span className="r num">{money(r.money, cur)}</span>
                    <span className={`r num${r.margin < 0 ? " neg" : ""}`}>{money(r.margin, cur)}</span>
                    <span className="r num">{pct(r.asr)}</span>
                    <span className="r num">{pct(r.dlr)}</span>
                  </button>
                )}
              />
            )}
          </Section>
        );
      })}
    </div>
  );
}

function TopDestinations({ tops, onOpen }: { tops: DashboardTopsEvent | null; onOpen: Open }) {
  const cur = tops?.currency ?? "EUR";
  const rows = tops?.destinations ?? [];
  const max = Math.max(1, ...rows.map((r) => r.attempts));
  return (
    <Section title="Top destinations today" className="dash-top">
      <div className="dash-cols dash-dest-row head" aria-hidden="true">
        <span>#</span>
        <span>Country / network</span>
        <span>MCCMNC</span>
        <span className="r">Volume</span>
        <span className="r">Revenue</span>
        <span className="r">Margin</span>
        <span className="r">ASR</span>
        <span className="r">DLR</span>
      </div>
      {!tops ? (
        <div className="grid-message muted dash-wait">Waiting for the live feed…</div>
      ) : (
        <RankedList
          rows={rows}
          label="Top destinations"
          height={ROW_H * Math.min(15, Math.max(5, rows.length))}
          rowKey={(r) => r.mccmnc}
          render={(r, i) => (
            <button
              type="button"
              className="dash-cols dash-dest-row"
              onClick={() => onOpen({ mccmnc: r.mccmnc }, `${r.country} ${r.network}`)}
            >
              <span className="muted num">{i + 1}</span>
              <span className="ellipsis dash-named" title={`${r.country} – ${r.network}`}>
                <span className="dash-volbar" style={{ width: `${(r.attempts / max) * 100}%` }} />
                <span className="t">
                  {r.country} <span className="muted">{r.network}</span>
                </span>
              </span>
              <span className="num muted">{r.mccmnc}</span>
              <span className="r num">{int(r.attempts)}</span>
              <span className="r num">{money(r.revenue, cur)}</span>
              <span className={`r num${r.margin < 0 ? " neg" : ""}`}>{money(r.margin, cur)}</span>
              <span className="r num">{pct(r.asr)}</span>
              <span className="r num">{pct(r.dlr)}</span>
            </button>
          )}
        />
      )}
    </Section>
  );
}
