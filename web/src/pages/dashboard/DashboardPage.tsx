// Live dashboard (§4, §13.3): the NOC view of today's traffic. Everything on it is pushed over
// the Phoenix socket (CLAUDE.md rule 5): live:dashboard sends the summary bar each second and
// the movers and top lists every 5 s; live:tps sends an hour of TPS history on join and a tick
// each second. The movers window and threshold travel as live:dashboard join params
// (dashboard.join.json), so changing them re-joins. Window, threshold, chart length and hidden
// panels are saved per user (preferences.dashboard). Rows and chart points open the Analytics
// view in a new tab (§13.5).
import { useCan } from "../../api/access";
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
import { qualityClass } from "../../ui/quality";
import {
  analyticsPath,
  appendTick,
  bufferFromHistory,
  chartWindow,
  limitLevel,
  newKeys,
  type AnalyticsTarget,
  type ChartBuffer,
} from "./dashboardModel";
import { useOnlineUsers } from "../../api/team";
import { useQuery } from "@tanstack/react-query";
import type { FilterCondition, ReportDimension } from "@sms/contract";
import { runMasterReport } from "../../api/masterReports";

const page = pageForPath("/dashboard")!;

const DEFAULTS: DashboardSettings = {
  windowMinutes: 15,
  customerMinMessages: 100,
  vendorMinMessages: 100,
  chartMinutes: 15,
  refreshSeconds: 1,
  hiddenPanels: [],
  layout: [],
};
type Panel = DashboardSettings["hiddenPanels"][number];
const PANELS: { key: Panel; label: string }[] = [
  // Default order (team trial round 3): cards, tops, TPS per trunk, movers, destinations, the TPS chart.
  { key: "summary", label: "Today's summary" },
  { key: "tops", label: "Top clients and vendors" },
  { key: "tps", label: "TPS per trunk" },
  { key: "movers", label: "Traffic movers" },
  { key: "destinations", label: "Top destinations" },
  { key: "chart", label: "Live TPS chart" },
];

