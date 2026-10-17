// Master Report (§13.15): every metric, grouped by up to five fields in any order and filtered by
// anything. "Start from" loads a ready-made report: the department reports and the §10 reports
// that became saved views (Customize, Enterprise, Master Grouping, Usage Enterprise, Negative
// Margin, Bilateral).
import { useLocation } from "react-router";
import type { MasterReportSettings } from "@sms/contract";
import { useReportPresets } from "../../api/masterReports";
import { emptyState, encodeState } from "../../grid/filterModel";
import { pageForPath } from "../../nav/registry";
import { useTabNavigate } from "../../shell/tabContext";
import { defaultSettings, encodeSettings, visibleOf } from "./masterModel";
import { ReportScreen, type ReportPreset } from "./ReportScreen";

const page = pageForPath("/reports/master")!;

export const MASTER_DEFAULT: ReportPreset = {
  settings: {
    groupBy: ["customer"],
    metrics: ["attempts", "successful", "asr", "dlrCustomer", "revenue", "cost", "margin", "marginPct"],
    timezone: "UTC",
    period: "yesterday",
    compare: "none",
  },
};

/** URL that opens a report with these settings (columns, filter and period). */
export function reportPath(path: string, s: MasterReportSettings) {
  const g = encodeState({ ...emptyState(), visible: visibleOf(s), builder: s.filter ?? null });
  return `${path}?r=${encodeSettings(defaultSettings(s))}${g ? `&g=${g}` : ""}`;
}

function StartFrom() {
  const presets = useReportPresets();
  const navigate = useTabNavigate();
  const location = useLocation();
  return (
    <select
      aria-label="Start from a ready-made report"
      value=""
      onChange={(e) => {
        const p = presets.data?.presets.find((x) => x.key === e.target.value);
        if (p) navigate(reportPath(location.pathname, p.settings), { replace: true });
      }}
    >
      <option value="">Start from…</option>
      {presets.data?.presets.map((p) => (
        <option key={p.key} value={p.key} title={p.description}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function MasterReportPage() {
  return <ReportScreen page={page} preset={MASTER_DEFAULT} extraActions={<StartFrom />} />;
}
