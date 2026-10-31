// ECharts wrapper (§14). Colours come from the tokens (§15.2), read from CSS variables, and
// the chart redraws when the theme switches, so charts follow light and dark themes.
import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface ChartColors {
  text: string;
  secondary: string;
  border: string;
  accent: string;
  good: string;
  warning: string;
  error: string;
  panel: string;
  /** Series colours that only tell things apart (--chart-1…4, §15.3), in a fixed order. */
  series: string[];
}

function readColors(): ChartColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    text: v("--color-text"),
    secondary: v("--color-text-secondary"),
    border: v("--color-border"),
    accent: v("--color-accent"),
    good: v("--color-good"),
    warning: v("--color-warning"),
    error: v("--color-error"),
    panel: v("--color-panel"),
    series: [v("--chart-1"), v("--chart-2"), v("--chart-3"), v("--chart-4")],
  };
}

/** Token colours, updated when data-theme changes on <html>. */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState(readColors);
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(readColors()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return colors;
}

export function Chart({
  option,
  height,
  className,
  label,
  merge = false,
  onClick,
}: {
  option: EChartsCoreOption;
  height: number;
  className?: string;
  label: string;
  /** Merge updates into the drawn chart (streaming data) instead of redrawing it. */
  merge?: boolean;
  onClick?: (params: { seriesId?: string; seriesName?: string; dataIndex: number }) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, merge ? { lazyUpdate: true } : { notMerge: true });
  }, [option, merge]);
  const clickRef = useRef(onClick);
  useEffect(() => {
    clickRef.current = onClick;
  });
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const h = (p: unknown) => clickRef.current?.(p as { seriesId?: string; seriesName?: string; dataIndex: number });
    c.on("click", h);
    return () => {
      c.off("click", h);
    };
  }, []);
  return <div ref={el} className={className} style={{ height, width: "100%" }} role="img" aria-label={label} />;
}