/** Refresh periods of the summary, movers, top lists and TPS table (team trial round 1). */
const REFRESH: { value: number; label: string }[] = [
  { value: 1, label: "Live (1 s)" },
  { value: 5, label: "Every 5 s" },
  { value: 10, label: "Every 10 s" },
  { value: 30, label: "Every 30 s" },
  { value: 60, label: "Every minute" },
  { value: 0, label: "Paused" },
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

/**
 * Two sockets: live:tps once, live:dashboard re-joined when the movers params or the refresh period
 * change. The refresh period (team trial round 1) sets the server's push period; the TPS table follows
 * it too (the chart stays live). Paused keeps the figures shown when it was paused.
 */
function useDashboardFeed(
  windowMinutes: number,
  customerMinMessages: number,
  vendorMinMessages: number,
  refreshSeconds: number,
): Feed {
  const paused = refreshSeconds === 0;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const lastTick = useRef(0);
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
        const now = Date.now();
        const showTick = !pausedRef.current && now - lastTick.current >= refreshRef.current * 1000 - 200;
        if (showTick) lastTick.current = now;
        setFeed((f) => ({ ...f, tick: showTick ? tick : f.tick, chart: f.chart && appendTick(f.chart, tick) }));
      }
    });
    s.connect();
    return () => s.close();
  }, []);
  const refreshRef = useRef(refreshSeconds);
  refreshRef.current = refreshSeconds;
  useEffect(() => {
    if (paused) return;
    const s = new LiveSocket(socketUrl());
    s.subscribe(
      "live:dashboard",
      (event, payload) => {
        if (event === "summary") setFeed((f) => ({ ...f, summary: payload as unknown as DashboardSummaryEvent }));
        if (event === "movers") setFeed((f) => ({ ...f, movers: payload as unknown as DashboardMoversEvent }));
        if (event === "tops") setFeed((f) => ({ ...f, tops: payload as unknown as DashboardTopsEvent }));
      },
      { windowMinutes, customerMinMessages, vendorMinMessages, refreshSeconds },
    );
    s.connect();
    return () => s.close();
  }, [windowMinutes, customerMinMessages, vendorMinMessages, refreshSeconds, paused]);
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
  const refreshSeconds = saved.refreshSeconds ?? 1;
  const feed = useDashboardFeed(
    saved.windowMinutes,
    saved.customerMinMessages ?? 100,
    saved.vendorMinMessages ?? 100,
    refreshSeconds,
  );
  const hidden = new Set(saved.hiddenPanels);
  const save = (patch: Partial<DashboardSettings>) => prefs.mutate({ dashboard: { ...saved, ...patch } });
  const open = (target: AnalyticsTarget, title: string) =>
    navigate(analyticsPath(target), { forceNew: true, title: `Analytics · ${title}` });

  const layout = layoutOf(saved.layout ?? []);
  const saveLayout = (next: LayoutItem[]) => save({ layout: next });
  const panel = (key: Panel): ReactNode => {
    switch (key) {
      case "summary":
        return <SummaryBar summary={feed.summary} animate={animate} onOpen={open} />;
      case "movers":
        return (
          <MoversPanel
            movers={feed.movers}
            onOpen={open}
            volumes={{ customer: saved.customerMinMessages ?? 100, vendor: saved.vendorMinMessages ?? 100 }}
            onVolume={(kind, n) => save(kind === "customer" ? { customerMinMessages: n } : { vendorMinMessages: n })}
          />
        );
      case "chart":
        return (
          <TpsChart
            chart={feed.chart}
            minutes={saved.chartMinutes}
            onMinutes={(chartMinutes) => save({ chartMinutes })}
            onOpen={open}
          />
        );
      case "tps":
        return <TpsTables tick={feed.tick} onOpen={open} />;
      case "tops":
        return <TopParties tops={feed.tops} onOpen={open} />;
      case "destinations":
        return <TopDestinations tops={feed.tops} onOpen={open} />;
    }
  };

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
            {/* Online now sits in the page header, left of the controls (team trial round 2). */}
            <OnlineNowCard />
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
            <label className="dash-control">
              Refresh
              <select
                value={refreshSeconds}
                onChange={(e) =>
                  save({ refreshSeconds: Number(e.target.value) as NonNullable<DashboardSettings["refreshSeconds"]> })
                }
              >
                {REFRESH.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <PanelsMenu
              hidden={hidden}
              onReset={() => save({ layout: [] })}
              onToggle={(p) =>
                save({
                  hiddenPanels: hidden.has(p) ? saved.hiddenPanels.filter((x) => x !== p) : [...saved.hiddenPanels, p],
                })
              }
            />
            <span className={`dash-live${feed.connected && refreshSeconds ? " on" : ""}`} role="status">
              <span className="dot" /> {!feed.connected ? "Offline" : refreshSeconds ? "Live" : "Paused"}
            </span>
          </>
        }
      />
      <div className="dash-body">
        {/* Panels in the user's order and sizes (team trial round 2): drag the grip to move, the corner to resize. */}
        <div className="dash-grid">
          {layout
            .filter((l) => !hidden.has(l.panel))
            .map((l) => (
              <PanelFrame
                key={l.panel}
                item={l}
                label={PANELS.find((p) => p.key === l.panel)!.label}
                onMove={(from) => saveLayout(movePanel(layout, from, l.panel))}
                onResize={(cols, height) =>
                  saveLayout(layout.map((x) => (x.panel === l.panel ? { ...x, cols, height } : x)))
                }
              >
                {panel(l.panel)}
              </PanelFrame>
            ))}
        </div>
        {hidden.size === PANELS.length && (
          <div className="grid-message muted">All panels are hidden. Use Panels to show them again.</div>
        )}
      </div>
    </div>
  );
}

type Open = (target: AnalyticsTarget, title: string) => void;

// ---------------------------------------------------------------- layout (team trial round 2)

