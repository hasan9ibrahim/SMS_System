// ASR and DLR coloured by value everywhere except Live analytics, which keeps its own cells
// (team trial round 1, §13.4 consistent colours): green from 80 %, amber from 60 % to 80 %, red below 60 %.
import type { ReactNode } from "react";

export type QualityTone = "good" | "warning" | "error" | "";

export function qualityTone(v: number | null | undefined): QualityTone {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  return v >= 80 ? "good" : v >= 60 ? "warning" : "error";
}

/** The CSS class for a value: tone-good (from 80 %) / tone-warning / tone-error (or none). */
export const qualityClass = (v: number | null | undefined) => {
  const t = qualityTone(v);
  return t ? `tone-${t}` : "";
};

/** An ASR or DLR percentage in its colour. `children` replaces the default "12.3%" text. */
export function QualityPct({
  value,
  digits = 1,
  suffix = "%",
  title,
  children,
}: {
  value: number | null | undefined;
  digits?: number;
  suffix?: string;
  title?: string;
  children?: ReactNode;
}) {
  if (value === null || value === undefined) return <span className="num muted">—</span>;
  return (
    <span className={`num ${qualityClass(value)}`} title={title}>
      {children ?? `${value.toFixed(digits)}${suffix}`}
    </span>
  );
}

/** Report metric keys that are ASR or DLR percentages (coloured by value in report grids). */
export const QUALITY_METRICS: ReadonlySet<string> = new Set(["asr", "dlr", "dlrCustomer", "dlrVendor"]);
/** qualityClass for a report metric, or "" when the metric is not ASR/DLR. */
export const metricQualityClass = (metric: string, v: number | null | undefined) =>
  QUALITY_METRICS.has(metric) ? qualityClass(v) : "";
