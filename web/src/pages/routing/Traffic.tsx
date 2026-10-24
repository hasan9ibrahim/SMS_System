// Route rule traffic (§13.27, §15.4): the Traffic section (volume, ASR, DLR and margin over
// time, per customer and vendor), the right-side 24h trend, and the hover breakdown on
// the 24h column with a selectable time frame. "Vendors over time" shows which vendor carried the
// traffic in each bucket and when the main vendor changed (team trial round 1).
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { RouteTraffic, TrafficWindow } from "@sms/contract";
import { usePlatformCurrency } from "../../api/records";
import { useRouteTraffic } from "../../api/routing";
import { Chart, useChartColors } from "../../ui/Chart";
import { Popover } from "../../ui/primitives";
import { qualityClass } from "../../ui/quality";
import { formatMoney, formatPct } from "../rates/format";
import { compact, vendorSwitches } from "./ruleModel";

export const WINDOWS: TrafficWindow[] = ["15m", "1h", "24h", "7d", "30d"];

export { usePlatformCurrency };

export function money(v: number | null | undefined, ccy: string): string {
  if (v === null || v === undefined) return "—";
  const s = formatMoney(Math.abs(v), ccy);
  return v < 0 ? `−${s}` : s;
}

export function WindowSwitch({ value, onChange }: { value: TrafficWindow; onChange: (w: TrafficWindow) => void }) {
  return (
    <div className="segmented small" role="radiogroup" aria-label="Time frame">
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          role="radio"
          aria-checked={value === w}
          className={value === w ? "on" : ""}
          onClick={() => onChange(w)}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

const bucketLabel = (at: string, w: TrafficWindow) => (w === "7d" || w === "30d" ? at.slice(5, 10) : at.slice(11, 16));

function TrafficChart({ data, ccy }: { data: RouteTraffic; ccy: string }) {
  const c = useChartColors();
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 48, right: 56, top: 26, bottom: 24 },
      legend: { top: 0, right: 0, textStyle: { color: c.secondary, fontSize: 11 }, itemHeight: 8 },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.panel,
        borderColor: c.border,
        textStyle: { color: c.text, fontSize: 12 },
      },
      xAxis: {
        type: "category",
        data: data.series.map((p) => bucketLabel(p.at, data.window)),
        axisLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.secondary, fontSize: 11 },
      },
      yAxis: [
        {
          type: "value",
          splitLine: { lineStyle: { color: c.border } },
          axisLabel: { color: c.secondary, fontSize: 11, formatter: (v: number) => compact(v) },
        },
        {
          type: "value",
          splitLine: { show: false },
          axisLabel: { color: c.secondary, fontSize: 11, formatter: (v: number) => money(v, ccy) },
        },
      ],
      series: [
        {
          name: "Messages",
          type: "bar",
          data: data.series.map((p) => p.messages),
          itemStyle: { color: c.accent, borderRadius: [2, 2, 0, 0] },
          barMaxWidth: 14,
        },
        {
          name: "Margin",
          type: "line",
          yAxisIndex: 1,
          data: data.series.map((p) => +p.margin.toFixed(2)),
          symbol: "none",
          lineStyle: { color: c.good, width: 1.5 },
          itemStyle: { color: c.good },
        },
      ],
    }),
    [data, c, ccy],
  );
  return <Chart option={option} height={170} label="Messages and margin over time" />;
}

const vendorLabel = (id: number, names: ReadonlyMap<number, string>) =>
  id === 0 ? "Not routed" : id === -1 ? "Other vendors" : (names.get(id) ?? `Trunk ${id}`);