type LayoutItem = DashboardSettings["layout"][number];

/** The saved order and sizes, then any panel not in it, full width in the default order. */
export function layoutOf(saved: LayoutItem[]): LayoutItem[] {
  const known = new Set(PANELS.map((p) => p.key));
  const out = saved.filter((l, i) => known.has(l.panel) && saved.findIndex((x) => x.panel === l.panel) === i);
  for (const p of PANELS) if (!out.some((l) => l.panel === p.key)) out.push({ panel: p.key, cols: 12, height: null });
  return out;
}

/** Moves `from` to where `to` is (the panels between shift by one). */
export function movePanel(layout: LayoutItem[], from: Panel, to: Panel): LayoutItem[] {
  if (from === to) return layout;
  const item = layout.find((l) => l.panel === from)!;
  const rest = layout.filter((l) => l.panel !== from);
  const at = rest.findIndex((l) => l.panel === to);
  const after = layout.findIndex((l) => l.panel === from) < layout.findIndex((l) => l.panel === to);
  rest.splice(after ? at + 1 : at, 0, item);
  return rest;
}

/** One panel in the grid: a grip to drag it onto another panel, a corner to resize it. */
function PanelFrame({
  item,
  label,
  onMove,
  onResize,
  children,
}: {
  item: LayoutItem;
  label: string;
  onMove: (from: Panel) => void;
  onResize: (cols: number, height: number | null) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [over, setOver] = useState(false);
  const [live, setLive] = useState<{ cols: number; height: number | null } | null>(null);
  const cols = live?.cols ?? item.cols;
  const height = live ? live.height : item.height;
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const grid = el.parentElement!;
    const colW = (grid.clientWidth + 12) / 12;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = el.offsetWidth;
    const h0 = el.offsetHeight;
    let last = { cols: item.cols, height: item.height };
    const move = (ev: PointerEvent) => {
      last = {
        cols: Math.max(3, Math.min(12, Math.round((w0 + ev.clientX - x0 + 12) / colW))),
        height: Math.max(120, Math.min(2000, Math.round(h0 + ev.clientY - y0))),
      };
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      if (last.cols !== item.cols || last.height !== item.height) onResize(last.cols, last.height);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      ref={ref}
      className={`dash-frame${over ? " drop" : ""}${height ? " sized" : ""}`}
      style={{ gridColumn: `span ${cols}`, height: height ?? undefined }}
      draggable={drag}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-dash-panel", item.panel);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setDrag(false)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/x-dash-panel")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const from = e.dataTransfer.getData("text/x-dash-panel") as Panel;
        if (from) onMove(from);
      }}
    >
      <button
        type="button"
        className="dash-grip"
        title={`Drag to move ${label}`}
        aria-label={`Move ${label}`}
        onMouseDown={() => setDrag(true)}
        onMouseUp={() => setDrag(false)}
      >
        ⠿
      </button>
      {children}
      <span
        className="dash-resize"
        title={`Drag to resize ${label}; double-click for its own height`}
        onPointerDown={startResize}
        onDoubleClick={() => onResize(item.cols, null)}
      />
    </div>
  );
}

function PanelsMenu({
  hidden,
  onToggle,
  onReset,
}: {
  hidden: Set<Panel>;
  onToggle: (p: Panel) => void;
  onReset: () => void;
}) {
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
          <button type="button" className="link small" onClick={onReset}>
            Reset layout (order and sizes)
          </button>
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
  valueClass,
  animate,
  sub,
}: {
  label: string;
  value: number | undefined;
  format: (v: number) => string;
  tone?: "good" | "warn" | "bad";
  /** Extra class on the value, e.g. the ASR/DLR quality colour (§13.4). */
  valueClass?: string;
  animate: boolean;
  sub?: string;
}) {
  const shown = useRolling(value ?? 0, animate);
  return (
    <div className={`dash-kpi${tone ? ` ${tone}` : ""}`}>
      <span className="label">{label}</span>
      <span className={`value ${valueClass ?? ""}`}>{value === undefined ? "—" : format(shown)}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

/**
 * Online now (§13.18): initials of signed-in staff, green when active in the last 5 minutes, grey when
 * idle; hover shows department, page, since and device. For admins and department managers (their
 * department only); opens Logged In Users.
 */
function OnlineNowCard() {
  const q = useOnlineUsers();
  const navigate = useTabNavigate();
  const o = q.data;
  if (!o || (o.scope !== "all" && o.scope !== "department")) return null;
  const shown = o.users.slice(0, 8);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost dash-online"
      title={`${o.active} active · ${o.total - o.active} idle — open Logged In Users`}
      onClick={() => navigate("/admin/logged-in")}
    >
      Online now <strong className="num">{o.total}</strong>
      <span className="dash-avatars">
        {shown.map((u) => (
          <span
            key={u.userId}
            className={`dash-avatar${u.active ? " active" : ""}`}
            title={[
              u.name,
              u.department,
              u.page ? `on ${pageForPath(u.page)?.label ?? u.page}` : null,
              `signed in ${u.since.slice(0, 16).replace("T", " ")} UTC`,
              [u.device, u.browser, u.os].filter(Boolean).join(" · "),
              u.active ? "active" : "idle",
            ]
              .filter(Boolean)
              .join("\n")}
          >
            {u.initials}
          </span>
        ))}
        {o.total > shown.length && <span className="dash-avatar more">+{o.total - shown.length}</span>}
      </span>
    </button>
  );
}

/** Market moves as a top card (§13.14, team trial round 2); opens Rates › Market moves. */
function MarketMovesCard() {
  const q = useMarketSummary();
  const navigate = useTabNavigate();
  const s = q.data;
  return (
    <button
      type="button"
      className="dash-kpi dash-kpi-btn"
      title={s ? `${s.up} up · ${s.down} down${s.mine ? ` · ${s.mine} for your clients` : ""}` : undefined}
      onClick={() => navigate("/rates/market-moves")}
    >
      <span className="label">Market moves</span>
      <span className="value">{s ? s.open.toLocaleString("en-US") : "—"}</span>
      <span className="sub">{s && s.urgent > 0 ? <span className="tone-error">{s.urgent} urgent</span> : "open"}</span>
    </button>
  );
}

/** Two figures in one card, one per line (team trial round 2), with an optional title above them. */
function PairCard({
  title,
  dot,
  rows,
  animate,
}: {
  title?: string;
  /** A green light before the title (Online, team trial round 3). */
  dot?: boolean;
  rows: {
    label: string;
    value: number | undefined;
    format: (v: number) => string;
    valueClass?: string;
  }[];
  animate: boolean;
}) {
  return (
    <div className={`dash-kpi dash-kpi-pair${title ? " titled" : ""}`}>
      {title && (
        <span className="label pair-title">
          {dot && <span className="dot dot-good" aria-hidden="true" />}
          {title}
        </span>
      )}
      {rows.map((r) => (
        <PairRow key={r.label} {...r} animate={animate} />
      ))}
    </div>
  );
}

function PairRow({
  label,
  value,
  format,
  valueClass,
  animate,
}: {
  label: string;
  value: number | undefined;
  format: (v: number) => string;
  valueClass?: string;
  animate: boolean;
}) {
  const shown = useRolling(value ?? 0, animate);
  return (
    <div className="pair-row">
      <span className="label">{label}</span>
      <span className={`value ${valueClass ?? ""}`}>{value === undefined ? "—" : format(shown)}</span>
    </div>
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
  const canMarketMoves = useCan("market-moves");
  const cur = s?.currency ?? "EUR";
  return (
    <Section title="Today" className="dash-summary">
      {/* Pairs in one card (team trial round 2): Submitted and Delivered, Revenue and Margin, ASR and DLR, Customers and Vendors online. */}
      <div className="dash-kpis">
        <Counter label="Attempts" value={s?.attempts} format={int} animate={animate} />
        <PairCard
          animate={animate}
          rows={[
            { label: "Submitted", value: s?.submitted, format: int },
            { label: "Delivered", value: s?.delivered, format: int },
          ]}
        />
        <PairCard
          animate={animate}
          rows={[
            { label: "Revenue", value: s?.revenue, format: (v) => money(v, cur) },
            {
              label: "Margin",
              value: s?.margin,
              format: (v) => money(v, cur),
              valueClass: s && s.margin < 0 ? "neg" : undefined,
            },
          ]}
        />
        <Counter label="Cost" value={s?.cost} format={(v) => money(v, cur)} animate={animate} />
        <PairCard
          animate={animate}
          rows={[
            { label: "ASR", value: s?.asr, format: (v) => `${v.toFixed(1)}%`, valueClass: qualityClass(s?.asr) },
            { label: "DLR", value: s?.dlr, format: (v) => `${v.toFixed(1)}%`, valueClass: qualityClass(s?.dlr) },
          ]}
        />
        <Counter label="TPS now" value={s?.tps} format={(v) => dec(v)} animate={animate} />
        <PairCard
          title="Online"
          dot
          animate={animate}
          rows={[
            { label: "Customers", value: s?.onlineCustomers, format: int },
            { label: "Vendors", value: s?.onlineVendors, format: int },
          ]}
        />
        {/* Only for users who may open Market moves (backend step 10). */}
        {canMarketMoves && <MarketMovesCard />}
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

type MoverKind = "started" | "customers" | "vendors" | "stopped";
/** Customer and Vendor in place of Increasing and Decreasing (team trial round 2). */
const MOVER_GROUPS: { key: MoverKind; label: string; tone: string }[] = [
  { key: "started", label: "Started", tone: "good" },
  { key: "customers", label: "Customer", tone: "neutral" },
  { key: "vendors", label: "Vendor", tone: "neutral" },
  { key: "stopped", label: "Stopped", tone: "bad" },
];

/** The card's volume (team trial round 2): only trunks that sent at least this many messages in the window. */
function VolumeInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 0 && n <= 10_000_000 && n !== value) onChange(n);
    else setDraft(String(value));
  };
  return (
    <label
      className="dash-volume"
      title="Only trunks that sent at least this many messages in the window, now or before"
    >
      Volume ≥
      <input
        type="number"
        min={0}
        step={50}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
}

function MoversPanel({
  movers,
  onOpen,
  volumes,
  onVolume,
}: {
  movers: DashboardMoversEvent | null;
  onOpen: Open;
  volumes: { customer: number; vendor: number };
  onVolume: (kind: "customer" | "vendor", n: number) => void;
}) {
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
            Last {movers.windowMinutes} min vs the {movers.windowMinutes} min before
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
                {(g.key === "customers" || g.key === "vendors") && (
                  <VolumeInput
                    value={g.key === "customers" ? volumes.customer : volumes.vendor}
                    onChange={(n) => onVolume(g.key === "customers" ? "customer" : "vendor", n)}
                  />
                )}
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
        title={`${row.enterprise.name} · ${row.trunk.name}: ${row.tpsBefore} → ${row.tpsNow} TPS (${int(row.messagesBefore)} → ${int(row.messagesNow)} messages). ASR ${pct(row.asr)}, DLR ${pct(row.dlr)}${row.topDestination ? `. Mostly ${row.topDestination.name}` : ""}`}
      >
        <span className="who">
          <span className="name">
            {row.enterprise.name}
            {isNew && <span className="badge-new">new</span>}
          </span>
          <span className="trunk muted">
            {row.trunk.name}
            {row.topDestination && (
              <span
                className="dash-mover-dest"
                title={`Sends most to ${row.topDestination.name} (${row.topDestination.mccmnc})`}
              >
                {" "}
                · {row.topDestination.name}
              </span>
            )}
          </span>
        </span>
        <Sparkline values={row.sparkline} />
        <span className="tps num">
          {kind === "stopped" ? dec(row.tpsBefore) : dec(row.tpsNow)}
          <span className="muted"> {kind === "stopped" ? "was" : `from ${dec(row.tpsBefore)}`}</span>
        </span>
        {change ?? <span className="chg muted">—</span>}
        <span className="ratios num muted">
          <span className={qualityClass(row.asr)}>{pct(row.asr)}</span> ·{" "}
          <span className={qualityClass(row.dlr)}>{pct(row.dlr)}</span>
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

/** Height of an expanded row's breakdown under it (team trial round 2). */
const OPEN_H = 300;

/**
 * Rows positioned by rank, so a rank change slides the row (§13.3 "rows re-sort smoothly"). An open row shows
 * `renderOpen` under it and the rows below move down (team trial round 2).
 */
function RankedList<T>({
  rows,
  rowKey,
  render,
  height,
  label,
  openKey = null,
  renderOpen,
}: {
  rows: T[];
  rowKey: (r: T) => string;
  render: (r: T, i: number) => ReactNode;
  height: number;
  label: string;
  openKey?: string | null;
  renderOpen?: (r: T) => ReactNode;
}) {
  const openAt = openKey === null ? -1 : rows.findIndex((r) => rowKey(r) === openKey);
  const opened = openAt >= 0 ? rows[openAt] : undefined;
  const y = (i: number) => i * ROW_H + (openAt >= 0 && i > openAt ? OPEN_H : 0);
  return (
    <div className="dash-ranked" style={{ height }} role="list" aria-label={label}>
      <div style={{ height: rows.length * ROW_H + (opened ? OPEN_H : 0), position: "relative" }}>
        {rows.map((r, i) => (
          <div
            key={rowKey(r)}
            role="listitem"
            className={`dash-rank-row${i === openAt ? " open" : ""}`}
            style={{ transform: `translateY(${y(i)}px)` }}
          >
            {render(r, i)}
          </div>
        ))}
        {opened !== undefined && renderOpen && (
          <div className="dash-rank-open" style={{ top: (openAt + 1) * ROW_H, height: OPEN_H }}>
            {renderOpen(opened)}
          </div>
        )}
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
  // Click a row: its breakdown opens under it; click a breakdown row: Live analytics (team trial round 2).
  const [open, setOpen] = useState<{ side: "clients" | "vendors"; key: string } | null>(null);
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
                openKey={open?.side === side ? open.key : null}
                renderOpen={(r) => (
                  <BreakdownTable
                    target={{ kind: side === "clients" ? "customer" : "vendor", name: r.party.name }}
                    onOpen={() => onOpen(r.party, r.party.name)}
                  />
                )}
                render={(r, i) => {
                  const key = String(r.party.id);
                  const isOpen = open?.side === side && open.key === key;
                  return (
                    <button
                      type="button"
                      className="dash-cols dash-top-row"
                      aria-expanded={isOpen}
                      title={isOpen ? "Close the breakdown" : "Show what it is made of today"}
                      onClick={() => setOpen(isOpen ? null : { side, key })}
                    >
                      <span className="muted num">{i + 1}</span>
                      <span className="ellipsis dash-named" title={r.party.name}>
                        <span className="dash-volbar" style={{ width: `${(r.attempts / max) * 100}%` }} />
                        <span className="t">{r.party.name}</span>
                      </span>
                      <span className="r num">{int(r.attempts)}</span>
                      <span className="r num">{money(r.money, cur)}</span>
                      <span className={`r num${r.margin < 0 ? " neg" : ""}`}>{money(r.margin, cur)}</span>
                      <span className={`r num ${qualityClass(r.asr)}`}>{pct(r.asr)}</span>
                      <span className={`r num ${qualityClass(r.dlr)}`}>{pct(r.dlr)}</span>
                    </button>
                  );
                }}
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
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="Top destinations today" className="dash-top">
      <div className="dash-cols dash-dest-row head" aria-hidden="true">
        <span>#</span>
        <span>Country</span>
        <span>Network count</span>
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
          rowKey={(r) => r.iso}
          openKey={open}
          renderOpen={(r) => (
            <BreakdownTable
              target={{ kind: "destination", iso: r.iso, name: r.country }}
              onOpen={() => onOpen({ country: r.country }, r.country)}
            />
          )}
          render={(r, i) => (
            <button
              type="button"
              className="dash-cols dash-dest-row"
              aria-expanded={open === r.iso}
              title={open === r.iso ? "Close the breakdown" : "Show who sends to it today"}
              onClick={() => setOpen(open === r.iso ? null : r.iso)}
            >
              <span className="muted num">{i + 1}</span>
              <span className="ellipsis dash-named" title={r.country}>
                <span className="dash-volbar" style={{ width: `${(r.attempts / max) * 100}%` }} />
                <span className="t">{r.country}</span>
              </span>
              <span className="num muted">{r.networks}</span>
              <span className="r num">{int(r.attempts)}</span>
              <span className="r num">{money(r.revenue, cur)}</span>
              <span className={`r num${r.margin < 0 ? " neg" : ""}`}>{money(r.margin, cur)}</span>
              <span className={`r num ${qualityClass(r.asr)}`}>{pct(r.asr)}</span>
              <span className={`r num ${qualityClass(r.dlr)}`}>{pct(r.dlr)}</span>
            </button>
          )}
        />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- row breakdowns

type Breakdown =
  | { kind: "customer"; name: string }
  | { kind: "vendor"; name: string }
  | { kind: "destination"; iso: string; name: string };

/**
 * What an opened row is made of today (team trial round 2), from the same report engine as Live analytics.
 * Destinations are whole countries, all networks together.
 */
const BREAKDOWN: Record<Breakdown["kind"], { by: [ReportDimension, ReportDimension]; heads: [string, string] }> = {
  customer: { by: ["country", "vendor"], heads: ["Destination", "Vendor"] },
  vendor: { by: ["customer", "country"], heads: ["Client", "Destination"] },
  destination: { by: ["customer", "vendor"], heads: ["Client", "Vendor"] },
};

function BreakdownTable({ target, onOpen }: { target: Breakdown; onOpen: () => void }) {
  const timezone = useReference().data?.platformTimezone ?? "UTC";
  const def = BREAKDOWN[target.kind];
  const condition: FilterCondition =
    target.kind === "destination"
      ? { field: "country", op: "eq", value: target.iso }
      : { field: target.kind, op: "eq", value: target.name };
  const q = useQuery({
    queryKey: ["dash-breakdown", target, timezone],
    queryFn: () =>
      runMasterReport({
        groupBy: def.by,
        metrics: ["attempts"],
        enterpriseLabel: "alias",
        timezone,
        period: "today",
        compare: "none",
        filter: { logic: "and", conditions: [condition] },
        sort: [{ field: "attempts", dir: "desc" }],
        limit: 10,
      }),
    staleTime: 30_000,
  });
  return (
    <div className="dash-breakdown">
      <strong>{target.name}</strong> <span className="muted small">today, by volume</span>
      {q.isPending ? (
        <p className="muted small">Loading…</p>
      ) : q.isError ? (
        <p className="error-text small">{(q.error as Error).message}</p>
      ) : !q.data.rows.length ? (
        <p className="muted small">No traffic today.</p>
      ) : (
        <table className="mini-table">
          <thead>
            <tr>
              <th>{def.heads[0]}</th>
              <th>{def.heads[1]}</th>
              <th className="num">Volume</th>
            </tr>
          </thead>
          <tbody>
            {q.data.rows.map((r) => (
              <tr key={r.key} className="dash-open-row" title="Open in Live analytics" onClick={onOpen}>
                <td>{r.dims[def.by[0]]?.label ?? "—"}</td>
                <td>{r.dims[def.by[1]]?.label ?? "—"}</td>
                <td className="num">{int(r.metrics.attempts ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