function VendorTimeline({ data }: { data: RouteTraffic }) {
  const c = useChartColors();
  const names = useMemo(() => new Map(data.byVendor.map((v) => [v.vendorTrunkId, v.name])), [data]);
  // Vendors in the window's order (most messages first), then "other" and "not routed".
  const ids = useMemo(() => {
    const seen = new Set(data.series.flatMap((p) => (p.vendors ?? []).map((v) => v.vendorTrunkId)));
    const ordered = data.byVendor.map((v) => v.vendorTrunkId).filter((id) => id > 0 && seen.has(id));
    return [...ordered, ...[-1, 0].filter((id) => seen.has(id))];
  }, [data]);
  const switches = useMemo(() => vendorSwitches(data.series), [data]);
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 48, right: 16, top: 26, bottom: 24 },
      legend: { top: 0, right: 0, type: "scroll", textStyle: { color: c.secondary, fontSize: 11 }, itemHeight: 8 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: c.panel,
        borderColor: c.border,
        textStyle: { color: c.text, fontSize: 12 },
      },
      xAxis: {
        type: "category",
        data: data.series.map((p) => bucketLabel(p.at, data.window)),
        axisLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.secondary, fontSize: 11 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.secondary, fontSize: 11, formatter: (v: number) => compact(v) },
      },
      // Colour carries meaning only: vendors in shades of the accent, other vendors grey, not routed red.
      series: ids.map((id, i) => ({
        name: vendorLabel(id, names),
        type: "bar",
        stack: "vendors",
        barMaxWidth: 14,
        data: data.series.map((p) => p.vendors?.find((v) => v.vendorTrunkId === id)?.messages ?? 0),
        itemStyle: {
          color: id === 0 ? c.error : id === -1 ? c.secondary : c.accent,
          opacity: id > 0 ? Math.max(0.25, 1 - i * 0.16) : 0.8,
        },
      })),
    }),
    [data, c, ids, names],
  );
  return (
    <div className="vendor-timeline">
      <div className="aside-label">Vendors over time</div>
      <Chart option={option} height={150} label="Messages per vendor over time" />
      {switches.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>From</th>
              <th>Until</th>
              <th>Main vendor</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {switches.map((x) => (
              <tr key={x.at}>
                <td>{fmtAt(x.at, data.window)}</td>
                <td>{x.untilAt ? fmtAt(x.untilAt, data.window) : "now"}</td>
                <td className={x.vendorTrunkId === 0 ? "tone-error" : ""}>{vendorLabel(x.vendorTrunkId, names)}</td>
                <td className="num">{formatPct(x.sharePct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const fmtAt = (at: string, w: TrafficWindow) =>
  w === "7d" || w === "30d" ? at.slice(0, 10) : `${at.slice(5, 10)} ${at.slice(11, 16)}`;

function FiguresTable({
  title,
  rows,
  ccy,
}: {
  title: string;
  rows: {
    key: number;
    name: string;
    sub?: string;
    messages: number;
    sharePct: number;
    asr: number | null;
    dlr: number | null;
    margin: number;
  }[];
  ccy: string;
}) {
  return (
    <table className="mini-table">
      <thead>
        <tr>
          <th>{title}</th>
          <th className="num">Msgs</th>
          <th className="num">Share</th>
          <th className="num">ASR</th>
          <th className="num">DLR</th>
          <th className="num">Margin</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              {r.name}
              {r.sub && <span className="muted small"> · {r.sub}</span>}
            </td>
            <td className="num">{r.messages.toLocaleString("en-US")}</td>
            <td className="num">{formatPct(r.sharePct)}</td>
            <td className={`num ${qualityClass(r.asr)}`}>{formatPct(r.asr)}</td>
            <td className={`num ${qualityClass(r.dlr)}`}>{formatPct(r.dlr)}</td>
            <td className={`num${r.margin < 0 ? " tone-error" : ""}`}>{money(r.margin, ccy)}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="muted">
              No traffic in this time frame.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Unavailable({ data }: { data: RouteTraffic | undefined }) {
  return data && !data.available ? (
    <p className="muted small">Traffic figures need the EDR store (ClickHouse), which is not answering.</p>
  ) : null;
}

export function TrafficSection({ ruleId }: { ruleId: number }) {
  const [win, setWin] = useState<TrafficWindow>("24h");
  const traffic = useRouteTraffic(ruleId, win);
  const ccy = usePlatformCurrency();
  const d = traffic.data;
  return (
    <div className="traffic">
      <div className="traffic-head">
        <WindowSwitch value={win} onChange={setWin} />
        {d && (
          <dl className="traffic-kpis">
            <div>
              <dt>Messages</dt>
              <dd className="num">{d.total.messages.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>ASR</dt>
              <dd className={`num ${qualityClass(d.total.asr)}`}>{formatPct(d.total.asr)}</dd>
            </div>
            <div>
              <dt>DLR</dt>
              <dd className={`num ${qualityClass(d.total.dlr)}`}>{formatPct(d.total.dlr)}</dd>
            </div>
            <div>
              <dt>Margin</dt>
              <dd className={`num${d.total.margin < 0 ? " tone-error" : ""}`}>{money(d.total.margin, ccy)}</dd>
            </div>
          </dl>
        )}
        {traffic.isFetching && <span className="muted small">Loading…</span>}
      </div>
      {traffic.isError && <p className="error-text">{(traffic.error as Error).message}</p>}
      <Unavailable data={d} />
      {d?.available && (
        <>
          <TrafficChart data={d} ccy={ccy} />
          <VendorTimeline data={d} />
          <div className="traffic-tables">
            <FiguresTable
              title="Customer trunk"
              ccy={ccy}
              rows={d.byCustomer.map((r) => ({ ...r, key: r.customerTrunkId, sub: r.enterpriseName }))}
            />
            <FiguresTable
              title="Vendor trunk"
              ccy={ccy}
              rows={d.byVendor.map((r) => ({ ...r, key: r.vendorTrunkId }))}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Right side of the detail panel: Traffic 24h trend line, Messages and Margin (§15.4). */
export function TrafficAside({ ruleId }: { ruleId: number }) {
  const traffic = useRouteTraffic(ruleId, "24h");
  const c = useChartColors();
  const ccy = usePlatformCurrency();
  const d = traffic.data;
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 2, right: 2, top: 4, bottom: 2 },
      xAxis: { type: "category", show: false, data: d?.series.map((p) => p.at) ?? [] },
      yAxis: { type: "value", show: false, min: "dataMin" },
      series: [
        {
          type: "line",
          data: d?.series.map((p) => p.messages) ?? [],
          symbol: "none",
          smooth: 0.3,
          lineStyle: { color: c.accent, width: 1.5 },
        },
      ],
    }),
    [d, c],
  );
  return (
    <div className="traffic-aside">
      <div className="aside-label">Traffic 24h</div>
      {d?.available ? (
        <Chart option={option} height={84} label="Messages over the last 24 hours" />
      ) : (
        <div className="spark-empty" />
      )}
      <dl className="aside-kv">
        <dt>Messages</dt>
        <dd className="num strong">{d ? d.total.messages.toLocaleString("en-US") : "—"}</dd>
        <dt>Margin</dt>
        <dd className={`num strong${d && d.total.margin < 0 ? " tone-error" : ""}`}>
          {d ? money(d.total.margin, ccy) : "—"}
        </dd>
      </dl>
    </div>
  );
}

function Breakdown({ ruleId, initial }: { ruleId: number; initial: TrafficWindow }) {
  const [win, setWin] = useState<TrafficWindow>(initial);
  const traffic = useRouteTraffic(ruleId, win);
  const ccy = usePlatformCurrency();
  const d = traffic.data;
  return (
    <div className="breakdown">
      <div className="breakdown-head">
        <strong>Per customer</strong>
        <span className="fb-spacer" />
        <WindowSwitch value={win} onChange={setWin} />
      </div>
      <Unavailable data={d} />
      {!d && <p className="muted small">Loading…</p>}
      {d?.available && (
        <FiguresTable
          title="Customer trunk"
          ccy={ccy}
          rows={d.byCustomer.slice(0, 10).map((r) => ({ ...r, key: r.customerTrunkId, sub: r.enterpriseName }))}
        />
      )}
      {d && d.byCustomer.length > 10 && (
        <p className="muted small">+{d.byCustomer.length - 10} more in the Traffic section.</p>
      )}
    </div>
  );
}

/** Hover the 24h value: per-customer breakdown with a selectable time frame (§13.27). */
export function TrafficHover({
  ruleId,
  frame,
  children,
}: {
  ruleId: number;
  frame: TrafficWindow;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const enter = () => {
    clearTimer(timer);
    timer.current = window.setTimeout(() => setOpen(true), 350);
  };
  const leave = () => {
    clearTimer(timer);
    timer.current = window.setTimeout(() => setOpen(false), 250);
  };
  return (
    <>
      <span ref={anchor} className="hover-target" onMouseEnter={enter} onMouseLeave={leave}>
        {children}
      </span>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end" className="breakdown-pop">
        <div onMouseEnter={() => clearTimer(timer)} onMouseLeave={leave} onClick={(e) => e.stopPropagation()}>
          <Breakdown ruleId={ruleId} initial={frame} />
        </div>
      </Popover>
    </>
  );
}

function clearTimer(timer: { current: number | undefined }) {
  if (timer.current !== undefined) window.clearTimeout(timer.current);
  timer.current = undefined;
}
